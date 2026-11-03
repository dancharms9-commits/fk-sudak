"""Данные PWA ФК «Судак»: открытый чемпионат Республики Крым, сезон 2026.

Сохраняем схему data.json (table/res/next/squad/coach/news), включая ссылки
на новости. Не перезаписываем рабочий файл при неполных данных федерации.
"""
import datetime
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE = "https://rffk-roo.ru"
TEAM = 141
SEASON_YEAR = 2026
LEAGUE_PATH = "/tournaments/4/"
LEAGUE_URL = BASE + LEAGUE_PATH
MONTHS = "января февраля марта апреля мая июня июля августа сентября октября ноября декабря".split()
GROUPS = {
    "Вратарь": "Вратари",
    "Защитник": "Защитники",
    "Полузащитник": "Полузащитники",
    "Нападающий": "Нападающие",
}
DATE = re.compile(r"\b\d{2}\.\d{2}\.\d{4}\b")
PLAYER_ROW = re.compile(
    r"(?<!\S)(?:-\s+)?([А-ЯЁ][А-ЯЁа-яё-]+\s+[А-ЯЁ][А-ЯЁа-яё-]+)\s+"
    r"\d{2}\.\d{2}\.\d{4}\s+"
    r"(Вратарь|Защитник|Полузащитник|Нападающий)\s+"
    r"(\d{1,3})(?=\s|$)"
)
TABLE_ROW = re.compile(
    r"(?<!\S)(\d{1,2})\s+(.{2,70}?)\s+(\d{1,3})\s+"
    r"(\d{1,3}\s*[-–]\s*\d{1,3})\s+(\d{1,3})(?=\s|$)"
)


def get(path):
    response = requests.get(
        urljoin(BASE, path), timeout=30,
        headers={"User-Agent": "Mozilla/5.0 (compatible; FKSudakPWA/1.3)"},
    )
    response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def txt(el):
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()


def tid(link):
    match = re.search(r"/teams/(\d+)(?:/|$)", link.get("href", ""))
    return int(match.group(1)) if match else None


def human(value):
    if not value:
        return "дата уточняется"
    try:
        date = datetime.datetime.strptime(value, "%d.%m.%Y")
        return f"{date.day} {MONTHS[date.month - 1]}"
    except ValueError:
        return "дата уточняется"


def norm_team(name):
    return re.sub(r"\s+", " ", re.sub(r'[«»"“”]', "", name)).strip().casefold()


def parse_table(soup):
    """Считываем именно таблицу чемпионата, а не соседний турнир 8×8."""
    for table in soup.find_all("table"):
        rows = []
        for tr in table.find_all("tr"):
            cells = [txt(td) for td in tr.find_all("td")]
            if (len(cells) >= 5 and tr.select_one('a[href*="/teams/"]')
                    and cells[0].isdigit() and cells[2].isdigit() and cells[4].isdigit()):
                rows.append([cells[1], int(cells[2]), cells[3].replace("-", "–"), int(cells[4])])
        if len(rows) >= 5 and any(norm_team(row[0]) == "фк судак" for row in rows):
            return rows

    page_text = txt(soup)
    if "Таблица" not in page_text:
        return []
    section = page_text.split("Таблица", 1)[1].split("Бомбардиры", 1)[0]
    rows = []
    for rank, name, games, goals, points in TABLE_ROW.findall(section):
        if int(rank) != len(rows) + 1:
            continue
        rows.append([name.strip(), int(games), re.sub(r"\s*[-–]\s*", "–", goals), int(points)])
    return rows if any(norm_team(row[0]) == "фк судак" for row in rows) else []


def clean_venue(value):
    """Оставляем только название стадиона, без служебного текста матчей."""
    candidate = re.sub(r"\s+", " ", value).strip(" ,:—–-")
    if (not candidate or len(candidate) > 140 or DATE.search(candidate)
            or candidate in {"-", "Подробности матча"}):
        return ""
    return candidate


