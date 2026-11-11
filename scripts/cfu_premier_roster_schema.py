"""Independent CFU Premier League 2026 club-roster contract.

The rosters are a separate CFU namespace.  A player identity comes only from
the official ``/players/<id>/`` URL; club membership, position and shirt number
live in the season roster record.  A player may therefore have several club
records in the same season without merging them.
"""
from datetime import datetime
import json
import re
from urllib.parse import urlparse

BASE = 'https://www.cfu2015.com'
COMPETITION_KEY = 'cfu-premier-2026'
SEASON = 2026
COMPETITION_URL = f'{BASE}/matches/premier-leagueCFU/'
ROBOTS_URL = f'{BASE}/robots.txt'
CRAWL_DELAY_SECONDS = 40
PLAYER_URL_PATTERN = f'{BASE}/players/<id>/'

PLAYER_URL_RE = re.compile(r'/players/([1-9][0-9]*)/')
TEAM_URL_RE = re.compile(r'/teams/([a-z0-9][a-z0-9-]*)/')
DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}')
SHA256_RE = re.compile(r'[0-9a-f]{64}')

POSITION_GROUPS = {
    'Вратари': 'Вратарь',
    'Защитники': 'Защитник',
    'Полузащитники': 'Полузащитник',
    'Нападающие': 'Нападающий',
}
POSITIONS = set(POSITION_GROUPS.values())
STATUS = {'current', 'stale', 'temporarily_unavailable'}
COVERAGE = {'complete', 'partial', 'unknown'}
UNRESOLVED_KINDS = {'player', 'roster', 'team'}


class InvalidCfuRosterData(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise InvalidCfuRosterData(message)


def official_player_id(url):
    """Return the official numeric player id from an exact CFU player URL."""
    if not isinstance(url, str):
        return None
    parsed = urlparse(url)
    hit = PLAYER_URL_RE.fullmatch(parsed.path)
    if (parsed.scheme == 'https' and parsed.netloc == 'www.cfu2015.com'
            and not parsed.query and not parsed.fragment and hit):
        return hit[1]
    return None


def official_team_slug(url):
    if not isinstance(url, str):
        return None
    parsed = urlparse(url)
    hit = TEAM_URL_RE.fullmatch(parsed.path)
    if (parsed.scheme == 'https' and parsed.netloc == 'www.cfu2015.com'
            and not parsed.query and not parsed.fragment and hit):
        return hit[1]
    return None


def player_url(player_id):
    require(isinstance(player_id, str) and player_id.isdigit()
            and player_id[0] != '0', 'Invalid official player id')
    return f'{BASE}/players/{player_id}/'


def iso_date(value, field):
    require(isinstance(value, str) and DATE_RE.fullmatch(value),
            f'Invalid {field}')
    datetime.strptime(value, '%Y-%m-%d')
    return value


def timestamp(value):
    require(isinstance(value, str) and bool(value), 'Timestamp must be a string')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, 'Timestamp needs a timezone')
    return parsed


def _player(player_id, player):
    require(player_id.startswith('cfu:player:'), 'Player id must use the cfu namespace')
    source_id = player_id.removeprefix('cfu:player:')
    require(player.get('playerId') == player_id, 'Player key mismatch')
    require(player.get('provider') == 'cfu', 'Wrong player provider')
    require(player.get('sourcePlayerId') == source_id, 'Player source id mismatch')
    require(official_player_id(player.get('sourceUrl')) == source_id,
            'Player URL/id mismatch')
    require(isinstance(player.get('name'), str) and bool(player['name'].strip()),
            'Missing player name')
    if player.get('dateOfBirth') is not None:
        iso_date(player['dateOfBirth'], 'date of birth')


def _entry(entry, team_id, players, seen):
    require(isinstance(entry, dict), 'Roster entry must be an object')
    player_id = entry.get('playerId')
    require(player_id in players, f'Unknown roster player: {player_id}')
    require(player_id not in seen, f'Duplicate player in one roster: {player_id}')
    seen.add(player_id)
    position = entry.get('position')
    group = entry.get('positionGroup')
    require(position in POSITIONS, 'Invalid published position')
    require(group in POSITION_GROUPS, 'Invalid published position group')
    require(POSITION_GROUPS[group] == position, 'Position does not match its group')
    number = entry.get('shirtNumber')
    require(number is None or (type(number) is int and 1 <= number <= 99),
            'Invalid shirt number')
    registered = entry.get('registeredAt')
    deregistered = entry.get('deregisteredAt')
    registration_note = entry.get('registrationNote')
    require(registration_note is None
            or (isinstance(registration_note, str) and bool(registration_note.strip())),
            'Invalid registration note')
    require(registration_note is None or registered is not None,
            'Registration note without a registration date')
    if registered is not None:
        iso_date(registered, 'registration date')
    if deregistered is not None:
        iso_date(deregistered, 'deregistration date')
    # The official page can publish a later re-registration beside an earlier
    # deregistration (loan/transfer history).  Keep both exactly as published.
    return entry


