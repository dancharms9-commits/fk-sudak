"""Import the independent CFU Premier League 2026 data foundation.

Only three public pages are needed: the official team registry, the full
standings and the calendar (all four circles are embedded in its HTML).
Match pages are parsed only by ``parse_match_page`` for targeted verification;
bulk protocol/status enrichment is deliberately out of scope.

Run from the repository root:

    python -m scripts.cfu_premier_import --output docs/cfu-premier-2026/snapshot.json

The importer sleeps for the crawl delay published in robots.txt between
requests.  It never replaces a valid snapshot after a failed source response.
"""
import argparse
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urljoin

from bs4 import BeautifulSoup
import requests

from scripts.cfu_premier_schema import (
    BASE, CALENDAR_URL, COMPETITION_KEY, COMPETITION_NAME, COMPETITION_URL,
    CRAWL_DELAY_SECONDS, ROBOTS_URL, SEASON, TABLE_URL, TEAMS_URL,
    InvalidCfuData, normalize_name, official_match_number, official_team_slug,
    require, timestamp, validate_snapshot,
)

MONTHS = {
    'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
    'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11,
    'декабря': 12,
}

STATUS_LABELS = {
    'матч завершен': 'finished',
    'матч не состоялся': 'cancelled',
    'матч перенесен': 'postponed',
    'матч приостановлен': 'suspended',
    'матч не начался': 'scheduled',
}

USER_AGENT = 'FKSudakPWA/cfu-premier-data-v1 (+https://github.com/dancharms9-commits/fk-sudak)'


def _section(soup, selector):
    section = soup.select_one(selector)
    require(section is not None, f'Missing page section: {selector}')
    return section


def _require_season(section, season=SEASON):
    title = section.select_one('.sectionTitle')
    require(title is not None, 'Missing section title')
    found = re.findall(r'сезон[а-яё]*\s+(\d{4})', title.get_text(' ', strip=True), re.I)
    require(found == [str(season)], f'Wrong season: {found or "not stated"}')


def _require_title_season(soup, season=SEASON):
    require(soup.title is not None, 'Missing page title')
    found = re.findall(r'сезон[а-яё]*\s+(\d{4})', soup.title.get_text(' ', strip=True), re.I)
    require(found == [str(season)], f'Wrong season: {found or "not stated"}')


def _own_text(element):
    """Text belonging to the element itself, excluding the nested city label."""
    require(element is not None, 'Missing published name')
    text = ' '.join(str(child) for child in element.find_all(string=True, recursive=False))
    return re.sub(r'\s+', ' ', text).strip()


def _parse_date_time(text, season=SEASON):
    if not text:
        return None, None
    match = re.search(
        r'(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s*(?:г\.)?\s*,?\s*(\d{1,2}:\d{2})?',
        text, re.I)
    if match is None:
        return None, None
    month = MONTHS.get(match[2].lower())
    require(month is not None, f'Unknown month: {match[2]}')
    year = int(match[3])
    require(year == season, f'Match date belongs to {year}, not {season}')
    day = date(year, month, int(match[1]))
    published_time = match[4]
    if published_time is not None:
        require(re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', published_time),
                'Invalid match time')
    return day.isoformat(), published_time


def _parse_score(element):
    if element is None:
        return None, None
    text = re.sub(r'\s+', ' ', element.get_text(' ', strip=True))
    if not text or re.fullmatch(r'[-–—:\s]+', text):
        return None, None
    match = re.fullmatch(r'(\d+)\s*:\s*(\d+)', text)
    require(match is not None, f'Malformed score: {text}')
    return int(match[1]), int(match[2])


def parse_teams(html, season=SEASON):
    """Parse the official participant registry, keyed by URL slug."""
    soup = BeautifulSoup(html, 'html.parser')
    section = _section(soup, '.matchesList-teams')
    _require_season(section, season)
    boxes = section.select('.entries-wrapper .entry-box')
    require(boxes, 'Team registry is empty')

    teams = {}
    for box in boxes:
        link = box.select_one('a[href^="/teams/"]')
        require(link is not None, 'Team without official page URL')
        url = urljoin(BASE + '/', link['href'])
        slug = official_team_slug(url)
        require(slug is not None, f'Invalid official team URL: {url}')
        name_element = box.select_one('.entry-title strong')
        city_element = box.select_one('.entry-title small')
        name = name_element.get_text(' ', strip=True) if name_element else ''
        city = city_element.get_text(' ', strip=True) if city_element else None
        require(name, f'Missing team name for {slug}')
        team_id = f'cfu:team:{slug}'
        require(team_id not in teams, f'Duplicate team: {slug}')
        teams[team_id] = {
            'teamId': team_id,
            'provider': 'cfu',
            'sourceTeamId': slug,
            'name': name,
            'city': city,
            'sourceUrl': url,
            'identityConfidence': 'official_team_page',
        }
    return teams


