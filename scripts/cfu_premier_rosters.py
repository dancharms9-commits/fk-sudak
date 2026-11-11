"""Import official CFU Premier League 2026 club rosters.

Only the seven confirmed team pages are requested.  Each page publishes the
selected competition "Чемпионат Премьер-лиги КФС" and season 2026.  Player
identity comes from the official ``/players/<id>/`` link; position, shirt
number and deregistration are kept as season roster fields.

Run from the repository root:

    python -m scripts.cfu_premier_rosters \
        --output docs/cfu-premier-rosters-2026/rosters.json \
        --public-output cfu-premier-rosters-2026.json

The importer sleeps for ``Crawl-delay: 40`` between requests and never
replaces a valid snapshot after a failed or incomplete source response.
"""
import argparse
from datetime import date, datetime, timezone
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

from scripts.cfu_premier_roster_schema import (
    BASE, COMPETITION_KEY, COMPETITION_URL, CRAWL_DELAY_SECONDS,
    PLAYER_URL_PATTERN, POSITION_GROUPS, ROBOTS_URL, SEASON, InvalidCfuRosterData,
    official_player_id, official_team_slug, player_url, require, timestamp,
    validate_rosters,
)
from scripts.cfu_premier_schema import InvalidCfuData, validate_snapshot

USER_AGENT = 'FKSudakPWA/cfu-premier-rosters-v1 (+https://github.com/dancharms9-commits/fk-sudak)'
TOURNAMENT_LABEL = 'Чемпионат Премьер-лиги КФС'
SEASON_LABEL = 'Сезон 2026'
POSITION_ORDER = {group: index for index, group in enumerate(POSITION_GROUPS)}


def _text(value):
    return re.sub(r'\s+', ' ', value or '').strip()


def _description_value(descriptions, label):
    pattern = re.compile(rf'^{re.escape(label)}:\s*(.+)$')
    for text in descriptions:
        match = pattern.fullmatch(text)
        if match:
            return match.group(1).strip()
    return None


def _parse_published_date(value, field, season_bound=False):
    if value is None:
        return None
    match = re.fullmatch(r'(\d{2})\.(\d{2})\.(\d{2,4})(?:\s*\((.+)\))?', value)
    require(match is not None, f'Invalid {field}: {value}')
    day, month, year, _ = match.groups()
    year = int(year) if len(year) == 4 else 2000 + int(year)
    try:
        parsed = date(year, int(month), int(day))
    except ValueError as exc:
        raise InvalidCfuRosterData(f'Invalid {field}: {value}') from exc
    if season_bound:
        require(SEASON - 2 <= parsed.year <= SEASON + 1,
                f'{field} is outside the 2026 season: {value}')
    return parsed.isoformat()


def _published_note(value):
    if value is None:
        return None
    match = re.fullmatch(r'\d{2}\.\d{2}\.\d{2,4}\s*\((.+)\)', value)
    return match.group(1).strip() if match else None


def _selected_label(wrapper, block_name):
    selected = wrapper.select_one(
        f'div[block-name="{block_name}"] li.selected')
    require(selected is not None, f'Missing selected {block_name}')
    return _text(selected.get_text(' ', strip=True)), selected.select_one('a')