def parse_venue(box):
    """Ищем стадион внутри одной карточки матча, если он туда входит."""
    lines = [re.sub(r"\s+", " ", line).strip() for line in box.stripped_strings]
    for i, line in enumerate(lines):
        match = re.match(r"^Стадион\s*:?[\s]*(.*)$", line, re.I)
        if match:
            value = match.group(1).strip(" ,")
            if not value and i + 1 < len(lines):
                value = lines[i + 1].strip()
            value = clean_venue(value)
            if value and "Подробности" not in value:
                return value
    raw = box.get_text("\n", strip=True)
    match = re.search(r"(?:^|\n)\s*Стадион\s*:?[\s]*([^\n]{2,130})", raw, re.I)
    return clean_venue(match.group(1)) if match else ""


def venues_by_date(soup, season_year=SEASON_YEAR):
    """Резервный способ для реальной разметки сайта федерации.

    Название стадиона находится ПОСЛЕ двух команд и даты, но часто в соседнем
    DOM-блоке, за пределами мини-карточки с двумя ссылками /teams/.
    Ищем его по строкам внутри календаря и результатов, не смешивая с другим
    матчем или списком футболистов. Даты без года не используются.
    """
    lines = [re.sub(r"\s+", " ", line).strip() for line in soup.stripped_strings]
    start = next((i for i, line in enumerate(lines) if line == "Календарь матчей"), None)
    if start is None:
        return {}
    found = {}
    # Ограничиваем поиск после даты первым же следующим матчем с датой,
    # завершением карточки результата или 18 строками, чтобы не приписать
    # чужой стадион. Для результатов сайт использует «Подробности матча».
    for i in range(start + 1, len(lines)):
        m = DATE.search(lines[i])
        if not m:
            continue
        raw_date = m.group()
        try:
            value = datetime.datetime.strptime(raw_date, "%d.%m.%Y")
        except ValueError:
            continue
        if value.year != season_year:
            continue
        for j in range(i + 1, min(i + 19, len(lines))):
            line = lines[j]
            if DATE.search(line) or line == "Подробности матча":
                break
            stadium = re.match(r"^Стадион\s*:?\s*(.*)$", line, re.I)
            if not stadium:
                continue
            name = stadium.group(1)
            if not name and j + 1 < len(lines):
                name = lines[j + 1]
            name = clean_venue(name)
            if name and "Подробности" not in name:
                found.setdefault(raw_date, name)
            break
    return found


def match_key(row, season_year=SEASON_YEAR):
    """Stable UI key without changing any of the six legacy result fields."""
    return "|".join((str(season_year), row[0], row[1], row[5]))


def safe_match_url(href):
    url = urljoin(BASE, href or "")
    parsed = urlparse(url)
    return url if (parsed.scheme == "https" and parsed.netloc == "rffk-roo.ru"
                   and re.fullmatch(r"/matches/\d+/?", parsed.path)
                   and not parsed.query and not parsed.fragment) else ""