def parse_standings(html, teams, season=SEASON):
    """Parse only the published full-season table, never recompute it."""
    soup = BeautifulSoup(html, 'html.parser')
    section = _section(soup, '.matchesList-table')
    _require_season(section, season)
    container = section.select_one('#tournamentTable_0')
    require(container is not None, 'Missing official standings table')
    selected = section.select_one('div[block-name="matches-table-tour"] li.selected')
    require(selected is not None, 'Missing standings round')
    round_match = re.search(r'(\d+)', selected.get_text(' ', strip=True))
    require(round_match is not None, 'Invalid standings round')
    as_of_round = int(round_match[1])

    by_slug = {team['sourceTeamId']: team for team in teams.values()}
    rows = []
    for row in container.select('.entries-rows-wrapper'):
        if 'header-row' in (row.get('class') or []):
            continue
        link = row.select_one('.smallSite a[href^="/teams/"]')
        require(link is not None, 'Standing without an official team URL')
        url = urljoin(BASE + '/', link['href'])
        slug = official_team_slug(url)
        require(slug is not None and slug in by_slug, f'Unknown standings team: {url}')
        team = by_slug[slug]

        published = row.select_one('.smallSite .entry-title strong')
        require(published is not None, 'Missing standings rank/name')
        rank_match = re.match(r'(\d+)\.\s*(.+)', published.get_text(' ', strip=True))
        require(rank_match is not None, 'Invalid standings rank/name')
        rank = int(rank_match[1])
        published_name = rank_match[2].strip()
        require(normalize_name(published_name) == normalize_name(team['name']),
                'Standings team name does not match its official page')
        city_element = row.select_one('.smallSite .entry-title small')
        if city_element is not None and team['city']:
            require(normalize_name(city_element.get_text(' ', strip=True))
                    == normalize_name(team['city']), 'Standings city mismatch')

        stats = row.select_one(
            'div.entry-values[block-name="matches-table-1"][block-index="1"]')
        require(stats is not None, 'Missing total standings block')
        cells = [cell.get_text(' ', strip=True) for cell in stats.select('.entry-value')]
        require(len(cells) == 7 and all(cells[i].isdigit() for i in (0, 1, 2, 3, 6)),
                'Invalid or incomplete standings numbers')
        goals = re.fullmatch(r'(\d+)\s*[-–—]\s*(\d+)', cells[4])
        require(goals is not None and re.fullmatch(r'-?\d+', cells[5]),
                'Invalid goals or difference')
        row_data = {
            'rank': rank,
            'teamId': team['teamId'],
            'played': int(cells[0]),
            'wins': int(cells[1]),
            'draws': int(cells[2]),
            'losses': int(cells[3]),
            'goalsFor': int(goals[1]),
            'goalsAgainst': int(goals[2]),
            'goalDifference': int(cells[5]),
            'points': int(cells[6]),
        }
        require(row_data['wins'] + row_data['draws'] + row_data['losses']
                == row_data['played'], 'Inconsistent standings played total')
        require(row_data['goalsFor'] - row_data['goalsAgainst']
                == row_data['goalDifference'], 'Inconsistent standings goal difference')
        rows.append(row_data)

    require(rows, 'Standings table is empty')
    require([row['rank'] for row in rows] == list(range(1, len(rows) + 1)),
            'Standings do not follow the published order')
    require({row['teamId'] for row in rows} == set(teams),
            'Standings participants do not match the official registry')
    return {'asOfRound': as_of_round, 'sourceUrl': TABLE_URL, 'rows': rows}


def _calendar_team_name(row, side):
    element = row.select_one(f'.teamName{side} .fullName')
    return _own_text(element)


