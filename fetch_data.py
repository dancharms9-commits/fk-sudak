"""Данные ФК «Судак» с rffk-roo.ru -> data.json для PWA.

Для страниц федерации, где таблица и состав могут быть сделаны из div,
а не из стандартных HTML-таблиц. Схема data.json сохранена.
"""
import datetime
import json
import os
import re
import sys

import requests
from bs4 import BeautifulSoup

BASE = "https://rffk-roo.ru"
TEAM = 141
MONTHS = "января февраля марта апреля мая июня июля августа сентября октября ноября декабря".split()
GROUPS = {
    "Вратарь": "Вратари",
    "Защитник": "Защитники",
    "Полузащитник": "Полузащитники",
    "Нападающий": "Нападающие",
}
DATE = re.compile(r"\d{2}\.\d{2}\.\d{4}")


def get(path):
    response = requests.get(
        BASE + path,
        timeout=30,
        headers={"User-Agent": "Mozilla/5.0 (compatible; FKSudakPWA/1.1)"},
    )
    response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def txt(el):
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()


def tid(a):
    match = re.search(r"/teams/(\d+)", a.get("href", ""))
    return int(match.group(1)) if match else None


def human(date):
    if not date:
        return "дата уточняется"
    day, month, _ = date.split(".")
    return f"{int(day)} {MONTHS[int(month) - 1]}"


def parse_matches(soup):
    seen, results, upcoming = set(), [], []
    for a in soup.select(f'a[href*="/teams/{TEAM}"]'):
        box = a
        while box.parent and len({tid(x) for x in box.select('a[href*="/teams/"]') if tid(x)}) < 2:
            box = box.parent
        links = [x for x in box.select('a[href*="/teams/"]') if tid(x)]
        ids = {tid(x) for x in links}
        if len(ids) != 2 or TEAM not in ids or id(box) in seen:
            continue
        seen.add(id(box))
        home, away = links[0], links[-1]
        text = txt(box)
        score = re.search(r"(\d+)\s+(\d{2}\.\d{2}\.\d{4})(?:\s+\d{2}:\d{2})?\s+(\d+)", text)
        venue = re.search(r"Стадион\s+.+?(?=\s*Подробности|$)", text)
        venue = venue.group(0).replace("Стадион", "", 1).strip() if venue else ""
        home_match = tid(home) == TEAM
        opponent = txt(away if home_match else home)
        where = "дома" if home_match else "в гостях"
        if score:
            h, date, a_goals = score.groups()
            ours, theirs = (int(h), int(a_goals)) if home_match else (int(a_goals), int(h))
            results.append((date, [human(date), opponent, ours, theirs, venue, where]))
        else:
            date_match = DATE.search(text)
            date = date_match.group(0) if date_match else None
            upcoming.append((date, [human(date), opponent, venue, where]))
    key = lambda item: tuple(reversed((item[0] or "99.99.9999").split(".")))
    results.sort(key=key, reverse=True)
    upcoming.sort(key=key)
    return [record for _, record in results], [record for _, record in upcoming]


# «1 СК «Каштан» 16 90-21 48» — работает и для div, и для table.
TABLE_ROW = re.compile(
    r"(?<!\S)(\d{1,2})\s+(.{2,70}?)\s+(\d{1,3})\s+"
    r"(\d{1,3}\s*[-–]\s*\d{1,3})\s+(\d{1,3})(?=\s|$)"
)


def parse_table(soup):
    # Сначала стандартные HTML-таблицы (если федерация их вернёт).
    for table in soup.find_all("table"):
        rows = []
        for tr in table.find_all("tr"):
            cells = [txt(td) for td in tr.find_all("td")]
            if (
                len(cells) >= 5
                and tr.select_one('a[href*="/teams/"]')
                and cells[0].isdigit()
                and cells[2].isdigit()
                and cells[4].isdigit()
            ):
                rows.append([cells[1], int(cells[2]), cells[3].replace("-", "–"), int(cells[4])])
        if len(rows) >= 5:
            return rows

    # Главная поправка: таблица может быть набором div, но текст сохраняет порядок.
    page_text = txt(soup)
    if "Таблица" not in page_text:
        return []
    section = page_text.split("Таблица", 1)[1].split("Бомбардиры", 1)[0]
    rows = []
    for rank, name, played, goals, points in TABLE_ROW.findall(section):
        if int(rank) != len(rows) + 1:
            continue
        rows.append([name.strip(), int(played), re.sub(r"\s*[-–]\s*", "–", goals), int(points)])
    return rows


