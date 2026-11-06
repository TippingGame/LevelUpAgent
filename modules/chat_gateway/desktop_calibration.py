"""Image geometry shared by all manually calibrated desktop applications."""
from desktop_core import matching_route, normalized, title_matches


def conversation_title_rows(lines, routes=()):
    """Separate name headings from close, aligned message-preview lines.

    Work in OCR text-height units, not fixed screen coordinates. Keep uncertain
    rows: a duplicate heading must still prevent choosing the wrong person.
    """
    rows = sorted((r for r in lines if r.get('confidence', 0) >= .80), key=lambda r: (r['y'], r['x']))
    headings = []
    for row in rows:
        previous = next((r for r in reversed(headings)
                         if abs(r['x'] - row['x']) <= max(r['h'], row['h']) * .8), None)
        if previous:
            distance = row['y'] + row['h']/2 - previous['y'] - previous['h']/2
            # A preview sits just below its heading; separate list items need
            # a larger gap. Do not merge overlapping OCR fragments.
            could_be_same_name = any(title_matches(previous['text'], r['chatId']) and title_matches(row['text'], r['chatId']) for r in routes)
            exact_registered_name = any(normalized(row['text']).casefold() == normalized(r['chatId']).casefold() for r in routes)
            smaller_preview = row['h'] < previous['h']*.85
            if ((not could_be_same_name or smaller_preview) and not exact_registered_name and normalized(row['text']) != normalized(previous['text'])
                    and row['h'] <= previous['h']*1.15
                    and max(previous['h'], row['h']) * .7 < distance <= previous['h'] * 1.6):
                continue
        headings.append(row)
    return headings


def notification_entry(image, layout, read, application='custom'):
    """Resolve one clickable entry; never click the center of a menu rail.

    Compact user selections work for any app. For an old, broad DingTalk
    selection, a unique Messages label can safely narrow both click and badge
    inspection. DING/OA badges cannot trigger navigation through that label.
    """
    area = layout['notification']
    x1, y1, x2, y2 = [int(v * (image.width if i % 2 == 0 else image.height)) for i, v in enumerate(area)]
    crop = image.crop((x1, y1, x2, y2))
    lines = [r for r in read(crop) if r.get('confidence', 0) >= .8]
    sidebar = layout['sidebar']
    overlap = max(0, min(area[2], sidebar[2])-max(area[0], sidebar[0])) * max(0, min(area[3], sidebar[3])-max(area[1], sidebar[1]))
    if overlap > (area[2]-area[0])*(area[3]-area[1])*.8:
        return dict(box=None, unread=False, detail='消息入口框位于会话栏内；仅检查会话红点，不点击此区域')
    labels = [r for r in lines if normalized(r['text']).casefold().replace(' ', '') in ('消息', 'messages', 'chats')]
    if application == 'dingtalk' and len(labels) == 1:
        row = labels[0]
        cy = row['y'] + row['h']/2
        half = max(8, row['h']*1.1)
        # Bound the badge band by adjacent text rows so a nearby DING badge
        # cannot be attributed to Messages in a tightly spaced navigation rail.
        centers = [r['y']+r['h']/2 for r in lines if r is not row and not normalized(r['text']).rstrip('+').isdigit()]
        top = max([cy-half] + [(cy+c)/2 for c in centers if c < cy-row['h']*.5])
        bottom = min([cy+half] + [(cy+c)/2 for c in centers if c > cy+row['h']*.5])
        band = crop.crop((0, max(0, int(top)), crop.width, min(crop.height, int(bottom))))
        box = [(x1+row['x'])/image.width, (y1+row['y'])/image.height,
               (x1+row['x']+row['w'])/image.width, (y1+row['y']+row['h'])/image.height]
        return dict(box=box, unread=bool(red_badges(band)), detail='已定位单个消息入口；忽略 DING、审批等其他入口红点')
    compact = crop.height <= max(48, image.height*.16) and crop.width <= max(200, image.width*.3)
    labels = [r for r in lines if not normalized(r['text']).rstrip('+').isdigit()]
    multiple = any(abs(a['y']+a['h']/2-b['y']-b['h']/2) > max(a['h'], b['h'])*1.7
                   for a in labels for b in labels)
    if not compact or multiple:
        return dict(box=None, unread=False, detail='消息入口框包含多个菜单或范围过大，已停止入口点击；请只框单个「消息」按钮，不要框整列菜单')
    return dict(box=list(area), unread=bool(red_badges(crop)), detail='使用框选的单个消息入口；点击框中心')


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
            # Badge corners may overlap a dark avatar. Inspect the center for
            # dark icon detail, not the background outside the rounded dot.
            inset = max(2, min(w, h)//5)
            inner = pixels[y+inset:y+h-inset, x+inset:x+w-inset]
            if (inner.max(axis=2) < 130).mean() > .025:
                continue  # Dark icon detail differs from a dot/white number.
            result.append(dict(x=x, y=y, w=w, h=h))
    return sorted(result, key=lambda b: (b['y'], b['x']))


def conversation_candidates(lines, badges, routes):
    """Associate badges with title rows; never use preview-text substring hits.

    A badge's center aligns with the title or lies a little above it (avatar
    corner). A candidate also needs a unique name among registered routes.
    """
    lines = conversation_title_rows(lines, routes)
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
