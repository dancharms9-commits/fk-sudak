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


def parse_match_lineups(info):
    """Optional official team sheets; never infer starters from events."""
    lineups = {}
    for selector, side in ((".players_list > .team_1", "home"),
                           (".players_list > .team_2", "away")):
        columns = info.select(selector)
        if len(columns) != 1:
            continue
        groups, seen, invalid = {}, set(), False
        for head in columns[0].select(".players_list_head"):
            group = {"Стартовый состав": "starters", "Запасные": "substitutes"}.get(txt(head))
            if not group:
                continue  # Coaches / representatives are not playing lineups.
            listing = head.find_next_sibling("div", class_="list")
            if group in groups or listing is None:
                invalid = True
                break
            entries = []
            for row in listing.select(".player"):
                link, number = row.select_one("a.name"), row.select_one(".number")
                url = urljoin(BASE, link.get("href", "")) if link else ""
                parsed = urlparse(url)
                if (not link or not txt(link) or parsed.scheme != "https"
                        or parsed.netloc != "rffk-roo.ru" or parsed.query or parsed.fragment
                        or not re.fullmatch(r"/players/\d+/", parsed.path) or url in seen):
                    invalid = True
                    break
                seen.add(url)
                value = txt(number) if number else ""
                entries.append({"name": txt(link), "profile_url": url,
                                "number": int(value) if value.isdigit() and 0 <= int(value) <= 99 else None})
            groups[group] = entries
        if not invalid and groups:
            lineups[side] = groups
    return lineups


def parse_match_events(info, goals):
    """Keep source order at equal minutes. Never invent substitution pairs."""
    types = {"icon_1": "goal", "icon_2": "own_goal", "icon_3": "penalty",
             "icon_4": "missed_penalty", "icon_5": "yellow", "icon_6": "second_yellow",
             "icon_7": "red", "icon_8": "substitution", "icon_9": "substitution_out",
             "icon_10": "substitution_in"}
    remaining = list(goals)
    events, complete = [], True
    for item in info.select(".timeline .list .item"):
        clock = item.select_one(".time")
        parts = minute_parts(txt(clock)) if clock else None
        for selector, side in ((".team1", "home"), (".team2", "away")):
            column = item.select_one(selector)
            if column is None:
                continue
            icons = set(column.get("class", [])).intersection(types)
            if not txt(column) and not icons:
                continue
            if len(icons) != 1 or parts is None or not txt(column):
                complete = False
                continue
            event_type = types[next(iter(icons))]
            minute = str(parts[0]) + (f"+{parts[1]}" if parts[1] else "")
            event = {"side": side, "player": txt(column), "minute": minute, "type": event_type}
            if event_type in {"goal", "penalty", "own_goal"}:
                matches = [g for g in remaining if g["type"] == event_type
                           and g["player"] == event["player"] and g["minute"] == minute
                           and (g["side"] == side or event_type == "own_goal")]
                if not matches:
                    complete = False
                    continue
                goal = matches[0]
                remaining.remove(goal)
                event = dict(goal)  # Existing credited side and running score are authoritative.
            events.append(event)
    events.sort(key=lambda event: minute_parts(event["minute"]))
    return events, complete and not remaining


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
    events, events_complete = parse_match_events(info, goals)
    result = {"goals": goals, "venue": clean_venue(txt(place)) if place else "",
              "time": time_hit[0] if time_hit else "", "events": events,
              "events_complete": events_complete}
    lineups = parse_match_lineups(info)
    if lineups:
        result["lineups"] = lineups
    for selector, field in ((".head .champ_name", "competition"), (".head .tour", "round")):
        element = info.select_one(selector)
        if element is not None and txt(element):
            result[field] = txt(element)
    return result


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


def preserve_player_enrichment(stats, previous, team_page, played, team_goals, leaderboard_current=False):
    """Keep all 41 profile IDs/photos even for players without season metrics."""
    from update_player_stats import player_profile_urls, safe_player_url, safe_photo_url, valid_stat_fields
    old_players = {p["name"]: p for p in previous.get("players", []) if isinstance(p, dict) and p.get("name")}
    links = player_profile_urls(team_page, {p["name"] for p in stats["players"]})
    for player in stats["players"]:
        old = old_players.get(player["name"], {})
        source = links.get(player["name"]) or safe_player_url(old.get("profile_url", ""))
        same_person = source and source == old.get("profile_url")
        current = {k: v for k, v in player.items() if k.startswith("league_")}
        fresh = leaderboard_current and current.get("league_games") is not None
        checked = valid_stat_fields(old, played, team_goals) if same_person else None
        if checked:
            player.update(checked)
            if fresh:
                player.update(current)
                if current.get("league_games") != checked.get("league_games"):
                    player.pop("league_starts", None)
                    player.pop("league_substitutions", None)
        if source:
            player["profile_url"] = source
        if same_person and old.get("photo_source_url") == source and safe_photo_url(old.get("photo_url")):
            player.update(photo_url=old["photo_url"], photo_source_url=source)
        player["stats_current"] = fresh
        player["leaderboard_current"] = fresh
    return stats


