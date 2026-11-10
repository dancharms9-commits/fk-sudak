"""Bounded server-side protocol import; never invoked by the PWA.

Calendar IDs establish teams. Only official player URLs establish identities.
Text event actors remain text, even when a surname matches a roster.
"""
import argparse
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import threading
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from fetch_data import parse_match_protocol, parse_match_lineups, parse_match_events, parse_championship_calendar, txt
from scripts.multi_club_schema import BASE, SEASON_URL, source_id, require, validate_platform
from scripts.multi_club_sources import quality
from scripts.multi_club_rosters import fresh, failed, evidence_rank


class NetworkLoader:
    def __init__(self, seconds=90):
        self.seconds, self.deadline, self.requests = seconds, None, 0
        self.lock = threading.Lock()

    def __call__(self, url):
        require(source_id(url, 'matches') or url == SEASON_URL, 'Unsafe match request')
        with self.lock:
            if self.deadline is None:
                self.deadline = time.monotonic() + self.seconds
        for attempt in range(2):
            remaining = self.deadline-time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Match import budget exhausted')
            try:
                with self.lock:
                    self.requests += 1
                response = requests.get(url, timeout=min(8, remaining), headers={'User-Agent': 'FKSudakPWA/match-review-v1'})
                response.raise_for_status()
                require(response.url.rstrip('/') == url.rstrip('/'), 'Unexpected protocol redirect')
                return BeautifulSoup(response.text, 'html.parser')
            except requests.RequestException as exc:
                if attempt or (exc.response is not None and exc.response.status_code not in {429, 500, 502, 503, 504}):
                    raise
                time.sleep(min(.5, max(0, self.deadline-time.monotonic())))


def parse_protocol(soup, match, teams):
    """Validate context before accepting any section of a damaged protocol."""
    info, crumbs = soup.select_one('.match_info'), soup.select_one('.breadcrumbs')
    require(info is not None and crumbs is not None, 'Missing protocol context')
    require(crumbs.select_one(f'a[href="{BASE}/tournaments/4/"]') is not None
            and re.search(r'Сезон\s+2026(?:/2026)?\b', txt(crumbs)), 'Wrong protocol season')
    expected = {'home': teams[match['homeTeamId']]['name'], 'away': teams[match['awayTeamId']]['name'],
                'home_score': match['homeScore'], 'away_score': match['awayScore'], 'date': match['date']}
    require([txt(n) for n in info.select('.score_line .team_name')] == [expected['home'], expected['away']], 'Wrong protocol sides')
    require([txt(info.select_one('.score .'+side)) for side in ('first', 'second')]
            == [str(expected['home_score']), str(expected['away_score'])], 'Wrong protocol score')
    date = txt(info.select_one('.head .date'))
    hit = re.search(r'\b\d{2}\.\d{2}\.2026\b', date)
    require(hit and datetime.strptime(hit[0], '%d.%m.%Y').date().isoformat() == match['date'], 'Wrong protocol date')
    tour = txt(info.select_one('.head .tour'))
    require(re.match(r'\s*'+re.escape(match['roundId'])+r'-й\s+тур\b', tour), 'Wrong protocol round')
    full = parse_match_protocol(soup, expected)
    # Goal consistency can fail while independent cards/team sheets are valid.
    # Never synthesize a scorer/type/running score from the final score.
    if full is None:
        events, _ = parse_match_events(info, [])
        lineups, complete = parse_match_lineups(info), False
    else:
        events, lineups, complete = full['events'], full.get('lineups', {}), full['events_complete']
    people, sheets = {}, {}
    for side, groups in lineups.items():
        sheets[side] = {}
        for group, entries in groups.items():
            sheets[side][group] = []
            for entry in entries:
                pid = source_id(entry['profile_url'], 'players')
                require(pid is not None, 'Invalid lineup player ID')
                people[pid] = {'playerId': pid, 'name': entry['name'], 'sourceUrl': entry['profile_url']}
                sheets[side][group].append({'playerId': pid, 'sourceUrl': entry['profile_url'], 'number': entry['number']})
    place = txt(info.select_one('.head .place'))
    venue = re.sub(r'^Стадион\s*:?\s*', '', place, flags=re.I) or None
    clock = re.search(r'\b(?:[01]\d|2[0-3]):[0-5]\d\b', date)
    protocol = {field: match[field] for field in ('matchId', 'sourceMatchId', 'sourceUrl', 'homeTeamId', 'awayTeamId', 'date', 'homeScore', 'awayScore')}
    protocol.update(lineups=sheets, eventsComplete=complete, goalsComplete=full is not None,
                    events=[{'type': e['type'], 'teamId': match[e['side']+'TeamId'], 'playerId': None,
                             'sourceLabel': e['player'], 'minute': e['minute'], 'score': e.get('score')} for e in events],
                    venue=venue, city=venue.rsplit(',', 1)[1].strip() if venue and ',' in venue else None,
                    time=clock[0] if clock else None, roundLabel=tour)
    return protocol, people


def compatible(protocol, match):
    return all(protocol.get(f) == match.get(f) for f in
               ('sourceMatchId', 'sourceUrl', 'homeTeamId', 'awayTeamId', 'date', 'homeScore', 'awayScore'))


def merge_protocols(base, extra):
    """Independent protocol enrichment survives restoration of the legacy root."""
    p = copy.deepcopy(base)
    for key, protocol in extra['protocolsByMatchId'].items():
        if key not in p['matchesById'] or not compatible(protocol, p['matchesById'][key]):
            continue
        old = p['protocolsByMatchId'].get(key)
        if old and evidence_rank(old['quality']) >= evidence_rank(protocol['quality']):
            continue
        p['protocolsByMatchId'][key] = copy.deepcopy(protocol)
        for groups in protocol['lineups'].values():
            for entries in groups.values():
                for entry in entries:
                    p['playersById'].setdefault(entry['playerId'], copy.deepcopy(extra['playersById'][entry['playerId']]))
    validate_platform(p)
    return p