def parse_calendar(html, teams, season=SEASON):
    """Parse all embedded circles, including future fixtures without scores."""
    soup = BeautifulSoup(html, 'html.parser')
    section = _section(soup, '.matchesList-calendar')
    _require_season(section, season)
    boxes = section.select('div[block-name="calendar-1-2026-group-1"]')
    menus = [box for box in boxes if box.select_one('ul') and not box.select('.entries-rows-list')]
    require(menus, 'Missing circle selector')
    expected_circles = len(menus[0].select('ul > li'))
    content_boxes = [box for box in boxes if box.select('.entries-rows-list[id^="tour_"]')]
    require(expected_circles > 0 and len(content_boxes) == expected_circles,
            'Calendar circles are missing or truncated')

    by_name = {}
    for team in teams.values():
        key = normalize_name(team['name'])
        require(key not in by_name, f'Ambiguous official team name: {team["name"]}')
        by_name[key] = team['teamId']

    matches = {}
    unresolved = []
    rounds_by_circle = {}
    for circle, box in enumerate(content_boxes, 1):
        tours = box.select('.entries-rows-list[id^="tour_"]')
        require(tours, f'Empty calendar circle: {circle}')
        rounds_by_circle[circle] = []
        for tour in tours:
            tour_match = re.fullmatch(r'tour_(\d+)', tour.get('id', ''))
            require(tour_match is not None, 'Invalid tour id')
            round_number = int(tour_match[1])
            rounds_by_circle[circle].append(round_number)
            rows = tour.select('a.entry-row[href*="/match_"]')
            require(rows, f'Empty tour: {round_number}')
            for row in rows:
                url = urljoin(BASE + '/', row['href'])
                source_match_id = official_match_number(url)
                require(source_match_id is not None,
                        f'Non-Premier-League match URL: {url}')
                home_name = _calendar_team_name(row, 1)
                away_name = _calendar_team_name(row, 2)
                home_id = by_name.get(normalize_name(home_name))
                away_id = by_name.get(normalize_name(away_name))
                if home_id is None or away_id is None:
                    unresolved.append({
                        'kind': 'match',
                        'reason': 'team_not_in_official_registry',
                        'raw': {'sourceUrl': url, 'round': round_number, 'circle': circle,
                                'homeName': home_name, 'awayName': away_name},
                    })
                    continue

                date_element = row.select_one('.entry-row-values .entry-title strong')
                published_date, published_time = _parse_date_time(
                    date_element.get_text(' ', strip=True) if date_element else '', season)
                venue_element = row.select_one('.smallSite .entry-title small')
                venue = (re.sub(r'\s+', ' ', venue_element.get_text(' ', strip=True))
                         if venue_element else None)
                home_score, away_score = _parse_score(row.select_one('.score'))
                record = {
                    'matchId': f'cfu:match:{source_match_id}',
                    'provider': 'cfu',
                    'sourceMatchId': source_match_id,
                    'sourceUrl': url,
                    'round': round_number,
                    'circle': circle,
                    'homeTeamId': home_id,
                    'awayTeamId': away_id,
                    'date': published_date,
                    'time': published_time,
                    'timeZone': None,
                    'venue': venue or None,
                    'homeScore': home_score,
                    'awayScore': away_score,
                    'status': None,
                    'statusLabel': None,
                }
                key = record['matchId']
                if key in matches:
                    require(matches[key] == record, f'Conflicting duplicate match: {key}')
                    continue
                matches[key] = record

    rounds = sorted({match['round'] for match in matches.values()})
    max_round = max(rounds) if rounds else 0
    expected_per_round = len(teams) // 2
    per_round = {number: sum(1 for match in matches.values() if match['round'] == number)
                 for number in rounds}
    per_circle = {circle: len(numbers) for circle, numbers in rounds_by_circle.items()}
    rounds_per_circle = max(per_circle.values()) if per_circle else 0
    referenced = {match['homeTeamId'] for match in matches.values()}
    referenced |= {match['awayTeamId'] for match in matches.values()}
    complete = (
        len(content_boxes) == expected_circles
        and rounds == list(range(1, max_round + 1))
        and expected_per_round > 0
        and all(count == expected_per_round for count in per_round.values())
        and all(count == rounds_per_circle for count in per_circle.values())
        and len(matches) == expected_circles * rounds_per_circle * expected_per_round
        and referenced == set(teams)
        and all(match['date'] and match['time'] for match in matches.values())
    )
    calendar_meta = {
        'circles': expected_circles,
        'rounds': max_round,
        'complete': complete,
        'roundsByCircle': rounds_by_circle,
    }
    return matches, unresolved, calendar_meta


