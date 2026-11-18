"""Audit CFU portraits in small resumable batches, or stage approved files locally."""
import argparse
from collections import Counter, defaultdict
import fcntl
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

from bs4 import BeautifulSoup
import requests

from scripts.cfu_premier_roster_schema import (
    BASE, CRAWL_DELAY_SECONDS, PHOTO_URL_RE, official_player_id, player_url,
    require, valid_player_photo,
)
from scripts.cfu_premier_rosters import (
    USER_AGENT, _decode, _payload, _utc_now, _write_atomic, load_rosters, write_rosters,
)

MEDIA = 'https://img.cfu2015.com'
PLACEHOLDER = '/content/themes/cfu2/images/noPeoplePhoto.svg'
MAX_IMAGE_BYTES = 256 * 1024
SNAPSHOT = Path('cfu-premier-rosters-2026.json')
ARCHIVE = Path('docs/cfu-premier-rosters-2026/rosters.json')
ASSETS = Path('assets/cfu-player-photos')


def parse_profile(html, source_url, source_id):
    """Read only the portrait slot of the page whose title links to this ID."""
    if source_url != player_url(source_id):
        return {'status': 'ambiguous', 'reason': 'profile_url_mismatch'}
    soup = BeautifulSoup(html, 'html.parser')
    links = soup.select('.pageTitle section > strong > a[href]')
    ids = {official_player_id(BASE + link['href'] if link['href'].startswith('/')
                              else link['href']) for link in links}
    if ids != {source_id}:
        return {'status': 'ambiguous', 'reason': 'profile_title_id_mismatch'}
    if not soup.select_one('.playerProfile-header .entryContentHeader h1'):
        return {'status': 'load_error', 'reason': 'missing_profile_header'}
    slot = '.playerProfile-header .playerProfile-header-content > .photo > img'
    sources = {image[attr].strip() for image in soup.select(slot)
               for attr in ('src', 'data-src') if image.get(attr, '').strip()}
    if not sources:
        return {'status': 'missing'}
    sources -= {PLACEHOLDER, BASE + PLACEHOLDER}
    if not sources:
        return {'status': 'placeholder'}
    if len(sources) != 1:
        return {'status': 'ambiguous', 'reason': 'multiple_portraits'}
    image_url = sources.pop()
    if not PHOTO_URL_RE.fullmatch(image_url):
        return {'status': 'rejected_url', 'reason': 'unexpected_portrait_url'}
    return {'status': 'found', 'imageUrl': image_url}


def jpeg_size(raw):
    """Read dimensions from baseline/progressive JPEG headers through SOS."""
    require(raw.startswith(b'\xff\xd8') and raw.endswith(b'\xff\xd9'), 'Invalid JPEG markers')
    size = None
    offset = 2
    while offset + 4 <= len(raw):
        require(raw[offset] == 255, 'Invalid JPEG segment')
        while offset < len(raw) and raw[offset] == 255:
            offset += 1
        marker = raw[offset]
        length = int.from_bytes(raw[offset + 1:offset + 3], 'big')
        end = offset + 1 + length
        require(length >= 2 and end < len(raw), 'Truncated JPEG segment')
        if marker in (0xc0, 0xc2):
            require(length >= 8 and raw[offset + 3] == 8, 'Unsupported JPEG frame')
            height = int.from_bytes(raw[offset + 4:offset + 6], 'big')
            width = int.from_bytes(raw[offset + 6:offset + 8], 'big')
            size = (width, height)
        elif marker == 0xda and size:
            return size
        offset = end
    raise ValueError('Missing JPEG frame or scan')