def parse_matches(soup, allowed_teams, season_year=SEASON_YEAR, today=None, match_refs=None):
    today = today or datetime.datetime.now(
        datetime.timezone(datetime.timedelta(hours=3))
    ).date()
    allowed = {norm_team(name) for name in allowed_teams}
    date_venues = venues_by_date(soup, season_year=season_year)
    seen_boxes, results, upcoming = set(), [], []
    for link in soup.select('a[href*="/teams/"]'):
        if tid(link) != TEAM:
            continue
        box = link
        while box.parent:
            ids = {tid(a) for a in box.select('a[href*="/teams/"]') if tid(a)}
            if len(ids) >= 2:
                break
            box = box.parent
        links = [a for a in box.select('a[href*="/teams/"]') if tid(a)]
        ids = {tid(a) for a in links}
        if len(ids) != 2 or TEAM not in ids or id(box) in seen_boxes:
            continue
        seen_boxes.add(id(box))
        home, away = links[0], links[-1]
        home_match = tid(home) == TEAM
        opponent = txt(away if home_match else home)
        if norm_team(opponent) not in allowed:
            continue
        content = txt(box)
        date_match = DATE.search(content)
        if not date_match:
            continue
        date_str = date_match.group()
        try:
            date = datetime.datetime.strptime(date_str, "%d.%m.%Y").date()
        except ValueError:
            continue
        if date.year != season_year:
            continue
        venue = parse_venue(box) or date_venues.get(date_str, "")
        location = "дома" if home_match else "в гостях"
        score = re.search(r"(\d+)\s+" + re.escape(date_str)
                          + r"(?:\s+\d{2}:\d{2})?\s+(\d+)", content)
        if score:
            home_goals, away_goals = map(int, score.groups())
            ours, theirs = (home_goals, away_goals) if home_match else (away_goals, home_goals)
            row = [human(date_str), opponent, ours, theirs, venue, location]
            results.append((date, row))
            if match_refs is not None:
                # The protocol link is outside .score_line, in the SAME match.
                card = link.find_parent(class_="matches_calendar_line")
                source_links = card.select('a[href*="/matches/"]') if card else []
                urls = {safe_match_url(a.get("href")) for a in source_links} - {""}
                match_refs[match_key(row, season_year)] = {
                    "id": next(iter(urls)).rstrip("/").rsplit("/", 1)[-1] if len(urls) == 1 else None,
                    "source_url": next(iter(urls)) if len(urls) == 1 else "",
                    "date": date.isoformat(),
                    "home": txt(home), "away": txt(away),
                    "home_score": home_goals, "away_score": away_goals,
                }
        elif date >= today:
            upcoming.append((date, [human(date_str), opponent, venue, location]))

    def unique(items):
        stored = {}
        for date, row in items:
            key = (date, norm_team(row[1]), row[-1])
            if key not in stored or (not stored[key][1][-2] and row[-2]):
                stored[key] = (date, row)
        return list(stored.values())

    return ([row for _, row in sorted(unique(results), key=lambda x: x[0], reverse=True)],
            [row for _, row in sorted(unique(upcoming), key=lambda x: x[0])])


def minute_parts(value):
    match = re.fullmatch(r"(\d{1,3})(?:\s*\+\s*(\d{1,2}))?\s*[’′']?", value)
    if not match:
        return None
    minute, added = int(match[1]), int(match[2] or 0)
    if not 1 <= minute <= 120 or added > 30:
        return None
    return minute, added


def parse_match_protocol(soup, expected):
    """Accept only a matching protocol with a complete, consistent goal list.

    РФФК CSS maps icon_1=goal, icon_3=penalty, icon_2=own goal,
    icon_4=missed penalty. Scorer columns identify the credited team (also
    for own goals); never infer the credited side from the player's name.
    """
    info = soup.select_one(".match_info")
    if info is None:
        return None
    names = [txt(el) for el in info.select(".score_line .team_name")]
    scores = [txt(info.select_one(selector)) if info.select_one(selector) else ""
              for selector in (".score .first", ".score .second")]
    date_el = info.select_one(".head .date")
    date_hit = DATE.search(txt(date_el)) if date_el else None
    if (names != [expected["home"], expected["away"]]
            or scores != [str(expected["home_score"]), str(expected["away_score"])]
            or not date_hit or datetime.datetime.strptime(date_hit[0], "%d.%m.%Y").date().isoformat() != expected["date"]):
        return None
    # Verify the tournament and season, not a similarly named cup fixture.
    crumbs = soup.select_one(".breadcrumbs")
    if (not crumbs or not crumbs.select_one(f'a[href="{LEAGUE_URL}"]')
            or not re.search(rf"Сезон\s+{SEASON_YEAR}(?:/{SEASON_YEAR})?\b", txt(crumbs))):
        return None
    columns = info.select(".score_balls .scorers")
    timeline = info.select_one(".timeline .list")
    if len(columns) != 2 or timeline is None:
        return None
    scorers = []
    for side, column in zip(("home", "away"), columns):
        for entry in column.find_all("div", recursive=False):
            fio, minute = entry.select_one(".fio"), entry.select_one(".minute")
            if fio is None or minute is None or not txt(fio) or minute_parts(txt(minute)) is None:
                return None
            scorers.append((side, txt(fio), minute_parts(txt(minute))))
    goals = []
    types = {"icon_1": "goal", "icon_3": "penalty", "icon_2": "own_goal"}
    for item in timeline.select(".item"):
        for column, side in ((".team1", "home"), (".team2", "away")):
            team = item.select_one(column)
            classes = set(team.get("class", [])) if team else set()
            goal_type = classes.intersection(types)
            if not goal_type:
                continue
            minute = item.select_one(".time")
            parts = minute_parts(txt(minute)) if minute else None
            player = txt(team)
            if len(goal_type) != 1 or parts is None or not player:
                return None
            # Own goals can be presented in either column by the source.
            # Use the scorer summary to determine which score increased.
            candidates = [s for s in scorers if s[1:] == (player, parts)
                          and (s[0] == side or "icon_2" in goal_type)]
            if len(candidates) != 1:
                return None
            credited = candidates[0]
            scorers.remove(credited)
            goals.append({"side": credited[0], "player": player,
                          "minute": str(parts[0]) + (f"+{parts[1]}" if parts[1] else ""),
                          "type": types[next(iter(goal_type))], "_order": parts})
    # Missing events / technical results must never become a made-up timeline.
    if scorers or len(goals) != expected["home_score"] + expected["away_score"]:
        return None
    goals.sort(key=lambda goal: goal["_order"])
    running = {"home": 0, "away": 0}
    for goal in goals:
        del goal["_order"]
        running[goal["side"]] += 1
        goal["score"] = [running["home"], running["away"]]
    if [running["home"], running["away"]] != [expected["home_score"], expected["away_score"]]:
        return None
    place = info.select_one(".head .place")
    time_hit = re.search(r"\b\d{2}:\d{2}\b", txt(date_el))
    return {"goals": goals, "venue": clean_venue(txt(place)) if place else "",
            "time": time_hit[0] if time_hit else ""}


