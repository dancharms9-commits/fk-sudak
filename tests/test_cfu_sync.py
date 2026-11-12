"""Matchday scheduling, official reconciliation and durable Pages transactions."""
import copy
from datetime import datetime, timedelta
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

from bs4 import BeautifulSoup
import requests

from scripts import cfu_sync as sync, cfu_premier_import as importer, build_pages as build
from test_pages_build import SEED, artifact, response, run

ROOT = Path(__file__).resolve().parents[1]
OLD = ROOT / 'tests/fixtures/cfu-premier'
FIX = ROOT / 'tests/fixtures/cfu-auto-refresh'
NOW = datetime.fromisoformat('2026-11-11T20:30:00+00:00')
ROSTERS = json.loads((ROOT / 'cfu-premier-rosters-2026.json').read_text())


def baseline():
    value = sync.seed_state(ROOT)
    value['calendar'] = importer.build_snapshot(
        (OLD / 'teams-2026.html').read_text(), (OLD / 'table-2026.html').read_text(),
        (OLD / 'calendar-2026.html').read_text(),
        {key: '2026-11-11T12:00:00+00:00' for key in ('teams', 'table', 'calendar')})
    details = value['details']
    for key in list(details['matchesById']):
        if key not in {'cfu:match:18763', 'cfu:match:18769'}:
            del details['matchesById'][key]
            del details['sourceMetadata']['sources'][key]
    details['unresolvedRecords'] = [r for r in details['unresolvedRecords']
                                    if r.get('raw', {}).get('matchId') in details['matchesById']]
    details['sourceMetadata']['retrievedAt'] = '2026-11-11T18:00:00+00:00'
    return sync.validate_state(value)


class OfficialFixtureClient:
    """Saved real HTTP bodies; mutations below are explicitly synthetic tests."""
    def __init__(self):
        self.calls = []
        self.pages = {sync.ROBOTS_URL: 'User-agent: *\nCrawl-delay: 40'}
        for url, name in ((sync.TEAMS_URL, 'teams'), (sync.TABLE_URL, 'table'),
                          (sync.CALENDAR_URL, 'calendar')):
            self.pages[url] = (FIX / f'cfu-{name}.html').read_text()
        for number in (18766, 18767, 18768):
            self.pages[f'{sync.BASE}/matches/premier-leagueCFU/match_{number}/'] = (
                FIX / f'cfu-match-{number}.html').read_text()

    def get(self, url):
        self.calls.append(url)
        value = self.pages[url]
        if isinstance(value, Exception):
            raise value
        return value, '2026-11-11T20:25:00+00:00'

    def score(self, number, home, away, status='Матч завершен'):
        url = f'{sync.BASE}/matches/premier-leagueCFU/match_{number}/'
        page = BeautifulSoup(self.pages[url], 'html.parser')
        page.select_one('.matchesDetails-header .score strong').string = f'{home}:{away}'
        page.select_one('.labelRow .label').string = status
        self.pages[url] = str(page)
        calendar = BeautifulSoup(self.pages[sync.CALENDAR_URL], 'html.parser')
        calendar.select_one(f'a[href$="/match_{number}/"] .score').string = f'{home}:{away}'
        self.pages[sync.CALENDAR_URL] = str(calendar)


