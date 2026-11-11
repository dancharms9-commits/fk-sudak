"""Independent CFU Premier League 2026 match-protocol snapshot contract.

The calendar remains the source of the fixture identity.  A protocol is
attached only by its official match id and URL, and every substantive field is
cross-checked against that calendar.  Missing lineups or chronology are valid:
partial coverage must never be turned into invented events.
"""
from datetime import datetime
import re
from urllib.parse import urlparse

from scripts.cfu_premier_schema import (
    BASE, COMPETITION_KEY, COMPETITION_URL, CRAWL_DELAY_SECONDS, MATCH_STATUS,
    ROBOTS_URL, SEASON, official_match_number, validate_snapshot,
)
from scripts.cfu_premier_roster_schema import validate_rosters

MATCH_ID_PREFIX = 'cfu:match:'
PLAYER_ID_PREFIX = 'cfu:player:'
SHA256_RE = re.compile(r'[0-9a-f]{64}')
DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}')
TIME_RE = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')
MINUTE_RE = re.compile(r'(?:[1-9]\d?|1[01]\d|120)(?:\+(?:[1-9]|[12]\d|30))?')
COVERAGE = {'schedule', 'result', 'events', 'full'}
MISSING_SECTIONS = {'result', 'goals', 'events', 'lineups', 'chronology'}
EVENT_TYPES = {
    'goal', 'penalty', 'own_goal', 'missed_penalty', 'yellow',
    'second_yellow', 'red', 'substitution', 'substitution_in', 'substitution_out',
}
GOAL_TYPES = {'goal', 'penalty', 'own_goal'}
SIDES = {'home', 'away'}
UNRESOLVED_KINDS = {'protocol', 'protocol_section'}
MATCH_PAGE_PATTERN = f'{BASE}/matches/premier-leagueCFU/match_<id>/'


