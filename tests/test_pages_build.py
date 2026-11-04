"""Publication safety: restore, parser failures, data retention and workflow contract."""
import copy
import os
from datetime import timedelta
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

import requests
import yaml
import fetch_data
import update_player_stats
from scripts import build_pages as build

ROOT = Path(__file__).resolve().parents[1]
SEED = json.loads((ROOT / 'data.json').read_text())


def newer(data=SEED):
    result = copy.deepcopy(data)
    result['updated'] = (build.timestamp(data) + timedelta(seconds=30)).isoformat()
    return result


def response(payload=None, content=None, links=None):
    value = Mock()
    value.json.return_value = payload
    value.content = content
    value.links = links or {}
    return value


def artifact(ident, branch='main', expired=False):
    return {'id': ident, 'name': f'football-state-{ident}-1', 'expired': expired,
            'created_at': f'2026-11-04T{ident:02}:00:00Z',
            'workflow_run': {'id': ident, 'head_branch': branch,
                             'repository_id': 1, 'head_repository_id': 1}}


def run(conclusion='success', event='schedule'):
    return {'status': 'completed', 'conclusion': conclusion, 'event': event,
            'path': '.github/workflows/update.yml'}


def checkpoint_zip(data=SEED):
    content = io.BytesIO()
    with zipfile.ZipFile(content, 'w') as archive:
        archive.writestr('_site/data.json', json.dumps(data))
        archive.writestr('_state/player_stats_cache_2026.json', '{}')
    return content.getvalue()