class SchedulingTests(unittest.TestCase):
    def test_wednesday_and_saturday_follow_dates_not_weekdays(self):
        for day in ('2026-11-11', '2026-11-21'):
            value = baseline()
            value['calendar']['sourceMetadata']['sections']['calendar']['checkedAt'] = day + 'T00:00:00+03:00'
            for match in value['calendar']['matchesById'].values():
                if match['round'] == 25:
                    match['date'] = day
            morning = datetime.fromisoformat(day + 'T10:00:00+03:00')
            self.assertIsNone(sync.due_slot(value, morning))
            for hour in (20, 23):
                now = datetime.fromisoformat(day + f'T{hour}:07:00+03:00')
                self.assertEqual(sync.due_slot(value, now), day + f'T{hour}:00:00+03:00')

    def test_no_matches_and_no_pending_means_zero_source_requests(self):
        client = Mock()
        value = sync.seed_state(ROOT)
        self.assertEqual(sync.refresh(value, datetime.fromisoformat('2026-11-13T21:00:00+03:00'), client), value)
        client.get.assert_not_called()

    def test_next_morning_and_overdue_pending_have_one_daily_retry(self):
        client = OfficialFixtureClient()
        client.pages[sync.ROBOTS_URL] = requests.Timeout('offline')
        failed = sync.refresh(baseline(), NOW, client)
        next_day = datetime.fromisoformat('2026-11-12T09:08:00+03:00')
        self.assertEqual(sync.due_slot(failed, next_day), '2026-11-12T09:00:00+03:00')
        retried = sync.refresh(failed, next_day, client)
        count = len(client.calls)
        self.assertEqual(sync.refresh(retried, next_day + timedelta(hours=1), client), retried)
        self.assertEqual(len(client.calls), count)
        self.assertIsNotNone(sync.due_slot(retried, next_day + timedelta(days=1)))

    def test_delayed_run_uses_latest_slot_and_rerun_does_not_refetch(self):
        client = OfficialFixtureClient()
        value = sync.refresh(baseline(), NOW, client, ROSTERS)
        self.assertEqual(value['sync']['lastSlot'], '2026-11-11T23:00:00+03:00')
        count = len(client.calls)
        self.assertEqual(sync.refresh(value, NOW + timedelta(minutes=10), client), value)
        self.assertEqual(len(client.calls), count)


