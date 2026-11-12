"""Small matchday transaction for the existing hourly Pages publisher.

The public bundle is an atomic calendar/protocol/checkpoint revision. No network
is used to decide whether a check is due. Football dates remain timezone-free;
Europe/Moscow is used only by the job scheduler.
"""
import copy
from datetime import datetime, time as day_time, timedelta, timezone
import json
import hashlib
from pathlib import Path
import time
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

from scripts import cfu_premier_import as calendar_import
from scripts import cfu_match_details as protocol_import
from scripts.cfu_premier_schema import (
    BASE, CALENDAR_URL, TABLE_URL, TEAMS_URL, ROBOTS_URL, CRAWL_DELAY_SECONDS,
    require, timestamp, validate_snapshot,
)
from scripts.cfu_match_details_schema import validate_match_details

PUBLIC_STATE = 'cfu-sync-2026.json'
CALENDAR_FILE = 'cfu-premier-2026.json'
DETAILS_FILE = 'cfu-premier-match-details-2026.json'
FINAL = {'finished', 'technical'}  # immutable, confirmed played results
CLOSED = FINAL | {'cancelled'}
LABELLED = CLOSED | {'postponed'}
IDENTITY = ('sourceMatchId', 'sourceUrl', 'homeTeamId', 'awayTeamId', 'round', 'circle')
FACTS = ('date', 'time', 'homeScore', 'awayScore', 'status')
try:
    SCHEDULER_TZ = ZoneInfo('Europe/Moscow')
except ZoneInfoNotFoundError:
    # Termux Python may have no IANA database. For this 2026-only scheduler
    # Moscow uses UTC+03; this never enters source football date/time fields.
    SCHEDULER_TZ = timezone(timedelta(hours=3), 'Europe/Moscow')


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def seed_state(root):
    root = Path(root)
    calendar = json.loads((root / CALENDAR_FILE).read_text())
    details = json.loads((root / DETAILS_FILE).read_text())
    return validate_state({'schemaVersion': 1, 'calendar': calendar, 'details': details,
                           'sync': {'lastAttemptAt': None, 'lastSlot': None,
                                    'lastSuccessAt': None, 'pending': [], 'error': None}})


def validate_state(state):
    require(isinstance(state, dict) and state.get('schemaVersion') == 1,
            'Invalid CFU state version')
    calendar, details = state['calendar'], state['details']
    validate_snapshot(calendar)
    validate_match_details(details, calendar)
    require(len(calendar['teamsById']) == 7 and len(calendar['matchesById']) == 84,
            'Incomplete CFU season: expected seven clubs and 84 matches')
    sync = state['sync']
    require(isinstance(sync, dict), 'Missing CFU sync state')
    for field in ('lastAttemptAt', 'lastSuccessAt', 'lastSlot'):
        if sync.get(field) is not None:
            timestamp(sync[field])
    require(isinstance(sync.get('pending'), list)
            and len(sync['pending']) == len(set(sync['pending']))
            and set(sync['pending']) <= set(calendar['matchesById']), 'Invalid pending matches')
    require(sync.get('error') is None or isinstance(sync['error'], str), 'Invalid CFU error')
    if sync.get('lastSuccessAt'):
        require(timestamp(sync['lastSuccessAt']) <= timestamp(calendar['sourceMetadata']['retrievedAt']),
                'Success time does not come from source metadata')
    for key, match in calendar['matchesById'].items():
        detail = details['matchesById'].get(key)
        if match['status'] in LABELLED:
            require(detail is not None and detail['status'] == match['status'],
                    f'Unconfirmed terminal status: {key}')
    return state


def revision(state):
    return max(timestamp(value) for value in (
        state['calendar']['sourceMetadata']['retrievedAt'],
        state['details']['sourceMetadata']['retrievedAt'],
        state['sync'].get('lastAttemptAt')) if value)


