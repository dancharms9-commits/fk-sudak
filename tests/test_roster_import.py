import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup
import requests
from scripts import multi_club_rosters as importer
from scripts import multi_club_schema as schema
from scripts import multi_club_sources as sources

ROOT = Path(__file__).resolve().parents[1]
SEED = json.loads((ROOT/'data.json').read_text())
FIX = ROOT/'tests/fixtures/rosters'
WHEN = '2026-11-10T08:00:00+00:00'


def soup(file):
    return BeautifulSoup((FIX/file).read_text(), 'html.parser')


class RosterImportTests(unittest.TestCase):
    def test_official_club_list_is_not_a_season_or_staff_list(self):
        rows = importer.parse_club(soup('teams-936.html'), SEED['platform']['teamsById']['936'])
        self.assertEqual(len(rows), 29)
        self.assertNotIn('3285', rows)  # actual coach on same page / CSS class
        self.assertEqual(rows['1949']['registeredAt'], '2025-03-27')
        self.assertEqual(rows['1949']['position'], 'Полузащитник')
        self.assertIsNone(rows['1949']['number'])
        self.assertIsNone(rows['1949']['photoUrl'])

    def test_transfer_groups_use_match_ids_without_splitting_tokens_or_joining_names(self):
        p = SEED['platform']
        s = soup('players-1698.html')
        # Deliberately destroy the textual team labels and numeric group syntax.
        for i, group in enumerate(s.select('.player-stat__stat_h[data-id]')):
            token = group['data-id']
            group['data-id'] = 'opaque-'+str(i)
            for node in s.select('.player-stat__more'):
                if node.get('data-id') == token:
                    node['data-id'] = group['data-id']
        for node in s.select('.player-stat__champ-team'):
            node.string = 'Одинаковое название'
        result = importer.parse_profile(s, '1698', {'Барканов Сергей'}, p['matchesById'])
        self.assertEqual((result['stats']['117']['games'], result['stats']['117']['goals'], result['stats']['117']['minutes']), (5, 1, 337))
        self.assertEqual((result['stats']['146']['games'], result['stats']['146']['goals'], result['stats']['146']['minutes']), (5, 6, 445))
        self.assertEqual(result['stats']['117']['yellowCards'], 0)
        self.assertEqual(result['registrations'][0]['registeredAt'], '2026-09-04')
        self.assertEqual(result['registrations'][1]['releasedAt'], '2026-09-01')

    def test_unknown_match_ids_do_not_create_bindings_and_missing_stats_do_not_create_zeroes(self):
        s = soup('players-1698.html')
        for index, a in enumerate(s.select('a[href*="/matches/"]')):
            a['href'] = f'/matches/{999999+index}/'
        result = importer.parse_profile(s, '1698', {'Барканов Сергей'}, SEED['platform']['matchesById'])
        self.assertEqual(result['stats'], {})
        self.assertEqual(len(result['unresolvedGroups']), 2)
        self.assertTrue(all(r['reason'] == 'calendar_match_not_resolved' for r in result['unresolvedGroups']))
        with self.assertRaises(ValueError):
            importer.parse_profile(s, '1698', {'Другой человек'}, SEED['platform']['matchesById'])

    def test_fetch_failure_preserves_all_previous_football_data(self):
        p = copy.deepcopy(SEED['platform'])
        def unavailable(url):
            raise requests.Timeout('fixture')
        result, report = importer.sync_platform(p, unavailable, max_profiles=0, checked_at=WHEN, force=True)
        self.assertEqual(result['playersById'], p['playersById'])
        self.assertEqual(result['playerSeasonStats'], p['playerSeasonStats'])
        self.assertEqual(result['matchesById'], p['matchesById'])
        self.assertEqual(result['rosters']['4:22:141'], p['rosters']['4:22:141'])
        self.assertEqual(len(report['clubs']), 10)
        self.assertTrue(all(r['status'] == 'temporarily_unavailable' for r in report['clubs'].values()))

    def test_club_catalog_is_unverified_until_a_profile_supplies_season_evidence(self):
        p = sources.project_snapshot({k: v for k, v in SEED.items() if k != 'platform'})
        def loader(url):
            if url == 'https://rffk-roo.ru/teams/936/':
                return soup('teams-936.html')
            raise requests.Timeout('fixture')
        result, report = importer.sync_platform(p, loader, max_profiles=0, checked_at=WHEN, force=True)
        r = result['rosters']['4:22:936']
        self.assertEqual(len(r['clubPlayerIds']), 29)
        self.assertEqual(r['playerIds'], [])
        self.assertEqual(len(r['unverifiedPlayerIds']), 29)
        self.assertEqual(r['clubListQuality']['status'], 'current')
        self.assertEqual(result['registrations'], p['registrations'])
        schema.validate_platform(result)

    def test_network_loader_retries_once_and_rejects_unsafe_urls(self):
        loader = importer.NetworkLoader()
        response = unittest.mock.Mock(url='https://rffk-roo.ru/teams/936/', text='<html/>')
        response.raise_for_status.return_value = None
        with patch('scripts.multi_club_rosters.requests.get', side_effect=[requests.Timeout(), response]) as get, patch('scripts.multi_club_rosters.time.sleep'):
            loader('https://rffk-roo.ru/teams/936/')
            self.assertEqual(get.call_count, 2)
            self.assertLessEqual(get.call_args.kwargs['timeout'], 8)
        with self.assertRaises(ValueError):
            loader('https://evil.test/teams/936/')


if __name__ == '__main__':
    unittest.main()
