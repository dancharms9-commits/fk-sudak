"""Real official November 13 response against the published November 7 calendar."""
import copy
from contextlib import redirect_stdout
from datetime import timedelta
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup
import requests
import fetch_data as parser
from scripts import build_pages as build, multi_club_sources as sources

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/rffk-refresh'
SEED = json.loads((ROOT / 'data.json').read_text())
MATCH = '4:2026:19:930:117'


def baseline():
    data = copy.deepcopy(SEED)
    meta = json.loads((FIXTURES / 'sources.json').read_text())
    data['updated'] = meta['publishedUpdated']
    data['platform']['sourceUpdatedAt'] = meta['publishedSourceUpdatedAt']
    data['championship']['calendar'] = json.loads((FIXTURES / 'calendar-last-good-2026-11-07.json').read_text())
    return build.choose_baseline(SEED, data)


def page():
    return BeautifulSoup((FIXTURES / 'season-22-2026-11-13.html').read_text(), 'html.parser')


def loader(path):
    if path == parser.LEAGUE_PATH:
        return BeautifulSoup('<a href="/tournaments/4/seasons/22/">2026/2026</a>', 'html.parser')
    assert path == '/tournaments/4/seasons/22/'
    return page()


def candidate(old):
    data = copy.deepcopy(old)
    data['championship'] = parser.update_championship(old['championship'], loader=loader, club_details=old['match_details'])
    data['updated'] = data['championship']['calendar']['updated']
    return data


def refresh(old, incoming=None, platform_loader=None):
    def runner(command, cwd, **kwargs):
        if command[-1].endswith('fetch_data.py'):
            build.write_json(cwd / 'data.json', incoming or candidate(old))
    with tempfile.TemporaryDirectory() as directory:
        return build.refresh(old, Path(directory), runner, platform_loader=platform_loader)


class RffkRefreshTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = baseline()
        cls.incoming = candidate(cls.old)
        cls.new = refresh(cls.old, cls.incoming)

    def test_real_ranking_turnover_does_not_reject_fresh_calendar(self):
        before = {p['id'] for p in self.old['championship']['scorers']['players']}
        after = {p['id'] for p in self.new['championship']['scorers']['players']}
        self.assertEqual(before - after, {'202'})
        self.assertEqual(after - before, {'1202'})
        self.assertEqual(len(after), 25)
        self.assertFalse(self.new['championship']['scorers']['stale'])
        self.assertIn('202', self.new['platform']['playersById'])
        self.assertEqual(self.new['player_stats_2026'], self.old['player_stats_2026'])
        build.validate(self.new, self.old)

    def test_scheduled_becomes_official_finished_one_four_in_both_models(self):
        old = next(m for m in self.old['championship']['calendar']['matches'] if m['id'] == MATCH)
        self.assertEqual(old['status'], 'scheduled')
        new = next(m for m in self.new['championship']['calendar']['matches'] if m['id'] == MATCH)
        self.assertEqual((new['source_id'], new['source_url'], new['date'], new['status'], new['home_score'], new['away_score']),
                         ('38768', 'https://rffk-roo.ru/matches/38768/', '2026-11-11', 'finished', 1, 4))
        platform = self.new['platform']['matchesById'][MATCH]
        self.assertEqual((platform['sourceMatchId'], platform['date'], platform['status'], platform['homeScore'], platform['awayScore']),
                         ('38768', '2026-11-11', 'finished', 1, 4))
        self.assertGreater(build.timestamp(self.new), build.timestamp(self.old))

    def test_existing_round_and_all_historical_results_are_retained(self):
        matches = {m['id']: m for m in self.new['championship']['calendar']['matches']}
        for old in self.old['championship']['calendar']['matches']:
            self.assertIn(old['id'], matches)
            if old['status'] in {'finished', 'technical'}:
                for field in ('date', 'status', 'home_score', 'away_score', 'source_id'):
                    self.assertEqual(matches[old['id']][field], old[field], (old['id'], field))
        self.assertEqual(len(matches), 113)
        self.assertEqual((matches['4:2026:19:1028:521']['home_score'], matches['4:2026:19:1028:521']['away_score']), (4, 5))
        self.assertEqual((matches['4:2026:19:936:1030']['home_score'], matches['4:2026:19:936:1030']['away_score']), (6, 3))
        self.assertEqual(self.new['match_details'], self.old['match_details'])
        self.assertEqual(set(self.new['platform']['teamsById']), set(self.old['platform']['teamsById']))
        self.assertEqual(self.new['platform']['protocolsByMatchId'], self.old['platform']['protocolsByMatchId'])

    def test_postponement_and_technical_win_keep_status_score_and_official_id(self):
        matches = {m['id']: m for m in self.new['championship']['calendar']['matches']}
        postponed = matches['4:2026:19:934:146']
        self.assertEqual((postponed['status'], postponed['date'], postponed['home_score'], postponed['away_score']), ('postponed', None, None, None))
        technical = matches['4:2026:19:757:932']
        self.assertEqual((technical['status'], technical['date'], technical['home_score'], technical['away_score'], technical['source_id']), ('technical', None, 0, 3, '38770'))
        self.assertEqual(self.new['platform']['matchesById'][technical['id']]['sourceMatchId'], '38770')

    def test_official_standings_only_and_outage_does_not_block_calendar(self):
        expected = sources.parse_standings(page())
        good = refresh(self.old, self.incoming, platform_loader=page)
        self.assertEqual(good['platform']['standings']['4:22']['rows'], expected)
        def down():
            raise requests.Timeout('official standings timeout')
        output = io.StringIO()
        with redirect_stdout(output):
            partial = refresh(self.old, self.incoming, platform_loader=down)
        self.assertEqual(partial['platform']['standings']['4:22']['rows'], self.old['platform']['standings']['4:22']['rows'])
        self.assertEqual(partial['platform']['standings']['4:22']['quality']['status'], 'stale')
        self.assertEqual(partial['platform']['matchesById'][MATCH]['awayScore'], 4)
        self.assertIn('platform.standings[4:22]', output.getvalue())
        self.assertIn('official standings timeout', output.getvalue())

    def test_scorers_outage_or_truncation_keeps_only_that_section(self):
        for mode in ('missing', 'truncated', 'missing_leader'):
            def broken(path):
                soup = loader(path)
                if path != parser.LEAGUE_PATH:
                    rows = soup.select('.champ_data_top_scorers .line')
                    if mode == 'missing':
                        soup.select_one('.champ_data_top_scorers').decompose()
                    elif mode == 'truncated':
                        rows[-1].decompose()
                    else:
                        rows[0].select_one('.name a')['href'] = '/players/99999/'
                return soup
            with self.subTest(mode=mode):
                hub = parser.update_championship(self.old['championship'], loader=broken)
                self.assertTrue(hub['scorers']['stale'])
                self.assertEqual(hub['scorers']['players'], self.old['championship']['scorers']['players'])
                self.assertFalse(hub['calendar']['stale'])
                incoming = copy.deepcopy(self.old)
                incoming['championship'] = hub
                self.assertEqual(refresh(self.old, incoming)['platform']['matchesById'][MATCH]['awayScore'], 4)

    def test_missing_match_partial_score_or_conflict_rejects_calendar_section(self):
        for mode in ('missing_match', 'partial_score', 'historical_conflict', 'wrong_id'):
            def broken(path):
                soup = loader(path)
                if path != parser.LEAGUE_PATH:
                    card = soup.select_one('.tour_calendar [data-team1="930"][data-team2="117"]')
                    if mode == 'missing_match': card.decompose()
                    elif mode == 'partial_score': card.select_one('.first').string = '-'
                    elif mode == 'wrong_id':
                        old = soup.select_one('.tour_calendar a[href*="/matches/38769/"]')
                        old['href'] = '/matches/99999/'
                    else:
                        old = soup.select_one('.tour_calendar [data-team1="1028"][data-team2="521"]')
                        old.select_one('.first').string = '99'
                return soup
            with self.subTest(mode=mode):
                output = io.StringIO()
                with redirect_stdout(output):
                    hub = parser.update_championship(self.old['championship'], loader=broken, club_details=self.old['match_details'])
                self.assertTrue(hub['calendar']['stale'])
                self.assertEqual(hub['calendar']['matches'], self.old['championship']['calendar']['matches'])
                self.assertIn('::warning::championship.calendar', output.getvalue())

    def test_conflicting_checkpoint_cannot_replace_confirmed_data(self):
        for field, value in [('home_score', 9), ('status', 'scheduled'), ('source_id', '99999')]:
            bad = copy.deepcopy(self.new)
            bad['updated'] = (build.timestamp(bad) + timedelta(seconds=30)).isoformat()
            bad['platform']['sourceUpdatedAt'] = bad['updated']
            match = next(m for m in bad['championship']['calendar']['matches'] if m['id'] == MATCH)
            match[field] = value
            if field == 'source_id': match['source_url'] = 'https://rffk-roo.ru/matches/99999/'
            with self.subTest(field=field), self.assertRaises(build.InvalidData):
                build.choose_baseline(SEED, self.new, bad)

    def test_platform_only_checkpoint_conflict_is_rejected(self):
        bad = copy.deepcopy(self.new)
        bad['updated'] = (build.timestamp(bad) + timedelta(seconds=30)).isoformat()
        bad['platform']['sourceUpdatedAt'] = bad['updated']
        bad['platform']['matchesById'][MATCH]['homeScore'] = 9
        with self.assertRaisesRegex(build.InvalidData, MATCH):
            build.choose_baseline(SEED, self.new, bad)

    def test_next_hour_restores_new_checkpoint_and_offline_parser_keeps_score(self):
        restored = build.choose_baseline(SEED, self.old, self.new)
        self.assertEqual(restored['platform']['matchesById'][MATCH]['awayScore'], 4)
        def runner(command, cwd, **kwargs):
            raise subprocess.CalledProcessError(1, command)
        with tempfile.TemporaryDirectory() as directory:
            result = build.refresh(restored, Path(directory), runner)
            staged = Path(directory) / 'site'
            build.stage_site(ROOT, staged, result)
            published = build.decode_json((staged / 'data.json').read_bytes())
        self.assertEqual(published, result)
        self.assertEqual(published['platform']['matchesById'][MATCH]['awayScore'], 4)
        self.assertEqual(build.choose_baseline(SEED, self.new, self.old)['championship'], self.new['championship'])

    def test_club_outage_runs_real_parser_and_accepts_independent_calendar(self):
        def runner(command, cwd, **kwargs):
            if not command[-1].endswith('fetch_data.py'): return
            previous = Path.cwd()
            try:
                os.chdir(cwd)
                with patch.object(parser, 'update_club_data', side_effect=requests.Timeout('club timeout')), patch.object(parser, 'get', side_effect=loader):
                    parser.main()
            finally:
                os.chdir(previous)
        with tempfile.TemporaryDirectory() as directory:
            result = build.refresh(self.old, Path(directory), runner)
        self.assertEqual(result['platform']['matchesById'][MATCH]['awayScore'], 4)
        for field in ('table', 'squad', 'res', 'next', 'match_details', 'player_stats_2026'):
            self.assertEqual(result[field], self.old[field])

    def test_failure_annotation_contains_section_rule_id_and_last_good_revision(self):
        bad = copy.deepcopy(self.incoming)
        next(m for m in bad['championship']['calendar']['matches'] if m['id'] == '4:2026:19:1028:521')['home_score'] = 99
        output = io.StringIO()
        with redirect_stdout(output):
            result = refresh(self.old, bad)
        log = output.getvalue()
        for text in ('::warning::fetch_data.py', 'platform.protocolsByMatchId', '4:2026:19:1028:521', 'Protocol does not match current result', 'using last-good', 'lastVerifiedAt=', 'retained sections='):
            self.assertIn(text, log)
        self.assertEqual(result, self.old)


if __name__ == '__main__':
    unittest.main()
