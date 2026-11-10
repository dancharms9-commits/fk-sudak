"""Platform identities, missing data and preservation across the real build pipeline."""
import copy
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import requests
import fetch_data
from bs4 import BeautifulSoup

from scripts import build_pages as build
from scripts import multi_club_schema as schema
from scripts import multi_club_sources as sources

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests/fixtures/multi-club/standings-2026.html'
SEED = json.loads((ROOT / 'data.json').read_text())
PLATFORM = SEED['platform']


def soup():
    return BeautifulSoup(FIXTURE.read_text(), 'html.parser')


def legacy():
    return {k: copy.deepcopy(v) for k, v in SEED.items() if k != 'platform'}


class PlatformTests(unittest.TestCase):
    def test_exactly_eleven_unique_string_ids_and_explicit_season(self):
        expected = {'141', '936', '1030', '932', '521', '930', '146', '934', '757', '1028', '117'}
        self.assertEqual(schema.TEAM_IDS, expected)
        self.assertEqual(len(schema.CLUBS), len(expected))
        self.assertEqual(set(PLATFORM['teamsById']), expected)
        self.assertTrue(all(isinstance(k, str) for k in PLATFORM['teamsById']))
        season = PLATFORM['competitionSeasons']['4:22']
        self.assertEqual((season['competitionId'], season['seasonId'], season['seasonYear']), ('4', '22', 2026))
        self.assertEqual(set(season['participantTeamIds']), expected)
        self.assertEqual(len(season['participantTeamIds']), 11)
        self.assertIs(schema.validate_platform(PLATFORM), PLATFORM)

    def test_every_legacy_root_value_is_unchanged(self):
        hashes = json.loads((FIXTURE.parent / 'legacy-root-sha256.json').read_text())
        self.assertEqual(set(SEED) - {'platform'}, set(hashes))
        self.assertGreaterEqual(schema.stamp(SEED['updated']), schema.stamp(PLATFORM['sourceUpdatedAt']))
        for key, expected in hashes.items():
            if key == 'updated':
                continue  # revision advances; all legacy football facts remain byte-equivalent
            raw = json.dumps(SEED[key], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), expected, key)

    def test_all_matches_are_accounted_for_without_making_unknown_clubs(self):
        raw = {m['id']: m for m in SEED['championship']['calendar']['matches']}
        known = PLATFORM['matchesById']
        unknown = PLATFORM['unresolvedSourceRecords']['matchesById']
        self.assertEqual((len(known), len(unknown)), (100, 13))
        self.assertFalse(known.keys() & unknown.keys())
        self.assertEqual(known.keys() | unknown.keys(), raw.keys())
        for key, match in known.items():
            self.assertEqual((match['homeTeamId'], match['awayTeamId']), (raw[key]['home_id'], raw[key]['away_id']))
            self.assertEqual((match['homeScore'], match['awayScore']), (raw[key]['home_score'], raw[key]['away_score']))
        self.assertEqual(set(PLATFORM['unresolvedSourceRecords']['teamsById']), {'0', '258', '1029'})
        for key, entry in unknown.items():
            self.assertEqual(entry['record'], raw[key])
            self.assertEqual(entry['reason'], 'identity_not_confirmed')

    def test_no_joins_from_team_or_player_names(self):
        data = legacy()
        for team in data['championship']['calendar']['teams']:
            team['name'] = 'Одно и то же название'
        # Homonyms remain distinct via official profile IDs.
        data['player_stats_2026']['players'][1]['name'] = data['player_stats_2026']['players'][0]['name']
        p = sources.project_snapshot(data)
        self.assertEqual(set(p['matchesById']), set(PLATFORM['matchesById']))
        self.assertEqual(len(p['playerSeasonStats']), 41)
        self.assertEqual(len(p['rosters']['4:22:141']['playerIds']), 41)

    def test_nulls_zeroes_and_partial_leaderboard_are_not_club_totals(self):
        players = {schema.source_id(p['profile_url'], 'players'): p for p in SEED['player_stats_2026']['players']}
        sudak = {k: v for k, v in PLATFORM['playerSeasonStats'].items() if v['teamId'] == '141'}
        self.assertEqual(len(sudak), 41)
        self.assertEqual(sum(p['games'] is not None for p in sudak.values()), 38)
        for p in sudak.values():
            old = players[p['playerId']]
            self.assertEqual(p['games'], old['league_games'])
            self.assertEqual(p['goals'], old['league_goals'])
            for field in ('yellowCards', 'secondYellowCards', 'redCards'):
                self.assertIsNone(p[field])
            self.assertEqual(p['teamId'], '141')
            self.assertEqual(p['quality']['status'], 'stale')
        self.assertTrue(any(p['goals'] == 0 for p in PLATFORM['playerSeasonStats'].values()))
        self.assertFalse(PLATFORM['scorerLeaderboard'])
        # In particular the combined UOR/Saki leaderboard row for 1698 cannot
        # become either club's season total in this foundation.
        projected = sources.project_snapshot(legacy())
        self.assertNotIn('1698:117:4:22', projected['playerSeasonStats'])
        self.assertNotIn('1698:146:4:22', projected['playerSeasonStats'])

    def test_foreign_rosters_are_not_fabricated_from_protocol_lineups(self):
        projected = sources.project_snapshot(legacy())
        for tid in schema.TEAM_IDS - {'141'}:
            roster = projected['rosters'][f'4:22:{tid}']
            self.assertEqual(roster['playerIds'], [])
            self.assertEqual(roster['quality']['status'], 'not_checked')
            self.assertEqual(roster['quality']['coverage'], 'unknown')
        self.assertEqual(projected['registrations'], {})
        self.assertEqual(PLATFORM['newsById'], {})

    def test_protocols_join_by_source_id_and_keep_text_events_unresolved(self):
        self.assertEqual(len(PLATFORM['protocolsByMatchId']), 16)
        for key, protocol in PLATFORM['protocolsByMatchId'].items():
            self.assertEqual(protocol['sourceMatchId'], PLATFORM['matchesById'][key]['sourceMatchId'])
            self.assertEqual(protocol['homeTeamId'], PLATFORM['matchesById'][key]['homeTeamId'])
            for side, groups in protocol['lineups'].items():
                for entries in groups.values():
                    for player in entries:
                        self.assertIn(player['playerId'], PLATFORM['playersById'])
            for event in protocol['events']:
                self.assertIsNone(event['playerId'])
                self.assertTrue(event['sourceLabel'])
        self.assertEqual(len(PLATFORM['legacyLinks']['matches']), 16)
        self.assertEqual(len(PLATFORM['legacyLinks']['players']), 41)

    def test_wrong_protocol_date_or_score_does_not_attach_to_match(self):
        for field, value in [('date', '2026-01-01'), ('home_score', 99), ('id', '999999')]:
            data = legacy()
            first = next(iter(data['match_details'].values()))
            first[field] = value
            self.assertEqual(len(sources.project_snapshot(data)['protocolsByMatchId']), 15)

    def test_match_rescheduling_keeps_identity_and_missing_score(self):
        data = legacy()
        match = next(m for m in data['championship']['calendar']['matches']
                     if m['status'] == 'scheduled' and m['home_id'] in schema.TEAM_IDS
                     and m['away_id'] in schema.TEAM_IDS)
        match['date'] = '2026-11-29'
        p = sources.project_snapshot(data)
        self.assertEqual(p['matchesById'][match['id']]['date'], '2026-11-29')
        self.assertIsNone(p['matchesById'][match['id']]['homeScore'])
        self.assertIsNone(p['matchesById'][match['id']]['awayScore'])

    def test_changed_calendar_result_cannot_keep_inconsistent_old_protocol(self):
        data = legacy()
        sid = next(iter(PLATFORM['protocolsByMatchId'].values()))['sourceMatchId']
        match = next(m for m in data['championship']['calendar']['matches'] if m['source_id'] == sid)
        match['home_score'] += 1
        with self.assertRaisesRegex(schema.InvalidPlatform, 'Protocol does not match'):
            sources.project_snapshot(data, PLATFORM)

    def test_missing_profile_url_does_not_make_an_identity_from_name(self):
        data = legacy()
        first = data['player_stats_2026']['players'][0]
        pid = schema.source_id(first.pop('profile_url'), 'players')
        p = sources.project_snapshot(data)
        self.assertNotIn(pid, p['rosters']['4:22:141']['playerIds'])
        self.assertNotIn(f'{pid}:141:4:22', p['playerSeasonStats'])

    def test_unsafe_profile_url_cannot_establish_identity(self):
        for url in ['http://rffk-roo.ru/players/202/', 'https://evil.test/players/202/',
                    'https://rffk-roo.ru/players/202/?team=141', 'https://rffk-roo.ru/players/0/']:
            self.assertIsNone(schema.source_id(url, 'players'))

    def test_schema_rejects_malformed_models_and_broken_foreign_keys(self):
        mid = next(iter(PLATFORM['matchesById']))
        stat = next(iter(PLATFORM['playerSeasonStats']))
        protocol = next(iter(PLATFORM['protocolsByMatchId']))
        mutations = {
            'version': lambda p: p.update(schemaVersion=2),
            'bool version': lambda p: p.update(schemaVersion=True),
            'missing model': lambda p: p.pop('registrations'),
            'numeric team': lambda p: p['teamsById']['141'].update(teamId=141),
            'unknown participant': lambda p: p['competitionSeasons']['4:22']['participantTeamIds'].append('0'),
            'duplicate participant': lambda p: p['competitionSeasons']['4:22']['participantTeamIds'].__setitem__(1, '141'),
            'unknown club': lambda p: p['teamsById'].__setitem__('0', copy.deepcopy(p['teamsById']['141'])),
            'unknown match team': lambda p: p['matchesById'][mid].update(homeTeamId='0'),
            'swapped sides': lambda p: p['matchesById'][mid].update(homeTeamId=p['matchesById'][mid]['awayTeamId']),
            'negative stat': lambda p: p['playerSeasonStats'][stat].update(goals=-1),
            'boolean stat': lambda p: p['playerSeasonStats'][stat].update(goals=True),
            'wrong season': lambda p: p['playerSeasonStats'][stat].update(seasonId='20'),
            'orphan player': lambda p: p['playerSeasonStats'][stat].update(playerId='999999'),
            'quality': lambda p: p['teamsById']['141']['quality'].update(status='good'),
            'bad current': lambda p: p['teamsById']['141']['quality'].update(status='current'),
            'bad stamp': lambda p: p.update(sourceUpdatedAt='not-a-time'),
            'missing roster': lambda p: p['rosters'].pop('4:22:936'),
            'partial standings': lambda p: p['standings']['4:22']['rows'].pop(),
            'fake empty current': lambda p: p['standings']['4:22'].update(rows=[]),
            'unimported leaderboard': lambda p: p['scorerLeaderboard'].update(fake={}),
            'unimported news': lambda p: p['newsById'].update(fake={}),
            'event team': lambda p: p['protocolsByMatchId'][protocol]['events'][0].update(teamId='0'),
            'event type': lambda p: p['protocolsByMatchId'][protocol]['events'][0].update(type='fake'),
            'event score': lambda p: p['protocolsByMatchId'][protocol]['events'][0].update(score=[True, 0]),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                p = copy.deepcopy(PLATFORM)
                mutate(p)
                with self.assertRaises(schema.InvalidPlatform):
                    schema.validate_platform(p)

    def test_previous_platform_protects_confirmed_data_and_history(self):
        for collection in ['playersById', 'matchesById', 'playerSeasonStats', 'protocolsByMatchId']:
            p = copy.deepcopy(PLATFORM)
            p[collection].pop(next(iter(p[collection])))
            with self.subTest(collection=collection), self.assertRaises(schema.InvalidPlatform):
                schema.validate_platform(p, PLATFORM)
        p = copy.deepcopy(PLATFORM)
        p['unresolvedSourceRecords']['matchesById'].pop(next(iter(p['unresolvedSourceRecords']['matchesById'])))
        with self.assertRaises(schema.InvalidPlatform):
            schema.validate_platform(p, PLATFORM)
        p = copy.deepcopy(PLATFORM)
        p['playerSeasonStats'][next(iter(p['playerSeasonStats']))]['minutes'] = None
        with self.assertRaises(schema.InvalidPlatform):
            schema.validate_platform(p, PLATFORM)


class StandingsTests(unittest.TestCase):
    def test_full_official_table_with_movement_indicators_and_explicit_ids(self):
        rows = sources.parse_standings(soup())
        self.assertEqual(len(rows), 11)
        self.assertEqual({r['teamId'] for r in rows}, schema.TEAM_IDS)
        self.assertEqual((rows[0]['teamId'], rows[0]['played'], rows[0]['points']), ('936', 17, 51))
        self.assertEqual((rows[4]['rank'], rows[4]['teamId']), (5, '521'))
        renamed = soup()
        for link in renamed.select('.team a'):
            link.string = 'Другое название'
        self.assertEqual(sources.parse_standings(renamed), rows)

    def test_missing_numbers_not_zero_wrong_context_and_partial_html_reject(self):
        for label in ['missing', 'unknown', 'duplicate', 'season', 'tournament', 'html200', 'negative']:
            s = soup()
            if label == 'missing':
                s.select_one('.total [data-col="1"]').decompose()
            elif label == 'unknown':
                s.select_one('.team a')['href'] = schema.BASE + '/teams/0/'
            elif label == 'duplicate':
                s.select('.team a')[1]['href'] = s.select_one('.team a')['href']
            elif label == 'season':
                s.select_one('.team_top_title .city').string = 'Сезон 2025/2025'
            elif label == 'tournament':
                s.select_one('.breadcrumbs a[href*="/tournaments/4/"]')['href'] = schema.BASE + '/tournaments/5/'
            elif label == 'negative':
                s.select_one('.total [data-col="7"]').string = '-1'
            else:
                s = BeautifulSoup('<html>Временно недоступно</html>', 'html.parser')
            with self.subTest(label=label), self.assertRaises(schema.InvalidPlatform):
                sources.parse_standings(s)

    def test_outage_preserves_last_good_and_does_not_touch_sudak(self):
        original = copy.deepcopy(SEED)
        with patch.object(sources, 'fetch_season', side_effect=requests.Timeout()):
            p = sources.update_platform(SEED, PLATFORM, loader=sources.fetch_season,
                                        checked_at='2026-11-10T09:00:00+00:00')
        self.assertEqual(SEED, original)
        table = p['standings']['4:22']
        self.assertEqual(table['rows'], PLATFORM['standings']['4:22']['rows'])
        self.assertEqual(table['quality']['status'], 'stale')
        self.assertEqual(table['quality']['lastAttemptStatus'], 'temporarily_unavailable')
        self.assertEqual(table['quality']['lastVerifiedAt'], PLATFORM['standings']['4:22']['quality']['lastVerifiedAt'])
        self.assertNotEqual(table['quality']['status'], 'not_published')

    def test_outage_without_prior_table_is_unavailable_not_empty_success(self):
        def fail():
            raise requests.ConnectionError()
        p = sources.update_platform(legacy(), loader=fail, checked_at='2026-11-10T09:00:00+00:00')
        self.assertEqual(p['standings']['4:22']['rows'], [])
        self.assertEqual(p['standings']['4:22']['quality']['status'], 'temporarily_unavailable')
        self.assertIsNone(p['standings']['4:22']['quality']['lastVerifiedAt'])

    def test_success_restores_current_status_only_for_actual_loaded_section(self):
        p = sources.update_platform(SEED, PLATFORM, loader=soup, checked_at='2026-11-10T09:00:00+00:00')
        self.assertEqual(p['standings']['4:22']['quality']['status'], 'current')
        self.assertEqual(p['standings']['4:22']['quality']['lastVerifiedAt'], '2026-11-10T09:00:00+00:00')
        self.assertEqual(p['rosters']['4:22:936'], PLATFORM['rosters']['4:22:936'])
        self.assertTrue(all(s['quality']['status'] == 'stale' for s in p['playerSeasonStats'].values() if s['teamId'] == '141'))


class MigrationTests(unittest.TestCase):
    def test_old_format_is_still_valid_and_new_block_is_optional(self):
        old = legacy()
        self.assertIs(build.validate(old), old)
        self.assertEqual(build.decode_json(json.dumps(old).encode()), old)
        self.assertEqual(sources.project_snapshot(old), sources.project_snapshot(old))
        self.assertEqual(set(old), set(SEED) - {'platform'})

    def test_full_schema_is_checked_during_restore_and_removal_is_rejected(self):
        bad = copy.deepcopy(SEED)
        bad['platform']['matchesById'][next(iter(bad['platform']['matchesById']))]['homeTeamId'] = '0'
        with self.assertRaises(build.InvalidData):
            build.decode_json(json.dumps(bad).encode())
        with self.assertRaises(build.InvalidData):
            build.validate(legacy(), SEED)

    def test_newer_legacy_publication_carries_seed_extension_during_rollout(self):
        old = legacy()
        old['updated'] = (build.timestamp(SEED) + timedelta(seconds=1)).isoformat()
        merged = build.choose_baseline(SEED, old)
        self.assertEqual(merged['updated'], old['updated'])
        self.assertEqual(merged['platform'], sources.project_snapshot(merged, PLATFORM, source_updated_at=old['updated']))
        self.assertNotIn('platform', old)

    def test_table_only_refresh_with_equal_projection_revision_beats_seed(self):
        live = copy.deepcopy(SEED)
        live['updated'] = (build.timestamp(SEED) + timedelta(seconds=1)).isoformat()
        q = live['platform']['standings']['4:22']['quality']
        newer = (schema.stamp(q['lastVerifiedAt']) + timedelta(seconds=30)).isoformat()
        q.update(lastVerifiedAt=newer, lastSuccessAt=newer, checkedAt=newer)
        merged = build.choose_baseline(SEED, live)
        self.assertEqual(merged['platform'], live['platform'])
        self.assertEqual(merged['platform']['sourceUpdatedAt'], PLATFORM['sourceUpdatedAt'])

    def test_newer_root_with_older_extension_carries_newest_platform(self):
        checkpoint = copy.deepcopy(SEED)
        checkpoint['updated'] = (build.timestamp(SEED) + timedelta(seconds=1)).isoformat()
        checkpoint['platform']['sourceUpdatedAt'] = checkpoint['updated']
        live = copy.deepcopy(SEED)
        live['updated'] = (build.timestamp(SEED) + timedelta(seconds=2)).isoformat()
        merged = build.choose_baseline(SEED, live, checkpoint)
        self.assertEqual(merged['updated'], live['updated'])
        self.assertEqual(merged['platform']['sourceUpdatedAt'], checkpoint['updated'])

    def test_direct_successful_legacy_core_writer_preserves_extension(self):
        replacements = {
            'get': lambda *a, **kw: BeautifulSoup('', 'html.parser'),
            'parse_table': lambda *a, **kw: copy.deepcopy(SEED['table']),
            'parse_matches': lambda *a, **kw: (copy.deepcopy(SEED['res']), copy.deepcopy(SEED['next'])),
            'parse_squad': lambda *a, **kw: (copy.deepcopy(SEED['squad']), SEED['coach']),
            'parse_news': lambda *a, **kw: copy.deepcopy(SEED['news']),
            'parse_league_scorers': lambda *a, **kw: {'verified': {}},
            'make_player_stats': lambda *a, **kw: copy.deepcopy(SEED['player_stats_2026']),
            'preserve_player_enrichment': lambda *a, **kw: None,
            'load_match_details': lambda *a, **kw: copy.deepcopy(SEED['match_details']),
            'update_championship': lambda *a, **kw: copy.deepcopy(SEED['championship']),
        }
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                Path('data.json').write_text(json.dumps(SEED))
                with patch.multiple(fetch_data, **replacements):
                    fetch_data.update_club_data()
                result = json.loads(Path('data.json').read_text())
            finally:
                os.chdir(original)
        self.assertEqual(result['platform'], PLATFORM)
        for key in ('squad', 'res', 'next', 'table', 'news', 'match_details', 'player_stats_2026'):
            self.assertEqual(result[key], SEED[key])

    def test_two_successful_legacy_producers_cannot_drop_platform(self):
        calls = []
        def runner(command, cwd, **kwargs):
            data = json.loads((cwd / 'data.json').read_text())
            self.assertIn('platform', data)
            calls.append(command[-1])
            data.pop('platform')  # simulate the pre-extension fetch_data version
            data['coach'] += ' · refreshed'
            build.write_json(cwd / 'data.json', data)
        with tempfile.TemporaryDirectory() as directory:
            result = build.refresh(SEED, Path(directory), runner)
        self.assertEqual(len(calls), 2)
        self.assertEqual(set(result['platform']['playersById']), set(PLATFORM['playersById']))
        self.assertEqual(result['squad'], SEED['squad'])
        self.assertEqual(result['match_details'], SEED['match_details'])
        self.assertEqual(result['platform']['standings'], PLATFORM['standings'])
        self.assertGreater(build.timestamp(result), build.timestamp(SEED))

    def test_partial_legacy_failure_plus_standings_outage_retains_all_data(self):
        def runner(command, cwd, **kwargs):
            if command[-1].endswith('update_player_stats.py'):
                raise subprocess.CalledProcessError(1, command)
            data = json.loads((cwd / 'data.json').read_text())
            data['championship']['calendar']['stale'] = True
            build.write_json(cwd / 'data.json', data)
        def fail():
            raise requests.Timeout()
        with tempfile.TemporaryDirectory() as directory:
            result = build.refresh(SEED, Path(directory), runner, platform_loader=fail)
        for key in ('table', 'res', 'next', 'squad', 'coach', 'news', 'player_stats_2026', 'match_details'):
            self.assertEqual(result[key], SEED[key], key)
        p = result['platform']
        self.assertEqual(p['playerSeasonStats'], PLATFORM['playerSeasonStats'])
        self.assertEqual(p['protocolsByMatchId'], PLATFORM['protocolsByMatchId'])
        self.assertEqual(p['standings']['4:22']['rows'], PLATFORM['standings']['4:22']['rows'])
        self.assertEqual(len(p['teamsById']), 11)

    def test_known_statistics_survive_missing_optional_new_values(self):
        data = legacy()
        data['player_stats_2026']['players'][0]['league_minutes'] = None
        p = sources.project_snapshot(data, PLATFORM)
        first = schema.source_id(data['player_stats_2026']['players'][0]['profile_url'], 'players')
        row = p['playerSeasonStats'][f'{first}:141:4:22']
        self.assertEqual(row['minutes'], PLATFORM['playerSeasonStats'][f'{first}:141:4:22']['minutes'])
        self.assertEqual(row['quality']['status'], 'stale')

    def test_partial_profile_failure_does_not_advance_individual_verification(self):
        data = legacy()
        raw = data['player_stats_2026']['players'][0]
        raw['stats_current'] = False
        data['player_stats_2026']['stats_as_of'] = '2026-11-10T09:00:00+00:00'
        pid = schema.source_id(raw['profile_url'], 'players')
        p = sources.project_snapshot(data, PLATFORM)
        self.assertEqual(p['playerSeasonStats'][f'{pid}:141:4:22']['quality']['lastVerifiedAt'],
                         PLATFORM['playerSeasonStats'][f'{pid}:141:4:22']['quality']['lastVerifiedAt'])

    def test_leaderboard_only_projection_cannot_replace_profile_statistics(self):
        data = legacy()
        raw = data['player_stats_2026']['players'][0]
        raw.pop('stats_current')
        raw['league_goals'] = 99
        pid = schema.source_id(raw['profile_url'], 'players')
        p = sources.project_snapshot(data, PLATFORM)
        self.assertEqual(p['playerSeasonStats'][f'{pid}:141:4:22']['goals'],
                         PLATFORM['playerSeasonStats'][f'{pid}:141:4:22']['goals'])
        p = sources.project_snapshot(data)
        self.assertIsNone(p['playerSeasonStats'][f'{pid}:141:4:22']['goals'])

    def test_staged_artifact_keeps_extension_and_original_pwa(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'site'
            build.stage_site(ROOT, out, SEED)
            self.assertEqual(json.loads((out / 'data.json').read_text())['platform'], PLATFORM)
            for name in ['index.html', 'sw.js', 'manifest.json', 'icon-192.png', 'assets/home-fortress.jpg']:
                self.assertEqual((out / name).read_bytes(), (ROOT / name).read_bytes(), name)
        self.assertLess(len(json.dumps(SEED).encode()), build.MAX_JSON)


if __name__ == '__main__':
    unittest.main()