def parse_team_roster(html, team, checked_at):
    """Parse one official team page, only the published 2026 season roster."""
    require(isinstance(html, str) and len(html) > 2000, 'Truncated team page')
    timestamp(checked_at)
    soup = BeautifulSoup(html, 'html.parser')

    page_title = soup.select_one('.pageTitle')
    require(page_title is not None, 'Missing official page title')
    team_slug = team['sourceTeamId']
    identity = [
        official_team_slug(urljoin(BASE + '/', anchor['href']))
        for anchor in page_title.select('a[href]')
    ]
    require(team_slug in identity, 'Team page identity does not match its official URL')

    wrapper = soup.select_one('.teamProfile-players')
    require(wrapper is not None, 'Missing official club roster section')
    tournament, _ = _selected_label(wrapper, 'filter-players-tournaments')
    season, season_link = _selected_label(wrapper, 'filter-players-seasons')
    require(tournament == TOURNAMENT_LABEL,
            f'Wrong competition: {tournament or "not stated"}')
    require(season == SEASON_LABEL, f'Wrong season: {season or "not stated"}')
    require(season_link is not None
            and f'season={SEASON}' in (season_link.get('link') or ''),
            'Selected season link does not confirm 2026')

    sections = wrapper.select('.entries-section')
    require(sections, 'Official roster has no position sections')
    found_groups = []
    entries = []
    players = {}
    unresolved = []
    seen = set()

    for section in sections:
        title = section.select_one('.cell-name')
        group = _text(title.get_text(' ', strip=True)) if title else ''
        if group not in POSITION_GROUPS:
            unresolved.append({
                'kind': 'roster',
                'reason': 'unknown_position_group',
                'raw': {'teamId': team['teamId'], 'group': group},
            })
            continue
        found_groups.append(group)
        for box in section.select('.entry-box'):
            link = box.select_one('a[href^="/players/"]')
            title_element = box.select_one('.entry-title')
            raw_text = _text(box.get_text(' ', strip=True))[:300]
            if link is None or title_element is None:
                unresolved.append({
                    'kind': 'roster',
                    'reason': 'missing_player_identity',
                    'raw': {'teamId': team['teamId'], 'text': raw_text},
                })
                continue
            source_url = urljoin(BASE + '/', link['href'])
            player_id = official_player_id(source_url)
            name = _text(title_element.get_text(' ', strip=True))
            if player_id is None or not name:
                unresolved.append({
                    'kind': 'roster',
                    'reason': 'invalid_player_link_or_name',
                    'raw': {'teamId': team['teamId'], 'href': link.get('href'),
                            'text': raw_text},
                })
                continue
            descriptions = [_text(p.get_text(' ', strip=True))
                            for p in box.select('.description')]
            number = _description_value(descriptions, 'Номер')
            birthday = _description_value(descriptions, 'Дата рождения')
            registered = _description_value(descriptions, 'Заявлен')
            deregistered = _description_value(descriptions, 'Отзаявлен')
            if number is None or birthday is None:
                unresolved.append({
                    'kind': 'roster',
                    'reason': 'missing_number_or_birth_date',
                    'raw': {'teamId': team['teamId'], 'playerId': player_id,
                            'text': raw_text},
                })
                continue
            require(re.fullmatch(r'\d{1,2}', number) is not None,
                    f'Invalid shirt number: {number}')
            number = int(number)
            require(1 <= number <= 99, f'Shirt number is outside 1..99: {number}')
            birthday = _parse_published_date(birthday, 'date of birth')
            registered_at = _parse_published_date(
                registered, 'registration date', season_bound=True)
            deregistered_at = _parse_published_date(
                deregistered, 'deregistration date', season_bound=True)

            canonical = f'cfu:player:{player_id}'
            require(canonical not in seen,
                    f'Duplicate player in one official roster: {canonical}')
            seen.add(canonical)
            known = players.get(canonical)
            player = {
                'playerId': canonical,
                'provider': 'cfu',
                'sourcePlayerId': player_id,
                'sourceUrl': player_url(player_id),
                'name': name,
                'dateOfBirth': birthday,
            }
            if known is not None:
                require(known['name'] == player['name']
                        and known['dateOfBirth'] == player['dateOfBirth'],
                        f'Conflicting official player identity: {canonical}')
            else:
                players[canonical] = player
            entry = {
                'playerId': canonical,
                'position': POSITION_GROUPS[group],
                'positionGroup': group,
                'shirtNumber': number,
                'registeredAt': registered_at,
                'deregisteredAt': deregistered_at,
            }
            registration_note = _published_note(registered)
            if registration_note:
                entry['registrationNote'] = registration_note
            entries.append(entry)

    missing_groups = [group for group in POSITION_GROUPS if group not in found_groups]
    for group in missing_groups:
        unresolved.append({
            'kind': 'roster',
            'reason': 'missing_position_group',
            'raw': {'teamId': team['teamId'], 'group': group},
        })
    if not entries:
        unresolved.append({
            'kind': 'roster',
            'reason': 'empty_roster',
            'raw': {'teamId': team['teamId'], 'sourceUrl': team['sourceUrl']},
        })
    entries.sort(key=lambda entry: (POSITION_ORDER[entry['positionGroup']],
                                    entry['shirtNumber'], entry['playerId']))
    return {
        'entries': entries,
        'players': players,
        'unresolved': unresolved,
        'complete': not unresolved and bool(entries),
    }


def _all_complete(snapshot):
    return (snapshot['sourceMetadata']['rosters']['coverage'] == 'complete'
            and all(roster['coverage'] == 'complete'
                    for roster in snapshot['rostersByTeamId'].values()))


