"""Additive, ID-based platform projection and isolated official standings import.

No writes to legacy fields, no player-name/team-name joins, no leaderboard totals.
Without a loader this is deterministic and performs no network requests.
"""
import copy
from datetime import datetime, timezone
import re

import requests
from bs4 import BeautifulSoup

from scripts.multi_club_schema import (
    BASE, CLUBS, SEASON_KEY, SEASON_URL, TEAM_IDS, STATS,
    InvalidPlatform, require, source_id, validate_platform,
)


def quality(url, status='stale', reason='imported_snapshot', verified=None, coverage='partial', checked=None):
    return {'status': status, 'coverage': coverage, 'sourceUrl': url,
            'checkedAt': checked, 'lastSuccessAt': verified,
            'lastVerifiedAt': verified, 'reason': reason}


def fetch_season():
    response = requests.get(SEASON_URL, timeout=30,
                            headers={'User-Agent': 'FKSudakPWA/multi-club-data-v1'})
    response.raise_for_status()
    return BeautifulSoup(response.text, 'html.parser')


def parse_standings(soup):
    """Only full season rows with explicit official team URLs, not the teaser."""
    heading = soup.select_one('.team_top_title') or soup.find('h1')
    require(heading is not None and 'Сезон 2026/2026' in heading.get_text(' ', strip=True), 'Wrong season')
    require('Открытый Чемпионат Республики Крым среди мужских любительских команд'
            in heading.get_text(' ', strip=True), 'Wrong tournament')
    links = soup.select('.breadcrumbs a[href]')
    require(any(a['href'] in (BASE + '/tournaments/4/', SEASON_URL) for a in links), 'Wrong tournament ID')
    sections = soup.select('.champ_data_table .tour_table')
    require(len(sections) == 1, 'Missing or ambiguous full standings')
    rows = []
    for row in sections[0].select(':scope > .line'):
        link, place = row.select_one('.team a[href]'), row.select_one('.place')
        if link is None:
            continue
        tid = source_id(link['href'], 'teams')
        require(tid in TEAM_IDS, 'Unconfirmed standings participant')
        cells = []
        for index in range(1, 8):
            cell = row.select_one(f'.total [data-col="{index}"]')
            require(cell is not None, 'Missing standings value')
            cells.append(cell.get_text(' ', strip=True))
        require(place is not None, 'Missing rank')
        rank = place.get_text(' ', strip=True).split()[0]  # exclude movement indicator
        require(rank.isdigit() and all(cells[i].isdigit() for i in (0, 1, 2, 3, 6)), 'Invalid standings number')
        goals = re.fullmatch(r'(\d+)\s*[-–]\s*(\d+)', cells[4])
        require(goals is not None and re.fullmatch(r'-?\d+', cells[5]), 'Invalid goal totals')
        rows.append({'rank': int(rank), 'teamId': tid, 'played': int(cells[0]),
                     'wins': int(cells[1]), 'draws': int(cells[2]), 'losses': int(cells[3]),
                     'goalsFor': int(goals[1]), 'goalsAgainst': int(goals[2]),
                     'goalDifference': int(cells[5]), 'points': int(cells[6])})
    require(len(rows) == 11 and {r['teamId'] for r in rows} == TEAM_IDS, 'Incomplete standings')
    require([r['rank'] for r in rows] == list(range(1, 12)), 'Wrong official order')
    for row in rows:
        require(row['wins'] + row['draws'] + row['losses'] == row['played']
                and row['goalsFor'] - row['goalsAgainst'] == row['goalDifference'], 'Inconsistent standings')
    return rows


