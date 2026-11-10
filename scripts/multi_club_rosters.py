"""Official club lists and profile facts, prepared in Python, never in the PWA.

Club-list membership is not a season registration. Opaque profile group tokens
only pair a header with its match links; team identity comes from calendar IDs.
"""
import argparse
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import re
import threading
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from scripts.multi_club_schema import BASE, TEAM_IDS, STATS, source_id, require, validate_platform
from scripts.multi_club_sources import quality
from update_player_stats import safe_photo_url

TARGET_IDS = sorted(TEAM_IDS - {'141'}, key=int)
LEAGUE_TITLE = 'Открытый Чемпионат Республики Крым среди мужских любительских команд'


def text(node):
    return re.sub(r'\s+', ' ', node.get_text(' ', strip=True)).strip() if node else ''


def iso_date(value):
    if value in ('', '-', '—'):
        return None
    return datetime.strptime(value, '%d.%m.%Y').date().isoformat()


def optional_int(value, maximum=None):
    if value in ('', '-', '—'):
        return None
    require(value.isdigit(), 'Invalid published integer')
    result = int(value)
    require(maximum is None or result <= maximum, 'Integer outside field range')
    return result


def parse_club(soup, team):
    """Explicit /players/<id>/ links inside the requested club's own roster."""
    title = soup.select_one('.team_top_title .name')
    require(title is not None and text(title) == team['name'], 'Wrong club page')
    tables = [n.select_one(':scope>.tour_table.players') for n in soup.select('.team_data_players')
              if text(n.select_one(':scope>.sub_title')) == 'Состав команды']
    tables = [n for n in tables if n is not None]
    require(len(tables) == 1, 'Missing or ambiguous club list')
    headings = [text(n) for n in tables[0].select('.sub_head .total>.col')]
    require(headings == ['Дата рождения', 'Позиция', 'Игр', 'Заявлен'], 'Changed club columns')
    entries = {}
    for row in tables[0].select(':scope>.line'):
        link = row.select_one('.name a[href]')
        require(link is not None, 'Missing player link')
        url = urljoin(BASE, link['href'])
        pid = source_id(url, 'players')
        last, first = row.select_one('.player_lastname'), row.select_one('.player_name')
        require(pid and pid not in entries and text(last) and text(first), 'Invalid club identity')
        photo = row.select_one('.photo img[src]')
        cells = {n.get('data-col'): text(n) for n in row.select('.total>[data-col]')}
        require(set(cells) == {'1', '2', '3', '4'}, 'Incomplete club row')
        entries[pid] = {'playerId': pid, 'name': text(last) + ' ' + text(first),
            'lastName': text(last), 'firstName': text(first), 'sourceUrl': url,
            'number': optional_int(text(row.select_one('.place'))),
            'position': cells['2'] if cells['2'] not in ('', '-', '—') else None,
            'registeredAt': iso_date(cells['4']),
            'photoUrl': safe_photo_url(urljoin(BASE, photo['src'])) if photo else None}
    require(1 <= len(entries) <= 150, 'Empty or implausible club list')
    return entries


def parse_registrations(soup):
    """An unrelated bad historical row must not erase valid profile facts."""
    registrations, issues, blocked = [], [], set()
    for index, row in enumerate(soup.select('.player-data__teams>.player-data__team:not(.player-data__team_head)')):
        tid = None
        try:
            cols = row.find_all('div', recursive=False)
            require(len(cols) == 5, 'Changed registration columns')
            link = cols[1].select_one('a[href]')
            tid = source_id(urljoin(BASE, link['href']), 'teams') if link else None
            require(tid is not None, 'Registration without official team ID')
            if tid not in TEAM_IDS:
                continue
            start, end = iso_date(text(cols[3])), iso_date(text(cols[4]))
            require(start is None or end is None or start <= end, 'Invalid registration interval')
            reg = {'teamId': tid, 'registeredAt': start, 'releasedAt': end,
                   'number': optional_int(text(cols[0])),
                   'position': text(cols[2]) if text(cols[2]) not in ('', '-', '—') else None}
            key = (tid, start)
            if key in blocked:
                continue
            old = next((r for r in registrations if (r['teamId'], r['registeredAt']) == key), None)
            if old == reg:
                continue  # exact duplicate published facts, not a second period
            if old is not None:
                registrations.remove(old)
                blocked.add(key)
                issues.append({'teamId': tid, 'sourceRow': index+1, 'reason': 'ambiguous_registration_period'})
            else:
                registrations.append(reg)
        except (ValueError, TypeError, AttributeError) as exc:
            issues.append({'teamId': tid, 'sourceRow': index+1, 'reason': str(exc)[:160]})
    return registrations, issues