def choose_state(*candidates):
    candidates = [validate_state(value) for value in candidates if value is not None]
    newest = max(candidates, key=revision)
    for old in candidates:
        require(set(old['calendar']['matchesById']) == set(newest['calendar']['matchesById']),
                'CFU fixture identities changed during restoration')
        for key, before in old['calendar']['matchesById'].items():
            after = newest['calendar']['matchesById'][key]
            require(all(before[f] == after[f] for f in IDENTITY), f'CFU identity rollback: {key}')
            if before['status'] in FINAL:
                require(all(before[f] == after[f] for f in FACTS), f'CFU confirmed result rollback: {key}')
        require(set(old['details']['matchesById']) <= set(newest['details']['matchesById']),
                'Lost saved CFU protocols')
        for key, detail in old['details']['matchesById'].items():
            if detail['status'] in FINAL:
                updated = newest['details']['matchesById'][key]
                require(all(detail[field] == updated[field] for field in FACTS),
                        f'CFU verified protocol rollback: {key}')
    return copy.deepcopy(newest)


def due_slot(state, now):
    """Hourly from first kickoff + 1h through last + 3h; 20/23 if time is missing.

    The latest elapsed slot absorbs delayed Actions jobs. A persisted slot makes
    reruns idempotent, including failures. Historical unverified fixtures before
    the saved calendar check are deliberately not bulk-downloaded. Unresolved
    results, errors and a lagging table retry daily at 09 Moscow time.
    """
    now = now.astimezone(SCHEDULER_TZ)
    today, yesterday = now.date(), now.date() - timedelta(days=1)
    sync = state['sync']
    calendar = state['calendar']
    matches = calendar['matchesById'].values()
    start = timestamp(state['calendar']['sourceMetadata']['sections']['calendar']['checkedAt']).astimezone(now.tzinfo).date()
    pending = set(sync['pending'])
    dates = set()
    by_day = {}
    for match in matches:
        if not match.get('date'):
            continue
        match_day = datetime.fromisoformat(match['date']).date()
        by_day.setdefault(match_day, []).append(match)
        table_lagging = (match['status'] in FINAL
                         and match['round'] > calendar['standings']['asOfRound'])
        if ((match['status'] not in CLOSED and match_day >= start)
                or match['matchId'] in pending or table_lagging):
            if match_day <= today:
                dates.add(match_day)
    slots = []
    for day in dates & {today, yesterday}:
        fixtures = by_day[day]
        # Keep completed fixtures in the window calculation: confirmation of
        # the earliest game must not shift the remaining hourly slots.
        kickoffs = [datetime.combine(day, day_time.fromisoformat(m['time']), now.tzinfo)
                    for m in fixtures if m.get('time')]
        if kickoffs:
            first, last = min(kickoffs) + timedelta(hours=1), max(kickoffs) + timedelta(hours=3)
            slot = first.replace(minute=0)
            if slot < first:
                slot += timedelta(hours=1)
            while slot <= last:
                if slot.date() == today:
                    slots.append(slot)
                slot += timedelta(hours=1)
        if any(not m.get('time') for m in fixtures) and day == today:
            slots += [datetime.combine(day, day_time(hour), now.tzinfo) for hour in (20, 23)]
    failed_before_today = (sync.get('error') and sync.get('lastAttemptAt')
                           and timestamp(sync['lastAttemptAt']).astimezone(now.tzinfo).date() < today)
    if any(day < today for day in dates) or failed_before_today:
        slots.append(datetime.combine(today, day_time(9), now.tzinfo))
    elapsed = [slot for slot in slots if slot <= now]
    if not elapsed:
        return None
    slot = max(elapsed)
    if sync.get('lastSlot') and timestamp(sync['lastSlot']) >= slot:
        return None
    return slot.isoformat()


