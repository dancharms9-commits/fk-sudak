"""Забирает данные ФК «Судак» с rffk-roo.ru и пишет data.json."""
import re, json, sys, datetime, requests
from bs4 import BeautifulSoup

BASE, TEAM = "https://rffk-roo.ru", 141
MONTHS = "января февраля марта апреля мая июня июля августа сентября октября ноября декабря".split()
GROUPS = {"Вратарь": "Вратари", "Защитник": "Защитники", "Полузащитник": "Полузащитники", "Нападающий": "Нападающие"}
DATE = re.compile(r"\d{2}\.\d{2}\.\d{4}")

def get(path):
    r = requests.get(BASE + path, timeout=30, headers={"User-Agent": "fk-sudak-app/1.0"})
    r.raise_for_status()
    return BeautifulSoup(r.text, "html.parser")

def txt(el): return re.sub(r"\s+", " ", el.get_text(" ")).strip()
def tid(a):
    m = re.search(r"/teams/(\d+)", a.get("href", ""))
    return int(m.group(1)) if m else None
def human(d):
    if not d: return "дата уточняется"
    dd, mm, _ = d.split(".")
    return f"{int(dd)} {MONTHS[int(mm) - 1]}"

def parse_matches(soup):
    seen, res, nxt = set(), [], []
    for a in soup.select('a[href*="/teams/%d"]' % TEAM):
        box = a
        while box.parent and len({tid(x) for x in box.select('a[href*="/teams/"]') if tid(x)}) < 2:
            box = box.parent
        links = [x for x in box.select('a[href*="/teams/"]') if tid(x)]
        ids = {tid(x) for x in links}
        if len(ids) != 2 or TEAM not in ids or id(box) in seen: continue
        seen.add(id(box))
        home, away = links[0], links[-1]
        t = txt(box)
        sc = re.search(r"(\d+)\s+(\d{2}\.\d{2}\.\d{4})(?:\s+\d{2}:\d{2})?\s+(\d+)", t)
        ven = re.search(r"Стадион\s.+?(?=\s*Подробности|$)", t)
        ven = ven.group(0).replace("Стадион", "").strip() if ven else ""
        us_home = tid(home) == TEAM
        opp = txt(away if us_home else home)
        where = "дома" if us_home else "в гостях"
        if sc:
            g1, d, g2 = sc.group(1), sc.group(2), sc.group(3)
            our, their = (int(g1), int(g2)) if us_home else (int(g2), int(g1))
            res.append((d, [human(d), opp, our, their, ven, where]))
        else:
            d = (DATE.search(t) or [None])[0]
            nxt.append((d, [human(d), opp, ven, where]))
    key = lambda x: (x[0] or "99.99.9999").split(".")[::-1]
    res.sort(key=lambda x: x[0].split(".")[::-1], reverse=True)
    nxt.sort(key=key)
    return [r for _, r in res], [n for _, n in nxt]

def parse_table(soup):
    for tb in soup.find_all("table"):
        rows = []
        for tr in tb.find_all("tr"):
            c = [txt(td) for td in tr.find_all("td")]
            if len(c) >= 5 and tr.select_one('a[href*="/teams/"]') and c[0].isdigit():
                rows.append([c[1], int(c[2]), c[3].replace("-", "–"), int(c[4])])
        if len(rows) >= 5: return rows
    return []

def parse_squad(soup):
    out, coach = {}, ""
    for tr in soup.find_all("tr"):
        a = tr.select_one('a[href*="/players/"][class], a[href*="/players/"]')
        cells = [txt(td) for td in tr.find_all("td")]
        if not a or not cells: continue
        name = [x for x in (txt(l) for l in tr.select('a[href*="/players/"]')) if x][0]
        pos = next((c for c in cells if c in GROUPS), None)
        if pos:
            i = cells.index(pos)
            games = cells[i + 1] if i + 1 < len(cells) and cells[i + 1].isdigit() else "0"
            out.setdefault(GROUPS[pos], []).append(f"{name}|{games}")
        elif "Главный тренер" in cells: coach = name
    for k in out: out[k].sort(key=lambda s: -int(s.split("|")[1]))
    return out, coach

def parse_news(soup):
    seen, out = set(), []
    for a in soup.select('a[href*="/news/"]'):
        m = re.search(r"/news/(\d+)/$", a["href"])
        title = txt(a)
        if not m or m.group(1) in seen or len(title) < 8: continue
        seen.add(m.group(1))
        box, d = a, None
        for _ in range(4):
            box = box.parent
            d = DATE.search(txt(box))
            if d: break
        out.append([human(d[0]) if d else "", title, ""])
    return out[:6]

soup = get(f"/teams/{TEAM}/")
results, upcoming = parse_matches(soup)
table, (squad, coach) = parse_table(soup), parse_squad(soup)
data = {"updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"),
        "table": table, "res": results, "next": upcoming, "squad": squad, "coach": coach, "news": parse_news(soup)}
if len(table) < 5 or len(results) < 3 or sum(map(len, squad.values())) < 10:
    sys.exit(f"Разметка сайта изменилась: таблица={len(table)}, матчи={len(results)}, состав={sum(map(len, squad.values()))}. data.json не тронут.")
json.dump(data, open("data.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("ok", len(results), "матчей,", len(table), "команд в таблице")