class InvalidCfuMatchData(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise InvalidCfuMatchData(message)


def timestamp(value, field='timestamp'):
    require(isinstance(value, str) and bool(value), f'Missing {field}')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise InvalidCfuMatchData(f'Invalid {field}') from exc
    require(parsed.tzinfo is not None, f'{field} needs a timezone')
    return parsed


def match_number(match_id):
    """Return the official numeric match id from a cfu:match:<id> key."""
    require(isinstance(match_id, str) and match_id.startswith(MATCH_ID_PREFIX),
            'Match id must use the cfu:match namespace')
    number = match_id[len(MATCH_ID_PREFIX):]
    require(bool(number) and number.isdigit() and number[0] != '0',
            'Invalid official match id')
    return number


def _official_match_url(url):
    return official_match_number(url) is not None


def _event(event, detail, rosters):
    require(isinstance(event, dict), 'Event must be an object')
    event_type = event.get('type')
    require(event_type in EVENT_TYPES, 'Invalid event type')
    side = event.get('side')
    require(side in SIDES, 'Invalid event side')
    team_id = detail['homeTeamId' if side == 'home' else 'awayTeamId']
    player = event.get('player')
    require(isinstance(player, str) and bool(player.strip()), 'Missing event player')
    minute = event.get('minute')
    require(minute is None or (isinstance(minute, str) and MINUTE_RE.fullmatch(minute)),
            'Invalid event minute')
    player_id = event.get('playerId')
    if player_id is not None:
        require(isinstance(player_id, str) and player_id.startswith(PLAYER_ID_PREFIX),
                'Player id must use the cfu:player namespace')
        if rosters is not None:
            require(player_id in rosters.get('playersById', {}), 'Unknown event player')
            roster = rosters.get('rostersByTeamId', {}).get(team_id)
            require(roster is not None, 'Missing roster for event team')
            require(any(entry.get('playerId') == player_id
                        for entry in roster.get('entries', [])),
                    'Event player is not in the verified team roster')
    score = event.get('score')
    if score is not None:
        require(isinstance(score, list) and len(score) == 2
                and all(type(value) is int and value >= 0 for value in score),
                'Invalid event score')
        require(event_type in GOAL_TYPES, 'Only goal events may carry a score')
    return event


def _lineups(lineups, detail, rosters):
    if lineups is None:
        return
    require(isinstance(lineups, dict), 'Lineups must be an object or null')
    seen = set()
    for side in ('home', 'away'):
        if side not in lineups:
            continue
        groups = lineups[side]
        require(isinstance(groups, dict), 'Lineup side must be an object')
        for group in ('starters', 'substitutes'):
            entries = groups.get(group)
            if entries is None:
                continue
            require(isinstance(entries, list), 'Lineup group must be a list')
            for entry in entries:
                require(isinstance(entry, dict), 'Lineup entry must be an object')
                player_id = entry.get('playerId')
                require(isinstance(player_id, str) and player_id.startswith(PLAYER_ID_PREFIX),
                        'Lineup player id must use the cfu:player namespace')
                require(player_id not in seen, 'Duplicate player in lineups')
                seen.add(player_id)
                name = entry.get('name')
                require(isinstance(name, str) and bool(name.strip()), 'Missing lineup player name')
                number = entry.get('number')
                require(number is None or (type(number) is int and 0 <= number <= 99),
                        'Invalid lineup shirt number')
                if rosters is not None:
                    require(player_id in rosters.get('playersById', {}),
                            'Unknown lineup player')
                    team_id = detail['homeTeamId' if side == 'home' else 'awayTeamId']
                    roster = rosters.get('rostersByTeamId', {}).get(team_id)
                    require(roster is not None, 'Missing roster for lineup team')
                    require(any(item.get('playerId') == player_id
                                for item in roster.get('entries', [])),
                            'Lineup player is not in the verified team roster')


def _detail(match_id, detail, calendar, rosters):
    require(isinstance(detail, dict), 'Protocol must be an object')
    number = match_number(match_id)
    require(detail.get('matchId') == match_id, 'Protocol key mismatch')
    require(detail.get('provider') == 'cfu', 'Wrong protocol provider')
    require(detail.get('sourceMatchId') == number, 'Protocol source id mismatch')
    source_url = detail.get('sourceUrl')
    require(_official_match_url(source_url), 'Invalid official match URL')
    require(official_match_number(source_url) == number, 'Protocol URL does not match its id')

    calendar_match = calendar.get('matchesById', {}).get(match_id)
    require(calendar_match is not None, 'Protocol match is not in the confirmed calendar')
    require(detail.get('homeTeamId') == calendar_match.get('homeTeamId'),
            'Protocol home team differs from the calendar')
    require(detail.get('awayTeamId') == calendar_match.get('awayTeamId'),
            'Protocol away team differs from the calendar')
    require(detail.get('homeTeamId') != detail.get('awayTeamId'),
            'A team cannot play itself')
    require(detail.get('round') == calendar_match.get('round'),
            'Protocol round differs from the calendar')
    if detail.get('date') is not None:
        require(isinstance(detail['date'], str) and DATE_RE.fullmatch(detail['date']),
                'Invalid protocol date')
        datetime.strptime(detail['date'], '%Y-%m-%d')
        if calendar_match.get('date') is not None:
            require(detail['date'] == calendar_match['date'],
                    'Protocol date differs from the calendar')
    if detail.get('time') is not None:
        require(isinstance(detail['time'], str) and TIME_RE.fullmatch(detail['time']),
                'Invalid protocol time')
        if calendar_match.get('time') is not None:
            require(detail['time'] == calendar_match['time'],
                    'Protocol time differs from the calendar')
    require(detail.get('venue') is None or isinstance(detail.get('venue'), str),
            'Invalid protocol venue')
    home, away = detail.get('homeScore'), detail.get('awayScore')
    require((home is None and away is None)
            or (type(home) is int and type(away) is int and home >= 0 and away >= 0),
            'Invalid or partial protocol score')
    if (home is not None and calendar_match.get('homeScore') is not None
            and calendar_match.get('awayScore') is not None):
        require((home, away) == (calendar_match['homeScore'], calendar_match['awayScore']),
                'Protocol score differs from the calendar')
    require(detail.get('status') is None or detail['status'] in MATCH_STATUS,
            'Invalid protocol status')
    require(detail.get('statusLabel') is None or isinstance(detail['statusLabel'], str),
            'Invalid protocol status label')
    require(detail.get('coverage') in COVERAGE, 'Invalid protocol coverage')
    missing = detail.get('missingSections')
    require(isinstance(missing, list) and len(missing) == len(set(missing))
            and all(section in MISSING_SECTIONS for section in missing),
            'Invalid missing protocol sections')
    require(type(detail.get('goalsComplete')) is bool, 'Invalid goalsComplete flag')
    require(type(detail.get('eventsComplete')) is bool, 'Invalid eventsComplete flag')
    timestamp(detail.get('checkedAt'), 'protocol checkedAt')
    require(isinstance(detail.get('sourceSha256'), str)
            and bool(SHA256_RE.fullmatch(detail['sourceSha256'])),
            'Invalid protocol source hash')

    events = detail.get('events')
    goals = detail.get('goals')
    require(isinstance(events, list), 'Protocol events must be a list')
    require(isinstance(goals, list), 'Protocol goals must be a list')
    for event in events:
        _event(event, detail, rosters)
    for goal in goals:
        require(isinstance(goal, dict), 'Goal must be an object')
        require(goal in events, 'Every goal must be present in the confirmed events')
        require(goal.get('type') in GOAL_TYPES, 'Invalid goal type')
    goal_events = [event for event in events if event.get('type') in GOAL_TYPES]
    require(goals == goal_events, 'Goals do not match goal events')
    if detail['goalsComplete'] and home is not None:
        require(sum(1 for event in goals if event.get('side') == 'home') == home
                and sum(1 for event in goals if event.get('side') == 'away') == away,
                'Goal count differs from the published score')
    if goals and home is None:
        raise InvalidCfuMatchData('Goals without a published score')

    _lineups(detail.get('lineups'), detail, rosters)


def _source(source, detail):
    require(isinstance(source, dict), 'Missing protocol source metadata')
    require(source.get('url') == detail.get('sourceUrl'), 'Protocol source URL mismatch')
    require(source.get('checkedAt') == detail.get('checkedAt'),
            'Protocol source checkedAt mismatch')
    require(source.get('sourceSha256') == detail.get('sourceSha256'),
            'Protocol source hash mismatch')
    require(source.get('httpStatus') == 200, 'Protocol was not fetched over HTTP 200')
    require(source.get('coverage') == detail.get('coverage'), 'Protocol source coverage mismatch')
    require(isinstance(source.get('reason'), str) and bool(source['reason']),
            'Missing protocol source reason')
    timestamp(source.get('checkedAt'), 'source checkedAt')


def validate_match_details(snapshot, calendar, rosters=None):
    """Validate the independent protocol snapshot against the confirmed calendar."""
    require(isinstance(snapshot, dict), 'Protocol snapshot must be an object')
    require(snapshot.get('schemaVersion') == 1, 'Unknown protocol schema version')
    require(snapshot.get('provider') == 'cfu', 'Wrong protocol provider')
    require(snapshot.get('competitionKey') == COMPETITION_KEY, 'Wrong competition key')
    require(snapshot.get('season') == SEASON, 'Wrong protocol season')

    # The calendar is the authority for match identity and fixture fields.
    validate_snapshot(calendar)
    if rosters is not None:
        validate_rosters(rosters, expected_team_ids=set(calendar['teamsById']))

    matches = snapshot.get('matchesById')
    require(isinstance(matches, dict), 'Missing protocol matches')
    for match_id, detail in matches.items():
        _detail(match_id, detail, calendar, rosters)

    metadata = snapshot.get('sourceMetadata')
    require(isinstance(metadata, dict), 'Missing protocol source metadata')
    require(metadata.get('provider') == 'cfu', 'Wrong metadata provider')
    require(metadata.get('season') == SEASON, 'Wrong metadata season')
    require(metadata.get('competitionUrl') == COMPETITION_URL, 'Wrong metadata competition URL')
    require(metadata.get('robotsUrl') == ROBOTS_URL, 'Wrong metadata robots URL')
    require(metadata.get('crawlDelaySeconds') == CRAWL_DELAY_SECONDS, 'Wrong crawl delay')
    require(metadata.get('matchPagePattern') == MATCH_PAGE_PATTERN,
            'Wrong match page pattern')
    require(isinstance(metadata.get('retrieval'), str) and bool(metadata['retrieval']),
            'Missing protocol retrieval method')
    timestamp(metadata.get('retrievedAt'), 'retrievedAt')
    if matches:
        latest = max(timestamp(detail['checkedAt'], 'protocol checkedAt')
                     for detail in matches.values())
        require(timestamp(metadata['retrievedAt'], 'retrievedAt') >= latest,
                'retrievedAt precedes a protocol check')
    sources = metadata.get('sources')
    require(isinstance(sources, dict) and set(sources) == set(matches),
            'Protocol sources do not match the imported matches')
    for detail in matches.values():
        _source(sources[detail['matchId']], detail)

    unresolved = snapshot.get('unresolvedRecords')
    require(isinstance(unresolved, list), 'unresolvedRecords must be a list')
    for record in unresolved:
        require(isinstance(record, dict), 'Invalid unresolved record')
        require(record.get('kind') in UNRESOLVED_KINDS, 'Invalid unresolved kind')
        require(isinstance(record.get('reason'), str) and bool(record['reason']),
                'Missing unresolved reason')
        require(isinstance(record.get('raw'), dict), 'Missing unresolved raw record')

    # No RFFK identifier may enter the independent CFU snapshot.
    all_ids = list(matches)
    for detail in matches.values():
        all_ids.extend([detail['homeTeamId'], detail['awayTeamId']])
        all_ids.extend(event['playerId'] for event in detail['events']
                       if event.get('playerId'))
    require(all(item.startswith('cfu:') for item in all_ids),
            'Non-CFU identifier in protocol snapshot')
    return snapshot