class ReconciliationTests(unittest.TestCase):
    def test_real_official_25th_round_and_only_three_new_protocols(self):
        client = OfficialFixtureClient()
        value = sync.refresh(baseline(), NOW, client, ROSTERS)
        self.assertIsNone(value['sync']['error'])
        self.assertEqual(value['sync']['pending'], [])
        for number, score in ((18766, (1, 0)), (18767, (2, 0)), (18768, (2, 1))):
            match = value['calendar']['matchesById'][f'cfu:match:{number}']
            self.assertEqual((match['homeScore'], match['awayScore']), score)
            self.assertEqual(match['status'], 'finished')
            self.assertIsNone(match['timeZone'])
        self.assertEqual(len(client.calls), 7)  # robots + 3 summary pages + 3 protocols
        self.assertEqual(len(value['calendar']['teamsById']), 7)
        self.assertEqual(len(value['calendar']['matchesById']), 84)
        self.assertEqual(value['calendar']['standings']['asOfRound'], 25)
        self.assertEqual(value['calendar']['standings']['rows'][0]['points'], 49)
        self.assertEqual(len(value['details']['matchesById']), 5)
        # Independently check the published table against the full real calendar;
        # production continues to display the official table rather than deriving it.
        for row in value['calendar']['standings']['rows']:
            totals = dict.fromkeys(('played', 'wins', 'draws', 'losses', 'goalsFor', 'goalsAgainst'), 0)
            for match in value['calendar']['matchesById'].values():
                if match['homeScore'] is None:
                    continue
                for side, other in (('home', 'away'), ('away', 'home')):
                    if match[side + 'TeamId'] != row['teamId']:
                        continue
                    own, theirs = match[side + 'Score'], match[other + 'Score']
                    totals['played'] += 1
                    totals['wins'] += own > theirs
                    totals['draws'] += own == theirs
                    totals['losses'] += own < theirs
                    totals['goalsFor'] += own
                    totals['goalsAgainst'] += theirs
            self.assertEqual(totals, {field: row[field] for field in totals})
            self.assertEqual(row['points'], row['wins'] * 3 + row['draws'])

    def test_unconfirmed_zero_is_not_finished_then_can_become_two_zero(self):
        client = OfficialFixtureClient()
        client.score(18767, 0, 0, 'Ожидается подтверждение')
        provisional = sync.refresh(baseline(), NOW, client, ROSTERS)
        match = provisional['calendar']['matchesById']['cfu:match:18767']
        self.assertEqual(match['homeScore'], 0)
        self.assertIsNone(match['status'])
        self.assertIn('cfu:match:18767', provisional['sync']['pending'])
        self.assertFalse(provisional['details']['matchesById']['cfu:match:18767']['goalsComplete'])
        # A real later successful fetch, rather than an elapsed match duration.
        next_client = OfficialFixtureClient()
        done = sync.refresh(provisional, datetime.fromisoformat('2026-11-12T09:00:00+03:00'), next_client, ROSTERS)
        self.assertIsNone(done['sync']['error'])
        self.assertEqual(done['calendar']['matchesById']['cfu:match:18767']['homeScore'], 2)
        self.assertEqual(done['calendar']['matchesById']['cfu:match:18767']['status'], 'finished')

    def test_labelled_finished_zero_zero_is_preserved_as_final(self):
        client = OfficialFixtureClient()
        client.score(18767, 0, 0)
        url = f'{sync.BASE}/matches/premier-leagueCFU/match_18767/'
        page = BeautifulSoup(client.pages[url], 'html.parser')
        for events in page.select('.eventEntries1, .eventEntries2'):
            events.clear()
        client.pages[url] = str(page)
        value = sync.refresh(baseline(), NOW, client, ROSTERS)
        match = value['calendar']['matchesById']['cfu:match:18767']
        self.assertEqual((match['homeScore'], match['awayScore'], match['status']), (0, 0, 'finished'))
        self.assertNotIn(match['matchId'], value['sync']['pending'])
        self.assertEqual(value['details']['matchesById'][match['matchId']]['goals'], [])
        self.assertTrue(value['details']['matchesById'][match['matchId']]['goalsComplete'])
        self.assertEqual(sync.choose_state(value, value), value)

    def test_missing_new_protocol_leaves_result_provisional(self):
        client = OfficialFixtureClient()
        error = requests.HTTPError('404', response=Mock(status_code=404))
        client.pages[f'{sync.BASE}/matches/premier-leagueCFU/match_18767/'] = error
        value = sync.refresh(baseline(), NOW, client, ROSTERS)
        self.assertIsNone(value['sync']['error'])
        self.assertIsNone(value['calendar']['matchesById']['cfu:match:18767']['status'])
        self.assertIn('cfu:match:18767', value['sync']['pending'])

    def test_postponed_match_can_receive_a_verified_new_date_and_later_result(self):
        client = OfficialFixtureClient()
        client.score(18767, 0, 0, 'Матч перенесен')
        postponed = sync.refresh(baseline(), NOW, client, ROSTERS)
        self.assertEqual(postponed['calendar']['matchesById']['cfu:match:18767']['status'], 'postponed')
        self.assertIn('cfu:match:18767', postponed['sync']['pending'])
        # Both NEW official sources agree on the changed date. A postponed
        # fixture is not an immutable played result.
        future = OfficialFixtureClient()
        calendar = BeautifulSoup(future.pages[sync.CALENDAR_URL], 'html.parser')
        row = calendar.select_one('a[href$="/match_18767/"]')
        date = row.select_one('.entry-row-values .entry-title strong')
        date.string = date.get_text().replace('11 ноября 2026', '15 ноября 2026')
        row.select_one('.score').string = '—'
        future.pages[sync.CALENDAR_URL] = str(calendar)
        url = f'{sync.BASE}/matches/premier-leagueCFU/match_18767/'
        page = BeautifulSoup(future.pages[url].replace('11 ноября 2026', '15 ноября 2026'), 'html.parser')
        page.select_one('.matchesDetails-header .score strong').string = '—'
        page.select_one('.labelRow .label').string = 'Матч не начался'
        future.pages[url] = str(page)
        rescheduled = sync.refresh(postponed, datetime.fromisoformat('2026-11-12T09:00:00+03:00'), future, ROSTERS)
        self.assertIsNone(rescheduled['sync']['error'])
        match = rescheduled['calendar']['matchesById']['cfu:match:18767']
        self.assertEqual((match['date'], match['status'], match['homeScore']), ('2026-11-15', 'scheduled', None))
        self.assertNotIn(match['matchId'], rescheduled['sync']['pending'])
        self.assertEqual(sync.choose_state(postponed, rescheduled), rescheduled)
        self.assertIsNone(sync.due_slot(rescheduled, datetime.fromisoformat('2026-11-13T21:00:00+03:00')))
        # A later confirmed result on the same date is also a valid transition.
        finished = sync.refresh(postponed, datetime.fromisoformat('2026-11-12T09:00:00+03:00'), OfficialFixtureClient(), ROSTERS)
        self.assertEqual(finished['calendar']['matchesById']['cfu:match:18767']['status'], 'finished')

    def test_conflicting_score_team_date_id_competition_or_season_retains_snapshot(self):
        mutations = [('<strong>2:0</strong>', '<strong>3:0</strong>'),
                     ('/teams/tavriya/', '/teams/fc-okean/'),
                     ('11 ноября 2026', '10 ноября 2026'),
                     ('match_score_18767', 'match_score_18768'),
                     ('matches_premier-leagueCFU', 'matches_cupCFU'),
                     ('сезон 2026', 'сезон 2025')]
        for before, after in mutations:
            client = OfficialFixtureClient()
            url = f'{sync.BASE}/matches/premier-leagueCFU/match_18767/'
            self.assertIn(before, client.pages[url])
            client.pages[url] = client.pages[url].replace(before, after)
            old = baseline()
            with self.subTest(mutation=before):
                value = sync.refresh(old, NOW, client, ROSTERS)
                self.assertIsNotNone(value['sync']['error'])
                self.assertEqual(value['calendar'], old['calendar'])
                self.assertEqual(value['details'], old['details'])

    def test_network_failure_keeps_last_good_and_failure_is_checkpointable(self):
        client = Mock()
        client.get.side_effect = requests.Timeout('network')
        old = baseline()
        value = sync.refresh(old, NOW, client)
        self.assertEqual(value['calendar'], old['calendar'])
        self.assertEqual(value['details'], old['details'])
        self.assertIsNone(value['sync']['lastSuccessAt'])
        self.assertEqual(len(value['sync']['pending']), 3)
        self.assertEqual(sync.choose_state(old, value), value)

    def test_lagging_table_retries_even_when_protocols_are_finished(self):
        client = OfficialFixtureClient()
        client.pages[sync.TABLE_URL] = (OLD / 'table-2026.html').read_text()
        value = sync.refresh(baseline(), NOW, client, ROSTERS)
        self.assertEqual(len(value['sync']['pending']), 3)
        self.assertIsNotNone(sync.due_slot(value, datetime.fromisoformat('2026-11-12T09:00:00+03:00')))
        next_client = OfficialFixtureClient()
        latest = sync.refresh(value, datetime.fromisoformat('2026-11-12T09:00:00+03:00'), next_client, ROSTERS)
        self.assertEqual(latest['sync']['pending'], [])
        self.assertEqual(len(next_client.calls), 4, 'Confirmed protocols must not be fetched again for a table update')