def build_rosters(pages, teams, checked_at, retrieval, source_hashes=None):
    """Pure deterministic roster builder. Network and file writes live outside."""
    require(isinstance(teams, dict) and len(teams) == 7,
            'The official season registry must contain seven clubs')
    require(isinstance(pages, dict) and set(pages) == set(teams),
            'Roster pages do not match the official season registry')
    require(isinstance(checked_at, dict) and set(checked_at) == set(teams),
            'Missing per-club check timestamps')
    require(isinstance(retrieval, str) and bool(retrieval), 'Missing retrieval method')
    if source_hashes is None:
        source_hashes = {
            team_id: hashlib.sha256(html.encode('utf-8')).hexdigest()
            for team_id, html in pages.items()
        }
    require(set(source_hashes) == set(teams), 'Missing source HTML hashes')

    players = {}
    rosters = {}
    unresolved = []
    for team_id in sorted(teams, key=lambda key: teams[key]['sourceTeamId']):
        team = teams[team_id]
        timestamp(checked_at[team_id])
        parsed = parse_team_roster(pages[team_id], team, checked_at[team_id])
        for player_id, player in parsed['players'].items():
            known = players.get(player_id)
            if known is not None:
                require(known['name'] == player['name']
                        and known['dateOfBirth'] == player['dateOfBirth'],
                        f'Conflicting official player identity: {player_id}')
            else:
                players[player_id] = player
        coverage = 'complete' if parsed['complete'] else 'partial'
        rosters[team_id] = {
            'teamId': team_id,
            'provider': 'cfu',
            'sourceTeamId': team['sourceTeamId'],
            'sourceUrl': team['sourceUrl'],
            'checkedAt': checked_at[team_id],
            'httpStatus': 200,
            'status': 'current',
            'coverage': coverage,
            'reason': ('official_2026_roster_parsed' if coverage == 'complete'
                       else 'official_2026_roster_incomplete'),
            'sourceSha256': source_hashes[team_id],
            'records': len(parsed['entries']),
            'entries': parsed['entries'],
        }
        unresolved.extend(parsed['unresolved'])

    all_entries = [entry for roster in rosters.values() for entry in roster['entries']]
    complete = all(roster['coverage'] == 'complete' for roster in rosters.values())
    retrieved_at = max(timestamp(value) for value in checked_at.values()).isoformat()
    snapshot = {
        'schemaVersion': 1,
        'provider': 'cfu',
        'competitionKey': COMPETITION_KEY,
        'season': SEASON,
        'playersById': dict(sorted(players.items(),
                                   key=lambda item: int(item[1]['sourcePlayerId']))),
        'rostersByTeamId': rosters,
        'sourceMetadata': {
            'provider': 'cfu',
            'season': SEASON,
            'competitionUrl': COMPETITION_URL,
            'robotsUrl': ROBOTS_URL,
            'crawlDelaySeconds': CRAWL_DELAY_SECONDS,
            'retrieval': retrieval,
            'retrievedAt': retrieved_at,
            'playerProfilePattern': PLAYER_URL_PATTERN,
            'rosters': {
                'coverage': 'complete' if complete else 'partial',
                'teams': len(rosters),
                'records': len(all_entries),
                'players': len(players),
                'deregisteredRecords': sum(
                    1 for entry in all_entries if entry['deregisteredAt'] is not None),
                'checkedAt': retrieved_at,
                'reason': ('official_2026_club_rosters_parsed' if complete
                           else 'official_2026_club_rosters_incomplete'),
            },
        },
        'unresolvedRecords': unresolved,
    }
    return validate_rosters(snapshot, expected_team_ids=set(teams))


def load_rosters(path, expected_team_ids=None):
    path = Path(path)
    if not path.exists():
        return None
    try:
        snapshot = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InvalidCfuRosterData(f'Existing roster snapshot is unreadable: {exc}') from exc
    return validate_rosters(snapshot, expected_team_ids=expected_team_ids)


def load_teams(path):
    path = Path(path)
    require(path.exists(), f'Missing official CFU season snapshot: {path}')
    try:
        snapshot = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InvalidCfuRosterData(f'Official CFU season snapshot is unreadable: {exc}') from exc
    try:
        validate_snapshot(snapshot)
    except InvalidCfuData as exc:
        raise InvalidCfuRosterData(
            f'Official CFU season snapshot is invalid: {exc}') from exc
    require(len(snapshot['teamsById']) == 7, 'Season snapshot must contain seven clubs')
    return snapshot['teamsById']


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