def parse_profile(soup, pid, expected_names, matches):
    last, first = soup.select_one('.player-data__lastname'), soup.select_one('.player-data__name')
    require(last and first and text(first), 'Missing official profile identity')
    name = text(last) + ' ' + text(first).split()[0]
    normalize = lambda s: s.casefold().replace('ё', 'е').strip()
    require(normalize(name) in {normalize(n) for n in expected_names}, 'Profile identity guard failed')
    url = f'{BASE}/players/{pid}/'
    image = soup.select('.player-data__image img[src]')
    photo = safe_photo_url(urljoin(BASE, image[0]['src'])) if len(image) == 1 else None
    registrations, registration_issues = parse_registrations(soup)
    by_source = {m['sourceMatchId']: m for m in matches.values() if m.get('sourceMatchId')}
    stats, unresolved = {}, []
    container = soup.select_one('.player-stat')
    if container:
        header = container.select_one(':scope>.player-stat__stat_h:not([data-id])')
        cells = header.find_all('div', recursive=False) if header else []
        signature = [next((c for c in ('goal', 'goal4', 'goal3', 'yellow', 'yellow2', 'red') if n.select_one('.'+c)), None) for n in cells]
        require(len(cells) == 9 and signature[2:8] == ['goal', 'goal4', 'goal3', 'yellow', 'yellow2', 'red'] and text(cells[8]) == 'мин', 'Changed profile statistics columns')
        for group in container.select(':scope>.player-stat__stat_h[data-id]'):
            champ = group.select_one('.player-stat__champ')
            title = champ.select_one('.player-stat__champ-title') if champ else None
            labels = [text(n) for n in champ.find_all('div', recursive=False)] if champ else []
            if text(title) != LEAGUE_TITLE or 'Сезон 2026/2026' not in labels:
                continue
            token = group['data-id']  # opaque, never split into team/competition/season
            more = [n for n in container.select(':scope>.player-stat__more') if n.get('data-id') == token]
            ids = [source_id(urljoin(BASE, a['href']), 'matches') for a in more[0].select('a[href*="/matches/"]')] if len(more) == 1 else []
            reason = None
            if not ids or None in ids or len(ids) != len(set(ids)):
                reason = 'missing_or_ambiguous_match_links'
            elif not any(i in by_source for i in ids):
                reason = 'calendar_match_not_resolved'
            else:
                linked = [by_source[i] for i in ids if i in by_source]
                candidates = set.intersection(*[{m['homeTeamId'], m['awayTeamId']} for m in linked])
                if len(candidates) > 1:
                    # Dates and explicit /teams/<id>/ registration links may
                    # disambiguate a one-match group; text labels never do.
                    if any(issue['teamId'] is None or issue['teamId'] in candidates for issue in registration_issues):
                        candidates = set()
                    candidates = {tid for tid in candidates if any(r['teamId'] == tid and all(
                        m['date'] is not None and (r['registeredAt'] is None or r['registeredAt'] <= m['date'])
                        and (r['releasedAt'] is None or m['date'] <= r['releasedAt']) for m in linked) for r in registrations)}
                if len(candidates) != 1:
                    reason = 'team_binding_ambiguous'
            if reason:
                unresolved.append({'sourceGroupId': token, 'reason': reason, 'sourceMatchIds': ids})
                continue
            tid = next(iter(candidates))
            require(tid not in stats, 'Duplicate season group for same club')
            values = group.find_all('div', recursive=False)
            require(len(values) == 9, 'Changed group columns')
            starts = re.fullmatch(r'в старте\s*-\s*(\d+)\s*,\s*на замену\s*-\s*(\d+)', text(group.select_one('.player-stat__champ-tt')))
            require(starts is not None, 'Missing appearances')
            a, b = map(int, starts.groups())
            goals = re.fullmatch(r'(\d+)\s*\((\d+)\)', text(values[2]))
            row = {field: None for field in STATS}
            row.update(games=a+b, starts=a, substitutions=b,
                goals=int(goals[1]) if goals else optional_int(text(values[2])),
                penaltyGoals=int(goals[2]) if goals else None,
                yellowCards=optional_int(text(values[5])), secondYellowCards=optional_int(text(values[6])),
                redCards=optional_int(text(values[7])), minutes=optional_int(text(values[8])))
            row['sourceBinding'] = {'sourceGroupId': token, 'sourceMatchIds': [i for i in ids if i in by_source],
                'unresolvedSourceMatchIds': [i for i in ids if i not in by_source],
                'method': 'calendar_match_id_intersection', 'competitionId': '4', 'seasonId': '22'}
            stats[tid] = row
    return {'name': name, 'lastName': text(last), 'firstName': text(first).split()[0],
            'photoUrl': photo, 'registrations': registrations, 'registrationIssues': registration_issues, 'stats': stats, 'unresolvedGroups': unresolved}


