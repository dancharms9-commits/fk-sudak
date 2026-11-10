"""Version 1 platform contract. No UI dependencies and no name-based joins."""
from datetime import date, datetime
import re
from urllib.parse import urlparse

BASE = 'https://rffk-roo.ru'
SEASON_URL = BASE + '/tournaments/4/seasons/22/'
SEASON_KEY = '4:22'
# Registry audited in docs/multi-club-platform/architecture.md, not inferred
# from calendar placeholders or the mutable current tournament page.
CLUBS = (
    ('141', 'ФК «Судак»', 'Судак', 'I9XYryJ4.png'),
    ('936', 'СК «Каштан»', 'Каштановое', 'JGs7cv0n.png'),
    ('1030', '«СТО-Газель»', 'Новосельцево', 'tO46qCym.png'),
    ('932', 'ФК «Фуна»', 'Алушта', 'GT03HExw.png'),
    ('521', 'АФК', 'Евпатория', 'wMEHGLAW.png'),
    ('930', 'ФК «НКСТРОЙ-Керчь»', 'Керчь', '0wasEISv.png'),
    ('146', 'ФК «Саки»', 'Саки', '0G9V2YKE.png'),
    ('934', 'ФК «Сталкер»', 'Евпатория', 'ZP6yNKMk.png'),
    ('757', 'ФК «Турбо»', 'Керчь', '4Q2fW6Qx.png'),
    ('1028', '«Темп»', 'Раздольное', 'aBN26wGY.png'),
    ('117', 'УОР', 'Краснолесье', 'ZG8Em4Kb.png'),
)
TEAM_IDS = frozenset(row[0] for row in CLUBS)
STATS = ('games', 'goals', 'penaltyGoals', 'minutes', 'starts', 'substitutions',
         'yellowCards', 'secondYellowCards', 'redCards')
STATUS = {'current', 'stale', 'not_published', 'temporarily_unavailable', 'not_checked'}
COLLECTIONS = ('teamsById', 'competitionSeasons', 'playersById', 'registrations',
               'rosters', 'matchesById', 'standings', 'playerSeasonStats',
               'protocolsByMatchId', 'scorerLeaderboard', 'newsById')
MATCH_STATUSES = {'finished', 'technical', 'scheduled', 'postponed', 'cancelled', 'suspended'}
EVENT_TYPES = {'goal', 'own_goal', 'penalty', 'missed_penalty', 'yellow', 'second_yellow',
               'red', 'substitution', 'substitution_in', 'substitution_out'}


class InvalidPlatform(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise InvalidPlatform(message)


def source_id(url, kind):
    """Only an exact official URL is an identity; never names or query strings."""
    if not isinstance(url, str):
        return None
    parsed = urlparse(url)
    hit = re.fullmatch(r'/' + kind + r'/([1-9][0-9]*)/', parsed.path)
    return hit[1] if (parsed.scheme == 'https' and parsed.netloc == 'rffk-roo.ru'
                      and not parsed.query and not parsed.fragment and hit) else None


def stamp(value):
    require(isinstance(value, str), 'Timestamp must be a string')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, 'Timestamp needs a timezone')
    return parsed


def official_url(url):
    if not isinstance(url, str):
        return False
    parsed = urlparse(url)
    return (parsed.scheme == 'https' and parsed.netloc == 'rffk-roo.ru'
            and not parsed.query and not parsed.fragment)


def quality(q):
    require(isinstance(q, dict) and q['status'] in STATUS, 'Invalid quality status')
    require(q['coverage'] in {'complete', 'partial', 'unknown'}, 'Invalid coverage')
    require(official_url(q['sourceUrl']), 'Invalid quality source')
    for key in ('checkedAt', 'lastSuccessAt', 'lastVerifiedAt'):
        if q[key] is not None:
            stamp(q[key])
    require(isinstance(q['reason'], str) and bool(q['reason']), 'Missing quality reason')
    if q['status'] == 'current':
        require(q['lastVerifiedAt'] is not None, 'Current data needs verification time')
    if 'lastAttemptStatus' in q:
        require(q['lastAttemptStatus'] in STATUS, 'Invalid attempt status')


