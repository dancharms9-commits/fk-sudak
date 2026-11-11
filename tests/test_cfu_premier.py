"""Targeted tests for the independent CFU Premier League 2026 data foundation.

These tests use only saved official HTML fixtures and never access the network.
"""
import copy
from collections import Counter
import json
from pathlib import Path
import tempfile
import unittest

from bs4 import BeautifulSoup

from scripts import cfu_premier_import as importer
from scripts.cfu_premier_schema import (
    COMPETITION_KEY, InvalidCfuData, normalize_name, validate_snapshot,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/cfu-premier'
CHECKED_AT = {
    'teams': '2026-11-11T08:50:00+00:00',
    'table': '2026-11-11T08:51:00+00:00',
    'calendar': '2026-11-11T08:52:00+00:00',
}


def read(name):
    return (FIXTURES / name).read_text(encoding='utf-8')


class CfuPremierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.teams_html = read('teams-2026.html')
        cls.table_html = read('table-2026.html')
        cls.calendar_html = read('calendar-2026.html')
        cls.match_html = read('match-18763.html')
        cls.future_html = read('match-18769-future.html')
        cls.snapshot = importer.build_snapshot(
            cls.teams_html, cls.table_html, cls.calendar_html, CHECKED_AT)
        cls.teams = importer.parse_teams(cls.teams_html)

    def test_official_standings_2026(self):
        standings = self.snapshot['standings']
        self.assertEqual(standings['asOfRound'], 24)
        rows = standings['rows']
        self.assertEqual(len(rows), 7)
        tavriya = rows[0]
        self.assertEqual(
            (tavriya['rank'], tavriya['teamId'], tavriya['played'], tavriya['wins'],
             tavriya['draws'], tavriya['losses'], tavriya['goalsFor'],
             tavriya['goalsAgainst'], tavriya['goalDifference'], tavriya['points']),
            (1, 'cfu:team:tavriya', 20, 15, 1, 4, 59, 18, 41, 46))
        yalta = rows[1]
        self.assertEqual(
            (yalta['rank'], yalta['teamId'], yalta['played'], yalta['points']),
            (2, 'cfu:team:gfc-yalta', 21, 46))
        self.assertEqual([row['rank'] for row in rows], list(range(1, 8)))
        self.assertEqual({row['teamId'] for row in rows}, set(self.snapshot['teamsById']))
        for row in rows:
            self.assertEqual(row['wins'] + row['draws'] + row['losses'], row['played'])
            self.assertEqual(row['goalsFor'] - row['goalsAgainst'], row['goalDifference'])

    def test_official_calendar_has_all_four_circles(self):
        matches = self.snapshot['matchesById']
        self.assertEqual(len(matches), 84)
        self.assertEqual(self.snapshot['sourceMetadata']['sections']['calendar']['circles'], 4)
        self.assertEqual(self.snapshot['sourceMetadata']['sections']['calendar']['rounds'], 28)
        self.assertEqual({match['round'] for match in matches.values()}, set(range(1, 29)))
        self.assertEqual({match['circle'] for match in matches.values()}, {1, 2, 3, 4})
        per_round = Counter(match['round'] for match in matches.values())
        self.assertTrue(all(count == 3 for count in per_round.values()))
        self.assertEqual(matches['cfu:match:17745']['circle'], 1)
        self.assertEqual(matches['cfu:match:17745']['round'], 1)
        self.assertEqual(matches['cfu:match:17745']['homeTeamId'], 'cfu:team:fc-okean')
        self.assertEqual(matches['cfu:match:17745']['awayTeamId'], 'cfu:team:fc-feodosiya')
        self.assertEqual((matches['cfu:match:17745']['date'],
                          matches['cfu:match:17745']['time']), ('2026-03-28', '15:00'))
        self.assertEqual((matches['cfu:match:17745']['homeScore'],
                          matches['cfu:match:17745']['awayScore']), (3, 1))
        self.assertIsNone(matches['cfu:match:17745']['status'])
        self.assertEqual(matches['cfu:match:18763']['circle'], 4)
        self.assertEqual((matches['cfu:match:18763']['homeScore'],
                          matches['cfu:match:18763']['awayScore']), (0, 2))

    def test_unique_teams_and_matches(self):
        teams = self.snapshot['teamsById']
        matches = self.snapshot['matchesById']
        self.assertEqual(len(teams), 7)
        self.assertEqual(len(matches), 84)
        self.assertEqual(len({match['sourceMatchId'] for match in matches.values()}), 84)
        self.assertEqual(len({match['sourceUrl'] for match in matches.values()}), 84)
        self.assertEqual(len({normalize_name(team['name']) for team in teams.values()}), 7)
        self.assertEqual(
            {team['sourceTeamId'] for team in teams.values()},
            {'gfc-yalta', 'zarechnoe', 'fc-mak-dzhankoy', 'fc-okean',
             'fc-sparta-kt', 'tavriya', 'fc-feodosiya'})

    def test_every_match_links_two_known_teams(self):
        teams = self.snapshot['teamsById']
        matches = self.snapshot['matchesById']
        appearances = Counter()
        for match in matches.values():
            self.assertIn(match['homeTeamId'], teams)
            self.assertIn(match['awayTeamId'], teams)
            self.assertNotEqual(match['homeTeamId'], match['awayTeamId'])
            appearances[match['homeTeamId']] += 1
            appearances[match['awayTeamId']] += 1
        self.assertEqual(set(appearances), set(teams))
        self.assertTrue(all(count == 24 for count in appearances.values()))

    def test_2025_pages_are_rejected_as_wrong_season(self):
        with self.assertRaises(InvalidCfuData):
            importer.build_snapshot(
                self.teams_html.replace('сезона 2026', 'сезона 2025'),
                self.table_html, self.calendar_html, CHECKED_AT)
        with self.assertRaises(InvalidCfuData):
            importer.build_snapshot(
                self.teams_html,
                self.table_html.replace('сезона 2026', 'сезона 2025'),
                self.calendar_html, CHECKED_AT)
        with self.assertRaises(InvalidCfuData):
            importer.build_snapshot(
                self.teams_html, self.table_html,
                self.calendar_html.replace('сезона 2026', 'сезона 2025'), CHECKED_AT)
        with self.assertRaises(InvalidCfuData):
            importer.build_snapshot(
                self.teams_html, self.table_html,
                self.calendar_html.replace('28 марта 2026', '28 марта 2025'), CHECKED_AT)

    def test_repeated_import_does_not_duplicate_records(self):
        second = importer.build_snapshot(
            self.teams_html, self.table_html, self.calendar_html, CHECKED_AT)
        self.assertEqual(second, self.snapshot)
        soup = BeautifulSoup(self.calendar_html, 'html.parser')
        row = soup.select_one('a.entry-row[href*="/match_"]')
        row.insert_after(copy.copy(row))
        matches, unresolved, _ = importer.parse_calendar(str(soup), self.teams)
        self.assertEqual(len(matches), 84)
        self.assertEqual(unresolved, [])

    def test_no_cup_or_other_competition_data(self):
        self.assertEqual(self.snapshot['competitionKey'], COMPETITION_KEY)
        self.assertTrue(all('/matches/premier-leagueCFU/' in match['sourceUrl']
                            for match in self.snapshot['matchesById'].values()))
        raw = json.dumps(self.snapshot, ensure_ascii=False).lower()
        self.assertNotIn('cup_cfu', raw)
        self.assertNotIn('supercup', raw)
        self.assertNotIn('rffk', raw)

    def test_previous_snapshot_survives_source_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'snapshot.json'
            importer.write_snapshot(self.snapshot, path)
            before = path.read_bytes()

            def unavailable(delay=0, timeout=0):
                raise InvalidCfuData('source is unavailable')

            with self.assertRaises(InvalidCfuData):
                importer.run_import(path, fetch=unavailable)
            self.assertEqual(path.read_bytes(), before)

            def truncated(delay=0, timeout=0):
                return {'teams': self.teams_html, 'table': self.table_html,
                        'calendar': self.calendar_html[:2000]}, CHECKED_AT

            with self.assertRaises(InvalidCfuData):
                importer.run_import(path, fetch=truncated)
            self.assertEqual(path.read_bytes(), before)

            partial_calendar = BeautifulSoup(self.calendar_html, 'html.parser')
            partial_calendar.select_one(
                'a.entry-row[href*="match_17745"] '
                '.entry-row-values .entry-title strong').clear()

            def partial(delay=0, timeout=0):
                return {'teams': self.teams_html, 'table': self.table_html,
                        'calendar': str(partial_calendar)}, CHECKED_AT

            with self.assertRaises(InvalidCfuData):
                importer.run_import(path, fetch=partial)
            self.assertEqual(path.read_bytes(), before)

    def test_invalid_or_truncated_pages_are_rejected(self):
        table = BeautifulSoup(self.table_html, 'html.parser')
        row = table.select_one('#tournamentTable_0 .entries-rows-wrapper:not(.header-row)')
        stats = row.select_one(
            'div.entry-values[block-name="matches-table-1"][block-index="1"]')
        for cell in stats.select('.entry-value'):
            cell.decompose()
        with self.assertRaises(InvalidCfuData):
            importer.parse_standings(str(table), self.teams)

        calendar = BeautifulSoup(self.calendar_html, 'html.parser')
        boxes = [box for box in calendar.select(
            'div[block-name="calendar-1-2026-group-1"]') if box.select('.entries-rows-list')]
        boxes[-1].decompose()
        with self.assertRaises(InvalidCfuData):
            importer.parse_calendar(str(calendar), self.teams)

        with self.assertRaises(InvalidCfuData):
            importer.parse_calendar(self.calendar_html[:2000], self.teams)

        teams = BeautifulSoup(self.teams_html, 'html.parser')
        teams.select_one('.entry-box').decompose()
        partial_teams = importer.parse_teams(str(teams))
        with self.assertRaises(InvalidCfuData):
            importer.parse_standings(self.table_html, partial_teams)

    def test_unknown_score_date_and_status_are_preserved_as_unknown(self):
        future = importer.parse_match_page(self.future_html)
        self.assertEqual((future['homeScore'], future['awayScore']), (None, None))
        self.assertIsNone(future['status'])
        self.assertIsNone(future['statusLabel'])
        self.assertEqual((future['date'], future['time']), ('2026-11-15', '14:00'))

        played = importer.parse_match_page(self.match_html)
        self.assertEqual((played['homeScore'], played['awayScore']), (0, 2))
        self.assertEqual(played['status'], 'finished')
        self.assertEqual(played['statusLabel'], 'Матч завершен')

        soup = BeautifulSoup(self.calendar_html, 'html.parser')
        row = soup.select_one('a.entry-row[href*="match_17745"]')
        row.select_one('.entry-row-values .entry-title strong').clear()
        matches, unresolved, _ = importer.parse_calendar(str(soup), self.teams)
        self.assertIsNone(matches['cfu:match:17745']['date'])
        self.assertIsNone(matches['cfu:match:17745']['time'])
        self.assertEqual(unresolved, [])
        partial = importer.build_snapshot(
            self.teams_html, self.table_html, str(soup), CHECKED_AT)
        self.assertEqual(
            partial['sourceMetadata']['sections']['calendar']['coverage'], 'partial')

        soup = BeautifulSoup(self.calendar_html, 'html.parser')
        score = soup.select_one('a.entry-row[href*="match_17745"] .score')
        score.string = '—'
        matches, _, _ = importer.parse_calendar(str(soup), self.teams)
        self.assertIsNone(matches['cfu:match:17745']['homeScore'])
        self.assertIsNone(matches['cfu:match:17745']['awayScore'])

        sample = BeautifulSoup(self.future_html, 'html.parser')
        label = sample.new_tag('span', attrs={'class': 'label'})
        label.string = 'Неизвестный статус'
        sample.select_one('.labelRow').append(label)
        unknown = importer.parse_match_page(str(sample))
        self.assertIsNone(unknown['status'])
        self.assertEqual(unknown['statusLabel'], 'Неизвестный статус')

    def test_committed_snapshot_is_valid_and_matches_fixtures(self):
        committed = importer.load_snapshot(ROOT / 'docs/cfu-premier-2026/snapshot.json')
        self.assertEqual(committed['teamsById'], self.snapshot['teamsById'])
        self.assertEqual(committed['matchesById'], self.snapshot['matchesById'])
        self.assertEqual(committed['standings'], self.snapshot['standings'])
        self.assertEqual(committed['unresolvedRecords'], self.snapshot['unresolvedRecords'])

    def test_snapshot_contract_and_namespace(self):
        self.assertIs(validate_snapshot(self.snapshot), self.snapshot)
        mutated = copy.deepcopy(self.snapshot)
        mutated['provider'] = 'rffk'
        with self.assertRaises(InvalidCfuData):
            validate_snapshot(mutated)
        mutated = copy.deepcopy(self.snapshot)
        mutated['matchesById']['4:22'] = mutated['matchesById'].pop('cfu:match:17745')
        with self.assertRaises(InvalidCfuData):
            validate_snapshot(mutated)


if __name__ == '__main__':
    unittest.main()