class PoliteClient:
    """One limiter for robots, calendar, table, protocols, redirects and retries."""
    def __init__(self, session=None, clock=time.monotonic, sleep=time.sleep, now=utc_now):
        self.session = session or requests.Session()
        self.session.headers.update({'User-Agent': calendar_import.USER_AGENT})
        self.clock, self.sleep, self.now = clock, sleep, now
        self.last = None
        self.delay = CRAWL_DELAY_SECONDS
        self.robots = None

    def get(self, url):
        for attempt in range(2):
            current = url
            try:
                for _ in range(4):
                    parsed = urlparse(current)
                    require(parsed.scheme == 'https' and parsed.netloc == 'www.cfu2015.com',
                            'CFU redirect left official origin')
                    if self.robots is not None:
                        require(self.robots.can_fetch(calendar_import.USER_AGENT, current),
                                f'robots.txt disallows {parsed.path}')
                    if self.last is not None:
                        self.sleep(max(0, self.delay - (self.clock() - self.last)))
                    # Record every attempt, including exceptions. Requests has no
                    # automatic retries; redirects are explicitly rate-limited.
                    self.last = self.clock()
                    response = self.session.get(current, timeout=30, allow_redirects=False)
                    if response.status_code in (301, 302, 303, 307, 308):
                        from urllib.parse import urljoin
                        current = urljoin(current, response.headers['Location'])
                        continue
                    response.raise_for_status()
                    require(response.status_code == 200, 'Unexpected CFU HTTP status')
                    html = protocol_import._decode(response.content, current)
                    checked = self.now()
                    if url == ROBOTS_URL:
                        robots = RobotFileParser()
                        robots.parse(html.splitlines())
                        self.delay = max(CRAWL_DELAY_SECONDS, robots.crawl_delay(calendar_import.USER_AGENT) or 0)
                        self.robots = robots
                    else:
                        require(len(html) > 1000, f'Truncated CFU HTML: {url}')
                    return html, checked
                raise ValueError('Too many CFU redirects')
            except requests.RequestException as exc:
                status = getattr(exc.response, 'status_code', None)
                if attempt or (status is not None and status < 500):
                    raise
        raise AssertionError('unreachable')


def _merge_protocols(previous, added, calendar):
    result = copy.deepcopy(previous)
    for key, value in added['matchesById'].items():
        result['matchesById'][key] = value
        result['sourceMetadata']['sources'][key] = added['sourceMetadata']['sources'][key]
    result['sourceMetadata']['retrievedAt'] = max(
        (result['sourceMetadata']['retrievedAt'], added['sourceMetadata']['retrievedAt']), key=timestamp)
    replaced = set(added['matchesById'])
    result['unresolvedRecords'] = [item for item in result['unresolvedRecords']
                                   if item.get('raw', {}).get('matchId') not in replaced]
    result['unresolvedRecords'] += added['unresolvedRecords']
    return result