def load_match_details(results, refs, loader=None):
    loader = loader or get

    def load(row):
        key = match_key(row)
        ref = refs.get(key, {})
        detail = {**ref, "venue": row[4], "status": "unavailable", "goals": []}
        if ref.get("source_url"):
            try:
                protocol = parse_match_protocol(loader(ref["source_url"]), ref)
                if protocol is not None:
                    detail.update(protocol, status="available")
                    detail["venue"] = protocol["venue"] or row[4]
            except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
                print(f"Протокол {ref.get('id')} недоступен: {type(exc).__name__}")
        return key, detail

    # Optional protocols cannot prevent the main hourly dataset from updating.
    with ThreadPoolExecutor(max_workers=4) as pool:
        return dict(pool.map(load, results))


def parse_squad(soup):
    """Игр = показатель на странице федерации; может включать другие турниры."""
    page_text = txt(soup)
    squad, coach = {}, ""
    if "Состав команды" in page_text:
        section = page_text.split("Состав команды", 1)[1]
        for boundary in ("Календарь матчей", "Сыгранные матчи", "Информация о команде"):
            section = section.split(boundary, 1)[0]
        for name, role, games in PLAYER_ROW.findall(section):
            player = f"{name}|{int(games)}"
            group = squad.setdefault(GROUPS[role], [])
            if player not in group:
                group.append(player)
    if not squad:
        for tr in soup.find_all("tr"):
            link = tr.select_one('a[href*="/players/"]')
            cells = [txt(td) for td in tr.find_all("td")]
            if not link or not cells:
                continue
            role = next((cell for cell in cells if cell in GROUPS), None)
            if role:
                idx = cells.index(role)
                games = cells[idx + 1] if idx + 1 < len(cells) and cells[idx + 1].isdigit() else "0"
                squad.setdefault(GROUPS[role], []).append(f"{txt(link)}|{games}")
    if "Информация о команде" in page_text:
        about = page_text.rsplit("Информация о команде", 1)[1]
        found = re.search(r"([А-ЯЁ][А-ЯЁа-яё-]+\s+[А-ЯЁ][А-ЯЁа-яё-]+)\s+"
                          r"\d{2}\.\d{2}\.\d{4}\s+Главный тренер", about)
        if found:
            coach = found.group(1)
    for group in squad.values():
        group.sort(key=lambda row: -int(row.rsplit("|", 1)[1]))
    return squad, coach



