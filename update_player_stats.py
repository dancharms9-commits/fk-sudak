"""Сезонная статистика всех игроков ФК «Судак» (Открытый чемпионат РК, 2026).

Дополняет data.json после существующего fetch_data.py, не меняя календарь,
таблицу, новости и состав. Источник: персональные карточки игроков РФФК.
Частичные ошибки сети не сбрасывают ранее подтверждённые показатели.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE = "https://rffk-roo.ru"
TEAM_URL = BASE + "/teams/141/"
LEAGUE_URL = BASE + "/tournaments/4/"
DATA_FILE = Path("data.json")
CACHE_FILE = Path("player_stats_cache_2026.json")
USER_AGENT = "Mozilla/5.0 (compatible; FKSudakPWA/1.4)"
MAX_WORKERS = 4
TIMEOUT_SECONDS = 12

# Читаем только итоги чемпионата 2026 ИМЕННО для «Судака».
# На странице могут встречаться 2025 год и другие команды того же игрока.
# После строки «в старте» идут голы (пенальти в скобках), 5 служебных
# числовых показателей и минуты. Расширение таблицы на сайте РФФК требует
# отдельной проверки, а не молчаливого использования неверных чисел.
SEASON_ROW = re.compile(
    r"Открытый\s+Чемпионат\s+Республики\s+Крым\s+среди\s+мужских\s+"
    r"любительских\s+команд\s+Сезон\s+2026(?:/2026)?\s+"
    r"ФК\s*[«\"]Судак[»\"]\s*\(Судак\)\s+"
    r"в\s+старте\s*-\s*(\d+)\s*,\s*на\s+замену\s*-\s*(\d+)\s+"
    r"(\d+)\s*\((\d+)\)\s+(?:\d+\s+){5}(\d+)(?=\s|$)",
    re.IGNORECASE,
)
PLAYER_PATH = re.compile(r"^/players/\d+/?$")


def normalized_text(soup):
    return re.sub(r"\s+", " ", soup.get_text(" ", strip=True)).strip()


def fetch_html(url):
    response = requests.get(
        url, timeout=TIMEOUT_SECONDS,
        headers={"User-Agent": USER_AGENT},
    )
    response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def safe_player_url(href):
    url = urljoin(BASE, href or "")
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.netloc == "rffk-roo.ru" and PLAYER_PATH.fullmatch(parsed.path):
        return url
    return None


def safe_photo_url(raw):
    if not isinstance(raw, str):
        return None
    parsed = urlparse(raw)
    filename = parsed.path.rsplit("/", 1)[-1].lower()
    if (parsed.scheme != "https" or parsed.netloc != "rffk-roo.ru"
            or parsed.query or parsed.fragment
            or not re.fullmatch(r"/uploads/people/(?:large|medium|small)/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)", parsed.path, re.I)
            or re.search(r"(?:default|no[-_]?photo|placeholder|unknown|empty|avatar)\.", filename)):
        return None
    return raw


def parse_profile_photo(soup, expected_name, profile_url):
    """Only the portrait attached to this exact official player identity."""
    if safe_player_url(profile_url) != profile_url:
        return {}
    last = soup.select_one(".player-data__lastname")
    first = soup.select_one(".player-data__name")
    images = soup.select(".player-data__image img")
    if not last or not first or len(images) != 1:
        return {}
    name = normalized_text(last) + " " + normalized_text(first).split(" ")[0]
    if name != expected_name:
        return {}
    image = images[0]
    # Ignore page logos, generic avatars, and portraits with a different alt name.
    if normalized_text(BeautifulSoup(image.get("alt", ""), "html.parser")) != expected_name:
        return {}
    url = safe_photo_url(urljoin(BASE, image.get("src", "")))
    return {"photo_url": url, "photo_source_url": profile_url} if url else {}


def parse_profile_stats(soup, expected_name, played, team_goals):
    """Returns None for missing/ambiguous; zero goals for a verified 0-goal player."""
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    if expected_name not in title:
        return None
    matches = list(SEASON_ROW.finditer(normalized_text(soup)))
    if len(matches) != 1:
        return None
    starts, subs, goals, penalties, minutes = map(int, matches[0].groups())
    games = starts + subs
    if not (1 <= games <= played
            and 0 <= goals <= team_goals
            and 0 <= penalties <= goals
            and 0 <= minutes <= games * 120):
        return None
    return {
        "league_games": games,
        "league_goals": goals,
        "league_penalty_goals": penalties,
        "league_minutes": minutes,
        "league_starts": starts,
        "league_substitutions": subs,
    }


def player_profile_urls(team_soup, roster_names):
    """Only exact names from the existing verified team roster."""
    candidates = {}
    for link in team_soup.select('a[href*="/players/"]'):
        name = re.sub(r"\s+", " ", link.get_text(" ", strip=True)).strip()
        url = safe_player_url(link.get("href", ""))
        if name in roster_names and url:
            candidates.setdefault(name, set()).add(url)
    return {name: next(iter(urls)) for name, urls in candidates.items() if len(urls) == 1}


def read_json(path):
    try:
        with path.open(encoding="utf-8") as file:
            return json.load(file)
    except (OSError, ValueError, TypeError):
        return {}


def atomic_json(path, payload):
    tmp_path = path.with_name(path.name + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=1)
        file.write("\n")
    os.replace(tmp_path, path)


def valid_stat_fields(item, played, team_goals):
    if not isinstance(item, dict):
        return None
    keys = ("league_games", "league_goals", "league_penalty_goals", "league_minutes")
    if any(type(item.get(key)) is not int for key in keys):
        return None
    games, goals, penalty, minutes = (item[k] for k in keys)
    if not (1 <= games <= played and 0 <= goals <= team_goals
            and 0 <= penalty <= goals and 0 <= minutes <= games * 120):
        return None
    output = {k: item[k] for k in keys}
    starts, subs = item.get("league_starts"), item.get("league_substitutions")
    if (type(starts) is int and type(subs) is int
            and starts >= 0 and subs >= 0 and starts + subs == games):
        output.update(league_starts=starts, league_substitutions=subs)
    if item.get("profile_url") and safe_player_url(item["profile_url"]) == item["profile_url"]:
        output["profile_url"] = item["profile_url"]
    if (output.get("profile_url") and item.get("photo_source_url") == output["profile_url"]
            and safe_photo_url(item.get("photo_url"))):
        output.update(photo_url=item["photo_url"], photo_source_url=item["photo_source_url"])
    return output


def fetch_one_player(name, url, played, team_goals):
    try:
        soup = fetch_html(url)
        stats = parse_profile_stats(soup, name, played, team_goals)
        photo = parse_profile_photo(soup, name, url)
        return name, ({**stats, "profile_url": url, **photo} if stats else None)
    except (requests.RequestException, ValueError, TypeError, AttributeError):
        return name, None


def main():
    data = read_json(DATA_FILE)
    squad = data.get("squad", {})
    if not isinstance(squad, dict):
        print("Состав некорректен; ничего не меняем")
        return
    # Existing data.json has name|total-matches strings grouped by position.
    roster = {}
    for position, members in squad.items():
        if not isinstance(members, list):
            continue
        for value in members:
            if not isinstance(value, str) or "|" not in value:
                continue
            name, count = value.rsplit("|", 1)
            if count.isdigit() and name.strip():
                roster[name.strip()] = (position, int(count))
    table = data.get("table", [])
    sudak = next((r for r in table if isinstance(r, list) and len(r) >= 3
                  and re.sub(r'[«»"\s]', '', str(r[0])).casefold() == 'фксудак'), None)
    if not sudak or len(roster) < 10:
        print("Нет надёжной таблицы чемпионата или состава: текущий файл сохранён")
        return
    try:
        played = int(sudak[1])
        team_goals = int(re.split(r"[-–]", str(sudak[2]))[0].strip())
    except (ValueError, TypeError, IndexError):
        return
    if not (1 <= played <= 50 and 0 <= team_goals <= 300):
        return

    previous_from_data = data.get("player_stats_2026", {})
    previous_from_cache = read_json(CACHE_FILE)
    saved = {}
    # Cache is the durable previous set: fetch_data.py can overwrite its own
    # stats subsection before this script runs, without destroying the cache.
    for source in (previous_from_data, previous_from_cache):
        if not isinstance(source, dict) or source.get("season") != 2026:
            continue
        if source.get("source_url") != LEAGUE_URL:
            continue
        for item in source.get("players", []):
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            checked = valid_stat_fields(item, played, team_goals)
            if name in roster and checked:
                saved[name] = {**saved.get(name, {}), **checked}

    links = {}
    fresh = {}
    try:
        team_soup = fetch_html(TEAM_URL)
        links = player_profile_urls(team_soup, set(roster))
    except requests.RequestException as error:
        print(f"Карточка команды недоступна: {type(error).__name__}")
        links = {name: stats["profile_url"] for name, stats in saved.items()
                 if "profile_url" in stats}

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        jobs = [pool.submit(fetch_one_player, name, url, played, team_goals)
                for name, url in links.items()]
        for job in as_completed(jobs):
            name, stats = job.result()
            if stats:
                # When the tournament's separate scorer list is available,
                # reject contradicting profile statistics rather than guessing.
                from_leaderboard = valid_stat_fields(next(
                    (p for p in previous_from_data.get("players", [])
                     if isinstance(p, dict) and p.get("name") == name), {}),
                    played, team_goals)
                if from_leaderboard and any(
                    stats[k] != from_leaderboard[k]
                    for k in ("league_games", "league_goals", "league_penalty_goals", "league_minutes")
                ):
                    print(f"Несовпадение источников для {name}; используем предыдущие подтверждённые данные")
                    continue
                fresh[name] = stats

    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    previous_timestamp = (previous_from_cache.get("stats_as_of")
                          or previous_from_data.get("stats_as_of"))
    players = []
    for name, (position, federation_games) in roster.items():
        stats = fresh.get(name, saved.get(name, {}))
        row = {
            "name": name,
            "position": position,
            "federation_games": federation_games,
            "league_games": stats.get("league_games"),
            "league_goals": stats.get("league_goals"),
            "league_penalty_goals": stats.get("league_penalty_goals"),
            "league_minutes": stats.get("league_minutes"),
            "league_starts": stats.get("league_starts"),
            "league_substitutions": stats.get("league_substitutions"),
            "profile_url": stats.get("profile_url", links.get(name)),
            "stats_current": name in fresh,
        }
        if stats.get("photo_url"):
            row.update(photo_url=stats["photo_url"], photo_source_url=stats["photo_source_url"])
        players.append(row)
    available = sum(row["league_games"] is not None for row in players)
    updated_stats = {
        "season": 2026,
        "competition": "Открытый чемпионат Республики Крым",
        "source_url": LEAGUE_URL,
        "verified": bool(fresh),
        "stats_as_of": now if fresh else previous_timestamp,
        "fresh_players": len(fresh),
        "available_players": available,
        "players": players,
    }
    # Preserve all existing unrelated keys exactly, including all match data.
    data["player_stats_2026"] = updated_stats
    atomic_json(DATA_FILE, data)
    # Always save last confirmed per-player values; never cache missing stats.
    atomic_json(CACHE_FILE, updated_stats)
    print(f"Сезон 2026: в составе {len(roster)}; проверено сейчас {len(fresh)}; "
          f"подтверждённые значения есть у {available}; "
          f"неполученные значения показаны прочерком")


if __name__ == "__main__":
    main()