def parse_match_page(html, season=SEASON):
    """Targeted verification of one official match page (not a bulk import)."""
    soup = BeautifulSoup(html, 'html.parser')
    _require_title_season(soup, season)
    details = _section(soup, '.matchesDetails')
    home = details.select_one('.matchesDetails-header .teamName1 a[href^="/teams/"]')
    away = details.select_one('.matchesDetails-header .teamName2 a[href^="/teams/"]')
    require(home is not None and away is not None, 'Missing match teams')
    home_slug = official_team_slug(urljoin(BASE + '/', home['href']))
    away_slug = official_team_slug(urljoin(BASE + '/', away['href']))
    require(home_slug is not None and away_slug is not None, 'Invalid match team URL')
    score = details.select_one('.matchesDetails-header .score')
    home_score, away_score = _parse_score(score)
    meta = details.select_one('.matchesDetails-header-meta')
    require(meta is not None, 'Missing match metadata')
    meta_text = meta.get_text(' ', strip=True)
    published_date, published_time = _parse_date_time(meta_text, season)
    round_match = re.search(r'(\d+)-й\s+тур', meta_text)
    label = details.select_one('.labelRow .label')
    status_label = label.get_text(' ', strip=True) if label else None
    status = STATUS_LABELS.get(status_label.casefold().replace('ё', 'е')) if status_label else None
    spans = meta.find_all('span', recursive=False)
    venue = spans[1].get_text(' ', strip=True) if len(spans) > 1 else None
    return {
        'homeTeamId': f'cfu:team:{home_slug}',
        'awayTeamId': f'cfu:team:{away_slug}',
        'homeScore': home_score,
        'awayScore': away_score,
        'date': published_date,
        'time': published_time,
        'round': int(round_match[1]) if round_match else None,
        'venue': venue,
        'status': status,
        'statusLabel': status_label,
    }


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _required_timestamps(checked_at):
    require(isinstance(checked_at, dict), 'checked_at must be an object')
    for key in ('teams', 'table', 'calendar'):
        require(key in checked_at, f'Missing checkedAt for {key}')
        timestamp(checked_at[key])
    return checked_at


def build_snapshot(teams_html, table_html, calendar_html, checked_at,
                   retrieval='direct_http'):
    """Pure, deterministic snapshot builder. Network and file writes live outside."""
    _required_timestamps(checked_at)
    require(isinstance(retrieval, str) and bool(retrieval), 'Missing retrieval method')
    teams = parse_teams(teams_html)
    standings = parse_standings(table_html, teams)
    matches, unresolved, calendar_meta = parse_calendar(calendar_html, teams)
    retrieved_at = max(timestamp(checked_at[key])
                       for key in ('teams', 'table', 'calendar')).isoformat()
    calendar_coverage = 'complete' if calendar_meta['complete'] else 'partial'
    snapshot = {
        'schemaVersion': 1,
        'provider': 'cfu',
        'competitionKey': COMPETITION_KEY,
        'competitionName': COMPETITION_NAME,
        'competitionUrl': COMPETITION_URL,
        'season': SEASON,
        'teamsById': teams,
        'matchesById': matches,
        'standings': standings,
        'sourceMetadata': {
            'provider': 'cfu',
            'season': SEASON,
            'competitionUrl': COMPETITION_URL,
            'robotsUrl': ROBOTS_URL,
            'crawlDelaySeconds': CRAWL_DELAY_SECONDS,
            'retrieval': retrieval,
            'retrievedAt': retrieved_at,
            'sections': {
                'teams': {
                    'url': TEAMS_URL,
                    'checkedAt': checked_at['teams'],
                    'status': 'current',
                    'coverage': 'complete',
                    'httpStatus': 200,
                    'records': len(teams),
                    'reason': 'official_team_registry_parsed',
                },
                'table': {
                    'url': TABLE_URL,
                    'checkedAt': checked_at['table'],
                    'status': 'current',
                    'coverage': 'complete' if len(standings['rows']) == len(teams) else 'partial',
                    'httpStatus': 200,
                    'records': len(standings['rows']),
                    'reason': 'official_full_standings_parsed',
                },
                'calendar': {
                    'url': CALENDAR_URL,
                    'checkedAt': checked_at['calendar'],
                    'status': 'current',
                    'coverage': calendar_coverage,
                    'httpStatus': 200,
                    'records': len(matches),
                    'circles': calendar_meta['circles'],
                    'rounds': calendar_meta['rounds'],
                    'reason': ('official_calendar_parsed' if calendar_meta['complete']
                               else 'official_calendar_incomplete'),
                },
            },
        },
        'unresolvedRecords': unresolved,
    }
    return validate_snapshot(snapshot)


