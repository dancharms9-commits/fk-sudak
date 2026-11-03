"""PWA assets and the supplied visual updater's atomic/idempotent preflight."""
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ['apply_visual_refresh.py', 'modern-home.css', 'index.html',
          'manifest.json', 'sw.js', 'fk-sudak-pwa-192.png', 'fk-sudak-pwa-512.png',
          'fk-sudak-pwa-maskable-512.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']


def png_size(path):
    raw = path.read_bytes()
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Not a PNG')
    offset = 8
    dimensions = None
    while offset < len(raw):
        size = struct.unpack('>I', raw[offset:offset+4])[0]
        kind = raw[offset+4:offset+8]
        payload = raw[offset+8:offset+8+size]
        crc = struct.unpack('>I', raw[offset+8+size:offset+12+size])[0]
        if zlib.crc32(kind+payload) & 0xffffffff != crc:
            raise ValueError('Invalid PNG checksum')
        if kind == b'IHDR':
            dimensions = struct.unpack('>II', payload[:8])
        offset += 12 + size
        if kind == b'IEND':
            return dimensions
    raise ValueError('Truncated PNG')


class VisualRefreshTests(unittest.TestCase):
    def copy_bundle(self, target):
        for name in BUNDLE:
            shutil.copyfile(ROOT / name, target / name)
        # Sentinels must survive even if the supplied updater changes in future.
        (target / 'data.json').write_text('{"keep":"federation data"}')
        (target / 'player_stats_cache_2026.json').write_text('{"keep":"player stats"}')

    def apply(self, target):
        return subprocess.run([sys.executable, str(target / 'apply_visual_refresh.py')],
                              cwd=target, capture_output=True, text=True)

    def test_correct_png_dimensions_and_manifest_purposes(self):
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        self.assertEqual([(i['sizes'], i['purpose']) for i in manifest['icons']],
                         [('192x192', 'any'), ('512x512', 'any'), ('512x512', 'maskable')])
        for icon in manifest['icons']:
            size = tuple(map(int, icon['sizes'].split('x')))
            self.assertEqual(png_size(ROOT / icon['src']), size)
            self.assertEqual(icon['type'], 'image/png')
        for source, output in [('fk-sudak-pwa-192.png', 'icon-192.png'),
                               ('fk-sudak-pwa-512.png', 'icon-512.png'),
                               ('fk-sudak-pwa-maskable-512.png', 'icon-maskable-512.png')]:
            self.assertEqual((ROOT / source).read_bytes(), (ROOT / output).read_bytes())

    def test_inline_css_matches_source_and_header_uses_new_icon(self):
        html = (ROOT / 'index.html').read_text()
        css = (ROOT / 'modern-home.css').read_text()
        self.assertIn(css, html)
        self.assertEqual(html.count('/* Modern Football Home 2026'), 1)
        self.assertIn('<img src="icon-192.png" alt="" width="54" height="54">', html)
        self.assertIn('<link rel="icon" type="image/png" href="icon-192.png">', html)

    def test_rerun_is_idempotent_and_preserves_federation_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            self.copy_bundle(target)
            before = {p.name: p.read_bytes() for p in target.iterdir()}
            for _ in range(2):
                result = self.apply(target)
                self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
                self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, before)

    def test_missing_asset_never_partially_changes_the_app(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            self.copy_bundle(target)
            (target / 'fk-sudak-pwa-maskable-512.png').unlink()
            before = {p.name: p.read_bytes() for p in target.iterdir()}
            result = self.apply(target)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('missing bundled asset', result.stderr)
            self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, before)

    def test_unknown_index_layout_never_partially_changes_the_app(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            self.copy_bundle(target)
            (target / 'index.html').write_text('<html><style></style><body>Unknown layout</body></html>')
            before = {p.name: p.read_bytes() for p in target.iterdir()}
            result = self.apply(target)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('unexpected index.html layout', result.stderr)
            self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, before)


if __name__ == '__main__':
    unittest.main()