def official_season_path(soup):
    """Pin the requested season even when /tournaments/4/ moves to a new year."""
    for link in soup.select('a[href*="/tournaments/4/seasons/"]'):
        url = urlparse(urljoin(BASE, link.get("href", "")))
        if (url.netloc == "rffk-roo.ru" and re.fullmatch(r"/tournaments/4/seasons/\d+/", url.path)
                and re.search(r"(?<!\d)2026/2026(?!\d)", txt(link))):
            return url.path
    raise ValueError("Не найдена официальная страница сезона 2026")


def check_league_season(soup):
    heading = soup.select_one(".team_top_title .city") or soup.find("h1")
    if heading is None or not re.search(r"Сезон\s+2026/2026\b", txt(heading)):
        raise ValueError("Неверный сезон чемпионата")


def optional_int(el):
    value = txt(el) if el else ""
    return int(value) if value.isdigit() else None


def official_logo(el):
    if el is None:
        return None
    url = urljoin(BASE, el.get("src", ""))
    parsed = urlparse(url)
    return url if (parsed.scheme == "https" and parsed.netloc == "rffk-roo.ru"
                   and re.fullmatch(r"/uploads/clubs/(?:small|medium|large)/[\w.-]+", parsed.path)
                   and not parsed.query and not parsed.fragment) else None


def parse_championship_calendar(soup):
    """Read explicit round/team/result attributes, never news or date heuristics."""
    check_league_season(soup)
    calendar = soup.select_one(".champ_data_calendar .tour_calendar")
    if calendar is None:
        raise ValueError("Отсутствует полный календарь")
    teams, rounds, matches = {}, [], {}
    for group in calendar.select(".list > [data-id]"):
        round_id = group.get("data-id", "")
        if not round_id.isdigit() or any(r["id"] == round_id for r in rounds):
            raise ValueError("Некорректный идентификатор тура")
        head = group.select_one(".block_title .name")
        rounds.append({"id": round_id, "name": txt(head) if head else f"Тур {round_id}"})
        for card in group.select("[data-team1][data-team2]"):
            ids = [card.get("data-team1"), card.get("data-team2")]
            if not all(i and i.isdigit() for i in ids) or ids[0] == ids[1]:
                raise ValueError("Некорректные команды матча")
            for team_id, selector in zip(ids, (".logo_home", ".logo_guest")):
                box = card.select_one(selector)
                link = box.select_one('a[href*="/teams/"]') if box else None
                if link is None or str(tid(link)) != team_id:
                    raise ValueError("Идентификатор команды не совпал")
                team = {"id": team_id, "name": txt(link) or None,
                        "source_url": f"{BASE}/teams/{team_id}/",
                        "logo_url": official_logo(box.select_one("img"))}
                old = teams.get(team_id)
                if old and old["name"] and team["name"] and old["name"] != team["name"]:
                    raise ValueError("Противоречивые названия команд")
                teams[team_id] = {k: v or (old or {}).get(k) for k, v in team.items()}
            date_box = card.select_one(".score .date")
            raw = txt(date_box) if date_box else ""
            hit = DATE.search(raw)
            date = datetime.datetime.strptime(hit[0], "%d.%m.%Y").date() if hit else None
            if date and date.year != SEASON_YEAR:
                raise ValueError("Дата матча вне сезона")
            clock = re.search(r"\b([01]\d|2[0-3]):[0-5]\d\b", raw)
            label = DATE.sub("", raw)
            label = re.sub(r"\b\d{2}:\d{2}\b", "", label).strip(" ,—–-")
            status = "finished" if card.get("data-end") == "1" else "scheduled"
            for pattern, code in ((r"тех", "technical"), (r"перен", "postponed"),
                                  (r"отмен", "cancelled"), (r"приостан|прерван", "suspended")):
                if re.search(pattern, label, re.I):
                    status = code
                    break
            scores = [optional_int(card.select_one(".score ." + key)) for key in ("first", "second")]
            # data-end=0 sometimes has placeholders. A lone score is incomplete.
            if status not in {"finished", "technical"} or None in scores:
                scores = [None, None]
            urls = {safe_match_url(a.get("href")) for a in card.select('a[href*="/matches/"]')} - {""}
            if len(urls) > 1:
                raise ValueError("Неоднозначный протокол")
            source_url = next(iter(urls), None)
            source_id = source_url.rstrip("/").rsplit("/", 1)[-1] if source_url else None
            # Upcoming/deleted source records have no match URL. Team IDs + round
            # remain stable through reschedules and are also kept after publication.
            key = f"4:2026:{round_id}:{ids[0]}:{ids[1]}"
            venue_box = card.select_one(".dop_info .left")
            venue = re.sub(r"^Стадион\s*:?\s*", "", txt(venue_box), flags=re.I) if venue_box else ""
            match = {"id": key, "source_id": source_id, "source_url": source_url,
                     "round_id": round_id, "home_id": ids[0], "away_id": ids[1],
                     "date": date.isoformat() if date else None,
                     "time": clock[0] if clock else None, "venue": clean_venue(venue) or None,
                     "home_score": scores[0], "away_score": scores[1],
                     "status": status, "status_label": label or None}
            if key in matches and matches[key] != match:
                raise ValueError("Конфликтующие дубликаты матча")
            matches[key] = match
    if not rounds or not matches or str(TEAM) not in teams:
        raise ValueError("Пустой или неполный календарь")
    # The full calendar omits a protocol URL for some technical matches while
    # the current-round teaser publishes it. Join by round + exact team IDs,
    # scores and date; the teaser never creates another match or changes status.
    by_name = {norm_team(t["name"]): t["id"] for t in teams.values() if t["name"]}
    for card in soup.select("a.matches_calendar_line[href]"):
        parent = card.find_parent(class_="up_container")
        head = parent.select_one('.current_tur[data-cid="4"][data-id]') if parent else None
        names = [txt(el) for el in card.select(".team_name")]
        if head is None or len(names) != 2:
            continue
        home, away = [by_name.get(norm_team(name)) for name in names]
        key = f"4:2026:{head['data-id']}:{home}:{away}"
        match = matches.get(key)
        url = safe_match_url(card.get("href"))
        scores = [optional_int(card.select_one(".score ." + k)) for k in ("first", "second")]
        clock = card.select_one(".date")
        hit = DATE.search(txt(clock)) if clock else None
        date = datetime.datetime.strptime(hit[0], "%d.%m.%Y").date().isoformat() if hit else None
        if (match and not match["source_id"] and url and date == match["date"]
                and scores == [match["home_score"], match["away_score"]]):
            match.update(source_url=url, source_id=url.rstrip("/").rsplit("/", 1)[-1])
    source_ids = [m["source_id"] for m in matches.values() if m["source_id"]]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("Протокол повторяется в разных турах")
    return {"teams": list(teams.values()), "rounds": rounds, "matches": list(matches.values())}