def sync_platform(platform, loader, max_matches=8, max_seconds=90, force=False, checked_at=None):
    p = copy.deepcopy(platform)
    now = checked_at or datetime.now(timezone.utc).isoformat(timespec='seconds')
    report = {'workers': 2, 'requestLimit': max_matches, 'matches': {}}
    start = time.monotonic()
    jobs = [m for m in p['matchesById'].values() if m['sourceMatchId'] and m['status'] in {'finished', 'technical'}
            and m['homeScore'] is not None and (force or not fresh(m.get('protocolQuality', {}), now, 168))]
    # Oldest attempts first; a broken page cannot starve all remaining matches.
    jobs.sort(key=lambda m: (m.get('protocolQuality', {}).get('checkedAt') or '', m['sourceMatchId']))
    def job(m):
        try:
            protocol, people = parse_protocol(loader(m['sourceUrl']), m, p['teamsById'])
            return m, protocol, people, None
        except (requests.RequestException, ValueError, TypeError, AttributeError, TimeoutError) as exc:
            return m, None, {}, exc
    with ThreadPoolExecutor(max_workers=2) as pool:
        # Submit in pairs, never queue the entire season after the time budget.
        for index in range(0, min(max_matches, len(jobs)), 2):
            if time.monotonic()-start >= max_seconds:
                break
            for m, protocol, people, error in pool.map(job, jobs[index:min(index+2, max_matches)]):
                key, old = m['matchId'], p['protocolsByMatchId'].get(m['matchId'])
                if error is None and old:
                    try:
                        candidate = copy.deepcopy(p)
                        candidate['protocolsByMatchId'][key] = {**protocol, 'quality': old['quality']}
                        for pid, person in people.items():
                            candidate['playersById'].setdefault(pid, {**person, 'quality': quality(person['sourceUrl'])})
                        validate_platform(candidate, p)
                    except ValueError as exc:
                        error = exc  # truncated sections cannot erase last-good data
                if error is not None:
                    q = failed(old['quality'] if old else m.get('protocolQuality'), m['sourceUrl'], now, 'protocol_source_unavailable', error)
                    m['protocolQuality'] = q
                    if old:
                        old['quality'] = copy.deepcopy(q)
                    report['matches'][m['sourceMatchId']] = {'status': 'preserved' if old else 'unavailable', 'error': str(error)}
                    continue
                q = quality(m['sourceUrl'], status='current', reason='official_match_protocol', verified=now, checked=now,
                            coverage='complete' if protocol['eventsComplete'] and len(protocol['lineups']) == 2 else 'partial')
                protocol['quality'], m['protocolQuality'] = q, copy.deepcopy(q)
                p['protocolsByMatchId'][key] = protocol
                for pid, person in people.items():
                    p['playersById'].setdefault(pid, {**person, 'quality': copy.deepcopy(q)})
                report['matches'][m['sourceMatchId']] = {'status': 'accepted', 'events': len(protocol['events']), 'coverage': q['coverage']}
    validate_platform(p, platform)
    return p, report


def audit_counts(p):
    protocols = list(p['protocolsByMatchId'].values())
    def count(types):
        return sum(any(e['type'] in types for e in protocol['events']) for protocol in protocols)
    return {'matches': len(p['matchesById']), 'officialIds': sum(bool(m['sourceMatchId']) for m in p['matchesById'].values()),
            'protocols': len(protocols), 'lineups': sum(bool(x['lineups']) for x in protocols),
            'goals': count({'goal', 'penalty', 'own_goal'}), 'cards': count({'yellow', 'second_yellow', 'red'}),
            'substitutions': count({'substitution', 'substitution_in', 'substitution_out'}),
            'unresolvedTeamIds': sorted(p['unresolvedSourceRecords']['teamsById']),
            'unresolvedMatches': len(p['unresolvedSourceRecords']['matchesById'])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', default='data.json')
    parser.add_argument('--output', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--max-matches', type=int, default=120)
    parser.add_argument('--seconds', type=int, default=600)
    args = parser.parse_args()
    data = json.loads(Path(args.input).read_text())
    loader = NetworkLoader(args.seconds)
    # Read the official calendar once. The review lists discrepancies explicitly;
    # protocol enrichment never silently rewrites the legacy Sudak snapshot.
    calendar = parse_championship_calendar(loader(SEASON_URL))
    known = {m['matchId']: m for m in data['platform']['matchesById'].values()}
    differences = [m for m in calendar['matches'] if m['id'] in known and any(
        m[a] != known[m['id']][b] for a, b in [('source_id', 'sourceMatchId'), ('date', 'date'), ('home_score', 'homeScore'), ('away_score', 'awayScore'), ('status', 'status')])]
    data['platform'], report = sync_platform(data['platform'], loader, args.max_matches, args.seconds, force=True)
    data['updated'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    report.update(audit_counts(data['platform']))
    report.update(checkedAt=data['updated'], requests=loader.requests, calendarDifferences=differences,
                  calendarMatches=len(calendar['matches']), calendarSource=SEASON_URL,
                  calendarWithoutOfficialId=[m['id'] for m in calendar['matches'] if not m['source_id']])
    for file, value in [(args.output, data), (args.report, report)]:
        path = Path(file)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=1)+'\n')


if __name__ == '__main__':
    main()
