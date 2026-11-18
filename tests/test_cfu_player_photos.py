import copy
import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, Mock, patch

from scripts import cfu_player_photos as photos
from scripts.cfu_premier_roster_schema import InvalidCfuRosterData, validate_rosters

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/cfu-premier-rosters/player-photos'
SNAPSHOT = json.loads((ROOT / 'cfu-premier-rosters-2026.json').read_text())
HTML = (FIXTURES / 'profile.html').read_text()
IMAGE = (FIXTURES / 'test-portrait.jpg').read_bytes()
IMAGE_URL = 'https://img.cfu2015.com/i/rectangle/286x380/test-portrait.jpg'
PLAYER = {key: value for key, value in SNAPSHOT['playersById']['cfu:player:258'].items()
          if key != 'photo'}
PROFILE = PLAYER['sourceUrl']
SHA = hashlib.sha256(IMAGE).hexdigest()
PHOTO = {'status': 'approved', 'sourceUrl': PROFILE, 'imageUrl': IMAGE_URL, 'sha256': SHA}
PERMISSION = {'imageUrl': IMAGE_URL, 'sha256': SHA, 'permission': 'Repository test pattern'}


class PhotoParserTests(unittest.TestCase):
    def test_portrait_slot_ignores_club_badge_and_og_image(self):
        for html in (HTML, HTML.replace('src="' + IMAGE_URL, 'data-src="' + IMAGE_URL)):
            self.assertEqual(photos.parse_profile(html, PROFILE, '258'),
                             {'status': 'found', 'imageUrl': IMAGE_URL})
        self.assertEqual(photos.jpeg_size(IMAGE), (128, 160))

    def test_missing_and_placeholder_are_distinct(self):
        self.assertEqual(photos.parse_profile(HTML.replace('src="' + IMAGE_URL, 'data-unused="' + IMAGE_URL),
                                              PROFILE, '258')['status'], 'missing')
        self.assertEqual(photos.parse_profile(HTML.replace(IMAGE_URL, photos.PLACEHOLDER),
                                              PROFILE, '258')['status'], 'placeholder')
        self.assertEqual(photos.parse_profile(HTML.replace(IMAGE_URL, IMAGE_URL.replace(
            'test-portrait.jpg', 'no_people_photo.jpg')), PROFILE, '258')['status'], 'placeholder')

    def test_rejects_unrecognized_schemes_hosts_paths_and_files(self):
        for url in (IMAGE_URL.replace('https:', 'http:'),
                    IMAGE_URL.replace('img.cfu2015.com', 'img.cfu2015.com.evil.test'),
                    IMAGE_URL.replace('img.cfu2015.com', 'img.cfu2015.com:443'),
                    'javascript:alert(1)', 'data:image/jpeg;base64,AA',
                    IMAGE_URL + '?redirect=1', IMAGE_URL.replace('.jpg', '.svg'),
                    IMAGE_URL.replace('.jpg', '.webp'),
                    'https://img.cfu2015.com/l/logos/50x50/fk_tavriya.png'):
            with self.subTest(url=url):
                self.assertEqual(photos.parse_profile(HTML.replace(IMAGE_URL, url),
                                                      PROFILE, '258')['status'], 'rejected_url')
        with self.assertRaises(ValueError):
            photos.jpeg_size(b'\xff\xd8<html>unsafe</html>\xff\xd9')

    def test_profile_id_and_multiple_candidates(self):
        self.assertEqual(photos.parse_profile(HTML.replace('/players/258/', '/players/259/'),
                                              PROFILE, '258')['status'], 'ambiguous')
        self.assertEqual(photos.parse_profile(HTML, PROFILE.replace('258', '259'), '258')['status'],
                         'ambiguous')
        conflict = HTML.replace(f'src="{IMAGE_URL}"', f'src="{IMAGE_URL}" data-src="{IMAGE_URL[:-4]}2.jpg"')
        self.assertEqual(photos.parse_profile(conflict, PROFILE, '258')['status'], 'ambiguous')