def parse_league_scorers(soup, roster, played, team_goals):
    """Only competition 4, season 2026: games/goals/penalties/minutes.

    The federation has a ten-player teaser and a separate complete leaderboard.
    Read ONLY the complete "Лучшие бомбардиры" section; match an exact club
    and exact roster name. Do not treat absence from the list as zero goals.
    All checks are conservative: an ambiguous page yields no data.
    """
    page = txt(soup)
    if not re.search(r"Сезон\s+2026(?:/2026)?(?=\s|$)", page, re.I):
        return {}
    if "Лучшие бомбардиры" not in page:
        return {}
    section = page.rsplit("Лучшие бомбардиры", 1)[1]
    if not re.search(r"Голов\s+С\s*пен\s+Игр\s+Минут", section[:250], re.I):
        return {}
    # Anchoring on the competition leaderboard, rather than the team card,
    # prevents the all-competitions appearance count being relabelled as 2026.
    stats = {}
    for name in roster:
        pattern = (r"(?<![А-ЯЁа-яё])" + re.escape(name) +
                   r"\s+ФК\s*[«\"]?Судак[»\"]?\s+"
                   r"(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s+(\d{1,5})(?!\d)")
        hits = list(re.finditer(pattern, section, re.I))
        if len(hits) != 1:
            continue
        goals, penalties, games, minutes = map(int, hits[0].groups())
        if not (0 < goals <= team_goals and 0 <= penalties <= goals
                and 1 <= games <= played and 0 <= minutes <= games * 120):
            continue
        stats[name] = {
            "games": games, "goals": goals,
            "penalty_goals": penalties, "minutes": minutes,
        }
    if sum(row["goals"] for row in stats.values()) > team_goals:
        return {}
    return stats


def make_player_stats(squad, league_stats, league_verified, stats_as_of=None):
    """Additive data structure. The legacy squad stays identical."""
    roster = []
    for role, members in squad.items():
        for member in members:
            name, total = member.rsplit("|", 1)
            season = league_stats.get(name, {})
            roster.append({
                "name": name,
                "position": role,
                "federation_games": int(total),
                "league_games": season.get("games"),
                "league_goals": season.get("goals"),
                "league_penalty_goals": season.get("penalty_goals"),
                "league_minutes": season.get("minutes"),
            })
    return {
        "season": SEASON_YEAR,
        "competition": "Открытый чемпионат Республики Крым",
        "source_url": LEAGUE_URL,
        "verified": bool(league_verified),
        "stats_as_of": stats_as_of,
        "players": roster,
    }


def read_previous_stats(path="data.json"):
    """Reuse previously confirmed league stats only if the source is down.

    This avoids replacing verified numbers with unlabelled zeros. If reused,
    the UI displays that the live leaderboard was unavailable this run.
    """
    try:
        with open(path, encoding="utf-8") as src:
            prev = json.load(src).get("player_stats_2026", {})
        if (prev.get("season") != SEASON_YEAR or
                prev.get("source_url") != LEAGUE_URL or
                not isinstance(prev.get("players"), list)):
            return {}, None
        entries = {
            item["name"]: {
                "games": item["league_games"],
                "goals": item["league_goals"],
                "penalty_goals": item["league_penalty_goals"],
                "minutes": item["league_minutes"],
            }
            for item in prev["players"]
            if (isinstance(item, dict) and isinstance(item.get("name"), str)
                and isinstance(item.get("league_games"), int)
                and isinstance(item.get("league_goals"), int)
                and isinstance(item.get("league_penalty_goals"), int)
                and isinstance(item.get("league_minutes"), int))
        }
        return entries, prev.get("stats_as_of")
    except (OSError, TypeError, ValueError, KeyError, AttributeError):
        return {}, None


def safe_news_url(href):
    url = urljoin(BASE, href or "")
    parsed = urlparse(url)
    return url if parsed.scheme == "https" and parsed.netloc == "rffk-roo.ru" \
        and re.match(r"^/news/\d+/?$", parsed.path) else ""