class PhotoClient:
    """One sequential limiter for both official origins, including robots requests."""
    def __init__(self, session, clock=time.monotonic, sleep=time.sleep):
        self.session = session
        self.session.headers['User-Agent'] = USER_AGENT
        self.clock, self.sleep = clock, sleep
        # Also leave a delay before the first request after a resumed invocation.
        self.last = self.clock()
        self.delay = CRAWL_DELAY_SECONDS
        self.robots = {}

    def _request(self, url, limit, allow_missing=False):
        self.sleep(max(0, self.delay - (self.clock() - self.last)))
        self.last = self.clock()
        with self.session.get(url, timeout=30, allow_redirects=False, stream=True) as response:
            if allow_missing and response.status_code in (404, 410):
                return b'', ''
            require(response.status_code == 200, f'Unexpected HTTP {response.status_code}: {url}')
            chunks = bytearray()
            for chunk in response.iter_content(8192):
                chunks.extend(chunk)
                require(len(chunks) <= limit, f'Response exceeds {limit} bytes: {url}')
            mime = response.headers.get('Content-Type', '').split(';')[0].strip().lower()
            return bytes(chunks), mime

    def _read(self, url, limit, mime):
        origin = 'https://' + urlsplit(url).netloc
        if origin not in self.robots:
            raw, kind = self._request(origin + '/robots.txt', 128 * 1024,
                                      allow_missing=origin == MEDIA)
            require(not raw or kind == 'text/plain', f'Unexpected robots.txt type: {origin}')
            robots = RobotFileParser()
            robots.parse(_decode(raw, origin).splitlines())
            self.delay = max(self.delay, robots.crawl_delay(USER_AGENT) or 0)
            self.robots[origin] = robots
        require(self.robots[origin].can_fetch(USER_AGENT, url), f'robots.txt disallows {url}')
        raw, kind = self._request(url, limit)
        require(kind == mime, f'Unexpected response type {kind}: {url}')
        return raw

    def profile(self, url):
        require(official_player_id(url) is not None, 'Unknown CFU profile URL')
        return _decode(self._read(url, 2 * 1024 * 1024, 'text/html'), url)

    def image(self, url):
        require(PHOTO_URL_RE.fullmatch(url), 'Unknown CFU portrait URL')
        raw = self._read(url, MAX_IMAGE_BYTES, 'image/jpeg')
        require(all(32 <= dimension <= 512 for dimension in jpeg_size(raw)),
                'JPEG dimensions outside the accepted range')
        return raw


def audit_player(player, client):
    source_url = player['sourceUrl']
    result = {'sourceUrl': source_url, 'checkedAt': _utc_now()}
    try:
        result.update(parse_profile(client.profile(source_url), source_url, player['sourcePlayerId']))
        if result['status'] == 'found':
            raw = client.image(result['imageUrl'])
            result.update(status='verified', sha256=hashlib.sha256(raw).hexdigest())
    except (ValueError, requests.RequestException) as exc:
        result.update(status='load_error', reason=str(exc))
    return result


def ambiguous_ids(records, players=None):
    ids_by_image = defaultdict(set)
    known_photos = ((key, player['photo']) for key, player in (players or {}).items()
                    if 'photo' in player)
    for collection in (records.items(), known_photos):
        for key, record in collection:
            for field in ('imageUrl', 'sha256'):
                if record.get(field):
                    ids_by_image[field, record[field]].add(key)
    return {key for ids in ids_by_image.values() if len(ids) > 1 for key in ids}


def approved_photo(player, record, permission):
    if record.get('status') != 'verified' or not isinstance(permission, dict):
        return None
    evidence = permission.get('permission')
    if not isinstance(evidence, str) or not evidence.strip():
        return None
    if any(permission.get(key) != record.get(key) for key in ('imageUrl', 'sha256')):
        return None
    photo = {key: record.get(key) for key in ('sourceUrl', 'imageUrl', 'sha256')}
    photo['status'] = 'approved'
    return photo if valid_player_photo(photo, player['sourcePlayerId']) else None


def candidates(players, records, permissions, ambiguous):
    return {key: photo for key, player in players.items() if key not in ambiguous
            if (photo := approved_photo(player, records.get(key, {}), permissions.get(key)))}


def report(players, records, permissions):
    checked = {key: records[key] for key in players if key in records}
    duplicates = ambiguous_ids(records, players)
    permitted = candidates(players, checked, permissions, duplicates)
    counts = Counter('ambiguous' if key in duplicates else record['status']
                     for key, record in checked.items())
    published = {key for key, player in players.items() if 'photo' in player}
    return {
        'players': len(players),
        'checked': len(checked),
        'unchecked': len(players) - len(checked),
        'found': sum(bool(record.get('imageUrl')) for record in checked.values()),
        'verified': sum(record['status'] == 'verified' for record in checked.values()),
        'approved': len(set(permitted) | published),
        'inSnapshot': len(published),
        'withoutPhotoInSnapshot': len(players) - len(published),
        'missing': counts['missing'],
        'placeholder': counts['placeholder'],
        'loadErrors': sum(record['status'] == 'load_error' for record in checked.values()),
        'ambiguous': counts['ambiguous'],
        'rejectedUrls': counts['rejected_url'],
        'rightsUnconfirmed': sum(key not in permitted and key not in published
                                 and record['status'] == 'verified'
                                 for key, record in checked.items()),
    }


