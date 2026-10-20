"""Windows DingTalk desktop transport: local OCR/UIA, no platform API.

Coordinates are calibrated fractions of the selected window. Never accepts a
target executable from a chat. Windows bindings are imported only at runtime.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import io
import os
import time
from pathlib import Path

from desktop_core import Bubble, normalized, title_matches


class DesktopUnavailable(RuntimeError):
    pass


class DesktopDeferred(DesktopUnavailable):
    """Temporary human interaction, eligible for retry only before input."""


def text_bubbles(image, lines):
    """Only OCR inside a mostly uniform, distinct chat bubble is eligible.

    Detect the bubble background component around text. This discards labels,
    timestamps and most image/sticker text instead of treating every OCR word
    as a message. Unrecognized themes fail closed and require preview review.
    """
    import cv2
    import numpy as np
    pixels = np.asarray(image.convert('RGB'))
    height, width = pixels.shape[:2]
    canvas = np.median(pixels.reshape(-1, 3), axis=0)
    groups = {}
    for row in lines:
        if row.get('confidence', 0) < .9:
            continue
        x, y = int(row['x']), int(row['y'])
        right, bottom = int(row['x'] + row['w']), int(row['y'] + row['h'])
        if x < 4 or y < 4 or right > width-4 or bottom > height-4:
            continue
        probes = [(x-3, (y+bottom)//2), (right+3, (y+bottom)//2), ((x+right)//2, y-3), ((x+right)//2, bottom+3)]
        color = np.median([pixels[py, px] for px, py in probes], axis=0)
        if max(abs(color-canvas)) < 9:
            continue  # Plain sender labels and watermarks have the page background.
        mask = (np.max(np.abs(pixels.astype(np.int16)-color), axis=2) < 9).astype('uint8')
        seed = next(((px, py) for px, py in probes if mask[py, px]), None)
        if seed is None:
            continue
        count, _, _, rect = cv2.floodFill(mask, None, seed, 2)
        bx, by, bw, bh = rect
        if not (bx <= x and by <= y and bx+bw >= right and by+bh >= bottom):
            continue
        if bx <= 1 or by <= 1 or bx+bw >= width-1 or by+bh >= height-1 or bw < 22 or bh < 22:
            continue  # A clipped bubble cannot be compared safely across viewports.
        if count / (bw*bh) < .68 or bh > height*.85:
            continue  # Textured photo/sticker/card rather than a plain text bubble.
        if bx < width*.20 and bx+bw < width*.90:
            side = 'incoming'
        elif bx+bw > width*.85 and bx > width*.15:
            side = 'outgoing'
        else:
            continue
        key = (bx, by, bw, bh, side)
        groups.setdefault(key, []).append(row)
    result = []
    for key, rows in sorted(groups.items(), key=lambda item: item[0][1]):
        text = '\n'.join(normalized(r['text']) for r in sorted(rows, key=lambda r:(r['y'],r['x'])))
        if text:
            result.append(Bubble(text, key[4]))
    return result


def bubble_regions(image, *, include_actions=False):
    """Find complete, plain bubble bodies inside a calibrated message viewport.

    Avatar rails, nested icons, clipped shapes and textured images are excluded.
    With include_actions, one bounded footer separator is returned as a sixth
    item for further OCR verification; this alone never makes a card eligible.
    """
    import cv2
    import numpy as np
    pixels = np.asarray(image.convert('RGB'))
    height, width = pixels.shape[:2]
    canvas = np.median(pixels.reshape(-1, 3), axis=0)
    mask = (np.max(np.abs(pixels.astype(np.int16) - canvas), axis=2) > 9).astype('uint8')
    scale = max(.5, min(3, width / 800))
    # A scaled separator can equal the canvas color and disconnect one card
    # into two rectangles. Bridge only thin vertical gaps before classification.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((max(3, round(3*scale)), 1), dtype='uint8'))
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    candidates = []
    rail = max(30, min(80, width * .075))
    for x, y, w, h, count in stats[1:]:
        x, y, w, h, count = map(int, (x, y, w, h, count))
        if w < 22 or h < 24 or count / (w*h) < .78 or h > height * .90:
            continue
        if x < rail or x+w > width-rail or y <= 0 or y+h >= height:
            continue
        if x < width * .20 and x+w < width * .93:
            side = 'incoming'
        elif x+w > width * .80 and x > width * .15:
            side = 'outgoing'
        else:
            continue
        candidates.append((x, y, w, h, side))
    result = []
    for x, y, w, h, side in candidates:
        if any(ox <= x and oy <= y and ox+ow >= x+w and oy+oh >= y+h
               and (ow > w or oh > h) for ox, oy, ow, oh, _ in candidates):
            continue
        body = pixels[y:y+h, x:x+w]
        background = np.median(body.reshape(-1, 3), axis=0)
        # Reject saturated avatar/icon fills and mostly photographic content.
        if max(background)-min(background) > 105:
            continue
        delta = np.max(np.abs(body.astype(np.int16)-background), axis=2)
        if (delta < 9).mean() < .72:
            continue
        inset = max(5, min(12, w//8))
        interior = delta[8:-8, inset:-inset]
        separators = np.flatnonzero((interior > 5).mean(axis=1) > .86) + 8 if interior.size else []
        footer = None
        if len(separators):
            # DingTalk's real @ message has a 收到 / 回复 footer. Only expose
            # its geometry here; exact action labels and mention text are
            # checked below. Other divided cards continue to be excluded.
            if (not include_actions or side != 'incoming' or w < 140*scale
                    or separators[-1]-separators[0] > max(2, 2*scale)
                    or separators[0] < 32*scale or not 28*scale <= h-separators[-1] <= 64*scale):
                continue
            footer = int(separators[0])
        result.append((x, y, w, h, side, footer) if include_actions else (x, y, w, h, side))
    return sorted(result, key=lambda item: (item[1], item[0]))


def action_card_rows(body, footer, read, padding=12):
    """OCR the blue @ badge separately so OCR cannot join name and sentence.

    Only the observed leading badge style is split. Unknown/multiple badges fail
    closed; this is visual parsing and does not authenticate platform metadata.
    """
    import cv2
    import numpy as np
    from PIL import ImageOps, ImageDraw
    pixels = np.asarray(body.convert('RGB'))
    blue = ((pixels[:, :, 2] > 150) & (pixels[:, :, 0] < 80)
            & (pixels[:, :, 1] > 65) & (pixels[:, :, 1] < 200)).astype('uint8')
    _, _, stats, _ = cv2.connectedComponentsWithStats(blue, 8)
    badges = [(int(x), int(y), int(w), int(h)) for x, y, w, h, count in stats[1:]
              if w >= 25 and h >= 12 and count/(w*h) > .5 and y+h < footer]
    if not badges:
        return read(ImageOps.expand(body, border=padding, fill=(240, 242, 244)))
    if len(badges) != 1:
        return []
    x, y, w, h = badges[0]
    if not (x < body.width*.18 and y < footer*.4 and w > h*1.2):
        return []
    chip = ImageOps.expand(body.crop((x, y, x+w, y+h)), border=padding, fill='white')
    labels = read(chip)
    if len(labels) != 1 or labels[0].get('confidence', 0) < .97:
        return []
    label = normalized(labels[0]['text'])
    if not label.startswith('@') or len(label) < 2:
        return []
    remainder = body.copy()
    background = tuple(int(v) for v in np.median(pixels.reshape(-1, 3), axis=0))
    ImageDraw.Draw(remainder).rectangle((max(0,x-1),max(0,y-1),min(body.width-1,x+w),min(body.height-1,y+h)),fill=background)
    rows = read(ImageOps.expand(remainder, border=padding, fill=(240, 242, 244)))
    return rows + [dict(text=label, confidence=labels[0]['confidence'], x=x+padding, y=y+padding, w=w, h=h)]


def aligned_ocr_text(rows, width):
    """Join adjacent fragments by line, rejecting separated card columns."""
    if not rows or any(r.get('confidence',0) < .90 for r in rows):
        return None
    lines=[]
    for row in sorted(rows,key=lambda r:(r['y']+r['h']/2,r['x'])):
        center=row['y']+row['h']/2
        if lines and abs(center-lines[-1][0]) <= min(row['h'],lines[-1][1])*.4:
            lines[-1][2].append(row)
        else:
            lines.append([center,row['h'],[row]])
    texts=[];left_edges=[]
    for _,_,fragments in lines:
        fragments.sort(key=lambda r:r['x']);left_edges.append(fragments[0]['x'])
        for before,after in zip(fragments,fragments[1:]):
            gap=after['x']-before['x']-before['w']
            if gap < -min(before['h'],after['h'])*.6 or gap > max(before['h'],after['h'])*1.5:
                return None
        texts.append(' '.join(normalized(r['text']) for r in fragments))
    if max(left_edges)-min(left_edges)>max(18,width*.10):
        return None
    return '\n'.join(texts)


def mention_action_text(rows, width, footer, padding=12):
    """Read the known @ card, excluding its two action buttons from content.

    This recognizes a visual style, not authenticated platform mention metadata.
    Unknown footers, uncertain OCR, overlapping fragments and columns fail closed.
    """
    if not rows or any(r.get('confidence', 0) < .90 for r in rows):
        return None
    divider = footer + padding
    body = [r for r in rows if r['y'] + r['h'] < divider]
    actions = sorted((r for r in rows if r['y'] > divider), key=lambda r: r['x'])
    if not body or len(body)+len(actions) != len(rows) or len(actions) != 2:
        return None
    if [normalized(r['text']) for r in actions] != ['收到', '回复']:
        return None
    centers = [(r['x']+r['w']/2-padding)/width for r in actions]
    if not (.15 <= centers[0] <= .45 and .60 <= centers[1] <= .90):
        return None
    if abs((actions[0]['y']+actions[0]['h']/2)-(actions[1]['y']+actions[1]['h']/2)) > min(r['h'] for r in actions)*.4:
        return None
    lines = []
    for row in sorted(body, key=lambda r: (r['y']+r['h']/2, r['x'])):
        center = row['y']+row['h']/2
        if lines and abs(center-lines[-1][0]) <= min(row['h'], lines[-1][1])*.4:
            lines[-1][2].append(row)
        else:
            lines.append([center, row['h'], [row]])
    result = []
    left_edges = []
    for _, _, fragments in lines:
        fragments.sort(key=lambda r: r['x'])
        left_edges.append(fragments[0]['x'])
        for before, after in zip(fragments, fragments[1:]):
            gap = after['x']-before['x']-before['w']
            if gap < -2 or gap > max(before['h'], after['h'])*1.5:
                return None
        result.append(' '.join(normalized(r['text']) for r in fragments))
    if max(left_edges)-min(left_edges) > max(18, width*.10):
        return None
    text = '\n'.join(result)
    return text if text.startswith('@') else None


class WindowsDesktop:
    def __init__(self):
        if os.name != 'nt':
            raise DesktopUnavailable('Windows only')
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.gdi = ctypes.WinDLL('gdi32', use_last_error=True)
        self._bind()
        self.ocr = None
        self.auto_input = None
        self.stopped = lambda: False
        # Each process uses physical pixels throughout; never multiply guessed DPI.
        try:
            self.user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except (AttributeError, OSError):
            pass

    def _bind(self):
        for dll, name, args, result in [
            (self.user, 'GetForegroundWindow', [], wintypes.HWND),
            (self.user, 'IsWindow', [wintypes.HWND], wintypes.BOOL),
            (self.user, 'IsWindowVisible', [wintypes.HWND], wintypes.BOOL),
            (self.user, 'IsIconic', [wintypes.HWND], wintypes.BOOL),
            (self.user, 'GetWindowRect', [wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
            (self.user, 'GetWindowThreadProcessId', [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
            (self.user, 'GetWindowTextW', [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
            (self.user, 'GetDC', [wintypes.HWND], wintypes.HDC),
            (self.user, 'ReleaseDC', [wintypes.HWND, wintypes.HDC], ctypes.c_int),
            (self.user, 'PrintWindow', [wintypes.HWND, wintypes.HDC, wintypes.UINT], wintypes.BOOL),
            (self.user, 'SetForegroundWindow', [wintypes.HWND], wintypes.BOOL),
            (self.user, 'OpenInputDesktop', [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            (self.user, 'CloseDesktop', [wintypes.HANDLE], wintypes.BOOL),
            (self.user, 'GetUserObjectInformationW', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            (self.user, 'GetLastInputInfo', [ctypes.c_void_p], wintypes.BOOL),
            (self.user, 'SetCursorPos', [ctypes.c_int, ctypes.c_int], wintypes.BOOL),
            (self.user, 'GetCursorPos', [ctypes.POINTER(wintypes.POINT)], wintypes.BOOL),
            (self.user, 'WindowFromPoint', [wintypes.POINT], wintypes.HWND),
            (self.user, 'GetAncestor', [wintypes.HWND, wintypes.UINT], wintypes.HWND),
            (self.user, 'mouse_event', [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t], None),
            (self.kernel, 'GetTickCount', [], wintypes.DWORD),
            (self.kernel, 'OpenProcess', [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            (self.kernel, 'CloseHandle', [wintypes.HANDLE], wintypes.BOOL),
            (self.kernel, 'QueryFullProcessImageNameW', [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            (self.gdi, 'CreateCompatibleDC', [wintypes.HDC], wintypes.HDC),
            (self.gdi, 'CreateCompatibleBitmap', [wintypes.HDC, ctypes.c_int, ctypes.c_int], wintypes.HBITMAP),
            (self.gdi, 'SelectObject', [wintypes.HDC, wintypes.HANDLE], wintypes.HANDLE),
            (self.gdi, 'DeleteObject', [wintypes.HANDLE], wintypes.BOOL),
            (self.gdi, 'DeleteDC', [wintypes.HDC], wintypes.BOOL),
        ]:
            function = getattr(dll, name)
            function.argtypes, function.restype = args, result

    def windows(self):
        result = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(hwnd, _):
            if not self.user.IsWindowVisible(hwnd):
                return True
            pid = wintypes.DWORD()
            self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            process = self.kernel.OpenProcess(0x1000, False, pid.value)
            if not process:
                return True
            try:
                size = wintypes.DWORD(32768)
                path = ctypes.create_unicode_buffer(size.value)
                if not self.kernel.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(size)):
                    return True
                if Path(path.value).name.lower() not in ('dingtalk.exe', 'dingding.exe', 'dingtalkapp.exe'):
                    return True
                title = ctypes.create_unicode_buffer(1024)
                self.user.GetWindowTextW(hwnd, title, len(title))
                if not title.value.strip():
                    return True  # DingTalk's large transparent shadow is not a chat window.
                rect = self.rect(hwnd)
                if rect[2] < 600 or rect[3] < 400:
                    return True
                result.append(dict(handle=int(hwnd), title=title.value, width=rect[2], height=rect[3], minimized=bool(self.user.IsIconic(hwnd))))
            finally:
                self.kernel.CloseHandle(process)
            return True
        callback = callback_type(visit)
        self.user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
        self.user.EnumWindows.restype = wintypes.BOOL
        self.user.EnumWindows(callback, 0)
        return result

    def find(self, title):
        windows = [w for w in self.windows() if w['title'] == title]
        if len(windows) != 1:
            raise DesktopUnavailable('未找到唯一钉钉窗口，请打开并重新选择窗口')
        if windows[0]['minimized']:
            raise DesktopUnavailable('钉钉已最小化，请还原窗口')
        return windows[0]['handle']

    def rect(self, hwnd):
        rect = wintypes.RECT()
        if not self.user.GetWindowRect(hwnd, ctypes.byref(rect)):
            raise DesktopUnavailable('窗口已关闭')
        return (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)

    def unlocked(self):
        handle = self.user.OpenInputDesktop(0, False, 0x0100)
        if not handle:
            return False
        try:
            name = ctypes.create_unicode_buffer(256)
            needed = wintypes.DWORD()
            return bool(self.user.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed))) and name.value.lower() == 'default'
        finally:
            self.user.CloseDesktop(handle)

    def last_input(self):
        class LastInput(ctypes.Structure):
            _fields_ = [('cbSize', wintypes.UINT), ('dwTime', wintypes.DWORD)]
        value = LastInput(ctypes.sizeof(LastInput), 0)
        if not self.user.GetLastInputInfo(ctypes.byref(value)):
            raise DesktopUnavailable('无法确认桌面输入状态')
        return value.dwTime

    def idle(self):
        return ((self.kernel.GetTickCount() - self.last_input()) & 0xffffffff) / 1000

    def capture(self, hwnd):
        from PIL import Image, ImageGrab
        if not self.unlocked() or not self.user.IsWindow(hwnd) or self.user.IsIconic(hwnd):
            raise DesktopUnavailable('桌面锁定或窗口不可用')
        x, y, width, height = self.rect(hwnd)
        if width * height > 24000000:
            raise DesktopUnavailable('窗口尺寸过大')
        dc = self.user.GetDC(hwnd)
        memory = self.gdi.CreateCompatibleDC(dc)
        bitmap = self.gdi.CreateCompatibleBitmap(dc, width, height)
        old = self.gdi.SelectObject(memory, bitmap)
        try:
            if not self.user.PrintWindow(hwnd, memory, 2):
                if self.user.GetForegroundWindow() != hwnd:
                    raise DesktopUnavailable('请将钉钉窗口置于前台')
                return ImageGrab.grab(bbox=(x, y, x + width, y + height), all_screens=True)
            class Header(ctypes.Structure):
                _fields_ = [('size', wintypes.DWORD), ('width', wintypes.LONG), ('height', wintypes.LONG), ('planes', wintypes.WORD), ('bits', wintypes.WORD), ('compression', wintypes.DWORD), ('imageSize', wintypes.DWORD), ('x', wintypes.LONG), ('y', wintypes.LONG), ('used', wintypes.DWORD), ('important', wintypes.DWORD)]
            header = Header(ctypes.sizeof(Header), width, -height, 1, 32, 0, 0, 0, 0, 0, 0)
            buffer = ctypes.create_string_buffer(width * height * 4)
            self.gdi.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
            # A bitmap must be deselected before GetDIBits.
            self.gdi.SelectObject(memory, old)
            if not self.gdi.GetDIBits(memory, bitmap, 0, height, buffer, ctypes.byref(header), 0):
                raise DesktopUnavailable('截图失败')
            image = Image.frombuffer('RGB', (width, height), buffer, 'raw', 'BGRX', 0, 1).copy()
            if max(image.convert('L').getextrema()) < 8:
                raise DesktopUnavailable('钉钉窗口未渲染，请置于前台')
            return image
        finally:
            self.gdi.SelectObject(memory, old)
            self.gdi.DeleteObject(bitmap)
            self.gdi.DeleteDC(memory)
            self.user.ReleaseDC(hwnd, dc)

    @staticmethod
    def crop(image, box):
        w, h = image.size
        return image.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))

    def prepare(self):
        # Import/initialize native DLLs before another thread blocks on stdin.
        # Windows CRT stream locks can otherwise deadlock NumPy DLL loading.
        if self.ocr is None:
            import numpy, cv2, uiautomation  # noqa: F401
            from PIL import Image, ImageGrab  # noqa: F401
            from rapidocr_onnxruntime import RapidOCR
            self.ocr = RapidOCR()

    def read(self, image):
        self.prepare()
        import numpy as np
        result, _ = self.ocr(np.asarray(image))
        return [dict(text=text, confidence=float(confidence), x=min(p[0] for p in box), y=min(p[1] for p in box), w=max(p[0] for p in box)-min(p[0] for p in box), h=max(p[1] for p in box)-min(p[1] for p in box)) for box, text, confidence in (result or [])]

    def read_single_line(self, image):
        """Recognize one visible ink band without detector clipping punctuation."""
        import cv2
        import numpy as np
        pixels = np.asarray(image.convert('RGB'))
        background = np.median(pixels.reshape(-1, 3), axis=0)
        # Dark glyphs are inside the bubble; its lighter rounded outer corners
        # must not stretch the line crop to the entire bubble height.
        mask = ((background-pixels.astype(np.int16)).mean(axis=2) > 35).astype('uint8')
        _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        ink = [(int(x), int(y), int(w), int(h)) for x,y,w,h,count in stats[1:]
               if count >= 3 and not (w <= 2 and h >= 20)]
        if not ink:
            return None
        left=min(x for x,y,w,h in ink);top=min(y for x,y,w,h in ink)
        right=max(x+w for x,y,w,h in ink);bottom=max(y+h for x,y,w,h in ink)
        if bottom-top > max(h for x,y,w,h in ink)*1.6:
            return None  # Never flatten wrapped or multi-line text.
        crop=image.crop((max(0,left-3),max(0,top-3),min(image.width,right+3),min(image.height,bottom+3)))
        self.prepare()
        rows, _ = self.ocr(np.asarray(crop), use_det=False, use_cls=False)
        if rows and len(rows)==1 and rows[0][1] >= .97:
            return str(rows[0][0])
        return None

    def title(self, image, layout, expected):
        rows = self.read(self.crop(image, layout['title']))
        return any(r['confidence'] >= .9 and title_matches(r['text'], expected) for r in rows)

    def messages(self, image, layout):
        from PIL import ImageOps
        region = self.crop(image, layout['messages'])
        result = []
        for x, y, w, h, side, footer in bubble_regions(region, include_actions=True):
            body = region.crop((x, y, x+w, y+h))
            # A single digit often disappears when OCR resizes an entire viewport.
            # OCR each verified bubble at native resolution with a neutral border.
            padded = ImageOps.expand(body, border=12, fill=region.getpixel((0, 0)))
            if footer is not None:
                rows = action_card_rows(body, footer, self.read)
                text = mention_action_text(rows, w, footer)
                if text:
                    result.append(Bubble(text, side))
                continue
            rows = self.read(padded)
            if side == 'outgoing':
                text = aligned_ocr_text(rows, w)
                if text:
                    result.append(Bubble(text, side))
                    continue
            eligible = [r for r in rows if r.get('confidence', 0) >= .90]
            if not eligible or len(eligible) != len(rows):
                continue
            # Plain messages have a common left edge; icon/text columns are cards.
            left = min(r['x'] for r in eligible)
            if any(abs(r['x']-left) > max(18, w*.10) for r in eligible):
                continue
            text = '\n'.join(normalized(r['text']) for r in sorted(eligible,key=lambda r:(r['y'],r['x'])))
            if text:
                result.append(Bubble(text, side))
        return result

    def detect_layout(self, hwnd):
        """Read-only calibration for native DingTalk 9 controls; never guesses."""
        import uiautomation as auto
        x, y, width, height = self.rect(hwnd)
        found = {'messages': [], 'editor': [], 'send': [], 'sidebar': []}
        visited, deadline = 0, time.monotonic()+8
        def visit(control, depth=0):
            nonlocal visited
            visited += 1
            if self.stopped() or visited > 2500 or time.monotonic() > deadline:
                raise DesktopUnavailable('自动校准检查超时，请使用手动校准')
            if depth > 18 or control.IsOffscreen:
                return
            rect = control.BoundingRectangle
            if rect.width() > 0 and rect.height() > 0:
                kind, name, cls = control.ControlTypeName, control.Name, control.ClassName
                key = ('messages' if cls == 'im_chat::ChatBubbleWidget'
                       else 'editor' if kind == 'EditControl' and name == '请输入消息'
                       else 'send' if kind == 'ButtonControl' and name == '发送'
                       else 'sidebar' if kind == 'ListControl' and name == 'filterboxconvlist' else None)
                if key:
                    found[key].append([rect.left-x,rect.top-y,rect.right-x,rect.bottom-y])
            for child in control.GetChildren()[:150]:
                visit(child, depth+1)
        with auto.UIAutomationInitializerInThread():
            visit(auto.ControlFromHandle(hwnd))
        if any(len(items) != 1 for items in found.values()):
            raise DesktopUnavailable('当前钉钉未提供唯一校准控件，请手动框选并核对预览')
        messages, editor, send, sidebar = (found[key][0] for key in ('messages','editor','send','sidebar'))
        if not (messages[0] >= sidebar[2] and messages[1] > 40 and editor[1] >= messages[3]
                and send[1] >= editor[3] and send[0] >= editor[0]):
            raise DesktopUnavailable('钉钉布局不符合已验证结构，请手动校准')
        def box(rect):
            return [max(0,min(1,rect[0]/width)),max(0,min(1,rect[1]/height)),
                    max(0,min(1,rect[2]/width)),max(0,min(1,rect[3]/height))]
        return dict(messages=box([messages[0],messages[1]-2,messages[2],messages[3]]),
                    title=box([messages[0]+50,max(0,messages[1]-65),min(send[0],width),messages[1]-3]),
                    editor=box(editor),sidebar=box(sidebar),
                    send=[(send[0]+send[2])/2/width,(send[1]+send[3])/2/height])

    def foreground(self, hwnd):
        if self.stopped() or not self.unlocked():
            raise DesktopUnavailable('桌面锁定或宿主已停止，未激活窗口')
        if self.idle() < 5 and self.last_input() != self.auto_input:
            raise DesktopDeferred('正在人工操作桌面，等待空闲')
        if self.user.GetForegroundWindow() != hwnd:
            self.user.SetForegroundWindow(hwnd)
            time.sleep(.2)
        if self.user.GetForegroundWindow() != hwnd:
            # Windows may refuse SetForegroundWindow for a background process.
            # One native accessibility focus request is allowed; never simulate
            # Alt keys, attach input threads, or assume the request succeeded.
            import uiautomation as auto
            stamp, rect = self.last_input(), self.rect(hwnd)
            try:
                with auto.UIAutomationInitializerInThread():
                    auto.ControlFromHandle(hwnd).SetFocus()
            except Exception:
                pass
            time.sleep(.2)
            if (self.stopped() or not self.unlocked() or self.rect(hwnd) != rect
                    or self.last_input() != stamp):
                raise DesktopDeferred('窗口激活期间状态变化，等待空闲后重新检查')
        if self.user.GetForegroundWindow() != hwnd:
            raise DesktopDeferred('系统未允许激活钉钉窗口；请将钉钉置于前台，原回复保留排队')

    def click(self, hwnd, x, y):
        if self.stopped() or not self.unlocked() or self.user.GetForegroundWindow() != hwnd:
            raise DesktopUnavailable('目标窗口不在前台')
        px, py, width, height = self.rect(hwnd)
        target = wintypes.POINT(px + int(x * width), py + int(y * height))
        def point_is_target():
            hit = self.user.WindowFromPoint(target)
            return bool(hit) and self.user.GetAncestor(hit, 2) == hwnd
        if not point_is_target():
            raise DesktopUnavailable('点击位置被其他窗口遮挡，已暂停')
        if not self.user.SetCursorPos(target.x, target.y):
            raise DesktopUnavailable('系统拒绝定位鼠标，未点击')
        actual = wintypes.POINT()
        if (self.stopped() or self.user.GetForegroundWindow() != hwnd or self.rect(hwnd) != (px, py, width, height)
                or not self.user.GetCursorPos(ctypes.byref(actual)) or (actual.x, actual.y) != (target.x, target.y)
                or not point_is_target()):
            raise DesktopUnavailable('点击前窗口或鼠标位置已变化，未点击')
        self.user.mouse_event(0x0002, 0, 0, 0, 0)
        self.user.mouse_event(0x0004, 0, 0, 0, 0)
        self.auto_input = self.last_input()

    def select_chat(self, hwnd, layout, title):
        image = self.capture(hwnd)
        if self.title(image, layout, title):
            return image
        if self.idle() < 5 and self.last_input() != self.auto_input:
            raise DesktopUnavailable('正在人工操作桌面，等待空闲')
        rows = self.read(self.crop(image, layout['sidebar']))
        matches = [r for r in rows if r['confidence'] >= .92 and title_matches(r['text'], title)]
        if len(matches) != 1:
            raise DesktopUnavailable('聊天列表中未找到唯一完整标题，请将绑定聊天置顶或打开该聊天')
        row, box = matches[0], layout['sidebar']
        self.foreground(hwnd)
        self.click(hwnd, box[0] + (row['x'] + row['w']/2)/image.width, box[1] + (row['y'] + row['h']/2)/image.height)
        time.sleep(.4)
        image = self.capture(hwnd)
        if not self.title(image, layout, title):
            raise DesktopUnavailable('聊天切换后的标题核对失败')
        return image

    def editor(self, hwnd, layout):
        import uiautomation as auto
        root = auto.ControlFromHandle(hwnd)
        x, y, width, height = self.rect(hwnd)
        area = layout['editor']
        matches = []
        visited, deadline = 0, time.monotonic() + 5
        def visit(control, depth=0):
            nonlocal visited
            visited += 1
            if self.stopped() or visited > 2000 or time.monotonic() > deadline:
                raise DesktopUnavailable('输入框检查超时或已停止')
            if depth > 18:
                return
            rect = control.BoundingRectangle
            if not control.IsOffscreen and control.ControlTypeName in ('EditControl', 'DocumentControl') and rect.width() > 100 and rect.height() > 25:
                cx, cy = ((rect.left + rect.right)/2-x)/width, ((rect.top + rect.bottom)/2-y)/height
                if area[0] <= cx <= area[2] and area[1] <= cy <= area[3]:
                    matches.append(control)
            for child in control.GetChildren()[:150]:
                visit(child, depth + 1)
        visit(root)
        if len(matches) != 1:
            raise DesktopUnavailable('无法唯一识别消息输入框；请重新校准输入区')
        return matches[0]

    @staticmethod
    def editor_text(control):
        for read in (lambda: control.GetValuePattern().Value,
                     lambda: control.GetTextPattern().DocumentRange.GetText(-1),
                     lambda: control.GetLegacyIAccessiblePattern().Value):
            try:
                text = read()
                if isinstance(text, str):
                    return text
            except Exception:
                pass
        raise DesktopUnavailable('输入框不支持读取，禁止覆盖未知草稿')

    def inspect_editor(self, hwnd, layout):
        """Read-only capability report. Never exposes draft content or sets focus."""
        try:
            import uiautomation as auto
            with auto.UIAutomationInitializerInThread():
                control = self.editor(hwnd, layout)
                draft = self.editor_text(control)
                visual = self.visual_draft(hwnd, layout)
                methods = []
                for name in ('GetValuePattern', 'GetLegacyIAccessiblePattern'):
                    try:
                        pattern = getattr(control, name)()
                        if isinstance(pattern.Value, str) and not getattr(pattern, 'IsReadOnly', False):
                            methods.append(name)
                    except Exception:
                        pass
                empty = not normalized(draft) and visual['empty']
                return dict(readable=True, draftEmpty=empty, writable=bool(methods),
                            detail='输入框已做 UIA 与画面对照；' + ('已有可见内容，发送会停止' if not empty else '当前草稿为空') + '；写入能力需实际验证')
        except Exception as exc:
            return dict(readable=False, draftEmpty=False, writable=False, detail=str(exc)[:200])

    def visual_draft(self, hwnd, layout, expected=None):
        import cv2
        import numpy as np
        from PIL import Image, ImageOps
        region = self.crop(self.capture(hwnd), layout['editor'])
        pixels = np.asarray(region.convert('RGB'))
        background = np.median(pixels.reshape(-1, 3), axis=0)
        mask = (np.max(np.abs(pixels.astype(np.int16)-background), axis=2)>35).astype('uint8')
        _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        components = [(int(x),int(y),int(w),int(h)) for x,y,w,h,count in stats[1:]
                      if count >= 3 and not (w <= 2 and h >= 20)]
        if not components:
            return dict(empty=True,text='')
        left=min(x for x,y,w,h in components);top=min(y for x,y,w,h in components)
        right=max(x+w for x,y,w,h in components);bottom=max(y+h for x,y,w,h in components)
        crop=region.crop((max(0,left-8),max(0,top-8),min(region.width,right+8),min(region.height,bottom+8)))
        padded=ImageOps.expand(crop,border=12,fill=tuple(map(int,background)))
        def recognize(image):
            rows=self.read(image)
            return '\n'.join(r['text'] for r in sorted(rows,key=lambda r:(r['y'],r['x']))) if rows and all(r['confidence']>=.9 for r in rows) else None
        text=recognize(padded)
        if expected:
            import re
            compact=lambda s:re.sub(r'\s+','',normalized(s))
            if text is None or compact(text)!=compact(expected):
                for scale in (2,3):
                    candidate=recognize(padded.resize((padded.width*scale,padded.height*scale),Image.Resampling.LANCZOS))
                    if candidate is not None and compact(candidate)==compact(expected):
                        text=candidate
                        break
                if text is None or compact(text)!=compact(expected):
                    candidate=self.read_single_line(region)
                    if candidate is not None and compact(candidate)==compact(expected):
                        text=candidate
        return dict(empty=False,text=text)

    def focus_editor(self, hwnd, layout):
        # Some native DingTalk builds accept SetFocus without focusing the edit.
        # A single click is allowed only inside the freshly observed edit rect.
        self.foreground(hwnd)
        control = self.editor(hwnd, layout)
        if normalized(self.editor_text(control)) or not self.visual_draft(hwnd,layout)['empty']:
            raise DesktopUnavailable('输入框已有草稿，等待人工处理')
        rect, stamp = self.rect(hwnd), self.last_input()
        control.SetFocus()
        time.sleep(.15)
        self.guard(hwnd, rect, stamp)
        if not control.HasKeyboardFocus:
            bounds = control.BoundingRectangle
            x, y, width, height = rect
            cx, cy = ((bounds.left+bounds.right)/2-x)/width, ((bounds.top+bounds.bottom)/2-y)/height
            area = layout['editor']
            if not (area[0] <= cx <= area[2] and area[1] <= cy <= area[3]):
                raise DesktopUnavailable('输入框中心不在校准区域，未点击')
            self.click(hwnd, cx, cy)
            stamp = self.last_input()
            time.sleep(.2)
            self.guard(hwnd, rect, stamp)
            control = self.editor(hwnd, layout)
        if not control.HasKeyboardFocus or normalized(self.editor_text(control)) or not self.visual_draft(hwnd,layout)['empty']:
            raise DesktopUnavailable('无法确认空输入框焦点，未写入文字')
        return control

    def type_reply(self, hwnd, layout, text):
        import uiautomation as auto
        self.foreground(hwnd)
        with auto.UIAutomationInitializerInThread():
            control = self.focus_editor(hwnd, layout)
            rect, stamp = self.rect(hwnd), self.last_input()
            if self.user.GetForegroundWindow() != hwnd or not control.HasKeyboardFocus:
                raise DesktopUnavailable('输入焦点已变化')
            direct = False
            for name in ('GetValuePattern', 'GetLegacyIAccessiblePattern'):
                self.guard(hwnd, rect, stamp)
                if normalized(self.editor_text(control)):
                    raise DesktopUnavailable('写入前出现草稿，未覆盖')
                try:
                    pattern = getattr(control, name)()
                    pattern.SetValue(text)
                except Exception:
                    # A setter can throw after changing the document. Verify before
                    # considering another setter or keyboard input.
                    if self.verify_draft(hwnd,layout,text):
                        direct = True
                        break
                    if normalized(self.editor_text(control)) or not self.visual_draft(hwnd,layout)['empty']:
                        raise DesktopUnavailable('写入结果不完整，保留草稿待人工核对')
                    continue
                if self.verify_draft(hwnd,layout,text):
                    direct = True
                    break
                if normalized(self.editor_text(control)) or not self.visual_draft(hwnd,layout)['empty']:
                    raise DesktopUnavailable('写入后草稿核对失败，未发送')
            if not direct:
                # Never select/delete an unknown or concurrently edited draft.
                if normalized(self.editor_text(control)) or not self.visual_draft(hwnd,layout)['empty'] or self.user.GetForegroundWindow() != hwnd:
                    raise DesktopUnavailable('草稿或焦点已变化，未发送')
                # SendKeys parses {Enter}/{Ctrl} even with charMode=True. Send
                # UTF-16 units literally; multiline fallback is refused.
                # Never let model content become key combinations.
                if '\n' in text or '\r' in text or '\t' in text:
                    raise DesktopUnavailable('输入框不支持直接设置多行文本，未发送')
                stamp, rect = self.last_input(), self.rect(hwnd)
                for char in text:
                    self.guard(hwnd, rect, stamp)
                    if not control.HasKeyboardFocus:
                        raise DesktopUnavailable('输入框失去焦点，未发送')
                    encoded = char.encode('utf-16-le')
                    for offset in range(0, len(encoded), 2):
                        unit=int.from_bytes(encoded[offset:offset+2], 'little')
                        for flag in (auto.KeyboardEventFlag.KeyDown,auto.KeyboardEventFlag.KeyUp):
                            if auto.SendInput(auto.KeyboardInput(0,unit,auto.KeyboardEventFlag.KeyUnicode | flag)) != 1:
                                raise DesktopUnavailable('系统拒绝文字输入，未发送')
                    stamp = self.last_input()
            self.guard(hwnd, rect, stamp)
            if not self.verify_draft(hwnd,layout,text):
                raise DesktopUnavailable('写入后草稿核对失败，未发送')
            self.guard(hwnd, rect, stamp)
            return self.last_input()

    def guard(self, hwnd, rect, input_stamp):
        if self.stopped():
            raise DesktopUnavailable('宿主已停止，已停止发送')
        if not self.unlocked():
            raise DesktopUnavailable('桌面已锁定，已停止发送')
        if self.user.GetForegroundWindow() != hwnd:
            raise DesktopUnavailable('钉钉失去前台焦点，已停止发送')
        if self.rect(hwnd) != rect:
            raise DesktopUnavailable('钉钉窗口位置或尺寸变化，已停止发送')
        if self.last_input() != input_stamp:
            # The session only retries before its durable input intent.
            raise DesktopDeferred('检查期间出现人工输入；输入前等待，输入后禁止自动重发')

    def send_reply(self, config, title, text, before_dispatch):
        from desktop_core import outgoing_added
        if not text.strip() or len(text) > 4000:
            raise DesktopUnavailable('桌面回复限 1–4000 字符')
        if self.idle() < 5 and self.last_input() != self.auto_input:
            raise DesktopDeferred('正在人工操作桌面，等待空闲')
        hwnd = self.find(config['windowTitle'])
        layout = config['layout']
        self.foreground(hwnd)
        image = self.select_chat(hwnd, layout, title)
        rect, stamp = self.rect(hwnd), self.last_input()
        # Re-read the title under the input stamp. select_chat's earlier image
        # can become stale while OCR runs or the user changes conversations.
        image = self.capture(hwnd)
        if not self.title(image, layout, title):
            raise DesktopUnavailable('写入前聊天标题核对失败，未发送')
        before = self.messages(image, layout)
        self.guard(hwnd, rect, stamp)
        before_dispatch()  # Durable intent before any typing/clicking.
        stamp = self.type_reply(hwnd, layout, text)
        image = self.capture(hwnd)
        if not self.title(image, layout, title) or not self.verify_draft(hwnd, layout, text):
            raise DesktopUnavailable('发送前聊天标题或草稿核对失败')
        self.guard(hwnd, rect, stamp)
        self.click(hwnd, *layout['send'])
        stamp = self.last_input()
        for _ in range(12):
            time.sleep(.3)
            self.guard(hwnd, rect, stamp)
            image = self.capture(hwnd)
            if not self.title(image, layout, title):
                break
            after = self.messages(image, layout)
            if outgoing_added(before, after, text) and self.verify_draft(hwnd, layout, ''):
                return 'sent'
        return 'delivery_unknown'

    def verify_draft(self, hwnd, layout, text):
        import uiautomation as auto
        with auto.UIAutomationInitializerInThread():
            value=self.editor_text(self.editor(hwnd, layout))
            visual=self.visual_draft(hwnd,layout,text)
            if not text:
                return not normalized(value) and visual['empty']
            import re
            compact=lambda s:re.sub(r'\s+','',normalized(s))
            return visual['text'] is not None and compact(visual['text'])==compact(text) and (not value or compact(value)==compact(text))

    def preview(self, title, layout, auto_layout=False):
        import base64
        hwnd = self.find(title)
        if auto_layout:
            layout = self.detect_layout(hwnd)
        image = self.capture(hwnd)
        stream = io.BytesIO()
        image.save(stream, format='PNG')
        return dict(image='data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode(), width=image.width, height=image.height, layout=layout,
                    titleLines=self.read(self.crop(image, layout['title'])), messages=[b.__dict__ for b in self.messages(image, layout)],
                    editor=self.inspect_editor(hwnd, layout))