class NetworkLoader:
    """At most two workers in sync_platform; one retry, bounded time and URLs."""
    def __init__(self, seconds=120):
        self.seconds = seconds
        self.deadline = None
        self.requests = 0
        self.lock = threading.Lock()

    def __call__(self, url):
        require(source_id(url, 'teams') or source_id(url, 'players'), 'Unsafe roster request')
        with self.lock:
            if self.deadline is None:
                self.deadline = time.monotonic() + self.seconds
        for attempt in range(2):
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Roster request budget exhausted')
            try:
                with self.lock:
                    self.requests += 1
                response = requests.get(url, timeout=min(8, remaining), headers={'User-Agent': 'FKSudakPWA/roster-review-v1'})
                response.raise_for_status()
                require(response.url.rstrip('/') == url.rstrip('/'), 'Unexpected source redirect')
                return BeautifulSoup(response.text, 'html.parser')
            except requests.RequestException as exc:
                if attempt or (exc.response is not None and exc.response.status_code not in {429, 500, 502, 503, 504}):
                    raise
                time.sleep(min(.5, max(0, self.deadline-time.monotonic())))


def fresh(q, now, hours):
    try:
        return (timedelta(0) <= datetime.fromisoformat(now) - datetime.fromisoformat(q.get('lastVerifiedAt') or '') < timedelta(hours=hours)
                and q.get('status') == 'current')
    except (ValueError, TypeError):
        return False


def failed(q, url, when, reason, exc):
    q = copy.deepcopy(q) if q else quality(url, status='temporarily_unavailable', reason=reason, coverage='unknown')
    q.update(status='stale' if q.get('lastVerifiedAt') else 'temporarily_unavailable', checkedAt=when,
             lastAttemptStatus='temporarily_unavailable', errorCode=type(exc).__name__, reason=reason)
    return q