def pending_ids(players, records, ids, recheck, retry_failed):
    selected = ids or players
    return [key for key in selected if key not in records or recheck
            or (retry_failed and records[key]['status'] == 'load_error')]


def asset_path(player, photo, directory=ASSETS):
    return directory / player['sourcePlayerId'] / (photo['sha256'] + '.jpg')


def stage_photos(players, photos, client, directory=ASSETS):
    for key, photo in photos.items():
        player = players[key]
        path = asset_path(player, photo, directory)
        try:
            raw = path.read_bytes() if path.is_file() else b''
            if hashlib.sha256(raw).hexdigest() != photo['sha256']:
                raw = client.image(photo['imageUrl'])
                require(hashlib.sha256(raw).hexdigest() == photo['sha256'],
                        'Portrait bytes changed after verification')
                _write_atomic(path, raw)
            player['photo'] = photo
        except (ValueError, OSError, requests.RequestException) as exc:
            print(f'{key}: retained existing photo metadata ({exc})')


def _read_json(path):
    if path is None or not path.exists():
        return {}
    return json.loads(path.read_text(encoding='utf-8'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, default=Path('_state/cfu-player-photos/audit.json'))
    parser.add_argument('--ids', nargs='+', help='Official numeric player IDs')
    parser.add_argument('--limit', type=int, choices=range(1, 11), default=3)
    parser.add_argument('--retry-failed', action='store_true')
    parser.add_argument('--recheck', action='store_true', help='Audit selected IDs again')
    parser.add_argument('--report-only', action='store_true')
    parser.add_argument('--permissions', type=Path, help='Per-ID URL, SHA-256 and evidence of permission')
    parser.add_argument('--publish', action='store_true', help='Stage approved assets and roster metadata locally')
    args = parser.parse_args()
    if args.recheck and not args.ids:
        parser.error('--recheck requires --ids')
    if args.publish and (not args.permissions or not args.permissions.is_file() or args.report_only):
        parser.error('--publish requires a permissions file and cannot use --report-only')
    snapshot = load_rosters(SNAPSHOT)
    players = snapshot['playersById']
    ids = [f'cfu:player:{source_id}' for source_id in args.ids or []]
    if len(set(ids)) != len(ids) or any(key not in players for key in ids):
        parser.error('--ids must contain distinct official IDs from the roster snapshot')
    permissions = _read_json(args.permissions)

    args.state.parent.mkdir(parents=True, exist_ok=True)
    with args.state.with_suffix(args.state.suffix + '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        records = _read_json(args.state)
        with requests.Session() as session:
            client = PhotoClient(session)
            if args.publish:
                previous = load_rosters(ARCHIVE)
                if previous != snapshot:
                    parser.error('The roster snapshots must match before staging')
                photos = candidates(players, records, permissions, ambiguous_ids(records, players))
                selected = {key: photos[key] for key in ids or photos if key in photos}
                pending = {key: photo for key, photo in selected.items()
                           if players[key].get('photo') != photo
                           or not asset_path(players[key], photo).is_file()}
                stage_photos(players, dict(list(pending.items())[:args.limit]), client)
                if previous != snapshot:
                    require(load_rosters(SNAPSHOT) == previous and load_rosters(ARCHIVE) == previous,
                            'Rosters changed while staging portraits, rerun with the new snapshot')
                    write_rosters(snapshot, ARCHIVE, SNAPSHOT)
            elif not args.report_only:
                for key in pending_ids(players, records, ids, args.recheck, args.retry_failed)[:args.limit]:
                    records[key] = audit_player(players[key], client)
                    _write_atomic(args.state, _payload(records))
        print(json.dumps(report(players, records, permissions), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
