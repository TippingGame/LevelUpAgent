"""Image geometry shared by all manually calibrated desktop applications."""
from desktop_core import matching_route, normalized, title_matches


def red_badges(image):
    """Compact red/orange components, independent of absolute screen position.

    Rounded dots and number pills qualify. Large avatars, flat lines and text
    fragments do not. Callers only inspect the user's calibrated badge regions.
    """
    import cv2
    import numpy as np
    pixels = np.asarray(image.convert('RGB')).astype('int16')
    r, g, b = (pixels[:, :, i] for i in range(3))
    mask = ((r > 175) & (r - g > 55) & (r - b > 65)).astype('uint8')
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    result = []
    for x, y, w, h, count in stats[1:]:
        x, y, w, h, count = map(int, (x, y, w, h, count))
        if 6 <= h <= 36 and 6 <= w <= 64 and .55 <= w/h <= 3.5 and .48 <= count/(w*h) <= .94:
            component = mask[y:y+h, x:x+w]
            edge = max(1, h//6)
            if abs(component[:edge].mean() - component[-edge:].mean()) > .18:
                continue  # Speech icon tails and irregular avatar fragments.
            inner = pixels[y+1:y+h-1, x+1:x+w-1]
            if (inner.max(axis=2) < 130).mean() > .025:
                continue  # Dark icon detail differs from a dot/white number.
            result.append(dict(x=x, y=y, w=w, h=h))
    return sorted(result, key=lambda b: (b['y'], b['x']))


def conversation_candidates(lines, badges, routes):
    """Associate badges with title rows; never use preview-text substring hits.

    A badge's center aligns with the title or lies a little above it (avatar
    corner). A candidate also needs a unique name among registered routes.
    """
    candidates = []
    for badge in badges:
        cy = badge['y'] + badge['h']/2
        rows = [r for r in lines if r.get('confidence', 0) >= .80
                and -max(8, r['h']*.5) <= r['y']+r['h']/2-cy <= max(18, r['h']*1.35)]
        for row in rows:
            route = matching_route(row['text'], routes)
            if route:
                candidates.append((route, row))
    # Duplicate names in distinct rows are ambiguous even with just one unread.
    result = []
    for route, row in candidates:
        matches = [r for r in lines if r.get('confidence', 0) >= .80 and title_matches(r['text'], route['chatId'])]
        distinct = []
        for r in matches:
            if not any(abs(r['y']-other['y']) < max(r['h'], other['h']) for other in distinct):
                distinct.append(r)
        if len(distinct) == 1 and not any(item[0] == route for item in result):
            result.append((route, row))
    return result
