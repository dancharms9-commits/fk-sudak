"""Import verified CFU Premier League 2026 match protocols.

The calendar snapshot remains authoritative for fixture identity.  This importer
adds only fields that the saved official match HTML actually contains.  The
``Составы`` and ``Хронология`` tabs are loaded dynamically by the source site and
are deliberately not treated as present in the saved HTML.

Offline reproduction (the default for this repository):

    python -m scripts.cfu_match_details \
        --calendar docs/cfu-premier-2026/snapshot.json \
        --rosters docs/cfu-premier-rosters-2026/rosters.json \
        --html-dir tests/fixtures/cfu-premier \
        --checked-at 2026-11-11T18:00:00+00:00

Targeted network retrieval is available only through explicit ``--match`` ids
and sleeps for the published Crawl-delay of 40 seconds between requests.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urljoin

from bs4 import BeautifulSoup
import requests

from scripts.cfu_premier_import import load_snapshot, parse_match_page
from scripts.cfu_premier_schema import (
    BASE, CRAWL_DELAY_SECONDS, SEASON, InvalidCfuData, official_match_number,
)
from scripts.cfu_premier_rosters import load_rosters
from scripts.cfu_premier_roster_schema import official_player_id
from scripts.cfu_match_details_schema import (
    InvalidCfuMatchData, MATCH_PAGE_PATTERN, MINUTE_RE, require,
    timestamp, validate_match_details,
)

USER_AGENT = 'FKSudakPWA/cfu-match-details-v1 (+https://github.com/dancharms9-commits/fk-sudak)'
COMPETITION_TITLE = 'Чемпионат Премьер-лиги Крымского футбольного союза'
EVENT_ICON_TYPES = {'match_icon1_1.svg': 'goal'}
MATCH_ID_CLASS_RE = re.compile(r'match_(?:score_|label_|headermeta_)([1-9][0-9]*)')
MINUTE_TEXT_RE = re.compile(r'(\d{1,3})(?:\+(\d{1,2}))?\s*[\'′]')


def _text(value):
    return re.sub(r'\s+', ' ', value or '').strip()


def _source_digest(html):
    """Hash decoded source text with platform-independent line endings."""
    return hashlib.sha256(html.replace('\r\n', '\n').encode('utf-8')).hexdigest()


def _page_match_id(details):
    ids = set()
    for element in (
            details.select_one('.matchesDetails-header .score'),
            details.select_one('.labelRow'),
            details.select_one('.matchesDetails-header-meta')):
        if element is None:
            continue
        for class_name in element.get('class') or []:
            hit = MATCH_ID_CLASS_RE.fullmatch(class_name)
            if hit:
                ids.add(hit[1])
    require(ids, 'Official match id is missing from the page')
    require(len(ids) == 1, 'Official match id is ambiguous')
    return ids.pop()


def _page_competition(soup):
    wrapper = soup.select_one('.wrapper.matchesDetails')
    require(wrapper is not None, 'Missing official match wrapper')
    require('matches_premier-leagueCFU' in (wrapper.get('class') or []),
            'Match page is not a CFU Premier League fixture')
    title = soup.title.get_text(' ', strip=True) if soup.title else ''
    require(COMPETITION_TITLE in title, 'Wrong competition title')
    require(not re.search(r'Кубок|Суперкубок', title, re.I),
            'Match page belongs to another competition')


def _minute(value):
    hit = MINUTE_TEXT_RE.search(value or '')
    if hit is None:
        return None
    minute = hit[1] + ('+' + hit[2] if hit[2] else '')
    return minute if MINUTE_RE.fullmatch(minute) else None


def _resolve_player(link, team_id, rosters):
    if link is None:
        return None, 'missing_player_identity'
    source_url = urljoin(BASE + '/', link['href'])
    player_id = official_player_id(source_url)
    name = _text(link.get_text(' ', strip=True))
    if player_id is None or not name:
        return None, 'invalid_player_link'
    canonical = f'cfu:player:{player_id}'
    player = rosters.get('playersById', {}).get(canonical) if rosters else None
    roster = rosters.get('rostersByTeamId', {}).get(team_id) if rosters else None
    if player is None or roster is None:
        return {'name': name, 'playerId': None}, 'player_not_in_verified_rosters'
    if not any(entry.get('playerId') == canonical for entry in roster.get('entries', [])):
        return {'name': name, 'playerId': None}, 'player_not_in_verified_rosters'
    return {'name': player['name'], 'playerId': canonical}, None


def _parse_events(details, home_team_id, away_team_id, rosters):
    events, issues = [], []
    containers = (
        ('home', home_team_id, details.select_one('.eventEntries1')),
        ('away', away_team_id, details.select_one('.eventEntries2')),
    )
    for side, team_id, container in containers:
        if container is None:
            continue
        for element in container.find_all('span', recursive=False):
            link = element.select_one('a[href^="/players/"]')
            icon = element.select_one('img[src]')
            minute = None
            for span in element.find_all('span'):
                minute = _minute(span.get_text(' ', strip=True))
                if minute is not None:
                    break
            icon_name = (icon.get('src') or '').rsplit('/', 1)[-1] if icon else ''
            event_type = EVENT_ICON_TYPES.get(icon_name)
            if event_type is None:
                issues.append({
                    'kind': 'protocol_section',
                    'reason': 'unknown_event_icon',
                    'raw': {'side': side, 'icon': icon_name,
                            'text': _text(element.get_text(' ', strip=True))[:300]},
                })
                continue
            actor, issue = _resolve_player(link, team_id, rosters)
            if issue:
                issues.append({
                    'kind': 'protocol_section',
                    'reason': issue,
                    'raw': {'side': side, 'text': _text(element.get_text(' ', strip=True))[:300]},
                })
            if minute is None or actor is None:
                continue
            event = {
                'type': event_type,
                'side': side,
                'player': actor['name'],
                'playerId': actor['playerId'],
                'minute': minute,
                'score': None,
            }
            events.append(event)
    return events, issues


def parse_match_protocol(html, expected, rosters=None, checked_at=None,
                         source_sha256=None):
    """Parse one saved official match page and cross-check it with the calendar.

    Returns ``(record, issues)``.  Raises ``InvalidCfuMatchData`` for a page that
    cannot be attached safely to the confirmed calendar.
    """
    require(isinstance(html, str) and len(html) > 1000, 'Truncated match page')
    require(isinstance(expected, dict), 'Missing confirmed calendar match')
    soup = BeautifulSoup(html, 'html.parser')
    _page_competition(soup)
    parsed = parse_match_page(html, SEASON)
    details = soup.select_one('.matchesDetails')
    require(details is not None, 'Missing match details')

    match_id = expected['matchId']
    number = match_id.rsplit(':', 1)[-1]
    page_number = _page_match_id(details)
    require(page_number == number, 'Official match id was substituted')
    source_url = expected['sourceUrl']
    require(official_match_number(source_url) == number, 'Invalid calendar match URL')

    require(parsed['homeTeamId'] == expected['homeTeamId'],
            'Home team differs from the confirmed calendar')
    require(parsed['awayTeamId'] == expected['awayTeamId'],
            'Away team differs from the confirmed calendar')
    require(parsed['round'] == expected['round'],
            'Round differs from the confirmed calendar')
    if expected.get('date') is not None:
        require(parsed['date'] == expected['date'],
                'Date differs from the confirmed calendar')
    if expected.get('time') is not None:
        require(parsed['time'] == expected['time'],
                'Time differs from the confirmed calendar')
    if expected.get('homeScore') is not None and expected.get('awayScore') is not None:
        require((parsed['homeScore'], parsed['awayScore'])
                == (expected['homeScore'], expected['awayScore']),
                'Score differs from the confirmed calendar')
    if checked_at is not None:
        timestamp(checked_at, 'protocol checkedAt')

    events, event_issues = _parse_events(
        details, expected['homeTeamId'], expected['awayTeamId'], rosters)
    goals = [event for event in events if event['type'] in
             {'goal', 'penalty', 'own_goal'}]
    score = None
    if parsed['homeScore'] is not None and parsed['awayScore'] is not None:
        score = (parsed['homeScore'], parsed['awayScore'])
    goals_complete = False
    if score is not None:
        goals_complete = (sum(1 for goal in goals if goal['side'] == 'home') == score[0]
                          and sum(1 for goal in goals if goal['side'] == 'away') == score[1])
        if not goals_complete:
            event_issues.append({
                'kind': 'protocol_section',
                'reason': 'goal_events_incomplete',
                'raw': {'matchId': match_id, 'sourceUrl': source_url,
                        'publishedScore': list(score),
                        'confirmedGoals': len(goals)},
            })

    missing = ['lineups', 'chronology']
    if score is None:
        missing = ['result', 'goals', 'events', 'lineups', 'chronology']
    elif not goals_complete:
        missing = ['goals', 'events', 'lineups', 'chronology']
    coverage = 'schedule' if score is None else ('events' if events else 'result')
    if score is None:
        events, goals = [], []
        goals_complete = False

    record = {
        'matchId': match_id,
        'provider': 'cfu',
        'sourceMatchId': number,
        'sourceUrl': source_url,
        'checkedAt': checked_at,
        'sourceSha256': source_sha256,
        'homeTeamId': expected['homeTeamId'],
        'awayTeamId': expected['awayTeamId'],
        'round': expected['round'],
        'date': parsed['date'],
        'time': parsed['time'],
        'venue': expected.get('venue') or parsed.get('venue'),
        'homeScore': parsed['homeScore'],
        'awayScore': parsed['awayScore'],
        'status': parsed['status'],
        'statusLabel': parsed['statusLabel'],
        'coverage': coverage,
        'missingSections': missing,
        'goalsComplete': goals_complete,
        'eventsComplete': False,
        'goals': goals,
        'events': events,
        'lineups': None,
    }
    return record, event_issues


def _checked_at_for(match_id, checked_at):
    if isinstance(checked_at, str):
        return checked_at
    require(isinstance(checked_at, dict) and match_id in checked_at,
            f'Missing checkedAt for {match_id}')
    return checked_at[match_id]


def build_snapshot(calendar, rosters, pages, checked_at,
                   retrieval='saved_official_html', source_hashes=None):
    """Pure deterministic protocol snapshot builder from saved official HTML."""
    from scripts.cfu_premier_schema import validate_snapshot

    validate_snapshot(calendar)
    if rosters is not None:
        from scripts.cfu_premier_roster_schema import validate_rosters
        validate_rosters(rosters, expected_team_ids=set(calendar['teamsById']))
    require(isinstance(pages, dict) and bool(pages), 'No match pages to import')
    require(isinstance(retrieval, str) and bool(retrieval), 'Missing retrieval method')

    records, sources, unresolved = {}, {}, []
    for match_id in sorted(pages, key=lambda key: int(key.rsplit(':', 1)[-1])):
        expected = calendar['matchesById'].get(match_id)
        if expected is None:
            unresolved.append({
                'kind': 'protocol',
                'reason': 'match_not_in_confirmed_calendar',
                'raw': {'matchId': match_id},
            })
            continue
        html = pages[match_id]
        source_hash = (source_hashes or {}).get(match_id)
        if source_hash is None:
            source_hash = _source_digest(html)
        require(isinstance(source_hash, str) and bool(re.fullmatch(r'[0-9a-f]{64}', source_hash)),
                'Invalid source hash')
        checked = _checked_at_for(match_id, checked_at)
        timestamp(checked, 'protocol checkedAt')
        try:
            record, issues = parse_match_protocol(
                html, expected, rosters=rosters, checked_at=checked,
                source_sha256=source_hash)
        except (InvalidCfuMatchData, InvalidCfuData) as exc:
            unresolved.append({
                'kind': 'protocol',
                'reason': str(exc),
                'raw': {'matchId': match_id, 'sourceUrl': expected['sourceUrl']},
            })
            continue
        records[match_id] = record
        sources[match_id] = {
            'url': record['sourceUrl'],
            'checkedAt': record['checkedAt'],
            'sourceSha256': record['sourceSha256'],
            'httpStatus': 200,
            'coverage': record['coverage'],
            'reason': 'official_match_page_parsed',
        }
        for issue in issues:
            issue = {**issue, 'raw': {**(issue.get('raw') or {}),
                                      'matchId': match_id,
                                      'sourceUrl': expected['sourceUrl']}}
            unresolved.append(issue)
        for section in ('lineups', 'chronology'):
            if section in record['missingSections']:
                unresolved.append({
                    'kind': 'protocol_section',
                    'reason': 'dynamic_tab_not_in_saved_html',
                    'raw': {'matchId': match_id, 'sourceUrl': expected['sourceUrl'],
                            'section': section},
                })

    require(records, 'No protocol could be attached to the confirmed calendar')
    retrieved_at = max(timestamp(record['checkedAt'], 'protocol checkedAt')
                       for record in records.values()).isoformat()
    snapshot = {
        'schemaVersion': 1,
        'provider': 'cfu',
        'competitionKey': 'cfu-premier-2026',
        'season': SEASON,
        'matchesById': records,
        'sourceMetadata': {
            'provider': 'cfu',
            'season': SEASON,
            'competitionUrl': 'https://www.cfu2015.com/matches/premier-leagueCFU/',
            'robotsUrl': 'https://www.cfu2015.com/robots.txt',
            'crawlDelaySeconds': CRAWL_DELAY_SECONDS,
            'retrieval': retrieval,
            'retrievedAt': retrieved_at,
            'matchPagePattern': MATCH_PAGE_PATTERN,
            'calendarSnapshot': 'cfu-premier-2026.json',
            'sources': sources,
        },
        'unresolvedRecords': sorted(
            unresolved,
            key=lambda item: (
                (item.get('raw') or {}).get('matchId', ''),
                item.get('kind', ''),
                item.get('reason', ''),
                (item.get('raw') or {}).get('section', ''),
            )),
    }
    return validate_match_details(snapshot, calendar, rosters)


def load_match_details(path, calendar, rosters=None):
    path = Path(path)
    if not path.exists():
        return None
    try:
        snapshot = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InvalidCfuMatchData(f'Existing protocol snapshot is unreadable: {exc}') from exc
    return validate_match_details(snapshot, calendar, rosters)


def _payload(snapshot):
    return (json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def _write_atomic(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_match_details(snapshot, output, public_output, calendar, rosters=None):
    validate_match_details(snapshot, calendar, rosters)
    payload = _payload(snapshot)
    _write_atomic(output, payload)
    _write_atomic(public_output, payload)


def _decode(raw, label):
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        try:
            return raw.decode('cp1251')
        except UnicodeDecodeError as exc:
            raise InvalidCfuMatchData(f'Cannot decode official HTML: {label}') from exc


def fetch_local(directory, matches, checked_at=None):
    """Read official match HTML saved in a local fixtures directory."""
    directory = Path(directory)
    pages, timestamps, hashes = {}, {}, {}
    for expected in sorted(matches, key=lambda match: int(match['sourceMatchId'])):
        match_id, number = expected['matchId'], expected['sourceMatchId']
        candidates = (list(directory.glob(f'match-{number}.html'))
                      + list(directory.glob(f'match-{number}-*.html'))
                      + list(directory.glob(f'match_{number}.html'))
                      + list(directory.glob(f'match_{number}-*.html')))
        require(candidates, f'Missing saved official match page for {match_id}')
        require(len(candidates) == 1, f'Ambiguous saved match page for {match_id}')
        path = candidates[0]
        raw = path.read_bytes()
        html = _decode(raw, str(path))
        require(len(html) > 1000, f'Truncated saved match page: {path}')
        pages[match_id] = html
        hashes[match_id] = _source_digest(html)
        timestamps[match_id] = checked_at or datetime.fromtimestamp(
            path.stat().st_mtime, timezone.utc).isoformat()
    return pages, timestamps, hashes


def fetch_pages(matches, delay=CRAWL_DELAY_SECONDS, timeout=30, save_html_dir=None):
    """Fetch only explicitly selected match pages, sequentially and politely."""
    pages, timestamps, hashes = {}, {}, {}
    with requests.Session() as session:
        session.headers['User-Agent'] = USER_AGENT
        for index, expected in enumerate(sorted(matches, key=lambda match: int(match['sourceMatchId']))):
            if index and delay:
                time.sleep(delay)
            match_id = expected['matchId']
            try:
                response = session.get(expected['sourceUrl'], timeout=timeout)
                response.raise_for_status()
            except requests.RequestException as exc:
                raise InvalidCfuMatchData(
                    f'Source request failed: {expected["sourceUrl"]}: {exc}') from exc
            require(response.status_code == 200,
                    f'Unexpected HTTP status: {response.status_code}')
            content_type = response.headers.get('Content-Type', '')
            if content_type:
                require('html' in content_type.lower(),
                        f'Unexpected content type: {content_type}')
            html = _decode(response.content, expected['sourceUrl'])
            require(len(html) > 1000, f'Truncated source page: {expected["sourceUrl"]}')
            pages[match_id] = html
            timestamps[match_id] = datetime.now(timezone.utc).isoformat()
            hashes[match_id] = _source_digest(html)
            if save_html_dir:
                directory = Path(save_html_dir)
                directory.mkdir(parents=True, exist_ok=True)
                (directory / f'match-{expected["sourceMatchId"]}.html').write_bytes(response.content)
    return pages, timestamps, hashes


def run_import(calendar_path, rosters_path, output, public_output, fetch=None,
               delay=CRAWL_DELAY_SECONDS, timeout=30, retrieval='saved_official_html',
               selected_match_ids=None, checked_at=None, html_dir=None):
    """Build and atomically publish protocols; a failed fetch leaves files intact."""
    calendar = load_snapshot(calendar_path)
    rosters = load_rosters(rosters_path, expected_team_ids=set(calendar['teamsById']))
    previous = load_match_details(output, calendar, rosters)
    if selected_match_ids:
        require(isinstance(selected_match_ids, (list, tuple, set)),
                'Selected match ids must be a sequence')
        matches = [calendar['matchesById'][match_id] for match_id in selected_match_ids
                   if match_id in calendar['matchesById']]
        missing = set(selected_match_ids) - {match['matchId'] for match in matches}
        require(not missing, f'Unknown selected match ids: {sorted(missing)}')
    elif html_dir:
        known = set()
        directory = Path(html_dir)
        for path in directory.glob('match[-_]*.html'):
            hit = re.fullmatch(r'match[-_](\d+)(?:-[a-z0-9-]+)?\.html', path.name)
            if hit:
                match_id = f'cfu:match:{hit[1]}'
                if match_id in calendar['matchesById']:
                    known.add(match_id)
        matches = [calendar['matchesById'][match_id] for match_id in
                   sorted(known, key=lambda value: int(value.rsplit(':', 1)[-1]))]
    else:
        raise InvalidCfuMatchData(
            'Select explicit --match ids for network retrieval; bulk import is disabled')

    require(matches, 'No official match pages selected')
    if fetch is None:
        if html_dir:
            fetch = lambda selected, delay, timeout: fetch_local(
                html_dir, selected, checked_at=checked_at)
        else:
            fetch = fetch_pages
    pages, timestamps, hashes = fetch(matches, delay=delay, timeout=timeout)
    snapshot = build_snapshot(calendar, rosters, pages, timestamps,
                              retrieval=retrieval, source_hashes=hashes)
    if previous is not None and not snapshot['matchesById']:
        raise InvalidCfuMatchData(
            'Refusing to replace a valid protocol snapshot with an empty response')
    write_match_details(snapshot, output, public_output, calendar, rosters)
    return snapshot


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Import verified CFU Premier League 2026 match protocols')
    parser.add_argument('--calendar', type=Path,
                        default=Path('docs/cfu-premier-2026/snapshot.json'))
    parser.add_argument('--rosters', type=Path,
                        default=Path('docs/cfu-premier-rosters-2026/rosters.json'))
    parser.add_argument('--output', type=Path,
                        default=Path('docs/cfu-premier-2026/match-details.json'))
    parser.add_argument('--public-output', type=Path,
                        default=Path('cfu-premier-match-details-2026.json'))
    parser.add_argument('--html-dir', type=Path,
                        help='Read saved official match HTML from this directory')
    parser.add_argument('--match', action='append', dest='matches',
                        help='Official cfu:match:<id> to retrieve over HTTP (repeatable)')
    parser.add_argument('--checked-at',
                        help='Fixed ISO timestamp for deterministic offline snapshots')
    parser.add_argument('--delay', type=float, default=CRAWL_DELAY_SECONDS)
    parser.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args(argv)
    try:
        retrieval = 'saved_official_html' if args.html_dir else 'direct_http'
        snapshot = run_import(
            args.calendar, args.rosters, args.output, args.public_output,
            delay=args.delay, timeout=args.timeout, retrieval=retrieval,
            selected_match_ids=args.matches, checked_at=args.checked_at,
            html_dir=args.html_dir)
    except (InvalidCfuMatchData, InvalidCfuData, OSError, ValueError) as exc:
        print(f'CFU protocol import failed; snapshot not replaced: {exc}',
              file=sys.stderr)
        return 1
    print(f'Wrote {args.output} and {args.public_output}: '
          f'{len(snapshot["matchesById"])} protocols, '
          f'{len(snapshot["unresolvedRecords"])} unresolved records')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