def parse_news(soup, year=SEASON_YEAR, limit=6):
    """Публикации текущего года с прямыми проверяемыми ссылками."""
    news = []
    seen = set()
    for link in soup.select('a[href*="/news/"]'):
        url = safe_news_url(link.get("href", ""))
        title = txt(link)
        if not url or url in seen or len(title) < 8:
            continue
        date = None
        box = link
        for _ in range(5):
            box = box.parent
            if box is None:
                break
            text = txt(box)
            if len(text) > 900:
                break
            match = DATE.search(text)
            if match:
                date = match.group()
                break
        if not date:
            continue
        try:
            published = datetime.datetime.strptime(date, "%d.%m.%Y")
        except ValueError:
            continue
        if published.year != year:
            continue
        seen.add(url)
        news.append((published.date(), [human(date), title, "", url]))
    news.sort(key=lambda item: item[0], reverse=True)
    return [row for _, row in news[:limit]]


def main():
    soup = get(f"/teams/{TEAM}/")
    table = parse_table(soup)
    match_refs = {}
    res, nxt = parse_matches(soup, (row[0] for row in table), match_refs=match_refs)
    squad, coach = parse_squad(soup)
    nplayers = sum(map(len, squad.values()))
    print(f"Сезон {SEASON_YEAR}: команд={len(table)}, сыграно={len(res)}, "
          f"предстоит={len(nxt)}, игроков={nplayers}; "
          f"стадионы: сыгранные={sum(bool(row[4]) for row in res)}, "
          f"предстоящие={sum(bool(row[2]) for row in nxt)}")
    if len(table) < 5 or len(res) < 3 or nplayers < 10:
        sys.exit("Неполный ответ сайта федерации — прежний data.json сохранён")
    played = next((row[1] for row in table if norm_team(row[0]) == "фк судак"), None)
    if played is not None and len(res) > played:
        sys.exit("Найдены лишние матчи: обновление остановлено без изменения data.json")

    try:
        news = parse_news(get("/news/"))
    except requests.RequestException as exc:
        print(f"Новости федерации недоступны: {exc}")
        news = []
    if not news:
        news = parse_news(soup)
    if not news and os.path.exists("data.json"):
        try:
            with open("data.json", encoding="utf-8") as src:
                previous = json.load(src)
            news = [row for row in previous.get("news", []) if len(row) >= 4 and safe_news_url(row[3])]
        except (ValueError, OSError, TypeError):
            pass

    # Standings and player statistics are two separate sources. A failure of
    # the optional leaderboard must never stop calendar/news auto-updates.
    player_names = {item.rsplit("|", 1)[0] for members in squad.values() for item in members}
    league_stats = {}
    league_verified = False
    stats_as_of = None
    try:
        league_page = get(LEAGUE_PATH)
        league_stats = parse_league_scorers(
            league_page, player_names, played or len(res),
            int(next(row[2].split("–")[0] for row in table
                     if norm_team(row[0]) == "фк судак")),
        )
        league_verified = bool(league_stats)
        if league_verified:
            stats_as_of = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes")
    except (requests.RequestException, ValueError, StopIteration) as exc:
        print(f"Статистика чемпионата временно недоступна: {exc}")
    if not league_verified:
        league_stats, stats_as_of = read_previous_stats()
        if league_stats:
            print("Статистика чемпионата: используем последнее подтверждённое значение")
    player_stats = make_player_stats(squad, league_stats, league_verified, stats_as_of)
    print(f"Статистика чемпионата 2026: подтверждено {len(league_stats)} игроков")

    match_details = load_match_details(res, match_refs)
    print(f"Протоколы матчей: {sum(d['status'] == 'available' for d in match_details.values())}/{len(res)}")

    data = {
        "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"),
        "table": table, "res": res, "next": nxt,
        "squad": squad, "coach": coach, "news": news,
        "player_stats_2026": player_stats,
        "match_details": match_details,
    }
    with open("data.json.tmp", "w", encoding="utf-8") as out:
        json.dump(data, out, ensure_ascii=False, indent=1)
    os.replace("data.json.tmp", "data.json")
    print("Успешно: data.json обновлён")


if __name__ == "__main__":
    main()