def parse_championship_scorers(soup, teams):
    check_league_season(soup)
    section = soup.select_one(".champ_data_top_scorers .tour_table.players")
    if section is None:
        raise ValueError("Отсутствует полный список бомбардиров")
    by_name = {norm_team(t["name"]): t["id"] for t in teams if t.get("name")}
    players, seen, previous_goals, previous_rank = [], set(), None, 0
    for row in section.select(".line"):
        link = row.select_one('.name a[href*="/players/"]')
        url = urlparse(urljoin(BASE, link.get("href", ""))) if link else None
        if (url is None or url.netloc != "rffk-roo.ru" or url.scheme != "https"
                or not re.fullmatch(r"/players/\d+/", url.path) or url.query or url.fragment):
            raise ValueError("Неверная личность бомбардира")
        player_id = url.path.split("/")[2]
        surname, name, team = [row.select_one("." + c) for c in
                               ("player_lastname", "player_name", "player_position")]
        numbers = [optional_int(row.select_one(f'[data-col="{i}"]')) for i in (1, 2, 3, 4)]
        goals, penalties, games, minutes = numbers
        rank = optional_int(row.select_one(".place"))
        team_name = txt(team) if team else ""
        team_id = by_name.get(norm_team(team_name))
        if (not surname or not name or not txt(surname) or not txt(name) or not team_id
                or goals is None or games is None or rank is None or rank < 1
                or (penalties is not None and penalties > goals)
                or (minutes is not None and minutes > games * 120)
                or (previous_goals is not None and goals > previous_goals)
                or rank < previous_rank or (rank == previous_rank and goals != previous_goals)
                or (player_id, team_id) in seen):
            raise ValueError("Неполный или противоречивый рейтинг")
        seen.add((player_id, team_id))
        previous_goals, previous_rank = goals, rank
        players.append({"id": player_id, "rank": rank, "name": txt(surname) + " " + txt(name),
                        "team_id": team_id, "team_name": team_name, "games": games,
                        "goals": goals, "penalty_goals": penalties, "minutes": minutes,
                        "source_url": url.geturl()})
    if not players:
        raise ValueError("Пустой список бомбардиров")
    # No pagination or load-more exists in this section (GetGoalers returns only
    # the ten-player teaser). Never claim that absent players have zero goals.
    return {"players": players, "coverage": "published_list"}


