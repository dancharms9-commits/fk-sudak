"""Match centre enrichment uses the SAME verified official protocol."""
import json
from pathlib import Path
import unittest
from bs4 import BeautifulSoup
from fetch_data import parse_match_protocol
from test_match_details import EXPECTED, fixture as legacy_fixture

SOURCE = Path(__file__).parent / 'fixtures' / 'match-center-38762.html'
def fixture():
    return BeautifulSoup(SOURCE.read_text(), 'html.parser')

class MatchCenterTests(unittest.TestCase):
    def test_real_official_team_sheets_keep_source_identity_and_no_invented_numbers(self):
        result = parse_match_protocol(fixture(), EXPECTED)
        for side, bench in [('home', 6), ('away', 9)]:
            self.assertEqual(len(result['lineups'][side]['starters']), 11)
            self.assertEqual(len(result['lineups'][side]['substitutes']), bench)
            for group in result['lineups'][side].values():
                self.assertTrue(all(p['profile_url'].startswith('https://rffk-roo.ru/players/') for p in group))
                self.assertTrue(all(p['number'] is None or isinstance(p['number'], int) for p in group))
        self.assertTrue(all(p['number'] is None for p in result['lineups']['home']['starters']))
        self.assertEqual(next(p['number'] for p in result['lineups']['away']['starters'] if p['name']=='Ибраимов Эльдар'),99)
        self.assertEqual(result['round'], '18-й тур. Матч №103')
        self.assertEqual(result['goals'], parse_match_protocol(legacy_fixture(), EXPECTED)['goals'])
        self.assertNotIn('positions', result)
        self.assertNotIn('statistics', result)

    def test_real_cards_substitutions_and_goal_order_are_preserved(self):
        result = parse_match_protocol(fixture(), EXPECTED)
        self.assertTrue(result['events_complete'])
        self.assertEqual(len(result['events']), 34)
        self.assertEqual([e for e in result['events'] if e['type'] in {'goal','penalty','own_goal'}], result['goals'])
        entry = next(e for e in result['events'] if e['player']=='Донской И.' and e['type']=='substitution_out')
        self.assertEqual((entry['side'], entry['minute']), ('away','46'))
        self.assertTrue(any(e['type']=='substitution_in' and e['player']=='Абильвапов Э.' for e in result['events']))
        self.assertTrue(any(e['type']=='yellow' and e['player']=='Симончук В.' for e in result['events']))
        self.assertTrue(all('paired_player' not in e for e in result['events']))

    def test_missing_optional_lineups_never_invalidate_existing_goals(self):
        result = parse_match_protocol(legacy_fixture(), EXPECTED)
        self.assertNotIn('lineups', result)
        self.assertEqual(len(result['goals']), 5)
        soup = fixture()
        for node in soup.select('.players_list > .team'):
            node.decompose()
        self.assertEqual(parse_match_protocol(soup, EXPECTED)['goals'], result['goals'])

    def test_duplicate_or_external_player_identity_rejects_only_affected_lineup(self):
        for invalid in ['https://evil.example/players/202/', '/players/2614/']:
            soup = fixture()
            soup.select('.players_list > .team_1 a.name')[1]['href'] = invalid
            result = parse_match_protocol(soup, EXPECTED)
            self.assertNotIn('home', result['lineups'])
            self.assertIn('away', result['lineups'])
            self.assertEqual(len(result['goals']), 5)

    def test_numbers_only_when_published_and_staff_are_not_players(self):
        soup = fixture()
        soup.select_one('.players_list > .team_2 .number').string='17'
        result = parse_match_protocol(soup, EXPECTED)
        self.assertEqual(result['lineups']['away']['starters'][0]['number'], 17)
        self.assertEqual(set(result['lineups']['away']), {'starters','substitutes'})

    def test_unknown_event_and_unknown_minute_do_not_create_guesses(self):
        for change in ['icon_999', 'нет минуты']:
            soup = fixture()
            card = soup.select_one('.timeline .icon_5')
            if change.startswith('icon_'):
                card['class']=['team2','team',change]
            else:
                card.parent.select_one('.time').string=change
            result = parse_match_protocol(soup, EXPECTED)
            self.assertFalse(result['events_complete'])
            self.assertEqual(len(result['goals']),5)
            self.assertEqual(len(result['events']),33)

    def test_second_warning_red_and_missed_penalty_keep_their_types(self):
        for icon, kind in [('icon_6','second_yellow'),('icon_7','red'),('icon_4','missed_penalty')]:
            soup=fixture();card=soup.select_one('.timeline .icon_5');card['class']=['team2','team',icon]
            result=parse_match_protocol(soup,EXPECTED)
            self.assertTrue(result['events_complete'])
            self.assertEqual(result['events'][0]['type'],kind)
            self.assertEqual(len(result['goals']),5)

    def test_enriched_dataset_keeps_all_protocols_goals_and_existing_sources(self):
        data=json.loads(Path('data.json').read_text())
        self.assertEqual(len(data['match_details']),len(data['res']))
        for row in data['res']:
            detail=data['match_details']['|'.join(map(str,[2026,row[0],row[1],row[5]]))]
            scores=[row[2],row[3]] if row[5]=='дома' else [row[3],row[2]]
            if detail['status']=='available':
                self.assertEqual(detail['goals'][-1]['score'] if detail['goals'] else [0,0],scores)
            if detail.get('events_complete'):
                self.assertEqual([e for e in detail['events'] if e['type'] in {'goal','penalty','own_goal'}],detail['goals'])