def context(record, teams=TEAM_IDS):
    require(record['competitionId'] == '4' and record['seasonId'] == '22', 'Wrong context')
    if 'teamId' in record:
        require(record['teamId'] in teams, 'Unknown team reference')


def number(value, nullable=False):
    require((nullable and value is None) or (type(value) is int and value >= 0),
            'Expected a nonnegative integer or permitted null')


def match_record(key, m, teams):
    context(m, teams)
    require(m['matchId'] == key, 'Match key mismatch')
    require(m['homeTeamId'] in teams and m['awayTeamId'] in teams
            and m['homeTeamId'] != m['awayTeamId'], 'Invalid match teams')
    require(isinstance(m['roundId'], str) and m['roundId'].isdigit(), 'Invalid round')
    require(key == f"4:2026:{m['roundId']}:{m['homeTeamId']}:{m['awayTeamId']}",
            'Match identity differs from its team IDs')
    require(m['status'] in MATCH_STATUSES, 'Invalid match status')
    for field in ('homeScore', 'awayScore'):
        number(m[field], nullable=True)
    require((m['homeScore'] is None) == (m['awayScore'] is None), 'Incomplete score')
    if m['status'] not in {'finished', 'technical'}:
        require(m['homeScore'] is None, 'Unplayed match cannot have a score')
    if m['date'] is not None:
        require(date.fromisoformat(m['date']).year == 2026, 'Wrong match year')
    require(m['time'] is None or (isinstance(m['time'], str)
            and re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', m['time'])), 'Invalid match time')
    require(m['timeZone'] == 'Europe/Moscow', 'Wrong timezone')
    require(m['venue'] is None or isinstance(m['venue'], str), 'Invalid venue')
    if m['sourceMatchId'] is None:
        require(m['sourceUrl'] is None, 'URL without match identity')
    else:
        require(source_id(m['sourceUrl'], 'matches') == m['sourceMatchId'], 'Wrong protocol URL')
    quality(m['quality'])


def validate_platform(p, previous=None):
    """Validate populated models and their foreign keys; old root JSON is optional."""
    try:
        require(isinstance(p, dict) and type(p['schemaVersion']) is int
                and p['schemaVersion'] == 1 and p['provider'] == 'rffk', 'Unknown platform schema')
        stamp(p['sourceUpdatedAt'])
        for name in COLLECTIONS:
            require(isinstance(p[name], dict), 'Invalid collection: ' + name)
        teams = p['teamsById']
        require(set(teams) == TEAM_IDS and len(teams) == 11, 'Expected exactly 11 clubs')
        for key, t in teams.items():
            require(t['teamId'] == key and t['sourceTeamId'] == key and t['provider'] == 'rffk',
                    'Club identity mismatch')
            require(source_id(t['sourceUrl'], 'teams') == key, 'Wrong club URL')
            require(isinstance(t['name'], str) and bool(t['name']), 'Missing team name')
            require(isinstance(t['city'], str), 'Invalid city')
            require(official_url(t['branding']['officialLogoUrl']), 'Unsafe logo')
            require(t['branding']['accent'] is None, 'Unaudited branding')
            quality(t['quality'])
        seasons = p['competitionSeasons']
        require(set(seasons) == {SEASON_KEY}, 'Unexpected season')
        season = seasons[SEASON_KEY]
        context(season)
        require(season['seasonYear'] == 2026 and season['label'] == '2026/2026', 'Wrong season')
        require(len(season['participantTeamIds']) == 11
                and set(season['participantTeamIds']) == TEAM_IDS, 'Invalid participants')
        quality(season['quality'])
        players = p['playersById']
        for key, player in players.items():
            require(player['playerId'] == key and source_id(player['sourceUrl'], 'players') == key,
                    'Player identity mismatch')
            require(isinstance(player['name'], str) and bool(player['name'].strip()), 'Missing player name')
            quality(player['quality'])
        require(set(p['rosters']) == {f'4:22:{tid}' for tid in TEAM_IDS}, 'Missing club roster model')
        for key, roster in p['rosters'].items():
            context(roster)
            require(key == f"4:22:{roster['teamId']}", 'Wrong roster key')
            require(len(roster['playerIds']) == len(set(roster['playerIds']))
                    and set(roster['playerIds']) <= players.keys(), 'Invalid roster players')
            quality(roster['quality'])
        for key, reg in p['registrations'].items():
            context(reg)
            require(reg['playerId'] in players and key == reg['registrationId'], 'Invalid registration')
            for field in ('registeredAt', 'releasedAt'):
                if reg[field] is not None:
                    date.fromisoformat(reg[field])
            quality(reg['quality'])
        matches = p['matchesById']
        protocol_ids = []
        for key, m in matches.items():
            match_record(key, m, teams)
            if m['sourceMatchId']:
                protocol_ids.append(m['sourceMatchId'])
        require(len(protocol_ids) == len(set(protocol_ids)), 'Duplicate source match ID')
        for key, stats in p['playerSeasonStats'].items():
            context(stats)
            require(stats['playerId'] in players and key == f"{stats['playerId']}:{stats['teamId']}:4:22",
                    'Invalid player statistics key')
            require(source_id(stats['sourceUrl'], 'players') == stats['playerId'], 'Wrong statistics source')
            for field in STATS:
                number(stats[field], nullable=True)
            if stats['games'] is not None:
                if stats['starts'] is not None and stats['substitutions'] is not None:
                    require(stats['starts'] + stats['substitutions'] == stats['games'], 'Invalid appearances')
                if stats['minutes'] is not None:
                    require(stats['minutes'] <= stats['games'] * 120, 'Invalid minutes')
            if stats['penaltyGoals'] is not None and stats['goals'] is not None:
                require(stats['penaltyGoals'] <= stats['goals'], 'Invalid penalties')
            quality(stats['quality'])
        for key, table in p['standings'].items():
            require(key == SEASON_KEY, 'Wrong standings key')
            context(table)
            quality(table['quality'])
            rows = table['rows']
            require(isinstance(rows, list), 'Invalid standings')
            if not rows:
                require(table['quality']['status'] != 'current', 'Empty current standings')
            if rows:
                require(len(rows) == 11 and {r['teamId'] for r in rows} == TEAM_IDS, 'Incomplete standings')
                require([r['rank'] for r in rows] == list(range(1, 12)), 'Wrong standings order')
            for row in rows:
                for field in ('played', 'wins', 'draws', 'losses', 'goalsFor', 'goalsAgainst', 'points'):
                    number(row[field])
                require(type(row['goalDifference']) is int, 'Invalid goal difference')
                require(row['wins'] + row['draws'] + row['losses'] == row['played']
                        and row['goalsFor'] - row['goalsAgainst'] == row['goalDifference'], 'Inconsistent standings')
        for key, protocol in p['protocolsByMatchId'].items():
            require(key in matches and protocol['matchId'] == key, 'Orphan protocol')
            m = matches[key]
            require(protocol['sourceMatchId'] == m['sourceMatchId']
                    and protocol['sourceUrl'] == m['sourceUrl'], 'Wrong protocol identity')
            require(protocol['homeTeamId'] == m['homeTeamId']
                    and protocol['awayTeamId'] == m['awayTeamId'], 'Wrong protocol sides')
            require(all(protocol[field] == m[field] for field in ('date', 'homeScore', 'awayScore')),
                    'Protocol does not match current result')
            require(type(protocol['eventsComplete']) is bool, 'Invalid events coverage')
            for side, groups in protocol['lineups'].items():
                require(side in {'home', 'away'} and isinstance(groups, dict), 'Invalid lineup side')
                for group, entries in groups.items():
                    require(group in {'starters', 'substitutes'}, 'Invalid lineup group')
                    for entry in entries:
                        require(entry['playerId'] in players
                                and source_id(entry['sourceUrl'], 'players') == entry['playerId'], 'Unknown lineup player')
                        number(entry['number'], nullable=True)
                        require(entry['number'] is None or entry['number'] <= 99, 'Invalid shirt number')
            require(isinstance(protocol['events'], list), 'Invalid protocol events')
            for event in protocol['events']:
                require(event['type'] in EVENT_TYPES, 'Unknown event type')
                require(isinstance(event['sourceLabel'], str) and bool(event['sourceLabel']), 'Missing event label')
                require(isinstance(event['minute'], str) and re.fullmatch(r'\d{1,3}(?:\+\d{1,2})?', event['minute']), 'Invalid minute')
                if event['score'] is not None:
                    require(isinstance(event['score'], list) and len(event['score']) == 2, 'Invalid running score')
                    for value in event['score']:
                        number(value)
                require(event['teamId'] in {m['homeTeamId'], m['awayTeamId']}, 'Invalid event team')
                require(event['playerId'] is None or event['playerId'] in players, 'Invalid event actor')
            quality(protocol['quality'])
        # Reserved models remain explicitly empty until their own ID-based
        # importer exists; the partial name-labelled leaderboard is NOT stats.
        require(not p['scorerLeaderboard'] and not p['newsById'], 'Unimplemented importer')
        links = p['legacyLinks']
        require(isinstance(links['players'], dict) and isinstance(links['matches'], dict), 'Invalid aliases')
        require(all(key == 'rffk-' + value and value in players for key, value in links['players'].items()),
                'Broken player alias')
        require(set(links['matches'].values()) <= matches.keys(), 'Broken match alias')
        unresolved = p['unresolvedSourceRecords']
        require(isinstance(unresolved['teamsById'], dict) and isinstance(unresolved['matchesById'], dict),
                'Invalid unresolved records')
        require(not (unresolved['teamsById'].keys() & teams.keys()), 'Confirmed team marked unresolved')
        for key, raw in unresolved['teamsById'].items():
            require(isinstance(key, str) and key.isdigit() and raw['record']['id'] == key
                    and raw['reason'] == 'identity_not_confirmed', 'Invalid unknown team record')
        for key, raw in unresolved['matchesById'].items():
            require(key not in matches and raw['record']['id'] == key, 'Duplicate unresolved match')
            require(any(raw['record'][f] not in teams for f in ('home_id', 'away_id')), 'Resolved match quarantined')
            require(raw['reason'] == 'identity_not_confirmed', 'Invalid unresolved reason')
        if previous is not None:
            validate_platform(previous)
            require(stamp(p['sourceUpdatedAt']) >= stamp(previous['sourceUpdatedAt']), 'Older platform snapshot')
            for name in COLLECTIONS:
                require(previous[name].keys() <= p[name].keys(), 'Lost platform collection: ' + name)
            for key, old in previous['rosters'].items():
                require(set(old['playerIds']) <= set(p['rosters'][key]['playerIds']), 'Lost roster players')
            for key, old in previous['playerSeasonStats'].items():
                require(all(old[field] is None or p['playerSeasonStats'][key][field] is not None
                            for field in STATS), 'Lost confirmed statistic')
            for key, old in previous['standings'].items():
                table = p['standings'][key]
                require(not old['rows'] or bool(table['rows']), 'Lost standings')
                old_time = old['quality']['lastVerifiedAt']
                new_time = table['quality']['lastVerifiedAt']
                require(old_time is None or (new_time is not None and stamp(new_time) >= stamp(old_time)),
                        'Older verified standings')
            for key, old in previous['protocolsByMatchId'].items():
                new = p['protocolsByMatchId'][key]
                require(len(new['events']) >= len(old['events']), 'Lost protocol events')
                require(not old['eventsComplete'] or new['eventsComplete'], 'Lost complete protocol')
                for side, groups in old['lineups'].items():
                    for group, entries in groups.items():
                        require({e['playerId'] for e in entries} <=
                                {e['playerId'] for e in new['lineups'].get(side, {}).get(group, [])},
                                'Lost protocol lineup')
            for name in ('players', 'matches'):
                require(all(links[name].get(k) == v for k, v in previous['legacyLinks'][name].items()),
                        'Lost legacy alias')
            for name in ('teamsById', 'matchesById'):
                require(previous['unresolvedSourceRecords'][name].keys() <= unresolved[name].keys(),
                        'Lost unresolved source history')
    except (KeyError, TypeError, AttributeError, IndexError, ValueError) as exc:
        raise InvalidPlatform(str(exc)) from exc
    return p
