"""Shared cutout preparation for shape and texture; no model downloads."""
from PIL import Image, ImageChops, ImageDraw, ImageOps


def prepare_reference(image, background):
    image = image.convert('RGBA')
    image.thumbnail((2048, 2048))
    alpha = image.getchannel('A')
    method = 'existing-alpha'
    if alpha.getextrema()[0] >= 250:
        if background != 'white':
            raise ValueError('请使用透明 PNG，或选择白底图模式。')
        red, green, blue = image.convert('RGB').split()
        low = ImageChops.darker(ImageChops.darker(red, green), blue)
        high = ImageChops.lighter(ImageChops.lighter(red, green), blue)
        bright = low.point(lambda value: 255 if value >= 220 else 0)
        neutral = ImageChops.subtract(high, low).point(lambda value: 255 if value <= 24 else 0)
        candidates = ImageChops.multiply(bright, neutral)
        # Padding connects all image edges. Only near-white pixels connected to
        # the exterior are background; enclosed face/highlights/clothes survive.
        flood = ImageOps.expand(candidates, border=1, fill=255)
        ImageDraw.floodfill(flood, (0, 0), 128)
        exterior = flood.crop((1, 1, image.width + 1, image.height + 1))
        foreground = exterior.point(lambda value: 0 if value == 128 else 255)
        alpha = ImageChops.multiply(alpha, foreground)
        image.putalpha(alpha)
        method = 'border-connected-near-white-v2'
    visible = alpha.point(lambda value: 255 if value > 8 else 0)
    count = visible.histogram()[255]
    if not count or count >= image.width * image.height * .99:
        raise ValueError('没有检测到清晰主体；请先去除背景。')
    cutout = image.crop(visible.getbbox())
    side = int(max(cutout.size) * 1.2)
    canvas = Image.new('RGBA', (side, side), (255, 255, 255, 0))
    canvas.paste(cutout, ((side - cutout.width) // 2, (side - cutout.height) // 2))
    return canvas, {'method': method, 'background': background, 'implementationVersion': 2}
