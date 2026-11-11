"""Independent CFU Premier League 2026 snapshot contract.

The CFU competition is intentionally kept out of the RFFK platform schema.
Every identity uses the separate ``cfu:`` namespace.  No RFFK club or match
is referenced, and no club is joined across providers by name or city.
"""
from datetime import datetime
import re
from urllib.parse import urlparse

BASE = 'https://www.cfu2015.com'
COMPETITION_KEY = 'cfu-premier-2026'
COMPETITION_NAME = 'Чемпионат Премьер-лиги Крымского футбольного союза'
SEASON = 2026
TABLE_URL = f'{BASE}/matches/premier-leagueCFU/table/?season={SEASON}'
CALENDAR_URL = f'{BASE}/matches/premier-leagueCFU/calendar/?season={SEASON}'
TEAMS_URL = f'{BASE}/matches/premier-leagueCFU/teams/?season={SEASON}'
COMPETITION_URL = f'{BASE}/matches/premier-leagueCFU/'
ROBOTS_URL = f'{BASE}/robots.txt'

# Published by https://www.cfu2015.com/robots.txt on 2026-11-11.
CRAWL_DELAY_SECONDS = 40

STATUS = {'current', 'stale', 'temporarily_unavailable'}
COVERAGE = {'complete', 'partial', 'unknown'}
MATCH_STATUS = {'finished', 'technical', 'scheduled', 'postponed', 'cancelled', 'suspended'}

TEAM_URL_RE = re.compile(r'/teams/([a-z0-9][a-z0-9-]*)/')
MATCH_URL_RE = re.compile(r'/matches/premier-leagueCFU/match_([1-9][0-9]*)/')
DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}')
TIME_RE = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')


class InvalidCfuData(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise InvalidCfuData(message)


def official_team_slug(url):
    """Return the official CFU team slug, never a name-derived identifier."""
    if not isinstance(url, str):
        return None
    parsed = urlparse(url)
    hit = TEAM_URL_RE.fullmatch(parsed.path)
    if (parsed.scheme == 'https' and parsed.netloc == 'www.cfu2015.com'
            and not parsed.query and not parsed.fragment and hit):
        return hit[1]
    return None


def official_match_number(url):
    """Return the official CFU match number from its exact match URL."""
    if not isinstance(url, str):
        return None
    parsed = urlparse(url)
    hit = MATCH_URL_RE.fullmatch(parsed.path)
    if (parsed.scheme == 'https' and parsed.netloc == 'www.cfu2015.com'
            and not parsed.query and not parsed.fragment and hit):
        return hit[1]
    return None


def official_page(url, expected):
    return (isinstance(url, str) and url == expected
            and url.startswith(BASE + '/matches/premier-leagueCFU/'))


def timestamp(value):
    require(isinstance(value, str) and bool(value), 'Timestamp must be a string')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, 'Timestamp needs a timezone')
    return parsed


def normalize_name(value):
    """Normalize only for an in-source registry lookup, never cross-provider."""
    require(isinstance(value, str) and bool(value.strip()), 'Missing published name')
    value = value.replace('ё', 'е').replace('Ё', 'Е')
    for quote in '«»„“”':
        value = value.replace(quote, '"')
    return re.sub(r'\s+', ' ', value).strip().casefold()


def _team(team_id, team):
    require(team_id.startswith('cfu:team:'), 'Team id must use the cfu namespace')
    require(team.get('teamId') == team_id, 'Team key mismatch')
    require(team.get('provider') == 'cfu', 'Wrong team provider')
    slug = official_team_slug(team.get('sourceUrl'))
    require(slug is not None, 'Invalid official team URL')
    require(team.get('sourceTeamId') == slug, 'Team source id mismatch')
    require(team_id == f'cfu:team:{slug}', 'Team id does not match its URL')
    require(isinstance(team.get('name'), str) and bool(team['name'].strip()), 'Missing team name')
    require(team.get('city') is None or isinstance(team.get('city'), str), 'Invalid city')
    require(team.get('identityConfidence') == 'official_team_page', 'Unconfirmed team identity')