class ValidationTests(unittest.TestCase):
    def test_original_data_and_all_required_entities_are_valid(self):
        self.assertIs(build.validate(SEED), SEED)
        self.assertEqual(len(build.roster(SEED)), 41)
        self.assertEqual(len(SEED['match_details']), 16)
        self.assertEqual(len(SEED['championship']['calendar']['rounds']), 22)

    def test_plausible_truncated_snapshots_are_rejected(self):
        mutations = {
            'player': lambda d: d['squad']['Полузащитники'].pop(),
            'protocol': lambda d: d['match_details'].pop(next(iter(d['match_details']))),
            'round': lambda d: d['championship']['calendar']['rounds'].pop(),
            'match': lambda d: d['championship']['calendar']['matches'].pop(),
            'scorer': lambda d: d['championship']['scorers']['players'].pop(),
            'result': lambda d: d['res'].pop(),
            'protocol events': lambda d: next(iter(d['match_details'].values())).update(events=[]),
            'profile': lambda d: d['player_stats_2026']['players'].pop(),
            'statistic': lambda d: d['player_stats_2026']['players'][0].update(league_games=None),
            'bad statistic': lambda d: d['player_stats_2026']['players'][0].update(league_games='oops'),
            'score': lambda d: d['res'][0].__setitem__(2, -1),
            'news': lambda d: d.update(news=[]),
            'season': lambda d: d['championship'].update(season=2025),
            'timestamp': lambda d: d.update(updated='not-a-date'),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                data = newer()
                mutate(data)
                with self.assertRaises(build.InvalidData):
                    build.validate(data, SEED)

    def test_new_protocol_failure_cannot_erase_available_protocol(self):
        data = newer()
        next(iter(data['match_details'].values()))['status'] = 'unavailable'
        with self.assertRaisesRegex(build.InvalidData, 'protocol'):
            build.validate(data, SEED)

    def test_newer_checkpoint_beats_stale_cdn_and_tracked_data(self):
        latest = newer()
        latest['coach'] += ' · latest'
        chosen = build.choose_baseline(SEED, SEED, latest)
        self.assertEqual(chosen, latest)
        self.assertIsNot(chosen, latest)
        self.assertEqual(build.choose_baseline(SEED, latest, SEED), latest)

    def test_newer_but_incomplete_checkpoint_does_not_get_published(self):
        bad = newer()
        bad['match_details'] = {}
        with self.assertRaises(build.InvalidData):
            build.choose_baseline(SEED, SEED, bad)

    def test_old_revision_and_invalid_json_are_rejected(self):
        with self.assertRaises(build.InvalidData):
            build.validate(SEED, newer())
        for content in (b'{}', b'', b'<html>outage</html>', b'{"x":NaN}', b'{"x":Infinity}'):
            with self.subTest(content=content), self.assertRaises(ValueError):
                build.decode_json(content)


class RestoreTests(unittest.TestCase):
    def test_live_fetch_bypasses_caches_and_retries_bad_json(self):
        session = Mock()
        session.get.side_effect = [response(content=b'{}'), response(content=json.dumps(SEED).encode())]
        with patch.object(build.time, 'sleep'):
            self.assertEqual(build.published_data('https://example.test/fk-sudak/', session), SEED)
        first, second = session.get.call_args_list
        self.assertEqual(first.args[0], 'https://example.test/fk-sudak/data.json')
        self.assertEqual(first.kwargs['headers']['Cache-Control'], 'no-cache')
        self.assertNotEqual(first.kwargs['params'], second.kwargs['params'])

    def test_unavailable_published_data_stops_build_before_any_deployment(self):
        session = Mock()
        session.get.side_effect = requests.Timeout()
        with patch.object(build.time, 'sleep'), self.assertRaises(RuntimeError):
            build.published_data('https://example.test/fk-sudak', session)
        self.assertEqual(session.get.call_count, 3)

    def test_checkpoint_ignores_pr_expired_failed_and_cancelled_runs(self):
        session = Mock()
        session.get.side_effect = [
            response({'artifacts': [artifact(9, branch='feature'), artifact(8, expired=True),
                                     artifact(7), artifact(6), artifact(5)]}),
            response(run('failure')), response(run('cancelled')), response(run()),
            response(content=checkpoint_zip()),
        ]
        self.assertEqual(build.successful_checkpoint('owner/repo', 'test-token', session), SEED)
        urls = [call.args[0] for call in session.get.call_args_list]
        self.assertFalse(any('/runs/9' in u or '/runs/8' in u for u in urls))
        self.assertTrue(urls[-1].endswith('/artifacts/5/zip'))

    def test_checkpoint_pagination_and_first_migration_without_artifacts(self):
        session = Mock()
        session.get.side_effect = [response({'artifacts': []}, links={'next': {'url': 'https://api.github.com/next'}}),
                                   response({'artifacts': [artifact(2)]}), response(run()),
                                   response(content=checkpoint_zip())]
        self.assertEqual(build.successful_checkpoint('owner/repo', 'test-token', session), SEED)
        session = Mock()
        session.get.return_value = response({'artifacts': []})
        self.assertIsNone(build.successful_checkpoint('owner/repo', 'test-token', session))

    def test_api_or_corrupted_checkpoint_failure_is_not_silently_ignored(self):
        session = Mock()
        session.get.side_effect = requests.ConnectionError()
        with self.assertRaises(requests.ConnectionError):
            build.successful_checkpoint('owner/repo', 'test-token', session)
        session.get.side_effect = [response({'artifacts': [artifact(1)]}), response(run()),
                                   response(content=checkpoint_zip({}))]
        with self.assertRaises(ValueError):
            build.successful_checkpoint('owner/repo', 'test-token', session)


class RefreshTests(unittest.TestCase):
    def test_parser_error_timeout_empty_json_and_truncation_preserve_last_good(self):
        for failure in ('error', 'timeout', 'empty', 'partial'):
            def runner(command, cwd, **kwargs):
                if failure == 'error':
                    raise subprocess.CalledProcessError(1, command)
                if failure == 'timeout':
                    raise subprocess.TimeoutExpired(command, 480)
                bad = newer()
                bad['match_details'] = {}
                (cwd / 'data.json').write_text('' if failure == 'empty' else json.dumps(bad))
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                self.assertEqual(build.refresh(SEED, Path(directory), runner), SEED)

    def test_actual_parsers_with_rffk_fully_offline_keep_all_entities_and_statistics(self):
        def runner(command, cwd, **kwargs):
            original = Path.cwd()
            try:
                os.chdir(cwd)
                if command[-1].endswith('fetch_data.py'):
                    with patch.object(fetch_data, 'get', side_effect=requests.Timeout()):
                        fetch_data.main()
                else:
                    with patch.object(update_player_stats, 'fetch_html', side_effect=requests.Timeout()):
                        update_player_stats.main()
            finally:
                os.chdir(original)
        with tempfile.TemporaryDirectory() as directory:
            updated = build.refresh(SEED, Path(directory), runner)
        for key in ('table', 'res', 'next', 'squad', 'coach', 'news', 'match_details'):
            self.assertEqual(updated[key], SEED[key], key)
        self.assertTrue(updated['championship']['calendar']['stale'])
        self.assertTrue(updated['championship']['scorers']['stale'])
        for key in ('calendar', 'scorers'):
            expected = {**SEED['championship'][key], 'stale': True}
            self.assertEqual(updated['championship'][key], expected)
        old_players = {p['name']: p for p in SEED['player_stats_2026']['players']}
        for player in updated['player_stats_2026']['players']:
            for field in build.STAT_FIELDS:
                self.assertEqual(player.get(field), old_players[player['name']].get(field))

    def test_cache_is_restored_from_latest_data_not_old_main_cache(self):
        baseline = newer()
        baseline['player_stats_2026']['players'][0]['league_minutes'] += 1
        caches = []
        def runner(command, cwd, **kwargs):
            caches.append(json.loads((cwd / 'player_stats_cache_2026.json').read_text()))
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(build.refresh(baseline, Path(directory), runner), baseline)
        self.assertEqual(caches, [baseline['player_stats_2026']] * 2)

    def test_enrichment_same_minute_has_new_revision_for_open_clients(self):
        def runner(command, cwd, **kwargs):
            data = json.loads((cwd / 'data.json').read_text())
            if command[-1].endswith('update_player_stats.py'):
                data['player_stats_2026']['players'][0]['league_minutes'] += 1
            build.write_json(cwd / 'data.json', data)
        with tempfile.TemporaryDirectory() as directory:
            updated = build.refresh(SEED, Path(directory), runner)
        self.assertGreater(build.timestamp(updated), build.timestamp(SEED))
        self.assertEqual(updated['match_details'], SEED['match_details'])

    def test_consecutive_same_minute_run_accepts_fresh_core_with_minute_precision(self):
        baseline = newer()
        def runner(command, cwd, **kwargs):
            data = json.loads((cwd / 'data.json').read_text())
            if command[-1].endswith('fetch_data.py'):
                data['updated'] = build.timestamp(data).replace(second=0, microsecond=0).isoformat()
                data['coach'] += ' · fresh core'
            build.write_json(cwd / 'data.json', data)
        with tempfile.TemporaryDirectory() as directory:
            updated = build.refresh(baseline, Path(directory), runner)
        self.assertTrue(updated['coach'].endswith('fresh core'))
        self.assertGreater(build.timestamp(updated), build.timestamp(baseline))

    def test_optional_stats_failure_preserves_successful_core_refresh(self):
        def runner(command, cwd, **kwargs):
            if command[-1].endswith('update_player_stats.py'):
                (cwd / 'data.json').write_text('{}')
                raise subprocess.CalledProcessError(1, command)
            data = newer()
            data['coach'] += ' · fresh'
            build.write_json(cwd / 'data.json', data)
        with tempfile.TemporaryDirectory() as directory:
            updated = build.refresh(SEED, Path(directory), runner)
        self.assertTrue(updated['coach'].endswith('fresh'))
        self.assertEqual(updated['player_stats_2026'], SEED['player_stats_2026'])

    def test_artifact_preserves_pwa_assets_and_never_changes_tracked_data(self):
        originals = {name: (ROOT / name).read_bytes() for name in ('data.json', 'player_stats_cache_2026.json')}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / '_site'
            build.stage_site(ROOT, output, SEED)
            for item in ('index.html', 'sw.js', 'manifest.json', 'modern-home.css', 'match-center.css',
                         'championship.css', 'icon-maskable-512.png', 'assets/players/vladimir-semenov.webp'):
                self.assertEqual((output / item).read_bytes(), (ROOT / item).read_bytes())
            self.assertTrue((output / '.nojekyll').exists())
            self.assertFalse((output / '.github').exists())
            self.assertFalse((output / 'fetch_data.py').exists())
            self.assertEqual(json.loads((output / 'data.json').read_text()), SEED)
        for name, raw in originals.items():
            self.assertEqual((ROOT / name).read_bytes(), raw)


class WorkflowTests(unittest.TestCase):
    def test_production_triggers_permissions_and_transaction_lock(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/update.yml').read_text())
        triggers = workflow.get('on', workflow.get(True))  # YAML 1.1 treats on as bool
        self.assertEqual(triggers['schedule'][0]['cron'], '0 * * * *')
        self.assertEqual(triggers['push']['branches'], ['main'])
        self.assertIn('workflow_dispatch', triggers)
        publish = workflow['jobs']['publish']
        self.assertEqual(publish['if'], "github.ref == 'refs/heads/main'")
        self.assertEqual(publish['concurrency']['group'], 'football-pages-production')
        self.assertIs(publish['concurrency']['cancel-in-progress'], False)
        self.assertEqual(publish['permissions']['contents'], 'read')
        steps = publish['steps']
        checkout = next(s for s in steps if s.get('uses', '').startswith('actions/checkout@'))
        self.assertEqual(checkout['with']['ref'], 'main')
        self.assertIs(checkout['with']['persist-credentials'], False)
        self.assertTrue(steps[-1]['uses'].startswith('actions/deploy-pages@'))
        self.assertEqual(steps[0]['id'], 'source')
        for step in steps[1:]:
            self.assertEqual(step['if'], "steps.source.outputs.enabled == 'true'")
        self.assertEqual(next(s for s in steps if s.get('id') == 'pages')['with']['enablement'], False)

    def test_no_workflow_can_write_generated_data_to_main(self):
        for file in (ROOT / '.github/workflows').glob('*.yml'):
            workflow = yaml.safe_load(file.read_text())
            scopes = [workflow.get('permissions', {})]
            scopes.extend(job.get('permissions', {}) for job in workflow['jobs'].values())
            for scope in scopes:
                self.assertNotEqual(scope, 'write-all', file.name)
                if isinstance(scope, dict):
                    self.assertNotEqual(scope.get('contents'), 'write', file.name)
            self.assertNotRegex(file.read_text(), r'git\s+(?:push|commit)|contents:\s*write')


if __name__ == '__main__':
    unittest.main()