class PersistenceTests(unittest.TestCase):
    def test_checkpoint_beats_old_main_and_cdn_and_next_hour_does_not_rollback(self):
        old = baseline()
        latest = sync.refresh(old, NOW, OfficialFixtureClient(), ROSTERS)
        for candidates in ((old, old, latest), (old, latest, old)):
            restored = sync.choose_state(*candidates)
            self.assertEqual(restored, latest)
            client = Mock()
            self.assertEqual(sync.refresh(restored, NOW + timedelta(hours=1), client), latest)
            client.get.assert_not_called()
        rollback = copy.deepcopy(old)
        rollback['sync']['lastAttemptAt'] = (NOW + timedelta(hours=2)).isoformat()
        with self.assertRaisesRegex(ValueError, 'rollback|Lost'):
            sync.choose_state(latest, rollback)

    def test_successful_production_artifact_restores_both_competitions(self):
        state = sync.refresh(baseline(), NOW, OfficialFixtureClient(), ROSTERS)
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, 'w') as archive:
            archive.writestr('_site/data.json', json.dumps(SEED))
            archive.writestr('_site/' + sync.PUBLIC_STATE, json.dumps(state))
        session = Mock()
        session.get.side_effect = [response({'artifacts': [artifact(1)]}), response(run()),
                                   response(content=payload.getvalue())]
        self.assertEqual(build.successful_checkpoint('owner/repo', 'token', session, include_cfu=True), (SEED, state))

    def test_first_rollout_and_unavailable_or_broken_pages(self):
        session = Mock()
        session.get.return_value = Mock(status_code=404)
        self.assertIsNone(sync.published_state('https://example.test', session))
        self.assertEqual(sync.choose_state(baseline(), None, None), baseline())
        session.get.side_effect = requests.Timeout()
        with self.assertRaises(requests.Timeout):
            sync.published_state('https://example.test', session)
        session.get.side_effect = None
        session.get.return_value = Mock(status_code=200, content=b'{}')
        with self.assertRaises(ValueError):
            sync.published_state('https://example.test', session)

    def test_simultaneous_rffk_and_cfu_stage_without_changing_tracked_data(self):
        state = sync.refresh(baseline(), NOW, OfficialFixtureClient(), ROSTERS)
        original = {name: (ROOT / name).read_bytes() for name in ('data.json', sync.CALENDAR_FILE, sync.DETAILS_FILE)}
        def runner(command, cwd, **kwargs):
            data = json.loads((cwd / 'data.json').read_text())
            data['coach'] += ' · test refresh'
            build.write_json(cwd / 'data.json', data)
        with tempfile.TemporaryDirectory() as directory:
            data = build.refresh(SEED, Path(directory), runner=runner)
            output = Path(directory) / '_site'
            build.stage_site(ROOT, output, data, cfu=state)
            self.assertEqual(json.loads((output / 'data.json').read_text()), data)
            self.assertEqual(json.loads((output / sync.PUBLIC_STATE).read_text()), state)
            self.assertEqual(json.loads((output / sync.CALENDAR_FILE).read_text()), state['calendar'])
            self.assertEqual(len(data['match_details']), 16)
            self.assertEqual(len(data['platform']['teamsById']), 11)
        for name, raw in original.items():
            self.assertEqual((ROOT / name).read_bytes(), raw)

    def test_old_workflow_definition_is_stopped_before_any_refresh(self):
        session = Mock()
        session.get.return_value = response({'sha': 'old-workflow-blob'})
        with self.assertRaisesRegex(ValueError, 'Outdated workflow'):
            sync.require_current_workflow(ROOT, 'owner/repo', 'token', 'old-commit', session)