def load_snapshot(path):
    path = Path(path)
    if not path.exists():
        return None
    try:
        snapshot = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InvalidCfuData(f'Existing snapshot is unreadable: {exc}') from exc
    return validate_snapshot(snapshot)


def write_snapshot(snapshot, path):
    validate_snapshot(snapshot)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    try:
        with temporary.open('w', encoding='utf-8', newline='\n') as stream:
            json.dump(snapshot, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def fetch_pages(delay=CRAWL_DELAY_SECONDS, timeout=30):
    """Fetch exactly the three required public pages, respecting robots.txt."""
    pages, checked_at = {}, {}
    with requests.Session() as session:
        session.headers['User-Agent'] = USER_AGENT
        for key, url in (('teams', TEAMS_URL), ('table', TABLE_URL),
                         ('calendar', CALENDAR_URL)):
            if pages and delay:
                time.sleep(delay)
            try:
                response = session.get(url, timeout=timeout)
                response.raise_for_status()
            except requests.RequestException as exc:
                raise InvalidCfuData(f'Source request failed: {url}: {exc}') from exc
            require(response.status_code == 200,
                    f'Unexpected HTTP status: {response.status_code}')
            content_type = response.headers.get('Content-Type', '')
            if content_type:
                require('html' in content_type.lower(),
                        f'Unexpected content type: {content_type}')
            try:
                html = response.content.decode('utf-8')
            except UnicodeDecodeError:
                html = response.content.decode('cp1251')
            require(len(html) > 5000, f'Truncated source page: {url}')
            pages[key] = html
            checked_at[key] = _utc_now()
    return pages, checked_at


def fetch_local(directory, delay=0, timeout=None):
    """Offline reproduction from previously downloaded official HTML."""
    directory = Path(directory)
    pages, checked_at = {}, {}
    for key in ('teams', 'table', 'calendar'):
        path = directory / f'{key}.html'
        require(path.exists(), f'Missing local source page: {path}')
        raw = path.read_bytes()
        try:
            html = raw.decode('utf-8')
        except UnicodeDecodeError:
            html = raw.decode('cp1251')
        require(len(html) > 5000, f'Truncated local source page: {path}')
        pages[key] = html
        checked_at[key] = datetime.fromtimestamp(
            path.stat().st_mtime, timezone.utc).isoformat()
    return pages, checked_at


def _all_sections_complete(snapshot):
    return all(section['coverage'] == 'complete'
               for section in snapshot['sourceMetadata']['sections'].values())


def run_import(output, fetch=fetch_pages, delay=CRAWL_DELAY_SECONDS, timeout=30,
               retrieval='direct_http'):
    """Import and atomically replace the snapshot; a failure keeps the old file."""
    path = Path(output)
    previous = load_snapshot(path)  # validates the previous snapshot before any request
    pages, checked_at = fetch(delay=delay, timeout=timeout)
    snapshot = build_snapshot(pages['teams'], pages['table'], pages['calendar'],
                              checked_at, retrieval=retrieval)
    if previous is not None and _all_sections_complete(previous) \
            and not _all_sections_complete(snapshot):
        raise InvalidCfuData(
            'Refusing to replace a complete snapshot with a partial source response')
    write_snapshot(snapshot, path)
    return snapshot


def main(argv=None):
    parser = argparse.ArgumentParser(description='Import CFU Premier League 2026 data')
    parser.add_argument('--output', type=Path,
                        default=Path('docs/cfu-premier-2026/snapshot.json'))
    parser.add_argument('--delay', type=float, default=CRAWL_DELAY_SECONDS)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--html-dir', type=Path,
                        help='Read teams.html/table.html/calendar.html instead of HTTP')
    args = parser.parse_args(argv)
    try:
        if args.html_dir:
            fetch = lambda delay, timeout: fetch_local(args.html_dir)
            retrieval = 'saved_official_html'
        else:
            fetch = fetch_pages
            retrieval = 'direct_http'
        snapshot = run_import(args.output, fetch=fetch, delay=args.delay,
                              timeout=args.timeout, retrieval=retrieval)
    except (InvalidCfuData, OSError, ValueError) as exc:
        print(f'CFU import failed; snapshot not replaced: {exc}', file=sys.stderr)
        return 1
    print(f'Wrote {args.output}: {len(snapshot["teamsById"])} teams, '
          f'{len(snapshot["matchesById"])} matches')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
