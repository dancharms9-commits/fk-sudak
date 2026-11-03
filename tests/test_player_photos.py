"""Only a portrait belonging to the exact official player profile is accepted."""
from pathlib import Path
import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup

from update_player_stats import (fetch_one_player, parse_profile_photo,
                                 safe_photo_url, valid_stat_fields)

PROFILE = 'https://rffk-roo.ru/players/202/'
PHOTO = 'https://rffk-roo.ru/uploads/people/large/DGIaYmPn.jpg'


def fixture():
    path = Path(__file__).parent / 'fixtures' / 'player-202.html'
    return BeautifulSoup(path.read_text(encoding='utf-8'), 'html.parser')


class PlayerPhotoTests(unittest.TestCase):
    def test_real_portrait_and_identity(self):
        self.assertEqual(parse_profile_photo(fixture(), 'Донской Илья', PROFILE),
                         {'photo_url': PHOTO, 'photo_source_url': PROFILE})
        self.assertEqual(parse_profile_photo(fixture(), 'Донской Игорь', PROFILE), {})
        soup = fixture()
        soup.select_one('img')['alt'] = 'Другой человек'
        self.assertEqual(parse_profile_photo(soup, 'Донской Илья', PROFILE), {})

    def test_no_image_generic_avatar_logo_and_external_host(self):
        for value in ['https://evil.example/uploads/people/large/photo.jpg',
                      'https://rffk-roo.ru/assets/images/logo.png',
                      'https://rffk-roo.ru/uploads/people/large/no_photo.jpg',
                      'https://rffk-roo.ru/uploads/people/large/default.png',
                      PHOTO+'?redirect=1', PHOTO+'#fake', PHOTO.replace('https:', 'http:')]:
            with self.subTest(value=value):
                soup = fixture()
                soup.select_one('img')['src'] = value
                self.assertIsNone(safe_photo_url(value))
                self.assertEqual(parse_profile_photo(soup, 'Донской Илья', PROFILE), {})
        soup = fixture()
        soup.select_one('img').decompose()
        self.assertEqual(parse_profile_photo(soup, 'Донской Илья', PROFILE), {})

    def test_multiple_images_are_ambiguous(self):
        soup = fixture()
        soup.select_one('.player-data__image').append(soup.select_one('img').__copy__())
        self.assertEqual(parse_profile_photo(soup, 'Донской Илья', PROFILE), {})

    def test_saved_stats_retain_verified_portrait_only_for_same_profile(self):
        item = dict(league_games=14, league_goals=5, league_penalty_goals=0,
                    league_minutes=1051, league_starts=13, league_substitutions=1,
                    profile_url=PROFILE, photo_url=PHOTO, photo_source_url=PROFILE)
        self.assertEqual(valid_stat_fields(item, 16, 63), item)
        wrong = {**item, 'photo_source_url': 'https://rffk-roo.ru/players/999/'}
        result = valid_stat_fields(wrong, 16, 63)
        self.assertNotIn('photo_url', result)
        self.assertEqual(result['league_goals'], 5)

    @patch('update_player_stats.parse_profile_stats')
    @patch('update_player_stats.fetch_html')
    def test_photo_enrichment_does_not_change_league_stats(self, fetch, stats):
        fetch.return_value = fixture()
        numbers = dict(league_games=14, league_goals=5, league_penalty_goals=0,
                       league_minutes=1051, league_starts=13, league_substitutions=1)
        stats.return_value = numbers.copy()
        name, result = fetch_one_player('Донской Илья', PROFILE, 16, 63)
        self.assertEqual(name, 'Донской Илья')
        self.assertEqual({k: result[k] for k in numbers}, numbers)
        self.assertEqual(result['photo_url'], PHOTO)
        stats.return_value = None
        self.assertEqual(fetch_one_player('Донской Илья', PROFILE, 16, 63), ('Донской Илья', None))


if __name__ == '__main__':
    unittest.main()