class RateLimitTests(unittest.TestCase):
    def test_robots_retries_and_redirects_all_use_same_minimum_delay(self):
        now = [0.0]
        sleeps = []
        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds
        session = Mock(headers={})
        good = Mock(status_code=200, content=b'x' * 1500)
        session.get.side_effect = [Mock(status_code=200, content=b'User-agent: *\nCrawl-delay: 45'),
                                   requests.Timeout(), Mock(status_code=302, headers={'Location': sync.TABLE_URL}), good]
        client = sync.PoliteClient(session, clock=lambda: now[0], sleep=sleep)
        client.get(sync.ROBOTS_URL)
        client.get(sync.CALENDAR_URL)
        self.assertEqual(sleeps, [45, 45, 45])
        self.assertTrue(all(call.kwargs['allow_redirects'] is False for call in session.get.call_args_list))

    def test_robots_disallow_prevents_protocol_request(self):
        session = Mock(headers={})
        session.get.return_value = Mock(status_code=200, content=b'User-agent: *\nDisallow: /matches\nCrawl-delay: 40')
        client = sync.PoliteClient(session)
        client.get(sync.ROBOTS_URL)
        with self.assertRaisesRegex(ValueError, 'disallows'):
            client.get(sync.CALENDAR_URL)
        self.assertEqual(session.get.call_count, 1)


if __name__ == '__main__':
    unittest.main()
