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
from unittest.mock import Mock, call, patch
import zipfile

import requests
import yaml
import fetch_data
import update_player_stats
from scripts import build_pages as build
from scripts import wait_for_pages_artifact as wait

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


class PagesArtifactTests(unittest.TestCase):
    name = 'github-pages-123-2'

    def setUp(self):
        self.gh = self.enterContext(patch.object(wait.subprocess, 'run'))
        self.clock = self.enterContext(patch.object(wait, 'time'))
        self.elapsed = 0
        self.clock.monotonic.side_effect = lambda: self.elapsed
        self.clock.sleep.side_effect = self.advance

    def advance(self, seconds):
        self.elapsed += seconds

    def result(self, *pages):
        return Mock(stdout=json.dumps([{'artifacts': page} for page in pages]))

    def record(self, **overrides):
        return {'id': 456, 'name': self.name, 'expired': False,
                'workflow_run': {'id': 123}, **overrides}

    def test_retries_transient_errors_and_waits_for_this_upload(self):
        other_artifacts = [self.record(name='github-pages'), self.record(name='github-pages-123-1'),
                           self.record(name=self.name.upper()), self.record(workflow_run={'id': 124})]
        self.gh.side_effect = [
            subprocess.CalledProcessError(1, 'gh', stderr='gh: Unavailable (HTTP 503)'),
            self.result(other_artifacts),
            self.result(other_artifacts + [self.record(expired=True)]),
            self.result(other_artifacts + [self.record(id=455)]),
            self.result(other_artifacts + [self.record()]),
        ]
        wait.wait_for_artifact('owner/repo', 123, self.name, 456)
        self.assertEqual(self.gh.call_count, 5)
        command = self.gh.call_args.args[0]
        self.assertIn('repos/owner/repo/actions/runs/123/artifacts', command)
        self.assertIn(f'name={self.name}', command)
        self.assertIn('--paginate', command)
        self.assertEqual(self.clock.sleep.call_args_list, [call(5)] * 4 + [call(25)])

    def test_stabilization_starts_only_after_a_valid_rest_match(self):
        with patch.object(wait, 'WAIT_SECONDS', 6):
            self.gh.side_effect = [self.result([]), self.result([self.record()])]
            wait.wait_for_artifact('owner/repo', 123, self.name, 456)
        self.assertEqual(self.gh.call_count, 2)
        self.assertEqual(self.clock.sleep.call_args_list, [call(5), call(25)])

    def test_missing_build_identity_fails_before_polling(self):
        for name, artifact_id in (('', 456), (self.name, 0)):
            with self.subTest(name=name, artifact_id=artifact_id):
                with self.assertRaisesRegex(ValueError, 'Build did not provide'):
                    wait.wait_for_artifact('owner/repo', 123, name, artifact_id)
        self.gh.assert_not_called()

    def test_duplicate_name_fails_even_across_pages_and_with_an_expired_record(self):
        self.gh.return_value = self.result([self.record()], [self.record(id=455, expired=True)])
        with self.assertRaisesRegex(RuntimeError, 'Multiple artifacts.*github-pages-123-2.*found 2'):
            wait.wait_for_artifact('owner/repo', 123, self.name, 456)
        self.assertEqual(self.gh.call_count, 1)
        self.clock.sleep.assert_not_called()

    def test_missing_artifact_explains_which_run_and_name_timed_out(self):
        self.gh.return_value = self.result([])
        with self.assertRaisesRegex(RuntimeError, 'Timed out.*github-pages-123-2.*run 123.*no exact match'):
            wait.wait_for_artifact('owner/repo', 123, self.name, 456)
        self.assertEqual(self.elapsed, wait.WAIT_SECONDS)
        self.assertNotIn(call(25), self.clock.sleep.call_args_list)

    def test_api_timeouts_use_the_same_deadline_as_sleep(self):
        def timeout(command, *, timeout, **kwargs):
            self.advance(timeout)
            raise subprocess.TimeoutExpired(command, timeout)

        self.gh.side_effect = timeout
        with self.assertRaisesRegex(RuntimeError, 'Timed out.*GitHub API request timed out'):
            wait.wait_for_artifact('owner/repo', 123, self.name, 456)
        self.assertGreaterEqual(self.elapsed, 90)
        self.assertLess(self.elapsed, 120)
        self.assertEqual(self.elapsed, wait.WAIT_SECONDS)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load((ROOT / '.github/workflows/update.yml').read_text())
        self.build = self.workflow['jobs']['build']
        self.deploy = self.workflow['jobs']['deploy']

    def test_production_triggers_permissions_and_transaction_lock(self):
        workflow = self.workflow
        triggers = workflow.get('on', workflow.get(True))  # YAML 1.1 treats on as bool
        self.assertEqual(set(triggers), {'schedule', 'push', 'workflow_dispatch'})
        self.assertEqual(triggers['schedule'][0]['cron'], '0 * * * *')
        self.assertEqual(triggers['push']['branches'], ['main'])
        self.assertIs(triggers['workflow_dispatch']['inputs']['force_cfu']['default'], False)
        self.assertEqual(workflow['concurrency']['group'],
                         "${{ github.ref == 'refs/heads/main' && 'football-pages-production' || github.run_id }}")
        self.assertIs(workflow['concurrency']['cancel-in-progress'], False)
        self.assertEqual(set(workflow['jobs']), {'build', 'deploy'})
        self.assertNotIn('concurrency', self.build)
        self.assertNotIn('concurrency', self.deploy)
        self.assertEqual(self.deploy['needs'], 'build')
        self.assertEqual(self.build['if'], "github.ref == 'refs/heads/main'")
        self.assertEqual(self.deploy['if'],
                         "github.ref == 'refs/heads/main' && needs.build.outputs.pages_enabled == 'true'")
        self.assertEqual(self.build['permissions'], {
            'contents': 'read', 'actions': 'read', 'pages': 'read',
        })
        self.assertEqual(self.deploy['permissions'], {
            'contents': 'read', 'actions': 'read', 'pages': 'write', 'id-token': 'write',
        })
        self.assertNotIn('environment', self.build)
        self.assertEqual(self.deploy['environment'], {
            'name': 'github-pages', 'url': '${{ steps.deployment.outputs.page_url }}',
        })
        steps = self.build['steps']
        checkout = next(s for s in steps if s.get('uses', '').startswith('actions/checkout@'))
        self.assertEqual(checkout['with']['ref'], 'main')
        self.assertIs(checkout['with']['persist-credentials'], False)
        self.assertEqual(steps[0]['id'], 'source')
        for step in steps[1:]:
            self.assertEqual(step['if'], "steps.source.outputs.enabled == 'true'")
        self.assertEqual(next(s for s in steps if s.get('id') == 'pages')['with']['enablement'], False)

    def test_each_build_upload_has_a_unique_name(self):
        metadata, upload, _ = self.build['steps'][-3:]
        self.assertEqual(upload['uses'], 'actions/upload-pages-artifact@v3')
        self.assertEqual(upload['with']['name'], f"${{{{ steps.{metadata['id']}.outputs.name }}}}")
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'outputs'
            for run_id, attempt in ((123, 1), (123, 2), (124, 1)):
                subprocess.run(['sh', '-ec', metadata['run']], check=True, env={
                    **os.environ, 'GITHUB_OUTPUT': str(output),
                    'GITHUB_RUN_ID': str(run_id), 'GITHUB_RUN_ATTEMPT': str(attempt),
                })
            self.assertEqual(output.read_text().splitlines(), [
                'name=github-pages-123-1', 'name=github-pages-123-2', 'name=github-pages-124-1',
            ])

    def test_deploy_only_rerun_uses_the_successful_build_outputs(self):
        upload = self.build['steps'][-2]
        checkout, poll, deploy = self.deploy['steps']
        self.assertEqual(self.build['outputs'], {
            'pages_enabled': '${{ steps.source.outputs.enabled }}',
            'pages_artifact_name': upload['with']['name'],
            'pages_artifact_id': f"${{{{ steps.{upload['id']}.outputs.artifact_id }}}}",
        })
        self.assertEqual(checkout['uses'], 'actions/checkout@v4')
        self.assertEqual(checkout['with']['ref'], '${{ github.workflow_sha }}')
        self.assertIs(checkout['with']['persist-credentials'], False)
        self.assertEqual(deploy['uses'], 'actions/deploy-pages@v4')
        self.assertEqual(poll['run'], 'python3 scripts/wait_for_pages_artifact.py')
        self.assertEqual(poll['env'], {
            'GH_TOKEN': '${{ github.token }}',
            'PAGES_ARTIFACT_NAME': '${{ needs.build.outputs.pages_artifact_name }}',
            'PAGES_ARTIFACT_ID': '${{ needs.build.outputs.pages_artifact_id }}',
        })
        self.assertEqual(deploy['with']['artifact_name'], poll['env']['PAGES_ARTIFACT_NAME'])
        self.assertNotIn('run_attempt', yaml.safe_dump(self.deploy).lower())
        self.assertGreater(poll['timeout-minutes'] * 60, wait.WAIT_SECONDS + wait.STABILIZATION_SECONDS)
        self.assertNotIn('continue-on-error', poll)
        self.assertNotIn('continue-on-error', deploy)

    def test_football_state_checkpoint_stays_in_build(self):
        checkpoint = self.build['steps'][-1]
        self.assertEqual(checkpoint['uses'], 'actions/upload-artifact@v4')
        self.assertEqual(checkpoint['with'], {
            'name': 'football-state-${{ github.run_id }}-${{ github.run_attempt }}',
            'path': '_site/data.json\n_site/cfu-sync-2026.json\n_state/player_stats_cache_2026.json\n',
            'retention-days': 90,
            'if-no-files-found': 'error',
        })

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

    def test_no_workflow_can_auto_merge_pull_requests(self):
        for file in (ROOT / '.github/workflows').glob('*.y*ml'):
            source = file.read_text()
            workflow = yaml.safe_load(source)
            scopes = [workflow.get('permissions', {})]
            scopes.extend(job.get('permissions', {}) for job in workflow['jobs'].values())
            for scope in scopes:
                self.assertNotEqual(scope, 'write-all', file.name)
                if isinstance(scope, dict):
                    self.assertNotEqual(scope.get('pull-requests'), 'write', file.name)
            self.assertNotRegex(source, r'gh\s+pr\s+merge|auto[-_]?merge|enablePullRequestAutoMerge|mergePullRequest')


if __name__ == '__main__':
    unittest.main()