class PhotoAuditTests(unittest.TestCase):
    def test_audit_requires_permission_for_exact_file_and_keeps_diagnostics(self):
        client = Mock()
        client.profile.return_value = HTML
        client.image.return_value = IMAGE
        candidate = photos.audit_player(PLAYER, client)
        self.assertEqual(candidate['status'], 'verified')
        self.assertEqual(candidate['sha256'], SHA)
        for permission in (None, {**PERMISSION, 'sha256': '0' * 64},
                           {**PERMISSION, 'permission': ''}):
            self.assertIsNone(photos.approved_photo(PLAYER, candidate, permission))
        self.assertEqual(photos.approved_photo(PLAYER, candidate, PERMISSION), PHOTO)
        key = PLAYER['playerId']
        club_players = {**SNAPSHOT['playersById'], key: PLAYER}
        counts = photos.report(club_players, {key: candidate}, {})
        self.assertEqual((counts['checked'], counts['found'], counts['rightsUnconfirmed']), (1, 1, 1))
        self.assertEqual(counts['unchecked'], len(club_players) - 1)
        self.assertEqual(counts['inSnapshot'], sum('photo' in p for p in club_players.values()))
        self.assertEqual(photos.ambiguous_ids({key: candidate, 'other': candidate}), {key, 'other'})
        client.image.side_effect = ValueError('Invalid image')
        failed = photos.audit_player(PLAYER, client)
        self.assertEqual(failed['status'], 'load_error')
        self.assertNotIn('sha256', failed)
        self.assertEqual(photos.pending_ids(club_players, {key: failed}, [key], False, False), [])
        self.assertEqual(photos.pending_ids(club_players, {key: failed}, [key], False, True), [key])

    def test_requests_check_robots_crawl_delay_redirects_and_mime(self):
        def response(content, mime, status=200):
            reply = MagicMock(status_code=status, headers={'Content-Type': mime})
            reply.iter_content.return_value = [content]
            reply.__enter__.return_value = reply
            return reply

        session = Mock()
        session.headers = {}
        session.get.side_effect = [
            response(b'User-agent: *\nCrawl-delay: 45\nDisallow: /players/259/\n', 'text/plain'),
            response(HTML.encode(), 'text/html; charset=utf-8'),
            response(b'', 'text/plain', 404),
            response(IMAGE, 'image/jpeg'), response(b'', 'text/html', 302),
            response(IMAGE, 'image/svg+xml'),
        ]
        sleep = Mock()
        client = photos.PhotoClient(session, clock=lambda: 0, sleep=sleep)
        self.assertEqual(client.profile(PROFILE), HTML)
        with self.assertRaisesRegex(ValueError, 'robots.txt disallows'):
            client.profile(PROFILE.replace('258', '259'))
        self.assertEqual(client.image(IMAGE_URL), IMAGE)
        with self.assertRaisesRegex(ValueError, 'HTTP 302'):
            client.image(IMAGE_URL)
        with self.assertRaisesRegex(ValueError, 'image/svg'):
            client.image(IMAGE_URL)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [40, 45, 45, 45, 45, 45])
        self.assertTrue(all(call.kwargs['allow_redirects'] is False
                            for call in session.get.call_args_list))

    def test_staging_uses_verified_bytes_and_preserves_approved_photo_after_failure(self):
        players = {PLAYER['playerId']: PLAYER.copy()}
        client = Mock()
        client.image.return_value = IMAGE
        with TemporaryDirectory() as workspace:
            directory = Path(workspace)
            photos.stage_photos(players, {PLAYER['playerId']: PHOTO}, client, directory)
            self.assertEqual(players[PLAYER['playerId']]['photo'], PHOTO)
            self.assertEqual((directory / '258' / f'{SHA}.jpg').read_bytes(), IMAGE)
            updated = {**PHOTO, 'sha256': '1' * 64}
            photos.stage_photos(players, {PLAYER['playerId']: updated}, client, directory)
            self.assertEqual(players[PLAYER['playerId']]['photo'], PHOTO)
            self.assertFalse((directory / '258' / ('1' * 64 + '.jpg')).exists())

    def test_schema_accepts_old_snapshot_and_checks_optional_photo(self):
        value = copy.deepcopy(SNAPSHOT)
        validate_rosters(value)
        value['playersById'][PLAYER['playerId']]['photo'] = PHOTO.copy()
        validate_rosters(value)
        value['playersById'][PLAYER['playerId']]['photo']['sourceUrl'] = PROFILE.replace('258', '259')
        with self.assertRaisesRegex(InvalidCfuRosterData, 'Invalid approved player photo'):
            validate_rosters(value)

    def test_tavriya_publish_resumes_from_asset_and_checkpoint(self):
        original = copy.deepcopy(SNAPSHOT)
        key = PLAYER['playerId']
        original['playersById'][key] = PLAYER.copy()
        team = original['rostersByTeamId'][photos.TAVRIYA]
        client = Mock()
        client.profile.return_value = HTML
        client.image.return_value = IMAGE
        with TemporaryDirectory() as workspace:
            directory = Path(workspace)
            public, archive, state = (directory / name for name in ('public.json', 'archive.json', 'audit.json'))
            photos.write_rosters(original, archive, public)
            asset_path = photos.asset_path
            args = ['cfu_player_photos', '--team', photos.TAVRIYA, '--publish',
                    '--limit', '1', '--state', str(state)]
            with (patch.object(photos, 'SNAPSHOT', public), patch.object(photos, 'ARCHIVE', archive),
                  patch.object(photos, 'STATE', directory),
                  patch.object(photos, 'asset_path', side_effect=lambda player, photo:
                               asset_path(player, photo, directory / 'assets')),
                  patch.object(photos, 'PhotoClient', return_value=client), patch.object(sys, 'argv', args),
                  patch('builtins.print')):
                photos.main()
                published = photos.load_rosters(public)
                self.assertEqual(published['playersById'][key]['photo'], PHOTO)
                self.assertEqual(published['rostersByTeamId'][photos.TAVRIYA], team)
                self.assertEqual(archive.read_bytes(), public.read_bytes())
                self.assertEqual(json.loads(state.read_bytes())[key]['status'], 'verified')
                client.profile.assert_called_once_with(PROFILE)
                client.image.assert_called_once_with(IMAGE_URL)

                # Simulate an interruption after updating the archive, before the public copy.
                photos._write_atomic(public, photos._payload(original))
                args.extend(['--ids', '258'])
                client.reset_mock()
                photos.main()
                self.assertEqual(archive.read_bytes(), public.read_bytes())
                self.assertEqual(photos.load_rosters(public), published)
                client.profile.assert_not_called()
                client.image.assert_not_called()

                args.extend(['--recheck'])
                client.image.side_effect = ValueError('Invalid JPEG')
                photos.main()
                self.assertEqual(photos.load_rosters(public), published)

                args[args.index('258')] = '2168'  # Okean, outside the selected roster.
                with self.assertRaises(SystemExit):
                    photos.main()