def _match(match_id, match, teams):
    require(match_id.startswith('cfu:match:'), 'Match id must use the cfu namespace')
    require(match.get('matchId') == match_id, 'Match key mismatch')
    require(match.get('provider') == 'cfu', 'Wrong match provider')
    number = match.get('sourceMatchId')
    require(isinstance(number, str) and number.isdigit(), 'Invalid source match id')
    require(official_match_number(match.get('sourceUrl')) == number, 'Match URL/id mismatch')
    require(type(match.get('round')) is int and match['round'] > 0, 'Invalid round')
    require(type(match.get('circle')) is int and match['circle'] > 0, 'Invalid circle')
    require(match.get('homeTeamId') in teams and match.get('awayTeamId') in teams,
            'Unknown match team')
    require(match['homeTeamId'] != match['awayTeamId'], 'A team cannot play itself')
    if match.get('date') is not None:
        require(isinstance(match['date'], str) and DATE_RE.fullmatch(match['date']),
                'Invalid match date')
        datetime.strptime(match['date'], '%Y-%m-%d')
    if match.get('time') is not None:
        require(isinstance(match['time'], str) and TIME_RE.fullmatch(match['time']),
                'Invalid match time')
    require(match.get('timeZone') in (None, 'Europe/Moscow'), 'Invalid match time zone')
    require(match.get('venue') is None or isinstance(match['venue'], str), 'Invalid venue')
    home, away = match.get('homeScore'), match.get('awayScore')
    require((home is None and away is None)
            or (type(home) is int and type(away) is int and home >= 0 and away >= 0),
            'Invalid or partial score')
    require(match.get('status') is None or match['status'] in MATCH_STATUS,
            'Invalid match status')
    require(match.get('statusLabel') is None or isinstance(match['statusLabel'], str),
            'Invalid status label')


def _standing(row, teams):
    required = ('rank', 'teamId', 'played', 'wins', 'draws', 'losses',
                'goalsFor', 'goalsAgainst', 'goalDifference', 'points')
    for key in required:
        require(key in row, f'Missing standings field: {key}')
    require(type(row['rank']) is int and row['rank'] > 0, 'Invalid rank')
    require(row['teamId'] in teams, 'Unknown standings team')
    for key in ('played', 'wins', 'draws', 'losses', 'goalsFor', 'goalsAgainst', 'points'):
        require(type(row[key]) is int and row[key] >= 0, f'Invalid standings value: {key}')
    require(type(row['goalDifference']) is int, 'Invalid goal difference')
    require(row['wins'] + row['draws'] + row['losses'] == row['played'],
            'Standings played/wins/draws/losses mismatch')
    require(row['goalsFor'] - row['goalsAgainst'] == row['goalDifference'],
            'Standings goal difference mismatch')


def _source_section(section, expected_url, records):
    require(isinstance(section, dict), 'Missing source section')
    require(official_page(section.get('url'), expected_url), 'Unexpected source URL')
    timestamp(section.get('checkedAt'))
    require(section.get('status') in STATUS, 'Invalid source status')
    require(section.get('coverage') in COVERAGE, 'Invalid source coverage')
    require(section.get('httpStatus') == 200, 'Source was not fetched over HTTP 200')
    require(section.get('records') == records, 'Source record count mismatch')
    require(isinstance(section.get('reason'), str) and bool(section['reason']),
            'Missing source reason')


