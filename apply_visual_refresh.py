#!/usr/bin/env python3
"""Apply the 2026 FC Sudak UI/PWA icon refresh to the current repository.

No data.json, statistics logic, routing or tests are overwritten. Safe to run twice.
Usage: python apply_visual_refresh.py  (from repo root; files may live alongside script)
"""
from pathlib import Path
import json, re, shutil

root=Path.cwd()
source=Path(__file__).resolve().parent
index_path=root/'index.html'
if not index_path.exists():
    raise SystemExit('ERROR: run from repository root with index.html')
html=index_path.read_text(encoding='utf-8')
css=(source/'modern-home.css').read_text(encoding='utf-8')
marker='/* Modern Football Home 2026'

# Verify exact anchors before any file is changed; no partial transformations.
if marker not in html:
    header_old='<header><div class="crest" aria-hidden="true">С</div><div><h1>ФК «Судак»</h1><p>Открытый чемпионат Крыма · 2026</p></div></header>'
    header_new='<header><div class="crest" aria-hidden="true"><img src="icon-192.png?v=final-crest-v7" alt="" width="54" height="54"></div><div class="brand"><h1>ФК «Судак»</h1><p>Открытый чемпионат Крыма · 2026</p></div></header>'
    tag_nearest='`<div class="card next"><span class="tag">Ближайший матч</span>'
    tag_result='`<h2>Последний матч</h2><a class="card match-link"'
    tag_position='?`<h2>В таблице</h2><div class="card"><div class="row">'
    tag_home='$("home").innerHTML=nearest+latest+'
    needed=[('</style>',1), (header_old,1),(tag_nearest,1),(tag_result,1),(tag_position,1),(tag_home,1)]
    for needle,count in needed:
        actual=html.count(needle)
        if actual!=count:
            raise SystemExit(f'ERROR: unexpected index.html layout for {needle[:75]!r}: found {actual}, expected {count}. No files changed.')
    html=html.replace('</style>', '\n'+css+'\n</style>',1)
    html=html.replace(header_old,header_new,1)
    html=html.replace(tag_nearest,'`<div class="card next home-next"><span class="tag">Ближайший матч</span>',1)
    html=html.replace(tag_result,'`<h2>Последний матч</h2><a class="card match-link home-result"',1)
    html=html.replace(tag_position,'?`<h2>В таблице</h2><div class="card home-standing"><div class="row">',1)
    intro=('`<div class="home-intro"><span class="home-kicker">ФК Судак · сезон 2026</span>'
           '<h2>Наш клуб. <em>Наша игра.</em></h2>'
           '<p>Следите за матчами, результатами и командой в одном месте.</p></div>`+')
    html=html.replace(tag_home,'$("home").innerHTML='+intro+'nearest+latest+',1)
    html=html.replace('<link rel="apple-touch-icon" href="icon-192.png">',
                      '<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png?v=final-crest-v7">\n<link rel="icon" type="image/png" sizes="32x32" href="favicon.png?v=final-crest-v7">',1)
else:
    print('UI already applied; verifying PWA icons and manifest')

# Make manifest compatible with normal and adaptive/maskable launcher icons.
manifest_path=root/'manifest.json'
manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
# A complete launcher set may intentionally differ from the in-app crest.
# Preserve that selection when rerunning this older visual migration.
current_icons=manifest.get('icons')
expected_icons=[('192x192','any'),('512x512','any'),('512x512','maskable')]
if not (isinstance(current_icons,list) and len(current_icons)==len(expected_icons) and
        all(isinstance(icon,dict) and (icon.get('sizes'),icon.get('purpose'))==expected and
            icon.get('type')=='image/png' and isinstance(icon.get('src'),str) and icon['src']
            for icon,expected in zip(current_icons,expected_icons))):
    manifest['icons']=[
        {'src':'icon-192.png?v=final-crest-v7','sizes':'192x192','type':'image/png','purpose':'any'},
        {'src':'icon-512.png?v=final-crest-v7','sizes':'512x512','type':'image/png','purpose':'any'},
        {'src':'icon-maskable-512.png?v=final-crest-v7','sizes':'512x512','type':'image/png','purpose':'maskable'},
    ]
manifest.setdefault('description','ФК «Судак» — результаты, календарь, состав и новости')

sw_path=root/'sw.js'
sw=sw_path.read_text(encoding='utf-8')
for previous in ['sudak-v2','sudak-ui-v3','sudak-crest-v4','sudak-launch-v5','sudak-launch-v6']:
    sw=sw.replace(f'const CACHE="{previous}";','const CACHE="sudak-launch-v7";',1)
if not any(f'const CACHE="{version}";' in sw for version in ['sudak-launch-v7','sudak-home-v8','sudak-match-v9','sudak-tabs-v10','sudak-route-v11','sudak-player-photos-v12','sudak-championship-v13','sudak-matches-v14','sudak-typography-v15']):
    raise SystemExit('ERROR: unknown service-worker version. No files changed.')
new='const SHELL=["./","./index.html","./manifest.json","./assets/club-crest-final-original.png","./icon-192.png?v=final-crest-v7","./icon-512.png?v=final-crest-v7","./icon-maskable-512.png?v=final-crest-v7","./favicon.png?v=final-crest-v7","./apple-touch-icon.png?v=final-crest-v7"];'
for previous in [
    'const SHELL=["./","./index.html","./manifest.json","./assets/club-crest-original.png","./icon-192.png?v=crest-v4","./icon-512.png?v=crest-v4","./icon-maskable-512.png?v=crest-v4"];',
    'const SHELL=["./","./index.html","./manifest.json","./icon-192.png?v=crest-v4","./icon-512.png?v=crest-v4","./icon-maskable-512.png?v=crest-v4"];',
    'const SHELL=["./","./index.html","./manifest.json"];',
    'const SHELL=["./","./index.html","./manifest.json","./icon-192.png","./icon-512.png","./icon-maskable-512.png"];',
]:
    sw=sw.replace(previous,new,1)
if new not in sw:raise SystemExit('ERROR: unknown SW shell layout. No files changed.')

assets={
  'fk-sudak-pwa-192.png':'icon-192.png',
  'fk-sudak-pwa-512.png':'icon-512.png',
  'fk-sudak-pwa-maskable-512.png':'icon-maskable-512.png',
}
for src in assets:
    if not (source/src).is_file():raise SystemExit(f'ERROR: missing bundled asset {src}')

# Commit file modifications only after all preflight checks have passed.
index_path.write_text(html,encoding='utf-8')
manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
sw_path.write_text(sw,encoding='utf-8')
for src,dst in assets.items():shutil.copyfile(source/src,root/dst)
print('OK: main-page styling, PWA icon assets, manifest and SW cache version updated.')
print('Next: run tests, inspect 320/390/768/1440px and open a PR. DO NOT merge automatically.')
