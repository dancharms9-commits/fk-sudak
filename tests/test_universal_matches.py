"""Official fixture, bounded updates and preservation across core restoration."""
import copy
import json
from pathlib import Path
import threading
import time
import unittest
from bs4 import BeautifulSoup
import requests
from scripts.multi_club_matches import parse_protocol, sync_platform, merge_protocols, NetworkLoader
from scripts.multi_club_sources import project_snapshot
from scripts.multi_club_schema import validate_platform

DATA = json.loads(Path('data.json').read_text())
KEY = next(k for k, m in DATA['platform']['matchesById'].items() if m['sourceMatchId'] == '38762')
NOW = '2026-11-10T15:00:00+00:00'
def fixture():
    return BeautifulSoup(Path('tests/fixtures/match-center-38762.html').read_text(), 'html.parser')
def seed():
    p = copy.deepcopy(DATA['platform'])
    # Restrict a unit test to one real source. Other matches remain cached.
    for m in p['matchesById'].values():
        m['protocolQuality'] = {**m['quality'], 'status': 'current', 'lastVerifiedAt': NOW}
    p['matchesById'][KEY].pop('protocolQuality')
    return p

class UniversalMatchTests(unittest.TestCase):
    def parse(self, soup=None, match=None):
        p = DATA['platform']
        return parse_protocol(soup or fixture(), match or p['matchesById'][KEY], p['teamsById'])

    def test_real_protocol_goals_cards_substitutions_lineup_ids(self):
        protocol, people = self.parse()
        self.assertEqual(len(protocol['events']), 34)
        self.assertEqual(len(people), 37)
        self.assertTrue(protocol['eventsComplete'])
        self.assertTrue(protocol['goalsComplete'])
        self.assertEqual(protocol['city'], 'Саки')
        self.assertEqual(protocol['events'][1]['type'], 'penalty')
        self.assertTrue(all(e['playerId'] is None for e in protocol['events']))
        self.assertTrue(any(e['type'] == 'substitution_out' for e in protocol['events']))
        self.assertEqual(len(protocol['lineups']['home']['starters']), 11)

    def test_wrong_score_date_teams_round_or_season_rejected(self):
        m = DATA['platform']['matchesById'][KEY]
        for patch in [{'homeScore': 9}, {'date': '2026-10-26'}, {'homeTeamId': '936'}, {'roundId': '17'}]:
            with self.assertRaises(ValueError): self.parse(match={**m, **patch})
        soup = fixture();soup.select_one('.breadcrumbs').decompose()
        with self.assertRaises(ValueError): self.parse(soup)

    def test_incomplete_goals_keep_independent_cards_and_team_sheets(self):
        soup = fixture();soup.select_one('.score_balls').decompose()
        protocol, _ = self.parse(soup)
        self.assertFalse(protocol['goalsComplete'])
        self.assertFalse(protocol['eventsComplete'])
        self.assertEqual(len(protocol['lineups']), 2)
        self.assertTrue(any(e['type'] == 'yellow' for e in protocol['events']))
        self.assertFalse(any(e['type'] in {'goal','penalty','own_goal'} for e in protocol['events']))

    def test_invalid_lineup_does_not_erase_other_side_or_events(self):
        soup = fixture();soup.select_one('.players_list .team_1 a.name')['href'] = 'https://evil.test/players/1/'
        protocol, _ = self.parse(soup)
        self.assertNotIn('home', protocol['lineups'])
        self.assertIn('away', protocol['lineups'])
        self.assertEqual(len(protocol['events']), 34)

    def test_success_and_ttl_cache_without_any_profile_download(self):
        calls = []
        def loader(url): calls.append(url);return fixture()
        p, report = sync_platform(seed(), loader, checked_at=NOW)
        self.assertEqual(calls, ['https://rffk-roo.ru/matches/38762/'])
        self.assertEqual(report['matches']['38762']['status'], 'accepted')
        self.assertEqual(p['protocolsByMatchId'][KEY]['quality']['lastVerifiedAt'], NOW)
        calls.clear();sync_platform(p, loader, checked_at=NOW)
        self.assertEqual(calls, [])

    def test_network_or_structure_failure_preserves_last_good_events(self):
        p = seed();old = copy.deepcopy(p['protocolsByMatchId'][KEY])
        for loader in [lambda url: BeautifulSoup('<html>bad</html>','html.parser'), lambda url: (_ for _ in ()).throw(requests.Timeout())]:
            result, _ = sync_platform(p, loader, checked_at=NOW)
            self.assertEqual(result['protocolsByMatchId'][KEY]['events'], old['events'])
            self.assertEqual(result['protocolsByMatchId'][KEY]['lineups'], old['lineups'])
            self.assertEqual(result['protocolsByMatchId'][KEY]['quality']['lastVerifiedAt'], old['quality']['lastVerifiedAt'])
            self.assertEqual(result['matchesById'][KEY]['status'], 'finished')

    def test_truncated_protocol_cannot_delete_cached_sections(self):
        soup = fixture();soup.select_one('.timeline').decompose()
        p = seed();old = copy.deepcopy(p['protocolsByMatchId'][KEY])
        result, report = sync_platform(p, lambda url:soup, checked_at=NOW)
        self.assertEqual(report['matches']['38762']['status'], 'preserved')
        self.assertEqual(result['protocolsByMatchId'][KEY]['events'], old['events'])

    def test_unavailable_is_distinct_from_not_published(self):
        p = seed();p['protocolsByMatchId'].pop(KEY);p['legacyLinks']['matches']={k:v for k,v in p['legacyLinks']['matches'].items() if v != KEY}
        result, _ = sync_platform(p, lambda url:BeautifulSoup('bad','html.parser'), checked_at=NOW)
        self.assertNotIn(KEY, result['protocolsByMatchId'])
        self.assertEqual(result['matchesById'][KEY]['protocolQuality']['status'], 'temporarily_unavailable')

    def test_request_limit_and_parallelism(self):
        lock = threading.Lock();active = 0;peak = 0;calls = []
        def loader(url):
            nonlocal active, peak
            with lock: active += 1;peak=max(peak,active);calls.append(url)
            time.sleep(.01)
            with lock: active -= 1
            raise requests.Timeout()
        sync_platform(seed(), loader, max_matches=3, force=True, checked_at=NOW)
        self.assertEqual(len(calls), 3)
        self.assertLessEqual(peak, 2)

    def test_future_without_protocol_and_unknown_teams_never_requested(self):
        p = seed()
        for m in p['matchesById'].values():
            if m['status'] == 'scheduled': m.pop('protocolQuality', None)
        calls=[];sync_platform(p, lambda url:calls.append(url), max_matches=0, checked_at=NOW)
        self.assertEqual(calls, [])
        self.assertEqual(set(p['unresolvedSourceRecords']['teamsById']), {'0','258','1029'})

    def test_unsafe_requests_rejected_before_network(self):
        for url in ['https://evil.test/matches/38762/', 'https://rffk-roo.ru/players/202/', 'https://rffk-roo.ru/matches/38762/?x=1']:
            with self.assertRaises(ValueError): NetworkLoader()(url)

    def test_projection_preserves_refreshed_protocol(self):
        enriched, _ = sync_platform(seed(), lambda url:fixture(), checked_at=NOW)
        projected = project_snapshot(DATA, enriched)
        self.assertEqual(projected['protocolsByMatchId'][KEY], enriched['protocolsByMatchId'][KEY])
        self.assertEqual(projected['matchesById'][KEY]['protocolQuality'], enriched['matchesById'][KEY]['protocolQuality'])

    def test_restore_keeps_independent_protocol_enrichment(self):
        enriched, _ = sync_platform(seed(), lambda url:fixture(), checked_at=NOW)
        merged = merge_protocols(DATA['platform'], enriched)
        self.assertEqual(merged['protocolsByMatchId'][KEY], enriched['protocolsByMatchId'][KEY])
        validate_platform(merged)

    def test_complete_goals_must_match_running_and_final_score(self):
        enriched, _ = sync_platform(seed(), lambda url:fixture(), checked_at=NOW)
        enriched['protocolsByMatchId'][KEY]['events'][1]['score'] = [9,0]
        with self.assertRaises(ValueError): validate_platform(enriched)