def refresh(state, now=None, client=None, rosters=None, force=False):
    """Return a complete last-good transaction, with persistent failure metadata."""
    validate_state(state)
    now = now or datetime.now(timezone.utc)
    slot = due_slot(state, now)
    if slot is None and not force:
        return copy.deepcopy(state)
    result = copy.deepcopy(state)
    sync = result['sync']
    sync.update(lastSlot=slot or now.isoformat(), lastAttemptAt=now.isoformat(), error=None)
    previous = state['calendar']
    today = now.astimezone(SCHEDULER_TZ).date().isoformat()
    start = timestamp(previous['sourceMetadata']['sections']['calendar']['checkedAt']).astimezone(SCHEDULER_TZ).date().isoformat()
    pending = set(sync['pending'])
    targets = {key for key, match in previous['matchesById'].items()
               if match.get('date') and start <= match['date'] <= today and match['status'] not in CLOSED}
    targets |= pending
    try:
        client = client or PoliteClient()
        client.get(ROBOTS_URL)
        pages, checks = {}, {}
        for section, url in (('teams', TEAMS_URL), ('calendar', CALENDAR_URL), ('table', TABLE_URL)):
            pages[section], checks[section] = client.get(url)
        candidate = calendar_import.build_snapshot(pages['teams'], pages['table'], pages['calendar'], checks)
        for section, html in pages.items():
            candidate['sourceMetadata']['sections'][section]['sourceSha256'] = protocol_import._source_digest(html)
        require(set(candidate['teamsById']) == set(previous['teamsById'])
                and set(candidate['matchesById']) == set(previous['matchesById']), 'CFU season identities changed')
        for key, before in previous['matchesById'].items():
            after = candidate['matchesById'][key]
            require(all(before[f] == after[f] for f in IDENTITY), f'CFU fixture identity conflict: {key}')
            if before['status'] in FINAL:
                require(all(before[f] == after[f] for f in ('date', 'time', 'homeScore', 'awayScore')),
                        f'CFU confirmed calendar conflict: {key}')
                after['status'], after['statusLabel'] = before['status'], before['statusLabel']
            # Changed scores/dates need targeted verification even when the
            # publication caught up after a missed matchday job.
            elif any(before[f] != after[f] for f in ('date', 'time', 'homeScore', 'awayScore')):
                targets.add(key)
            elif before['status'] in LABELLED:
                after['status'], after['statusLabel'] = before['status'], before['statusLabel']
        details = copy.deepcopy(state['details'])
        pending = set()
        for key in sorted(targets):
            expected = candidate['matchesById'][key]
            old_detail = details['matchesById'].get(key)
            # Waiting for the table is not a reason to redownload a protocol
            # whose terminal facts were already verified and remain unchanged.
            if expected['status'] in FINAL and old_detail and old_detail['status'] in FINAL:
                continue
            try:
                html, checked = client.get(expected['sourceUrl'])
            except requests.HTTPError as exc:
                if exc.response is None or exc.response.status_code != 404:
                    raise
                pending.add(key)
                # A previously saved protocol cannot silently disappear.
                require(key not in details['matchesById'], f'Saved CFU protocol missing: {key}')
                continue
            record, _ = protocol_import.parse_match_protocol(html, expected, rosters, checked,
                                                             protocol_import._source_digest(html))
            if old_detail and old_detail['status'] in FINAL:
                require(all(old_detail[field] == record[field] for field in FACTS),
                        f'CFU confirmed protocol conflict: {key}')
            if record['status'] in {'finished', 'technical'}:
                require(record['homeScore'] is not None and expected['homeScore'] is not None,
                        f'CFU finished match has no calendar result: {key}')
            # Status is accepted only from the labelled official protocol.
            expected['status'], expected['statusLabel'] = record['status'], record['statusLabel']
            added = protocol_import.build_snapshot(candidate, rosters, {key: html}, {key: checked},
                                                   retrieval='direct_http_matchday')
            details = _merge_protocols(details, added, candidate)
            if record['status'] not in CLOSED and (not expected.get('date') or expected['date'] <= today):
                pending.add(key)
        validate_match_details(details, candidate, rosters)
        # The official table may be published later than the protocols. Keep it
        # verbatim and schedule another bounded check until the round catches up.
        finished_rounds = [m['round'] for m in candidate['matchesById'].values()
                           if m['status'] in {'finished', 'technical'}]
        if finished_rounds and candidate['standings']['asOfRound'] < max(finished_rounds):
            pending |= targets
        sync.update(pending=sorted(pending), lastSuccessAt=candidate['sourceMetadata']['retrievedAt'])
        result.update(calendar=candidate, details=details)
        return validate_state(result)
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        # Preserve ALL football facts on conflicts/errors; keep retry state in
        # the same deployed/checkpointed bundle so hourly reruns do not hammer CFU.
        result = copy.deepcopy(state)
        result['sync'].update(lastSlot=sync['lastSlot'], lastAttemptAt=sync['lastAttemptAt'])
        result['sync'].update(pending=sorted(targets | set(state['sync']['pending'])),
                              error=f'{type(exc).__name__}: {exc}')
        print(f'::warning::CFU sync: {result["sync"]["error"]}; last-good snapshot retained')
        return validate_state(result)


def published_state(site_url, session=None):
    session = session or requests.Session()
    response = session.get(site_url.rstrip('/') + '/' + PUBLIC_STATE,
                           params={'pages-refresh': time.time_ns()}, timeout=30,
                           headers={'Cache-Control': 'no-cache', 'Accept': 'application/json'})
    if response.status_code == 404:
        return None  # first rollout; seed + successful checkpoint are still checked
    response.raise_for_status()
    require(len(response.content) < 5_000_000, 'Oversized CFU published state')
    return validate_state(json.loads(response.content))


def stage(output, state):
    validate_state(state)
    for name, value in ((PUBLIC_STATE, state), (CALENDAR_FILE, state['calendar']),
                        (DETAILS_FILE, state['details'])):
        (Path(output) / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def require_current_workflow(root, repository, token, workflow_sha, session=None):
    """Old run definitions cannot omit the CFU file from their checkpoint upload."""
    if not workflow_sha:
        return
    session = session or requests.Session()
    response = session.get(f'https://api.github.com/repos/{repository}/contents/.github/workflows/update.yml',
                           params={'ref': workflow_sha}, timeout=30,
                           headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
    response.raise_for_status()
    raw = (Path(root) / '.github/workflows/update.yml').read_bytes()
    current_blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    require(response.json()['sha'] == current_blob,
            'Outdated workflow definition: start a new run on main; publication stopped before refresh')