def sync_platform(platform, loader, max_profiles=24, max_seconds=120, force=False, checked_at=None):
    previous = platform
    p = copy.deepcopy(platform)
    clock = lambda: checked_at or datetime.now(timezone.utc).isoformat(timespec='seconds')
    start = time.monotonic()
    report = {'clubs': {}, 'profiles': {}, 'requestLimit': max_profiles, 'workers': 2}
    jobs = []
    for tid in TARGET_IDS:
        r = p['rosters'][f'4:22:{tid}']
        if force or not fresh(r.get('clubListQuality', {}), clock(), 24):
            jobs.append(tid)
    def club_job(tid):
        try:
            entries = parse_club(loader(p['teamsById'][tid]['sourceUrl']), p['teamsById'][tid])
            previous_count = sum(e.get('currentlyListed', False) for e in p['rosters'][f'4:22:{tid}'].get('entriesByPlayerId', {}).values())
            require(not previous_count or len(entries)*2 >= previous_count, 'Implausibly truncated club list')
            return tid, entries, None, clock()
        except (requests.RequestException, ValueError, TypeError, AttributeError, TimeoutError) as exc:
            return tid, None, exc, clock()
    with ThreadPoolExecutor(max_workers=2) as pool:
        for tid, entries, error, when in pool.map(club_job, jobs):
            r, url = p['rosters'][f'4:22:{tid}'], p['teamsById'][tid]['sourceUrl']
            if error:
                r['clubListQuality'] = failed(r.get('clubListQuality'), url, when, 'club_list_source_unavailable', error)
                report['clubs'][tid] = {'status': 'temporarily_unavailable', 'error': type(error).__name__, 'detail': str(error)[:160]}
                continue
            r.setdefault('clubPlayerIds', [])
            stored = r.setdefault('entriesByPlayerId', {})
            for pid, entry in entries.items():
                r['clubPlayerIds'] = list(dict.fromkeys(r['clubPlayerIds'] + [pid]))
                stored[pid] = {k: entry[k] for k in ('playerId', 'number', 'position', 'registeredAt')}
                stored[pid].update(currentlyListed=True, sourceUrl=url, lastSeenAt=when)
                player = p['playersById'].setdefault(pid, {'playerId': pid, 'name': entry['name'], 'sourceUrl': entry['sourceUrl']})
                player.update(name=entry['name'], firstName=entry['firstName'], lastName=entry['lastName'])
                player['quality'] = quality(url, 'current', 'official_club_list_identity', when, 'partial', when)
                player.setdefault('profileQuality', quality(entry['sourceUrl'], 'not_checked', 'profile_not_checked', coverage='unknown'))
                if entry['photoUrl'] and not player.get('photoUrl'):
                    player.update(photoUrl=entry['photoUrl'], photoSourceUrl=url)
            for pid in stored.keys() - entries.keys():
                stored[pid]['currentlyListed'] = False
            r['clubListQuality'] = quality(url, 'current', 'official_club_list_not_season_roster', when, 'complete', when)
            report['clubs'][tid] = {'status': 'current', 'listed': len(entries)}
    candidates = set(pid for tid in TARGET_IDS for pid in p['rosters'][f'4:22:{tid}'].get('clubPlayerIds', []))
    candidates = [pid for pid in candidates if force or not fresh(p['playersById'][pid].get('profileQuality', {}), clock(), 24) or (p['playersById'][pid].get('unresolvedSeasonGroups') and p['playersById'][pid].get('profileImportVersion') != 2)]
    candidates.sort(key=lambda pid: (p['playersById'][pid].get('profileQuality', {}).get('checkedAt') or '', int(pid)))
    def profile_job(pid):
        if time.monotonic()-start >= max_seconds:
            return pid, None, 'budget', None
        try:
            names = {p['playersById'][pid]['name']}
            result = parse_profile(loader(p['playersById'][pid]['sourceUrl']), pid, names, p['matchesById'])
            return pid, result, None, clock()
        except (requests.RequestException, ValueError, TypeError, AttributeError, TimeoutError) as exc:
            return pid, None, exc, clock()
    with ThreadPoolExecutor(max_workers=2) as pool:
        for pid, result, error, when in pool.map(profile_job, candidates[:max_profiles]):
            player = p['playersById'][pid]
            url = player['sourceUrl']
            if error == 'budget':
                report['profiles'][pid] = {'status': 'not_checked', 'reason': 'budget_exhausted'}
                continue
            if error:
                player['profileQuality'] = failed(player.get('profileQuality'), url, when, 'profile_source_unavailable', error)
                for s in p['playerSeasonStats'].values():
                    if s['playerId'] == pid and s['teamId'] != '141':
                        s['quality'] = failed(s['quality'], url, when, 'profile_source_unavailable', error)
                report['profiles'][pid] = {'status': 'temporarily_unavailable', 'error': type(error).__name__, 'detail': str(error)[:160]}
                continue
            player.update({k: result[k] for k in ('name', 'firstName', 'lastName')})
            if result['photoUrl']:
                player.update(photoUrl=result['photoUrl'], photoSourceUrl=url)
            player['profileQuality'] = quality(url, 'current', 'official_profile', when, 'partial', when)
            player['unresolvedSeasonGroups'] = result['unresolvedGroups']
            player['profileImportVersion'] = 2
            player['registrationIssues'] = result['registrationIssues']
            for old_reg in p['registrations'].values():
                if old_reg['playerId'] == pid and old_reg['teamId'] != '141':
                    old_reg['quality'].update(status='stale', checkedAt=when, reason='registration_not_verified_in_latest_profile', lastAttemptStatus='not_checked')
            for reg in result['registrations']:
                key = f"{pid}:{reg['teamId']}:club:{reg['registeredAt'] or 'unknown'}"
                record = {'registrationId': key, 'playerId': pid, **reg, 'scope': 'club',
                    'competitionId': None, 'seasonId': None, 'sourceUrl': url,
                    'quality': quality(url, 'current', 'official_profile_club_registration', when, 'partial', when)}
                p['registrations'][key] = record
            for old_row in p['playerSeasonStats'].values():
                if old_row['playerId'] == pid and old_row['teamId'] != '141' and old_row['teamId'] not in result['stats']:
                    old_row['quality'].update(status='stale', checkedAt=when, reason='season_group_not_verified_in_latest_profile', lastAttemptStatus='not_checked')
            for tid, row in result['stats'].items():
                if tid == '141':
                    continue  # legacy Sudak statistics keep their existing producer
                key = f'{pid}:{tid}:4:22'
                old = p['playerSeasonStats'].get(key, {})
                retained = []
                availability = {}
                for field in STATS:
                    availability[field] = {'status': 'not_published' if row[field] is None else 'current', 'lastVerifiedAt': when if row[field] is not None else None}
                    if row[field] is None and old.get(field) is not None:
                        row[field] = old[field]
                        retained.append(field)
                        availability[field] = {'status': 'stale', 'lastVerifiedAt': old['quality']['lastVerifiedAt']}
                row['fieldQuality'] = availability
                p['playerSeasonStats'][key] = {'playerId': pid, 'teamId': tid, 'competitionId': '4', 'seasonId': '22',
                    'sourceUrl': url, **row, 'quality': quality(url, 'current', 'profile_group_bound_by_match_ids', when, 'partial', when)}
                if retained:
                    p['playerSeasonStats'][key]['quality'].update(status='stale', reason='partial_fields_preserved', lastVerifiedAt=old['quality']['lastVerifiedAt'])
                r = p['rosters'][f'4:22:{tid}']
                r['playerIds'] = list(dict.fromkeys(r['playerIds'] + [pid]))
                r['quality'] = quality(url, 'current', 'verified_season_participation_partial_roster', when, 'partial', when)
                for reg in result['registrations']:
                    if reg['teamId'] != tid:
                        continue
                    linked = [m for m in p['matchesById'].values() if m['sourceMatchId'] in row['sourceBinding']['sourceMatchIds']]
                    evidence = [m['sourceMatchId'] for m in linked if m['date'] and
                        (reg['registeredAt'] is None or reg['registeredAt'] <= m['date']) and
                        (reg['releasedAt'] is None or m['date'] <= reg['releasedAt'])]
                    if not evidence:
                        continue
                    key = f"{pid}:{tid}:4:22:{reg['registeredAt'] or 'unknown'}"
                    p['registrations'][key] = {'registrationId': key, 'playerId': pid, **reg,
                        'scope': 'competition_season', 'competitionId': '4', 'seasonId': '22', 'sourceUrl': url,
                        'evidenceSourceMatchIds': evidence,
                        'quality': quality(url, 'current', 'profile_registration_and_season_match_ids', when, 'partial', when)}
            report['profiles'][pid] = {'status': 'current', 'boundTeams': list(result['stats']), 'unresolvedGroups': result['unresolvedGroups'], 'registrationIssues': result['registrationIssues']}
    for tid in TARGET_IDS:
        r = p['rosters'][f'4:22:{tid}']
        historical, unverified = [], []
        for pid in r.get('clubPlayerIds', []):
            if pid in r['playerIds']:
                continue
            regs = [reg for reg in p['registrations'].values() if reg['playerId'] == pid and reg['teamId'] == tid and reg.get('scope') == 'club']
            target = historical if regs and all(reg['releasedAt'] and reg['releasedAt'] < '2026-01-01' for reg in regs) else unverified
            target.append(pid)
        r.update(historicalPlayerIds=historical, unverifiedPlayerIds=unverified)
    validate_platform(p, previous)
    return p, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=Path('data.json'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--max-profiles', type=int, default=24)
    parser.add_argument('--seconds', type=int, default=120)
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    require(0 <= args.max_profiles <= 600 and 1 <= args.seconds <= 900, 'Invalid audit budget')
    data = json.loads(args.input.read_text())
    loader = NetworkLoader(args.seconds)
    data['platform'], report = sync_platform(data['platform'], loader, args.max_profiles, args.seconds, args.force)
    report['httpRequests'] = loader.requests
    report['generatedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    # Revision only: none of the legacy football facts are rewritten.
    data['updated'] = report['generatedAt']
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=1)+'\n')
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')


if __name__ == '__main__':
    main()