def _roster(team_id, roster, players):
    require(team_id.startswith('cfu:team:'), 'Team id must use the cfu namespace')
    slug = team_id.removeprefix('cfu:team:')
    require(roster.get('teamId') == team_id, 'Roster key mismatch')
    require(roster.get('provider') == 'cfu', 'Wrong roster provider')
    require(roster.get('sourceTeamId') == slug, 'Roster source team id mismatch')
    require(official_team_slug(roster.get('sourceUrl')) == slug,
            'Roster team URL/id mismatch')
    timestamp(roster.get('checkedAt'))
    require(roster.get('httpStatus') == 200, 'Roster was not fetched over HTTP 200')
    require(roster.get('status') in STATUS, 'Invalid roster source status')
    require(roster.get('coverage') in COVERAGE, 'Invalid roster coverage')
    require(isinstance(roster.get('reason'), str) and bool(roster['reason']),
            'Missing roster source reason')
    require(isinstance(roster.get('sourceSha256'), str)
            and SHA256_RE.fullmatch(roster['sourceSha256']),
            'Invalid source HTML hash')
    entries = roster.get('entries')
    require(isinstance(entries, list), 'Roster entries must be a list')
    require(entries or roster['coverage'] != 'complete',
            'Complete roster cannot be empty')
    seen = set()
    for entry in entries:
        _entry(entry, team_id, players, seen)
    require(roster.get('records') == len(entries), 'Roster record count mismatch')
    return entries


def _source_metadata(metadata, rosters, players):
    require(isinstance(metadata, dict), 'Missing source metadata')
    require(metadata.get('provider') == 'cfu', 'Wrong metadata provider')
    require(metadata.get('season') == SEASON, 'Wrong metadata season')
    require(metadata.get('competitionUrl') == COMPETITION_URL,
            'Wrong metadata competition URL')
    require(metadata.get('robotsUrl') == ROBOTS_URL, 'Wrong robots URL')
    require(metadata.get('crawlDelaySeconds') == CRAWL_DELAY_SECONDS,
            'Wrong crawl delay')
    require(isinstance(metadata.get('retrieval'), str) and bool(metadata['retrieval']),
            'Missing retrieval method')
    timestamp(metadata.get('retrievedAt'))
    require(metadata.get('playerProfilePattern') == PLAYER_URL_PATTERN,
            'Wrong player profile pattern')
    summary = metadata.get('rosters')
    require(isinstance(summary, dict), 'Missing roster source summary')
    require(summary.get('coverage') in COVERAGE, 'Invalid roster source coverage')
    require(summary.get('teams') == len(rosters), 'Roster team count mismatch')
    entries = [entry for roster in rosters.values() for entry in roster['entries']]
    require(summary.get('records') == len(entries), 'Roster total record count mismatch')
    require(summary.get('players') == len(players), 'Roster player count mismatch')
    require(summary.get('deregisteredRecords')
            == sum(1 for entry in entries if entry['deregisteredAt'] is not None),
            'Deregistered record count mismatch')
    timestamp(summary.get('checkedAt'))
    require(isinstance(summary.get('reason'), str) and bool(summary['reason']),
            'Missing roster source reason')


def validate_rosters(snapshot, expected_team_ids=None):
    """Validate the independent roster snapshot. Returns the same object."""
    require(isinstance(snapshot, dict), 'Roster snapshot must be an object')
    require(snapshot.get('schemaVersion') == 1, 'Unknown roster schema version')
    require(snapshot.get('provider') == 'cfu', 'Wrong roster provider')
    require(snapshot.get('competitionKey') == COMPETITION_KEY,
            'Wrong roster competition key')
    require(snapshot.get('season') == SEASON, 'Wrong roster season')

    players = snapshot.get('playersById')
    require(isinstance(players, dict) and bool(players), 'Missing players')
    for player_id, player in players.items():
        _player(player_id, player)

    rosters = snapshot.get('rostersByTeamId')
    require(isinstance(rosters, dict) and bool(rosters), 'Missing rosters')
    if expected_team_ids is not None:
        require(set(rosters) == set(expected_team_ids),
                'Roster teams do not match the official season registry')
    else:
        require(len(rosters) == 7, 'Roster must contain all seven season clubs')

    referenced = set()
    for team_id, roster in rosters.items():
        entries = _roster(team_id, roster, players)
        referenced.update(entry['playerId'] for entry in entries)
    require(referenced == set(players), 'Players and roster entries do not match')

    _source_metadata(snapshot.get('sourceMetadata'), rosters, players)

    unresolved = snapshot.get('unresolvedRecords')
    require(isinstance(unresolved, list), 'unresolvedRecords must be a list')
    for record in unresolved:
        require(isinstance(record, dict), 'Invalid unresolved record')
        require(record.get('kind') in UNRESOLVED_KINDS, 'Invalid unresolved kind')
        require(isinstance(record.get('reason'), str) and bool(record['reason']),
                'Missing unresolved reason')
        require(isinstance(record.get('raw'), dict), 'Missing unresolved raw record')

    # The roster namespace must never acquire an RFFK identifier.
    all_ids = list(players) + list(rosters)
    all_ids += [entry['playerId'] for roster in rosters.values()
                for entry in roster['entries']]
    require(all(item.startswith('cfu:') for item in all_ids),
            'Non-CFU identifier in rosters')
    require('rffk' not in json.dumps(snapshot, ensure_ascii=False).lower(),
            'RFFK reference in rosters')
    return snapshot