def empty_platform(data):
    teams = {}
    for tid, name, city, logo in CLUBS:
        url = f'{BASE}/teams/{tid}/'
        teams[tid] = {'teamId': tid, 'sourceTeamId': tid, 'provider': 'rffk',
                      'name': name, 'city': city, 'sourceUrl': url,
                      'branding': {'officialLogoUrl': f'{BASE}/uploads/clubs/small/{logo}', 'accent': None},
                      'quality': quality(url, reason='registry_audit_2026-11-10', coverage='complete')}
    season = {'competitionId': '4', 'seasonId': '22', 'seasonYear': 2026,
              'label': '2026/2026', 'participantTeamIds': [c[0] for c in CLUBS],
              'quality': quality(SEASON_URL, reason='registry_audit_2026-11-10', coverage='complete')}
    rosters = {f'4:22:{tid}': {'teamId': tid, 'competitionId': '4', 'seasonId': '22',
                'playerIds': [], 'quality': quality(f'{BASE}/teams/{tid}/', status='not_checked',
                reason='roster_not_imported', coverage='unknown')} for tid, *_ in CLUBS}
    return {'schemaVersion': 1, 'provider': 'rffk', 'sourceUpdatedAt': data['updated'],
            'teamsById': teams, 'competitionSeasons': {SEASON_KEY: season},
            'playersById': {}, 'registrations': {}, 'rosters': rosters,
            'matchesById': {}, 'standings': {SEASON_KEY: {
                'competitionId': '4', 'seasonId': '22', 'rows': [],
                'quality': quality(SEASON_URL, status='not_checked', reason='standings_not_imported', coverage='unknown')}},
            'playerSeasonStats': {}, 'protocolsByMatchId': {},
            'scorerLeaderboard': {}, 'newsById': {},
            'legacyLinks': {'players': {}, 'matches': {}},
            'unresolvedSourceRecords': {'teamsById': {}, 'matchesById': {}}}


