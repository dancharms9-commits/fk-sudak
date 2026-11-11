"""Targeted regressions for verified CFU Premier League 2026 match protocols."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts import build_pages
from scripts.cfu_match_details import (
    build_snapshot, fetch_local, load_match_details, parse_match_protocol,
    run_import, write_match_details,
)
from scripts.cfu_match_details_schema import (
    InvalidCfuMatchData, validate_match_details,
)
from scripts.cfu_premier_import import load_snapshot
from scripts.cfu_premier_schema import InvalidCfuData
from scripts.cfu_premier_rosters import load_rosters

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/cfu-premier'
CHECKED_AT = '2026-11-11T18:00:00+00:00'


def read(name):
    return (FIXTURES / name).read_text(encoding='utf-8')


class CfuMatchDetailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.calendar = load_snapshot(ROOT / 'docs/cfu-premier-2026/snapshot.json')
        cls.rosters = load_rosters(
            ROOT / 'docs/cfu-premier-rosters-2026/rosters.json',
            expected_team_ids=set(cls.calendar['teamsById']))
        cls.finished_html = read('match-18763.html')
        cls.future_html = read('match-18769-future.html')
        cls.matches = [
            cls.calendar['matchesById']['cfu:match:18763'],
            cls.calendar['matchesById']['cfu:match:18769'],
        ]
        pages, timestamps, hashes = fetch_local(
            FIXTURES, cls.matches, checked_at=CHECKED_AT)
        cls.snapshot = build_snapshot(
            cls.calendar, cls.rosters, pages, timestamps,
            source_hashes=hashes)

    def build_with(self, match_id, html, extras=None):
        pages = {match_id: html, **(extras or {})}
        checked = {key: CHECKED_AT for key in pages}
        hashes = {key: hashlib.sha256(value.replace('\r\n', '\n').encode('utf-8')).hexdigest()
                  for key, value in pages.items()}
        return build_snapshot(self.calendar, self.rosters, pages, checked,
                              source_hashes=hashes)

    def test_finished_match_confirms_goals_minutes_and_player_ids(self):
        record = self.snapshot['matchesById']['cfu:match:18763']
        self.assertEqual((record['homeScore'], record['awayScore']), (0, 2))
        self.assertEqual(record['status'], 'finished')
        self.assertEqual(record['statusLabel'], 'Матч завершен')
        self.assertEqual([(goal['side'], goal['minute'], goal['player'], goal['playerId'])
                          for goal in record['goals']],
                         [('away', '44', 'Роман Климентовский', 'cfu:player:280'),
                          ('away', '48', 'Владимир Клепча', 'cfu:player:1776')])
        self.assertTrue(record['goalsComplete'])
        self.assertFalse(record['eventsComplete'])
        self.assertIsNone(record['lineups'])
        self.assertIn('lineups', record['missingSections'])
        self.assertIn('chronology', record['missingSections'])
        self.assertEqual(record['coverage'], 'events')

    def test_future_match_has_no_result_or_invented_status(self):
        record = self.snapshot['matchesById']['cfu:match:18769']
        self.assertIsNone(record['homeScore'])
        self.assertIsNone(record['awayScore'])
        self.assertIsNone(record['status'])
        self.assertIsNone(record['statusLabel'])
        self.assertEqual(record['goals'], [])
        self.assertEqual(record['events'], [])
        self.assertEqual(record['coverage'], 'schedule')
        self.assertIn('result', record['missingSections'])
        self.assertNotIn('"0:0"', json.dumps(record, ensure_ascii=False))

    def test_wrong_season_competition_and_substituted_id_are_rejected(self):
        wrong_season = self.finished_html.replace('сезон 2026', 'сезон 2025')
        with self.assertRaises((InvalidCfuMatchData, InvalidCfuData)):
            self.build_with('cfu:match:18763', wrong_season)

        wrong_competition = self.finished_html.replace(
            'matches_premier-leagueCFU', 'matches_cupCFU').replace(
            'Чемпионат Премьер-лиги Крымского футбольного союза', 'Кубок КФС')
        with self.assertRaises((InvalidCfuMatchData, InvalidCfuData)):
            self.build_with('cfu:match:18763', wrong_competition)

        substituted = self.finished_html.replace('match_score_18763', 'match_score_18764')
        with self.assertRaises((InvalidCfuMatchData, InvalidCfuData)):
            self.build_with('cfu:match:18763', substituted)

    def test_club_date_and_score_mismatches_are_rejected(self):
        bad_home = self.finished_html.replace('/teams/gfc-yalta/', '/teams/fc-okean/')
        with self.assertRaises((InvalidCfuMatchData, InvalidCfuData)):
            self.build_with('cfu:match:18763', bad_home)

        bad_date = self.finished_html.replace('31 октября 2026', '30 октября 2026')
        with self.assertRaises((InvalidCfuMatchData, InvalidCfuData)):
            self.build_with('cfu:match:18763', bad_date)

        bad_score = self.finished_html.replace('<strong>0:2</strong>', '<strong>1:2</strong>')
        with self.assertRaises((InvalidCfuMatchData, InvalidCfuData)):
            self.build_with('cfu:match:18763', bad_score)

    def test_conflicting_protocol_is_recorded_and_never_published(self):
        bad_score = self.finished_html.replace('<strong>0:2</strong>', '<strong>1:2</strong>')
        snapshot = self.build_with(
            'cfu:match:18763', bad_score,
            extras={'cfu:match:18769': self.future_html})
        self.assertNotIn('cfu:match:18763', snapshot['matchesById'])
        reasons = [record['reason'] for record in snapshot['unresolvedRecords']]
        self.assertTrue(any('Score differs' in reason for reason in reasons), reasons)
        self.assertNotIn('cfu:match:18763', snapshot['sourceMetadata']['sources'])

    def test_unknown_player_is_not_given_a_club(self):
        record, issues = parse_match_protocol(
            self.finished_html, self.matches[0], rosters=None,
            checked_at=CHECKED_AT,
            source_sha256=hashlib.sha256(self.finished_html.encode('utf-8')).hexdigest())
        self.assertTrue(all(goal['playerId'] is None for goal in record['goals']))
        self.assertTrue(any(issue['reason'] == 'player_not_in_verified_rosters'
                            for issue in issues))
        self.assertIn('Роман Климентовский', [goal['player'] for goal in record['goals']])

    def test_partial_snapshot_without_every_protocol_is_valid(self):
        snapshot = self.build_with('cfu:match:18763', self.finished_html)
        self.assertEqual(set(snapshot['matchesById']), {'cfu:match:18763'})
        self.assertIs(validate_match_details(snapshot, self.calendar, self.rosters), snapshot)

    def test_validator_rejects_wrong_season_competition_id_club_and_score(self):
        mutations = [
            lambda value: value.update(season=2025),
            lambda value: value.update(competitionKey='cfu-cup-2026'),
            lambda value: value['matchesById']['cfu:match:18763'].update(
                sourceMatchId='18764'),
            lambda value: value['matchesById']['cfu:match:18763'].update(
                homeTeamId='cfu:team:fc-okean'),
            lambda value: value['matchesById']['cfu:match:18763'].update(homeScore=1),
            lambda value: value['matchesById']['cfu:match:18763']['events'][0].update(
                playerId='cfu:player:999999'),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = copy.deepcopy(self.snapshot)
                mutate(value)
                with self.assertRaises(InvalidCfuMatchData):
                    validate_match_details(value, self.calendar, self.rosters)

    def test_committed_snapshot_is_valid_and_published_copy_is_identical(self):
        committed = load_match_details(
            ROOT / 'docs/cfu-premier-2026/match-details.json',
            self.calendar, self.rosters)
        self.assertEqual(committed, self.snapshot)
        public = ROOT / 'cfu-premier-match-details-2026.json'
        self.assertEqual(public.read_bytes(),
                         (ROOT / 'docs/cfu-premier-2026/match-details.json').read_bytes())

    def test_no_rffk_or_other_competition_data(self):
        raw = json.dumps(self.snapshot, ensure_ascii=False).lower()
        self.assertNotIn('rffk', raw)
        self.assertNotIn('supercup', raw)
        self.assertNotIn('cup_cfu', raw)
        self.assertTrue(all('/matches/premier-leagueCFU/match_' in record['sourceUrl']
                            for record in self.snapshot['matchesById'].values()))

    def test_published_protocol_json_is_staged_for_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / '_site'
            source = Path(directory) / 'source'
            source.mkdir()
            for name in ('index.html', 'sw.js', 'manifest.json',
                         'icon-192.png', 'icon-512.png'):
                (source / name).write_bytes(b'x')
            (source / 'data.json').write_text('{}', encoding='utf-8')
            published = ROOT / 'cfu-premier-match-details-2026.json'
            (source / 'cfu-premier-match-details-2026.json').write_bytes(
                published.read_bytes())
            build_pages.stage_site(source, output, {})
            staged = output / 'cfu-premier-match-details-2026.json'
            self.assertTrue(staged.is_file())
            self.assertEqual(staged.read_bytes(), published.read_bytes())

    def test_network_failure_preserves_last_valid_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'match-details.json'
            public = Path(directory) / 'published.json'
            write_match_details(self.snapshot, output, public,
                                self.calendar, self.rosters)
            before_output, before_public = output.read_bytes(), public.read_bytes()

            def unavailable(*args, **kwargs):
                raise InvalidCfuMatchData('source is unavailable')

            with self.assertRaises(InvalidCfuMatchData):
                run_import(
                    ROOT / 'docs/cfu-premier-2026/snapshot.json',
                    ROOT / 'docs/cfu-premier-rosters-2026/rosters.json',
                    output, public, fetch=unavailable,
                    selected_match_ids=['cfu:match:18763'])
            self.assertEqual(output.read_bytes(), before_output)
            self.assertEqual(public.read_bytes(), before_public)


if __name__ == '__main__':
    unittest.main()
