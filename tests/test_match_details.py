"""Protocol regressions: real РФФК markup and incomplete/ambiguous sources."""
import copy
import datetime
import json
from pathlib import Path
import unittest

from bs4 import BeautifulSoup
import requests

from fetch_data import (load_match_details, match_key, minute_parts,
                        parse_match_protocol, parse_matches, safe_match_url)

FIXTURE = Path(__file__).parent / "fixtures" / "match-38762.html"
EXPECTED = {"id": "38762", "source_url": "https://rffk-roo.ru/matches/38762/",
            "date": "2026-10-25", "home": "ФК «Саки»", "away": "ФК «Судак»",
            "home_score": 2, "away_score": 3}
ROW = ["25 октября", "ФК «Саки»", 3, 2, '"Авангард", Саки', "в гостях"]


def fixture():
    return BeautifulSoup(FIXTURE.read_text(encoding="utf-8"), "html.parser")


class ProtocolTests(unittest.TestCase):
    def test_real_away_match_and_penalty(self):
        result = parse_match_protocol(fixture(), EXPECTED)
        self.assertEqual([g["score"] for g in result["goals"]],
                         [[1, 0], [1, 1], [1, 2], [1, 3], [2, 3]])
        self.assertEqual(result["goals"][0]["type"], "penalty")
        self.assertEqual(result["goals"][0]["player"], "Колодяжный А.")
        self.assertEqual(result["goals"][2]["player"], "Донской И.")
        self.assertEqual(result["time"], "15:00")
        self.assertIn("Авангард", result["venue"])

    def test_mismatched_identity_and_season(self):
        for field, value in [("date", "2026-10-24"), ("home", "Другая команда"),
                             ("away_score", 4)]:
            with self.subTest(field=field):
                self.assertIsNone(parse_match_protocol(fixture(), {**EXPECTED, field: value}))
        soup = fixture()
        soup.select_one('.breadcrumbs a[href="https://rffk-roo.ru/tournaments/4/"]').decompose()
        self.assertIsNone(parse_match_protocol(soup, EXPECTED))
        soup = fixture()
        soup.select_one('.breadcrumbs').string = "Сезон 2025/2025"
        self.assertIsNone(parse_match_protocol(soup, EXPECTED))

    def test_missing_or_inconsistent_events_are_unavailable(self):
        for selector in [".timeline", ".score_balls", ".timeline .icon_1",
                         ".score_balls .fio", ".head .date"]:
            with self.subTest(selector=selector):
                soup = fixture()
                soup.select_one(selector).decompose()
                self.assertIsNone(parse_match_protocol(soup, EXPECTED))
        soup = fixture()
        soup.select_one('.timeline .icon_3').parent.select_one('.time').string = "не указана"
        self.assertIsNone(parse_match_protocol(soup, EXPECTED))
        self.assertIsNone(parse_match_protocol(BeautifulSoup("<h1>Ошибка</h1>", "html.parser"), EXPECTED))

    def test_stoppage_time_and_same_minute_keep_source_order(self):
        soup = fixture()
        summary = soup.select('.score_balls .minute')
        # Home summary minutes: 3,72; away: 6,27,44.
        for el, value in zip(summary, ["45+2’", "90+3’", "46’", "46’", "90’"]):
            el.string = value
        goals = soup.select('.timeline .icon_1, .timeline .icon_3')
        for el, value in zip(goals, ["45+2’", "46’", "46’", "90’", "90+3’"]):
            el.parent.select_one('.time').string = value
        result = parse_match_protocol(soup, EXPECTED)
        self.assertEqual([g['minute'] for g in result['goals']], ["45+2", "46", "46", "90", "90+3"])
        self.assertEqual([g['player'] for g in result['goals']][1:3], ["Добровольский В.", "Донской И."])

    def test_own_goal_uses_credited_summary_column(self):
        soup = fixture()
        event = soup.select_one('.timeline .icon_3')
        # Source puts the own-goal author on the opposite timeline side.
        event['class'] = ['team2', 'team', 'icon_2']
        result = parse_match_protocol(soup, EXPECTED)
        self.assertEqual(result['goals'][0]['type'], 'own_goal')
        self.assertEqual(result['goals'][0]['side'], 'home')
        self.assertEqual(result['goals'][0]['score'], [1, 0])

    def test_missed_penalty_is_not_a_goal(self):
        soup = fixture()
        extra = BeautifulSoup('<div class="item"><div class="team1 icon_4">Игрок</div><div class="time">10’</div><div class="team2"></div></div>', 'html.parser')
        soup.select_one('.timeline .list').append(extra)
        self.assertEqual(len(parse_match_protocol(soup, EXPECTED)['goals']), 5)

    def test_verified_scoreless_match_and_missing_stadium(self):
        soup = fixture()
        for el in soup.select('.score_balls .scorers'):
            el.clear()
        soup.select_one('.timeline .list').clear()
        soup.select_one('.score .first').string = '0'
        soup.select_one('.score .second').string = '0'
        soup.select_one('.head .place').decompose()
        result = parse_match_protocol(soup, {**EXPECTED, 'home_score': 0, 'away_score': 0})
        self.assertEqual(result['goals'], [])
        self.assertEqual(result['venue'], '')

    def test_timeout_missing_link_and_partial_response_preserve_result(self):
        original = copy.deepcopy(ROW)
        key = match_key(ROW)
        def down(_):
            raise requests.Timeout('test')
        for refs, loader in [({key: EXPECTED}, down), ({}, down),
                             ({key: EXPECTED}, lambda _: BeautifulSoup('', 'html.parser'))]:
            result = load_match_details([ROW], refs, loader=loader)[key]
            self.assertEqual(result['status'], 'unavailable')
            self.assertEqual(result['goals'], [])
            self.assertEqual(result['venue'], ROW[4])
            self.assertEqual(ROW, original)
        available = load_match_details([ROW], {key: EXPECTED}, loader=lambda _: fixture())
        self.assertEqual(available[key]['status'], 'available')

    def test_link_is_from_same_match_without_changing_legacy_schema(self):
        # This matches the source nesting: .dop_info is a sibling of .score_line.
        soup = BeautifulSoup('''<div class="matches_calendar_line"><div class="score_line">
            <a href="/teams/146/">ФК «Саки»</a><div>2 25.10.2026 15:00 3</div>
            <a href="/teams/141/">ФК «Судак»</a></div>
            <div class="dop_info">Стадион "Авангард", Саки <a href="/matches/38762/">Подробности матча</a></div></div>
            <a href="/matches/99999/">Другой матч</a>''', 'html.parser')
        refs = {}
        results, upcoming = parse_matches(soup, ['ФК «Саки»'], match_refs=refs,
                                          today=datetime.date(2026, 11, 3))
        self.assertEqual(len(results), 1)
        self.assertEqual(len(results[0]), 6)
        self.assertEqual(results[0][2:4], [3, 2])
        self.assertEqual(refs[match_key(results[0])], EXPECTED)
        self.assertEqual(upcoming, [])

    def test_safe_source_urls_and_minutes(self):
        self.assertEqual(safe_match_url('/matches/38762/'), EXPECTED['source_url'])
        for url in ['https://evil.example/matches/38762/', '//evil.example/matches/1/',
                    'http://rffk-roo.ru/matches/1/', 'javascript:alert(1)',
                    '/matches/1/?redirect=evil', '/matches/1/#evil', '/news/1/']:
            self.assertEqual(safe_match_url(url), '')
        for value in ['', 'нет', '-1', '0', '121', '45+99', '45+']:
            self.assertIsNone(minute_parts(value))
        self.assertEqual(minute_parts("45 + 2′"), (45, 2))

    def test_published_protocols_match_all_results(self):
        data = json.loads(Path('data.json').read_text(encoding='utf-8'))
        details = data['match_details']
        self.assertEqual(set(details), {match_key(r) for r in data['res']})
        for row in data['res']:
            detail = details[match_key(row)]
            if detail['status'] != 'available':
                self.assertEqual(detail['goals'], [])
                continue
            score = [row[2], row[3]] if row[5] == 'дома' else [row[3], row[2]]
            self.assertEqual(detail['goals'][-1]['score'] if detail['goals'] else [0, 0], score)
            running = [0, 0]
            for goal in detail['goals']:
                running[0 if goal['side'] == 'home' else 1] += 1
                self.assertEqual(goal['score'], running)


if __name__ == '__main__':
    unittest.main()