class MatchCalendarTests(unittest.TestCase):
    def calendar(self, p):
        mapping={'source_id':'sourceMatchId','source_url':'sourceUrl','round_id':'roundId','home_id':'homeTeamId','away_id':'awayTeamId','date':'date','time':'time','venue':'venue','home_score':'homeScore','away_score':'awayScore','status':'status'}
        return {'matches':[{'id':m['matchId'],'status_label':None,**{a:m[b] for a,b in mapping.items()}} for m in p['matchesById'].values()]+[copy.deepcopy(x['record']) for x in p['unresolvedSourceRecords']['matchesById'].values()]}
    def test_calendar_updates_source_ids_results_and_postponements(self):
        from scripts.multi_club_matches import apply_calendar
        p=copy.deepcopy(DATA['platform']);cal=self.calendar(p)
        planned=next(m for m in cal['matches'] if m['status']=='scheduled' and m['id'] in p['matchesById'])
        planned.update(source_id='9999999',source_url='https://rffk-roo.ru/matches/9999999/',status='finished',home_score=2,away_score=1)
        result,conflicts=apply_calendar(p,cal,NOW)
        self.assertEqual(conflicts,[])
        self.assertEqual(result['matchesById'][planned['id']]['sourceMatchId'],'9999999')
        self.assertEqual(result['matchesById'][planned['id']]['homeScore'],2)
        self.assertEqual(result['matchesById'][planned['id']]['quality']['reason'],'official_season_calendar')
        self.assertNotIn(planned['id'],result['protocolsByMatchId'])
    def test_truncated_calendar_cannot_remove_known_matches(self):
        from scripts.multi_club_matches import apply_calendar
        p=copy.deepcopy(DATA['platform']);cal=self.calendar(p);cal['matches'].pop(0)
        with self.assertRaises(ValueError):apply_calendar(p,cal,NOW)
    def test_conflicting_calendar_correction_retains_verified_protocol(self):
        from scripts.multi_club_matches import apply_calendar
        p=copy.deepcopy(DATA['platform']);cal=self.calendar(p)
        raw=next(m for m in cal['matches'] if m['id']==KEY);raw['home_score']=99
        result,conflicts=apply_calendar(p,cal,NOW)
        self.assertEqual(conflicts,[KEY])
        self.assertEqual(result['protocolsByMatchId'][KEY],p['protocolsByMatchId'][KEY])
        self.assertEqual(result['matchesById'][KEY]['homeScore'],p['matchesById'][KEY]['homeScore'])
    def test_independent_calendar_survives_legacy_projection_and_restore(self):
        from scripts.multi_club_matches import apply_calendar
        p=copy.deepcopy(DATA['platform']);cal=self.calendar(p)
        raw=next(m for m in cal['matches'] if m['status']=='scheduled' and m['id'] in p['matchesById']);raw['status']='postponed';raw['date']=None
        newer,_=apply_calendar(p,cal,NOW)
        projected=project_snapshot(DATA,newer)
        self.assertEqual(projected['matchesById'][raw['id']]['status'],'postponed')
        merged=merge_protocols(p,newer)
        self.assertEqual(merged['matchesById'][raw['id']]['status'],'postponed')