def validate_snapshot(snapshot):
    """Validate the independent CFU snapshot. Returns the same object."""
    require(isinstance(snapshot, dict), 'Snapshot must be an object')
    require(snapshot.get('schemaVersion') == 1, 'Unknown snapshot schema version')
    require(snapshot.get('provider') == 'cfu', 'Wrong snapshot provider')
    require(snapshot.get('competitionKey') == COMPETITION_KEY, 'Wrong competition key')
    require(snapshot.get('competitionName') == COMPETITION_NAME, 'Wrong competition name')
    require(snapshot.get('season') == SEASON, 'Wrong season')
    require(snapshot.get('competitionUrl') == COMPETITION_URL, 'Wrong competition URL')

    teams = snapshot.get('teamsById')
    require(isinstance(teams, dict) and bool(teams), 'Missing teams')
    for team_id, team in teams.items():
        _team(team_id, team)

    matches = snapshot.get('matchesById')
    require(isinstance(matches, dict) and bool(matches), 'Missing matches')
    seen_numbers, seen_urls = set(), set()
    for match_id, match in matches.items():
        _match(match_id, match, teams)
        require(match['sourceMatchId'] not in seen_numbers, 'Duplicate source match id')
        require(match['sourceUrl'] not in seen_urls, 'Duplicate source match URL')
        seen_numbers.add(match['sourceMatchId'])
        seen_urls.add(match['sourceUrl'])

    standings = snapshot.get('standings')
    require(isinstance(standings, dict), 'Missing standings')
    require(type(standings.get('asOfRound')) is int and standings['asOfRound'] > 0,
            'Invalid standings round')
    require(official_page(standings.get('sourceUrl'), TABLE_URL), 'Wrong standings source')
    rows = standings.get('rows')
    require(isinstance(rows, list) and len(rows) == len(teams), 'Incomplete standings')
    for row in rows:
        _standing(row, teams)
    require([row['rank'] for row in rows] == list(range(1, len(rows) + 1)),
            'Standings rows are not in official order')
    require({row['teamId'] for row in rows} == set(teams), 'Standings teams mismatch')

    metadata = snapshot.get('sourceMetadata')
    require(isinstance(metadata, dict), 'Missing source metadata')
    require(metadata.get('provider') == 'cfu', 'Wrong metadata provider')
    require(metadata.get('season') == SEASON, 'Wrong metadata season')
    require(metadata.get('competitionUrl') == COMPETITION_URL, 'Wrong metadata competition URL')
    require(metadata.get('robotsUrl') == ROBOTS_URL, 'Wrong robots URL')
    require(metadata.get('crawlDelaySeconds') == CRAWL_DELAY_SECONDS, 'Wrong crawl delay')
    require(isinstance(metadata.get('retrieval'), str) and bool(metadata['retrieval']),
            'Missing retrieval method')
    timestamp(metadata.get('retrievedAt'))
    sections = metadata.get('sections')
    require(isinstance(sections, dict), 'Missing source sections')
    _source_section(sections.get('teams'), TEAMS_URL, len(teams))
    _source_section(sections.get('table'), TABLE_URL, len(rows))
    _source_section(sections.get('calendar'), CALENDAR_URL, len(matches))
    calendar_section = sections['calendar']
    require(type(calendar_section.get('circles')) is int and calendar_section['circles'] > 0,
            'Invalid circle count')
    require(type(calendar_section.get('rounds')) is int and calendar_section['rounds'] > 0,
            'Invalid round count')
    require(max(match['circle'] for match in matches.values()) == calendar_section['circles'],
            'Circle count mismatch')
    require(max(match['round'] for match in matches.values()) == calendar_section['rounds'],
            'Round count mismatch')

    unresolved = snapshot.get('unresolvedRecords')
    require(isinstance(unresolved, list), 'unresolvedRecords must be a list')
    for record in unresolved:
        require(isinstance(record, dict), 'Invalid unresolved record')
        require(record.get('kind') in {'team', 'match', 'standing'}, 'Invalid unresolved kind')
        require(isinstance(record.get('reason'), str) and bool(record['reason']),
                'Missing unresolved reason')
        require(isinstance(record.get('raw'), dict), 'Missing unresolved raw record')

    # This is the core isolation rule: no RFFK identifier may enter this object.
    all_ids = list(teams) + list(matches) + [row['teamId'] for row in rows]
    require(all(item.startswith('cfu:') for item in all_ids), 'Non-CFU identifier in snapshot')
    return snapshot