def project_snapshot(data, previous=None, source_updated_at=None):
    """Pure legacy projection. Only source IDs establish identity or membership."""
    if previous is not None:
        validate_platform(previous)
    p = copy.deepcopy(previous) if previous is not None else empty_platform(data)
    p['sourceUpdatedAt'] = source_updated_at or data['updated']
    hub = data['championship']
    require(hub['season'] == 2026 and hub['competition_id'] == '4', 'Wrong legacy championship')
    calendar = hub['calendar']
    unresolved = p['unresolvedSourceRecords']
    for t in calendar['teams']:
        if t['id'] not in TEAM_IDS:
            unresolved['teamsById'][t['id']] = {'record': copy.deepcopy(t), 'reason': 'identity_not_confirmed'}
    for raw in calendar['matches']:
        key = raw['id']
        if raw['home_id'] not in TEAM_IDS or raw['away_id'] not in TEAM_IDS:
            unresolved['matchesById'][key] = {'record': copy.deepcopy(raw), 'reason': 'identity_not_confirmed'}
            continue
        p['matchesById'][key] = {
            'matchId': key, 'competitionId': '4', 'seasonId': '22', 'roundId': raw['round_id'],
            'homeTeamId': raw['home_id'], 'awayTeamId': raw['away_id'],
            'sourceMatchId': raw['source_id'], 'sourceUrl': raw['source_url'],
            'date': raw['date'], 'time': raw['time'], 'timeZone': 'Europe/Moscow', 'venue': raw['venue'],
            'homeScore': raw['home_score'], 'awayScore': raw['away_score'], 'status': raw['status'],
            'quality': quality(SEASON_URL, verified=calendar.get('updated'))}
    # Preserve per-player identity via profile URL. The legacy producer has
    # already verified the Sudak/2026 context; do not rejoin SQUAD by names.
    stats = data['player_stats_2026']
    require(stats['season'] == 2026 and stats['source_url'] == BASE + '/tournaments/4/', 'Wrong player context')
    mapping = {'games': 'league_games', 'goals': 'league_goals', 'penaltyGoals': 'league_penalty_goals',
               'minutes': 'league_minutes', 'starts': 'league_starts', 'substitutions': 'league_substitutions'}
    roster = p['rosters']['4:22:141']
    player_ids = []
    for raw in stats['players']:
        pid = source_id(raw.get('profile_url'), 'players')
        if pid is None:
            continue  # no synthetic ID from name; old format remains untouched
        require(pid not in player_ids, 'Duplicate Sudak player ID')
        player_ids.append(pid)
        p['playersById'][pid] = {**p['playersById'].get(pid, {}), 'playerId': pid, 'name': raw['name'], 'sourceUrl': raw['profile_url'],
                                'quality': quality(raw['profile_url'])}
        p['legacyLinks']['players']['rffk-' + pid] = pid
        old = p['playerSeasonStats'].get(f'{pid}:141:4:22', {})
        # stats_as_of is aggregate: another player's success must never make a
        # cached individual's values freshly verified. Missing stats_current
        # denotes the legacy leaderboard projection, not a profile import.
        verified = (stats.get('stats_as_of') if raw.get('stats_current') is True
                    else old.get('quality', {}).get('lastVerifiedAt'))
        row = {'playerId': pid, 'teamId': '141', 'competitionId': '4', 'seasonId': '22',
               'sourceUrl': raw['profile_url'], **{field: None for field in STATS},
               'quality': quality(raw['profile_url'], verified=verified)}
        if type(raw.get('stats_current')) is bool:
            row.update({field: raw.get(source) for field, source in mapping.items()})
        for field in STATS:
            if row[field] is None and old.get(field) is not None:
                row[field] = old[field]
                row['quality']['reason'] = 'last_good_statistic'
                row['quality']['lastVerifiedAt'] = old['quality']['lastVerifiedAt']
                row['quality']['lastSuccessAt'] = old['quality']['lastSuccessAt']
        p['playerSeasonStats'][f'{pid}:141:4:22'] = row
    roster['playerIds'] = list(dict.fromkeys(roster['playerIds'] + player_ids))
    roster['quality'] = quality(BASE + '/teams/141/', coverage='partial')
    # Lineups provide official profile URLs, not a season roster or totals.
    # Import their identities only; text-only event actors remain unresolved.
    by_source = {m['sourceMatchId']: m for m in p['matchesById'].values() if m['sourceMatchId']}
    for legacy_key, raw in data['match_details'].items():
        m = by_source.get(str(raw.get('id')))
        if (raw.get('status') != 'available' or not m
                or source_id(raw.get('source_url'), 'matches') != m['sourceMatchId']
                or raw.get('date') != m['date']
                or [raw.get('home_score'), raw.get('away_score')] != [m['homeScore'], m['awayScore']]):
            continue
        lineups = {}
        for side, groups in raw.get('lineups', {}).items():
            lineups[side] = {}
            for group, entries in groups.items():
                lineups[side][group] = []
                for entry in entries:
                    pid = source_id(entry.get('profile_url'), 'players')
                    require(pid is not None, 'Unverified lineup identity')
                    p['playersById'].setdefault(pid, {'playerId': pid, 'name': entry['name'],
                        'sourceUrl': entry['profile_url'], 'quality': quality(entry['profile_url'])})
                    lineups[side][group].append({'playerId': pid, 'sourceUrl': entry['profile_url'],
                                                 'number': entry['number']})
        events = []
        for raw_event in raw.get('events', []):
            side = raw_event['side']
            require(side in {'home', 'away'}, 'Invalid event side')
            # teamId is the source column/credited side, NOT necessarily the
            # actor's club for an own goal; no disciplinary totals are derived.
            events.append({'type': raw_event['type'], 'teamId': m[side + 'TeamId'],
                'playerId': None, 'sourceLabel': raw_event['player'], 'minute': raw_event['minute'],
                'score': copy.deepcopy(raw_event.get('score'))})
        p['protocolsByMatchId'][m['matchId']] = {'matchId': m['matchId'],
            'sourceMatchId': m['sourceMatchId'], 'sourceUrl': m['sourceUrl'],
            'homeTeamId': m['homeTeamId'], 'awayTeamId': m['awayTeamId'],
            'date': m['date'], 'homeScore': m['homeScore'], 'awayScore': m['awayScore'],
            'eventsComplete': raw.get('events_complete', False), 'lineups': lineups, 'events': events,
            'quality': quality(m['sourceUrl'])}
        p['legacyLinks']['matches'][legacy_key] = m['matchId']
    validate_platform(p, previous)
    return p


def update_platform(data, previous=None, loader=None, checked_at=None, source_updated_at=None):
    """A standings outage cannot erase the other clubs or legacy Sudak data."""
    p = project_snapshot(data, previous, source_updated_at=source_updated_at)
    if loader is not None:
        now = checked_at or datetime.now(timezone.utc).isoformat(timespec='seconds')
        table = p['standings'][SEASON_KEY]
        try:
            rows = parse_standings(loader())
            table['rows'] = rows
            table['quality'] = quality(SEASON_URL, status='current', reason='official_full_season_table',
                                       verified=now, checked=now, coverage='complete')
        except (requests.RequestException, ValueError, TypeError, AttributeError) as exc:
            q = table['quality']
            q.update(status='stale' if table['rows'] else 'temporarily_unavailable', checkedAt=now,
                     reason='standings_source_unavailable', lastAttemptStatus='temporarily_unavailable',
                     errorCode=type(exc).__name__)
    validate_platform(p, previous)
    return p
