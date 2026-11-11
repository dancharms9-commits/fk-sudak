"""Targeted tests for the official CFU Premier League 2026 club rosters.

Only the two small saved official HTML fixtures are used; no network access.
"""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from bs4 import BeautifulSoup

from scripts import cfu_premier_rosters as importer
from scripts.cfu_premier_roster_schema import (
    InvalidCfuRosterData, POSITION_GROUPS, validate_rosters,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/cfu-premier-rosters'
CHECKED_AT = '2026-11-11T09:00:00+00:00'
TEAMS = importer.load_teams(ROOT / 'docs/cfu-premier-2026/snapshot.json')


def read(name):
    return (FIXTURES / name).read_text(encoding='utf-8')


def fixture_for(team):
    """Build a seven-club diagnostic set from the two small official fixtures."""
    slug = team['sourceTeamId']
    if slug == 'fc-okean':
        html = read('fc-okean.html')
    else:
        html = read('tavriya.html').replace('/teams/tavriya/', f'/teams/{slug}/')
    return html


def page_set():
    return {team_id: fixture_for(team) for team_id, team in TEAMS.items()}


def checked_set():
    return {team_id: CHECKED_AT for team_id in TEAMS}


def build(pages=None):
    pages = pages or page_set()
    return importer.build_rosters(
        pages, TEAMS, checked_set(), 'saved_official_html')


class CfuRosterImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = build()

    def test_official_tavriya_fixture_parses_positions_numbers_and_dob(self):
        parsed = importer.parse_team_roster(
            read('tavriya.html'), TEAMS['cfu:team:tavriya'], CHECKED_AT)
        self.assertTrue(parsed['complete'])
        self.assertEqual(len(parsed['entries']), 4)
        entries = {entry['playerId']: entry for entry in parsed['entries']}
        self.assertEqual(entries['cfu:player:258']['position'], 'Вратарь')
        self.assertEqual(entries['cfu:player:258']['positionGroup'], 'Вратари')
        self.assertEqual(entries['cfu:player:258']['shirtNumber'], 1)
        self.assertEqual(parsed['players']['cfu:player:258']['dateOfBirth'],
                         '1997-06-26')
        self.assertEqual(entries['cfu:player:2111']['deregisteredAt'], '2026-09-08')
        self.assertEqual(entries['cfu:player:998']['position'], 'Нападающий')

    def test_shared_official_player_keeps_two_club_records(self):
        tavriya = importer.parse_team_roster(
            read('tavriya.html'), TEAMS['cfu:team:tavriya'], CHECKED_AT)
        okean = importer.parse_team_roster(
            read('fc-okean.html'), TEAMS['cfu:team:fc-okean'], CHECKED_AT)
        tavriya_entry = next(entry for entry in tavriya['entries']
                             if entry['playerId'] == 'cfu:player:2111')
        okean_entry = next(entry for entry in okean['entries']
                           if entry['playerId'] == 'cfu:player:2111')
        self.assertEqual(okean_entry['shirtNumber'], 12)
        self.assertIsNone(okean_entry['deregisteredAt'])
        self.assertEqual(tavriya_entry['shirtNumber'], 77)
        self.assertEqual(tavriya_entry['deregisteredAt'], '2026-09-08')
        # The stable player identity is the official id, not the club record.
        self.assertEqual(tavriya['players']['cfu:player:2111'],
                         okean['players']['cfu:player:2111'])

    def test_snapshot_has_seven_official_clubs_and_cfu_namespace(self):
        self.assertEqual(set(self.snapshot['rostersByTeamId']), set(TEAMS))
        self.assertEqual(len(self.snapshot['rostersByTeamId']), 7)
        self.assertTrue(all(key.startswith('cfu:player:')
                            for key in self.snapshot['playersById']))
        self.assertTrue(all(key.startswith('cfu:team:')
                            for key in self.snapshot['rostersByTeamId']))
        self.assertEqual(self.snapshot['unresolvedRecords'], [])
        self.assertEqual(self.snapshot['sourceMetadata']['rosters']['coverage'],
                         'complete')
        for roster in self.snapshot['rostersByTeamId'].values():
            self.assertEqual(roster['coverage'], 'complete')
            self.assertEqual(roster['records'], len(roster['entries']))
            self.assertEqual(len(roster['sourceSha256']), 64)

    def test_every_player_is_linked_to_a_2026_registry_club(self):
        for roster in self.snapshot['rostersByTeamId'].values():
            for entry in roster['entries']:
                self.assertIn(entry['playerId'], self.snapshot['playersById'])
                self.assertIn(entry['positionGroup'], POSITION_GROUPS)
                self.assertEqual(POSITION_GROUPS[entry['positionGroup']],
                                 entry['position'])
                self.assertIsInstance(entry['shirtNumber'], int)
                self.assertTrue(1 <= entry['shirtNumber'] <= 99)

    def test_deregistered_players_remain_in_the_historical_season_list(self):
        roster = self.snapshot['rostersByTeamId']['cfu:team:tavriya']
        entry = next(entry for entry in roster['entries']
                     if entry['playerId'] == 'cfu:player:2111')
        self.assertEqual(entry['deregisteredAt'], '2026-09-08')
        self.assertIn('cfu:player:2111', self.snapshot['playersById'])
        self.assertEqual(
            self.snapshot['sourceMetadata']['rosters']['deregisteredRecords'],
            sum(1 for roster in self.snapshot['rostersByTeamId'].values()
                for entry in roster['entries']
                if entry['deregisteredAt'] is not None))

    def test_wrong_season_competition_and_link_are_rejected(self):
        team = TEAMS['cfu:team:tavriya']
        cases = [
            read('tavriya.html').replace('Сезон 2026', 'Сезон 2025'),
            read('tavriya.html').replace('season=2026', 'season=2025'),
            read('tavriya.html').replace(
                'Чемпионат Премьер-лиги КФС', 'Кубок Премьер-лиги КФС'),
        ]
        for html in cases:
            with self.subTest(html=html[:80]), self.assertRaises(InvalidCfuRosterData):
                importer.parse_team_roster(html, team, CHECKED_AT)
        soup = BeautifulSoup(read('tavriya.html'), 'html.parser')
        soup.select_one('div[block-name="filter-players-seasons"] li.selected')[
            'class'].remove('selected')
        with self.assertRaises(InvalidCfuRosterData):
            importer.parse_team_roster(str(soup), team, CHECKED_AT)

    def test_missing_number_marks_partial_without_inventing_data(self):
        html = read('tavriya.html').replace(
            '<small class="fixed">Номер:</small> 1', '')
        parsed = importer.parse_team_roster(
            html, TEAMS['cfu:team:tavriya'], CHECKED_AT)
        self.assertFalse(parsed['complete'])
        self.assertNotIn('cfu:player:258', parsed['players'])
        self.assertTrue(any(record['reason'] == 'missing_number_or_birth_date'
                            for record in parsed['unresolved']))
        pages = page_set()
        pages['cfu:team:tavriya'] = html
        partial = build(pages)
        self.assertEqual(partial['rostersByTeamId']['cfu:team:tavriya']['coverage'],
                         'partial')
        self.assertEqual(partial['sourceMetadata']['rosters']['coverage'], 'partial')
        self.assertTrue(partial['unresolvedRecords'])

    def test_duplicate_player_in_one_team_is_rejected(self):
        soup = BeautifulSoup(read('tavriya.html'), 'html.parser')
        box = soup.select_one('.entries-section .entry-box')
        box.insert_after(copy.copy(box))
        with self.assertRaises(InvalidCfuRosterData):
            importer.parse_team_roster(
                str(soup), TEAMS['cfu:team:tavriya'], CHECKED_AT)

    def test_repeated_import_is_deterministic(self):
        self.assertEqual(build(), self.snapshot)

    def test_no_foreign_club_or_rffk_identifier(self):
        mutated = copy.deepcopy(self.snapshot)
        mutated['rostersByTeamId']['cfu:team:foreign'] = mutated[
            'rostersByTeamId'].pop('cfu:team:tavriya')
        with self.assertRaises(InvalidCfuRosterData):
            validate_rosters(mutated, expected_team_ids=set(TEAMS))
        mutated = copy.deepcopy(self.snapshot)
        player = mutated['playersById'].pop('cfu:player:258')
        mutated['playersById']['rffk-258'] = player
        with self.assertRaises(InvalidCfuRosterData):
            validate_rosters(mutated, expected_team_ids=set(TEAMS))

    def test_previous_snapshot_survives_source_failure_and_partial_response(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'docs/rosters.json'
            public = Path(directory) / 'rosters.json'
            importer.write_rosters(self.snapshot, output, public,
                                   expected_team_ids=set(TEAMS))
            before_docs = output.read_bytes()
            before_public = public.read_bytes()

            def unavailable(teams, delay=0, timeout=0):
                raise InvalidCfuRosterData('source is unavailable')

            with self.assertRaises(InvalidCfuRosterData):
                importer.run_import(output, public,
                                    ROOT / 'docs/cfu-premier-2026/snapshot.json',
                                    fetch=unavailable)
            self.assertEqual(output.read_bytes(), before_docs)
            self.assertEqual(public.read_bytes(), before_public)

            pages = page_set()
            pages['cfu:team:tavriya'] = read('tavriya.html').replace(
                '<small class="fixed">Номер:</small> 1', '')
            def partial(teams, delay=0, timeout=0):
                return pages, checked_set(), {
                    team_id: hashlib.sha256(html.encode('utf-8')).hexdigest()
                    for team_id, html in pages.items()
                }
            with self.assertRaises(InvalidCfuRosterData):
                importer.run_import(output, public,
                                    ROOT / 'docs/cfu-premier-2026/snapshot.json',
                                    fetch=partial)
            self.assertEqual(output.read_bytes(), before_docs)
            self.assertEqual(public.read_bytes(), before_public)

    def test_offline_fetch_uses_saved_official_html(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            for team in TEAMS.values():
                (source / f'{team["sourceTeamId"]}.html').write_text(
                    fixture_for(team), encoding='utf-8')
            pages, checked_at, hashes = importer.fetch_local(source, TEAMS)
            self.assertEqual(set(pages), set(TEAMS))
            self.assertEqual(set(checked_at), set(TEAMS))
            self.assertEqual(set(hashes), set(TEAMS))
            snapshot = importer.build_rosters(
                pages, TEAMS, checked_at, 'saved_official_html',
                source_hashes=hashes)
            self.assertEqual(set(snapshot['rostersByTeamId']), set(TEAMS))

    def test_committed_rosters_are_valid_and_complete(self):
        committed = importer.load_rosters(
            ROOT / 'docs/cfu-premier-rosters-2026/rosters.json',
            expected_team_ids=set(TEAMS))
        summary = committed['sourceMetadata']['rosters']
        self.assertEqual(summary['teams'], 7)
        self.assertEqual(summary['coverage'], 'complete')
        self.assertEqual(len(committed['playersById']), 238)
        self.assertEqual(summary['records'], 253)
        self.assertEqual(summary['deregisteredRecords'], 90)
        self.assertIn('cfu:player:258', committed['playersById'])
        self.assertEqual(committed['playersById']['cfu:player:258']['name'],
                         'Валентин Манякин')
        tavriya = committed['rostersByTeamId']['cfu:team:tavriya']
        self.assertEqual(tavriya['records'], 32)
        self.assertTrue(any(entry['playerId'] == 'cfu:player:258'
                            for entry in tavriya['entries']))
        # The same official player has separate records in two clubs.
        for team_id in ('cfu:team:tavriya', 'cfu:team:fc-mak-dzhankoy'):
            roster = committed['rostersByTeamId'][team_id]
            self.assertTrue(any(entry['playerId'] == 'cfu:player:2111'
                                for entry in roster['entries']))

    def test_published_copy_is_byte_identical_and_staged(self):
        from scripts import build_pages

        published = ROOT / 'cfu-premier-rosters-2026.json'
        committed = ROOT / 'docs/cfu-premier-rosters-2026/rosters.json'
        self.assertEqual(published.read_bytes(), committed.read_bytes())
        validate_rosters(json.loads(published.read_text(encoding='utf-8')),
                         expected_team_ids=set(TEAMS))

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            output = Path(directory) / 'site'
            source.mkdir()
            for name in ('index.html', 'sw.js', 'manifest.json',
                         'icon-192.png', 'icon-512.png'):
                (source / name).write_bytes(b'x')
            (source / 'data.json').write_text('{}', encoding='utf-8')
            (source / 'cfu-premier-rosters-2026.json').write_bytes(
                published.read_bytes())
            build_pages.stage_site(source, output, {})
            staged = output / 'cfu-premier-rosters-2026.json'
            self.assertTrue(staged.is_file())
            self.assertEqual(staged.read_bytes(), published.read_bytes())


if __name__ == '__main__':
    unittest.main()