def write_rosters(snapshot, output, public_output, expected_team_ids=None):
    """Validate once and publish the exact same bytes to both roster copies."""
    validate_rosters(snapshot, expected_team_ids=expected_team_ids)
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
            raise InvalidCfuRosterData(f'Cannot decode official HTML: {label}') from exc


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def fetch_pages(teams, delay=CRAWL_DELAY_SECONDS, timeout=30, save_html_dir=None):
    """Fetch exactly the seven official team pages in source order."""
    pages, checked_at, source_hashes = {}, {}, {}
    with requests.Session() as session:
        session.headers['User-Agent'] = USER_AGENT
        for index, team_id in enumerate(sorted(teams, key=lambda key: teams[key]['sourceTeamId'])):
            team = teams[team_id]
            if index and delay:
                time.sleep(delay)
            try:
                response = session.get(team['sourceUrl'], timeout=timeout)
                response.raise_for_status()
            except requests.RequestException as exc:
                raise InvalidCfuRosterData(
                    f'Source request failed: {team["sourceUrl"]}: {exc}') from exc
            require(response.status_code == 200,
                    f'Unexpected HTTP status: {response.status_code}')
            content_type = response.headers.get('Content-Type', '')
            if content_type:
                require('html' in content_type.lower(),
                        f'Unexpected content type: {content_type}')
            html = _decode(response.content, team['sourceUrl'])
            require(len(html) > 5000, f'Truncated source page: {team["sourceUrl"]}')
            pages[team_id] = html
            checked_at[team_id] = _utc_now()
            source_hashes[team_id] = hashlib.sha256(response.content).hexdigest()
            if save_html_dir:
                directory = Path(save_html_dir)
                directory.mkdir(parents=True, exist_ok=True)
                (directory / f'{team["sourceTeamId"]}.html').write_bytes(response.content)
    return pages, checked_at, source_hashes


def fetch_local(directory, teams):
    """Offline reproduction from previously saved official team HTML."""
    directory = Path(directory)
    pages, checked_at, source_hashes = {}, {}, {}
    for team_id, team in teams.items():
        slug = team['sourceTeamId']
        candidates = [directory / f'{slug}.html', directory / f'team-{slug}.html']
        path = next((candidate for candidate in candidates if candidate.exists()), None)
        require(path is not None, f'Missing local roster page for {slug}')
        raw = path.read_bytes()
        html = _decode(raw, str(path))
        require(len(html) > 5000, f'Truncated local roster page: {path}')
        pages[team_id] = html
        checked_at[team_id] = datetime.fromtimestamp(
            path.stat().st_mtime, timezone.utc).isoformat()
        source_hashes[team_id] = hashlib.sha256(raw).hexdigest()
    return pages, checked_at, source_hashes


def run_import(output, public_output, teams_path, fetch=fetch_pages,
               delay=CRAWL_DELAY_SECONDS, timeout=30,
               retrieval='direct_http'):
    """Import and atomically replace both copies; a failure keeps the old files."""
    teams = load_teams(teams_path)
    previous = load_rosters(output, expected_team_ids=set(teams))
    pages, checked_at, source_hashes = fetch(
        teams, delay=delay, timeout=timeout)
    snapshot = build_rosters(pages, teams, checked_at, retrieval,
                             source_hashes=source_hashes)
    if previous is not None and _all_complete(previous) and not _all_complete(snapshot):
        raise InvalidCfuRosterData(
            'Refusing to replace a complete roster snapshot with a partial source response')
    write_rosters(snapshot, output, public_output,
                  expected_team_ids=set(teams))
    return snapshot


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Import official CFU Premier League 2026 club rosters')
    parser.add_argument('--teams', type=Path,
                        default=Path('docs/cfu-premier-2026/snapshot.json'))
    parser.add_argument('--output', type=Path,
                        default=Path('docs/cfu-premier-rosters-2026/rosters.json'))
    parser.add_argument('--public-output', type=Path,
                        default=Path('cfu-premier-rosters-2026.json'))
    parser.add_argument('--delay', type=float, default=CRAWL_DELAY_SECONDS)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--html-dir', type=Path,
                        help='Read <slug>.html team pages instead of HTTP')
    parser.add_argument('--save-html-dir', type=Path,
                        help='Save fetched official HTML for local diagnostics')
    args = parser.parse_args(argv)
    try:
        if args.html_dir:
            teams = load_teams(args.teams)
            fetch = lambda *_, **__: fetch_local(args.html_dir, teams)
            retrieval = 'saved_official_html'
        else:
            fetch = lambda teams, delay, timeout: fetch_pages(
                teams, delay=delay, timeout=timeout,
                save_html_dir=args.save_html_dir)
            retrieval = 'direct_http'
        snapshot = run_import(args.output, args.public_output, args.teams,
                              fetch=fetch, delay=args.delay, timeout=args.timeout,
                              retrieval=retrieval)
    except (InvalidCfuRosterData, InvalidCfuData, OSError, ValueError) as exc:
        print(f'CFU roster import failed; roster snapshot not replaced: {exc}',
              file=sys.stderr)
        return 1
    summary = snapshot['sourceMetadata']['rosters']
    print(f'Wrote {args.output} and {args.public_output}: '
          f'{summary["teams"]} teams, {summary["players"]} players, '
          f'{summary["records"]} season records, '
          f'{summary["deregisteredRecords"]} deregistered')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
