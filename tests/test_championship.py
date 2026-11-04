"""Official season-22 snapshot captured 2026-11-04, with deterministic failures."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup
import requests
import fetch_data as parser

FIXTURE = Path(__file__).parent / 'fixtures' / 'championship-2026.html'
ROOT = Path(__file__).parent.parent


def fixture():
    return BeautifulSoup(FIXTURE.read_text(), 'html.parser')


def loader(path):
    if path == parser.LEAGUE_PATH:
        return BeautifulSoup('<a href="/tournaments/4/seasons/22/">2026/2026</a>', 'html.parser')
    if path == '/tournaments/4/seasons/22/':
        return fixture()
    raise AssertionError(path)


class ChampionshipTests(unittest.TestCase):
    def setUp(self):
        self.calendar = parser.parse_championship_calendar(fixture())

    def test_all_published_rounds_and_matches_not_just_sudak(self):
        self.assertEqual([r['id'] for r in self.calendar['rounds']], list(map(str, range(1, 23))))
        self.assertEqual(len(self.calendar['matches']), 113)
        self.assertEqual(len({m['id'] for m in self.calendar['matches']}), 113)
        self.assertEqual(len([m for m in self.calendar['matches'] if '141' in [m['home_id'], m['away_id']]]), 20)
        self.assertGreater(sum('141' not in [m['home_id'], m['away_id']] for m in self.calendar['matches']), 80)

    def test_real_rounds_results_and_technical_not_date_of_news(self):
        matches = {m['source_id']: m for m in self.calendar['matches'] if m['source_id']}
        for match_id, score, date in [('38662', [5, 3], '2026-03-28'),
                                     ('38763', [10, 2], '2026-10-25'),
                                     ('38762', [2, 3], '2026-10-25')]:
            m = matches[match_id]
            self.assertEqual([m['home_score'], m['away_score']], score)
            self.assertEqual(m['date'], date)
        m = matches['38765']
        self.assertEqual((m['status'], m['status_label']), ('technical', 'Тех. победа'))
        self.assertEqual([m['home_score'], m['away_score']], [3, 0])
        self.assertIsNone(m['date'])
        self.assertIsNone(m['time'])

    def test_scheduled_postponed_and_missing_names_stay_unknown(self):
        scheduled = [m for m in self.calendar['matches'] if m['status'] == 'scheduled']
        self.assertTrue(scheduled)
        self.assertTrue(all(m['home_score'] is None and m['away_score'] is None for m in scheduled))
        postponed = next(m for m in self.calendar['matches'] if m['status'] == 'postponed')
        self.assertIn('перенесен', postponed['status_label'])
        self.assertIsNone(postponed['date'])
        self.assertTrue(any(t['name'] is None for t in self.calendar['teams']))
        november = next(m for m in scheduled if m['date'] == '2026-11-07')
        self.assertIsNone(november['time'])

    def test_all_scorers_official_order_ids_and_equal_goals(self):
        players = parser.parse_championship_scorers(fixture(), self.calendar['teams'])['players']
        self.assertEqual(len(players), 25)
        self.assertEqual(players[0], {'id': '902', 'rank': 1, 'name': 'Юдин Ярослав',
            'team_id': '936', 'team_name': 'СК «Каштан»', 'games': 14, 'goals': 21,
            'penalty_goals': 0, 'minutes': 1007, 'source_url': 'https://rffk-roo.ru/players/902/'})
        self.assertEqual([p['name'] for p in players[2:4]], ['Щербина Илья', 'Александров Андрей'])
        self.assertEqual([p['goals'] for p in players[2:4]], [14, 14])
        donskoy = next(p for p in players if p['id'] == '202')
        self.assertEqual((donskoy['rank'], donskoy['team_id'], donskoy['goals']), (22, '141', 5))
        self.assertEqual(players[-1]['rank'], 25)

    def test_duplicate_cards_deduplicate_and_conflicts_reject(self):
        soup = fixture()
        card = soup.select_one('[data-team1]')
        card.parent.append(copy.copy(card))
        self.assertEqual(len(parser.parse_championship_calendar(soup)['matches']), 113)
        card.select_one('.first').string = '99'
        with self.assertRaises(ValueError):
            parser.parse_championship_calendar(soup)

    def test_partial_scores_and_missing_venue_do_not_invent_data(self):
        soup = fixture()
        card = soup.select_one('[data-team1]')
        card.select_one('.first').string = '-'
        card.select_one('.dop_info .left').decompose()
        m = parser.parse_championship_calendar(soup)['matches'][0]
        self.assertEqual((m['home_score'], m['away_score'], m['venue']), (None, None, None))
        card.select_one('.score .date').string = 'Матч отменён'
        self.assertEqual(parser.parse_championship_calendar(soup)['matches'][0]['status'], 'cancelled')

    def test_stable_match_identity_through_reschedule_and_protocol_publication(self):
        soup = fixture()
        card = soup.select('.tour_calendar [data-team1]')[-1]
        before = parser.parse_championship_calendar(soup)['matches'][-1]['id']
        card.select_one('.date').string = '29.11.2026 15:00'
        link = soup.new_tag('a', href='/matches/99999/')
        card.append(link)
        self.assertEqual(parser.parse_championship_calendar(soup)['matches'][-1]['id'], before)

    def test_wrong_season_teaser_missing_structure_and_unsafe_identity_reject(self):
        for mutate in [lambda s: s.select_one('.champ_data_top_scorers').decompose(),
                       lambda s: s.select_one('.champ_data_top_scorers .name a').__setitem__('href', 'https://evil.test/players/902/')]:
            soup = fixture(); mutate(soup)
            with self.assertRaises(ValueError):
                parser.parse_championship_scorers(soup, self.calendar['teams'])
        soup = fixture(); soup.h1.string = 'Сезон 2027/2027'
        soup.append(BeautifulSoup('<a>Сезон 2026/2026</a>', 'html.parser'))
        with self.assertRaises(ValueError): parser.parse_championship_calendar(soup)
        with self.assertRaises(ValueError): parser.official_season_path(BeautifulSoup('<a>2027/2027</a>', 'html.parser'))

    def test_one_section_failure_retains_snapshot_and_refreshes_other(self):
        previous = parser.update_championship(loader=loader)
        def broken(path):
            page = loader(path)
            if path != parser.LEAGUE_PATH:
                page.select_one('.champ_data_top_scorers').decompose()
            return page
        updated = parser.update_championship(previous, loader=broken)
        self.assertTrue(updated['scorers']['stale'])
        self.assertEqual(updated['scorers']['players'], previous['scorers']['players'])
        self.assertEqual(updated['scorers']['updated'], previous['scorers']['updated'])
        self.assertFalse(updated['calendar']['stale'])
        self.assertFalse(previous['scorers']['stale'])

    def test_calendar_failure_does_not_prevent_scorer_update(self):
        previous = parser.update_championship(loader=loader)
        def broken(path):
            page = loader(path)
            if path != parser.LEAGUE_PATH: page.select_one('.tour_calendar').decompose()
            return page
        updated = parser.update_championship(previous, loader=broken)
        self.assertTrue(updated['calendar']['stale'])
        self.assertEqual(updated['calendar']['matches'], previous['calendar']['matches'])
        self.assertFalse(updated['scorers']['stale'])

    def test_truncated_responses_cannot_replace_last_good_sections(self):
        previous = parser.update_championship(loader=loader)
        def broken(path):
            page = loader(path)
            if path != parser.LEAGUE_PATH:
                page.select('.tour_calendar .list > [data-id]')[-1].decompose()
                page.select('.champ_data_top_scorers .line')[-1].decompose()
            return page
        updated = parser.update_championship(previous, loader=broken)
        for name, field in [('calendar', 'matches'), ('scorers', 'players')]:
            self.assertTrue(updated[name]['stale'])
            self.assertEqual(updated[name][field], previous[name][field])

    def test_total_source_failure_keeps_data_and_success_timestamps(self):
        previous = parser.update_championship(loader=loader)
        def down(path): raise requests.Timeout('fixture')
        updated = parser.update_championship(previous, loader=down)
        for name in ['calendar', 'scorers']:
            self.assertEqual(updated[name], {**previous[name], 'stale': True})
        empty = parser.update_championship(loader=down)
        self.assertNotIn('matches', empty['calendar'])
        self.assertNotIn('players', empty['scorers'])

    def test_club_protocol_join_requires_source_id_date_and_score(self):
        data = json.loads((ROOT / 'data.json').read_text())
        hub = parser.update_championship(loader=loader, club_details=data['match_details'])
        self.assertEqual(sum('club_match_key' in m for m in hub['calendar']['matches']), 16)
        details = copy.deepcopy(data['match_details'])
        first = next(iter(details.values())); first['id'] = '99999'
        hub = parser.update_championship(loader=loader, club_details=details)
        self.assertEqual(sum('club_match_key' in m for m in hub['calendar']['matches']), 15)

    def test_club_refresh_preserves_all_profile_ids_and_photos_without_metric_guessing(self):
        data = json.loads((ROOT / 'data.json').read_text())
        previous = data['player_stats_2026']
        players = previous['players']
        team_page = BeautifulSoup(''.join(f'<a href="{p["profile_url"]}">{p["name"]}</a>' for p in players), 'html.parser')
        stats = parser.make_player_stats(data['squad'], {}, False)
        parser.preserve_player_enrichment(stats, previous, team_page, 16, 63)
        by_name = {p['name']: p for p in stats['players']}
        self.assertEqual(len(by_name), 41)
        for old in players:
            current = by_name[old['name']]
            self.assertEqual(current['profile_url'], old['profile_url'])
            self.assertEqual(current.get('photo_url'), old.get('photo_url'))
            self.assertEqual(current['league_goals'], old['league_goals'])
            self.assertFalse(current['leaderboard_current'])
        fresh = parser.make_player_stats(data['squad'], {'Донской Илья': {'games': 15, 'goals': 6, 'minutes': 1141, 'penalty_goals': 0}}, True)
        parser.preserve_player_enrichment(fresh, previous, team_page, 16, 63, True)
        player = next(p for p in fresh['players'] if p['name'] == 'Донской Илья')
        self.assertEqual(player['league_goals'], 6)
        self.assertNotIn('league_starts', player)
        self.assertTrue(player['leaderboard_current'])

    def test_stale_saved_metrics_do_not_block_fresh_profile_stats(self):
        import os
        import update_player_stats as profiles
        source = json.loads((ROOT / 'data.json').read_text())
        old = next(p for p in source['player_stats_2026']['players'] if p['name'] == 'Донской Илья')
        for current in [False, True]:
            with self.subTest(leaderboard_current=current), tempfile.TemporaryDirectory() as tmp:
                data = copy.deepcopy(source)
                data['player_stats_2026']['players'] = [{**old, 'leaderboard_current': current}]
                Path(tmp, 'data.json').write_text(json.dumps(data))
                page = BeautifulSoup(f'<a href="{old["profile_url"]}">{old["name"]}</a>', 'html.parser')
                fresh = {**old, 'league_games': 15, 'league_goals': 6, 'league_minutes': 1141,
                         'league_starts': 12, 'league_substitutions': 3}
                cwd = os.getcwd()
                try:
                    os.chdir(tmp)
                    with patch.object(profiles, 'fetch_html', return_value=page), patch.object(profiles, 'fetch_one_player', return_value=(old['name'], fresh)):
                        profiles.main()
                    result = next(p for p in json.loads(Path('data.json').read_text())['player_stats_2026']['players'] if p['name'] == old['name'])
                    self.assertEqual(result['league_goals'], 5 if current else 6)
                finally: os.chdir(cwd)

    def test_club_source_failure_still_writes_championship_without_erasing_club(self):
        data = json.loads((ROOT / 'data.json').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'data.json'; target.write_text(json.dumps(data))
            import os
            cwd = os.getcwd()
            try:
                os.chdir(tmp)
                with patch.object(parser, 'update_club_data', side_effect=requests.Timeout()), patch.object(parser, 'get', side_effect=loader):
                    parser.main()
                updated = json.loads(target.read_text())
                for key in ['res', 'next', 'table', 'squad', 'player_stats_2026', 'match_details']:
                    self.assertEqual(updated[key], data[key])
                self.assertEqual(len(updated['championship']['calendar']['matches']), 113)
            finally: os.chdir(cwd)


if __name__ == '__main__': unittest.main()