# «Абидов Руслан 30.01.1990 Защитник 37 26.03.2026».
# Даты применяются только при чтении: в data.json они не записываются.
PLAYER_ROW = re.compile(
    r"(?<!\S)(?:-\s+)?([А-ЯЁ][А-ЯЁа-яё-]+\s+[А-ЯЁ][А-ЯЁа-яё-]+)\s+"
    r"\d{2}\.\d{2}\.\d{4}\s+"
    r"(Вратарь|Защитник|Полузащитник|Нападающий)\s+"
    r"(\d{1,3})(?=\s|$)"
)


def parse_squad(soup):
    page_text = txt(soup)
    squad = {}
    coach = ""

    if "Состав команды" in page_text:
        section = page_text.split("Состав команды", 1)[1]
        section = section.split("Календарь матчей", 1)[0]
        section = section.split("Сыгранные матчи", 1)[0]
        for name, position, games in PLAYER_ROW.findall(section):
            player = f"{name}|{int(games)}"
            group = squad.setdefault(GROUPS[position], [])
            if player not in group:
                group.append(player)

    # Запасной способ на случай возврата обычных HTML-таблиц.
    if not squad:
        for tr in soup.find_all("tr"):
            link = tr.select_one('a[href*="/players/"]')
            cells = [txt(td) for td in tr.find_all("td")]
            if not link or not cells:
                continue
            position = next((cell for cell in cells if cell in GROUPS), None)
            if position:
                index = cells.index(position)
                games = cells[index + 1] if index + 1 < len(cells) and cells[index + 1].isdigit() else "0"
                squad.setdefault(GROUPS[position], []).append(f"{txt(link)}|{games}")

    if "Информация о команде" in page_text:
        about = page_text.rsplit("Информация о команде", 1)[1]
        found = re.search(
            r"([А-ЯЁ][А-ЯЁа-яё-]+\s+[А-ЯЁ][А-ЯЁа-яё-]+)\s+"
            r"\d{2}\.\d{2}\.\d{4}\s+Главный тренер", about
        )
        if found:
            coach = found.group(1)

    for group in squad.values():
        group.sort(key=lambda value: -int(value.rsplit("|", 1)[1]))
    return squad, coach


def parse_news(soup):
    seen, items = set(), []
    for link in soup.select('a[href*="/news/"]'):
        match = re.search(r"/news/(\d+)/?$", link.get("href", ""))
        title = txt(link)
        if not match or match.group(1) in seen or len(title) < 8:
            continue
        seen.add(match.group(1))
        box = link
        match_date = None
        for _ in range(4):
            if not box.parent:
                break
            box = box.parent
            match_date = DATE.search(txt(box))
            if match_date:
                break
        items.append([human(match_date.group(0)) if match_date else "", title, ""])
    return items[:6]


def main():
    soup = get(f"/teams/{TEAM}/")
    results, upcoming = parse_matches(soup)
    table = parse_table(soup)
    squad, coach = parse_squad(soup)
    count = sum(map(len, squad.values()))
    print(f"Найдено: таблица={len(table)}, матчи={len(results)}, состав={count}, тренер={coach or 'не указан'}")
    if len(table) < 5 or len(results) < 3 or count < 10:
        sys.exit("Ошибка чтения страницы: data.json сохранён без изменений")

    data = {
        "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"),
        "table": table,
        "res": results,
        "next": upcoming,
        "squad": squad,
        "coach": coach,
        "news": parse_news(soup),
    }
    with open("data.json.tmp", "w", encoding="utf-8") as output:
        json.dump(data, output, ensure_ascii=False, indent=1)
    os.replace("data.json.tmp", "data.json")
    print("Успешно: data.json обновлён")


if __name__ == "__main__":
    main()
