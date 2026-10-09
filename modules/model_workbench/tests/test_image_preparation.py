from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageDraw
from app.image_preparation import prepare_reference


class ReferenceTest(unittest.TestCase):
    def test_white_background_keeps_enclosed_skin_and_highlights(self):
        image = Image.new('RGB', (100, 100), (240, 239, 242))
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 10, 79, 89), fill=(45, 35, 70))
        draw.rectangle((30, 20, 69, 79), fill=(255, 250, 245))
        draw.rectangle((40, 30, 59, 39), fill='white')
        result, info = prepare_reference(image, 'white')
        cutout = result.crop(result.getchannel('A').getbbox())
        self.assertEqual(cutout.size, (60, 80))
        self.assertEqual(cutout.getpixel((25, 25)), (255, 255, 255, 255))
        self.assertEqual(cutout.getpixel((15, 45)), (255, 250, 245, 255))
        self.assertEqual(result.getpixel((0, 0))[3], 0)
        self.assertEqual(info['implementationVersion'], 2)

    def test_existing_alpha_preserves_soft_edges_and_rgb(self):
        image = Image.new('RGBA', (100, 100), (0, 255, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 10, 79, 89), fill=(240, 235, 225, 128))
        result, info = prepare_reference(image, 'white')
        self.assertEqual(result.getpixel((result.width//2, result.height//2)), (240, 235, 225, 128))
        self.assertEqual(info['method'], 'existing-alpha')

    def test_rejects_empty_and_opaque_non_background(self):
        for image, mode in [(Image.new('RGBA', (64, 64), (0, 0, 0, 0)), 'alpha'),
                            (Image.new('RGB', (64, 64), 'white'), 'white'),
                            (Image.new('RGB', (64, 64), 'red'), 'alpha'),
                            (Image.new('RGB', (64, 64), 'red'), 'white')]:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                prepare_reference(image, mode)