def update_championship(previous=None, loader=None, club_details=None):
    """Independent last-good snapshots: a failed section cannot erase another."""
    import copy
    loader = loader or get
    hub = copy.deepcopy(previous) if isinstance(previous, dict) and previous.get("season") == 2026 else {}
    hub.update(season=2026, competition_id="4", source_url=LEAGUE_URL)
    try:
        page = loader(LEAGUE_PATH)
        path = official_season_path(page)
        page = loader(path)
    except (requests.RequestException, ValueError, TypeError) as exc:
        for name in ("calendar", "scorers"):
            hub.setdefault(name, {})["stale"] = True
        print(f"Чемпионат: источник недоступен ({type(exc).__name__}); сохранены прежние данные")
        return hub
    source = urljoin(BASE, path)
    for name in ("calendar", "scorers"):
        try:
            if name == "calendar":
                parsed = parse_championship_calendar(page)
                # Catch truncated responses while allowing empty newly announced rounds.
                old = hub.get(name, {})
                old_ids = {r["id"] for r in old.get("rounds", [])}
                if not old_ids.issubset({r["id"] for r in parsed["rounds"]}):
                    raise ValueError("Ответ потерял опубликованные туры")
                if len(parsed["matches"]) < len(old.get("matches", [])):
                    raise ValueError("Ответ потерял опубликованные матчи")
            else:
                parsed = parse_championship_scorers(page, hub.get("calendar", {}).get("teams", []))
                if len(parsed["players"]) < len(hub.get(name, {}).get("players", [])):
                    raise ValueError("Ответ потерял часть рейтинга")
            hub[name] = {**parsed, "source_url": source,
                         "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                         "stale": False}
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            hub.setdefault(name, {})["stale"] = True
            print(f"Чемпионат, {name}: {exc}; сохранены прежние данные")
    # Strict source IDs join the two calendars. No opponent/date-only guesswork.
    details_by_id = {str(d["id"]): (key, d) for key, d in (club_details or {}).items() if d.get("id")}
    for match in hub.get("calendar", {}).get("matches", []):
        match.pop("club_match_key", None)
        entry = details_by_id.get(match.get("source_id"))
        if entry and str(TEAM) in (match["home_id"], match["away_id"]):
            key, detail = entry
            if (detail.get("status") == "available" and detail.get("date") == match["date"]
                    and [detail.get("home_score"), detail.get("away_score")] == [match["home_score"], match["away_score"]]):
                match["club_match_key"] = key
    return hub


def update_club_data():
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
    try:
        previous = json.loads(open("data.json", encoding="utf-8").read())
    except (OSError, ValueError):
        previous = {}
    preserve_player_enrichment(player_stats, previous.get("player_stats_2026", {}), soup,
                               played or len(res), int(next(row[2].split("–")[0]
                               for row in table if norm_team(row[0]) == "фк судак")),
                               leaderboard_current=league_verified)
    print(f"Статистика чемпионата 2026: подтверждено {len(league_stats)} игроков")

    match_details = load_match_details(res, match_refs)
    for key, detail in match_details.items():
        old = previous.get("match_details", {}).get(key, {})
        if (detail.get("status") != "available" and old.get("status") == "available"
                and all(detail.get(k) == old.get(k) for k in
                        ("id", "date", "home", "away", "home_score", "away_score"))):
            match_details[key] = old
    print(f"Протоколы матчей: {sum(d['status'] == 'available' for d in match_details.values())}/{len(res)}")

    championship = update_championship(previous.get("championship"), club_details=match_details)
    data = {
        "championship": championship,
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


def main():
    try:
        update_club_data()
    except (requests.RequestException, ValueError, TypeError, KeyError, AttributeError, SystemExit) as exc:
        print(f"Клубный раздел: {exc}; пробуем независимо обновить чемпионат")
        try:
            with open("data.json", encoding="utf-8") as src:
                data = json.load(src)
        except (OSError, ValueError):
            raise SystemExit("Нет сохранённых клубных данных") from exc
        hub = update_championship(data.get("championship"), club_details=data.get("match_details"))
        data["championship"] = hub
        data["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        with open("data.json.tmp", "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=1)
        os.replace("data.json.tmp", "data.json")


if __name__ == "__main__":
    main()
