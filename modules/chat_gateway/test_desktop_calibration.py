"""Manual calibration and unread routing; synthetic pixels, no external chats."""
import copy
from pathlib import Path
import tempfile
import unittest
import sys
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image, ImageDraw
from desktop_calibration import red_badges, conversation_candidates
from desktop_core import Bubble, MessageTracker, matching_route, validate_config
from desktop_gateway import DesktopSession, Store
from desktop_windows import WindowsDesktop, DesktopUnavailable


def config():
    return dict(version=2, windowTitle='Example', application='custom', processName='example.exe',
                inputMode='foreground', selfNames=[], referenceSize=[1000, 800],
                layout=dict(notification=[0, 0, .1, .1], sidebar=[.1, .1, .35, .85],
                            title=[.35, 0, 1, .1], messages=[.35, .1, 1, .7],
                            editor=[.35, .7, 1, .9], sendButton=[.9, .9, 1, 1], send=[.95, .95]))


def row(text, y=20):
    return dict(text=text, confidence=.95, x=70, y=y, w=110, h=20)


class CalibrationRulesTests(unittest.TestCase):
    def test_capture_only_does_not_require_regions_ocr_or_editor_labels(self):
        driver = WindowsDesktop.__new__(WindowsDesktop)
        driver.find = lambda title: 1
        driver.capture = lambda hwnd: Image.new('RGB', (1000,800), 'white')
        driver.resolve_layout = lambda *_: self.fail('Capture must not resolve regions')
        driver.read = lambda *_: self.fail('Capture must not invoke OCR')
        result = driver.preview('Example', {}, capture_only=True)
        self.assertEqual((result['width'],result['height']), (1000,800))
        self.assertTrue(result['image'].startswith('data:image/png;base64,'))
    def test_v2_requires_all_drawn_regions_not_platform_labels_or_self_name(self):
        self.assertEqual(validate_config(config()), config())
        for key in ('notification', 'sidebar', 'title', 'messages', 'editor', 'sendButton'):
            bad = config(); bad['layout'][key] = [0, 0, 0, 0]
            with self.subTest(key=key), self.assertRaises(ValueError): validate_config(bad)
        for changes in (dict(referenceSize=None), dict(processName=''), dict(inputMode='background')):
            with self.assertRaises(ValueError): validate_config(dict(config(), **changes))
        bad = config(); bad['layout']['send'] = [.1, .2]
        with self.assertRaises(ValueError): validate_config(bad)

    def test_compact_red_dots_and_number_pills_not_avatars_lines_or_dark_icons(self):
        image = Image.new('RGB', (300, 180), 'white'); draw = ImageDraw.Draw(image)
        draw.ellipse((10, 10, 25, 25), fill=(255, 65, 30))
        draw.rounded_rectangle((50, 10, 78, 27), radius=8, fill=(250, 55, 45))
        draw.text((56, 12), '12', fill='white')
        draw.rectangle((100, 10, 140, 50), fill='red')  # Avatar.
        draw.line((0, 70, 180, 70), fill='red', width=3)
        draw.rounded_rectangle((180, 10, 202, 27), radius=5, fill=(255, 65, 30))
        draw.rectangle((185, 15, 196, 20), fill=(30, 30, 30))
        self.assertEqual(len(red_badges(image)), 2)

    def test_name_contains_prefers_longer_rule_and_rejects_ties(self):
        short = dict(chatId='张楠'); long = dict(chatId='张楠楠')
        self.assertEqual(matching_route('张楠楠（设计部） 在线', [short, long]), long)
        self.assertIsNone(matching_route('Alice Bob', [dict(chatId='Alice'), dict(chatId='Alice')]))
        self.assertIsNone(matching_route('Other', [short]))
        self.assertIsNone(matching_route('张楠楠（设计部）', [short, dict(long, paused=True)]))

    def test_badge_is_associated_with_title_not_next_preview_line(self):
        routes = [dict(chatId='Alice'), dict(chatId='Bob')]
        badge = dict(x=30, y=10, w=16, h=16)
        self.assertEqual(conversation_candidates([row('Alice · team'), row('Bob said hello', 50)], [badge], routes)[0][0], routes[0])
        self.assertEqual(conversation_candidates([row('Alice'), row('Alice', 110)], [badge], routes), [])
        self.assertEqual(conversation_candidates([row('Unknown')], [badge], routes), [])

    def test_unread_first_view_latest_only_then_restart_deduplicates(self):
        tracker = MessageTracker()
        old, latest = Bubble('old', 'incoming'), Bubble('latest', 'incoming')
        events = tracker.observe([old, latest], 'alice', unread=True)
        self.assertEqual([b.text for _, b in events], ['latest'])
        resumed = MessageTracker(copy.deepcopy(tracker.state))
        self.assertEqual(resumed.observe([old, latest], 'alice', unread=True), [])
        self.assertEqual(resumed.observe([Bubble('reply', 'outgoing')], 'alice', unread=True), [])

    def test_unread_after_lost_overlap_does_not_bulk_replay(self):
        tracker = MessageTracker(); tracker.observe([Bubble('a', 'incoming')], 'x')
        events = tracker.observe([Bubble('unseen history', 'incoming'), Bubble('new tail', 'incoming')], 'x', unread=True)
        self.assertEqual([b.text for _, b in events], ['new tail'])


class UnreadDriver:
    def __init__(self):
        self.current = 'Other'; self.unread = True; self.clicks = []; self.routes = []
        self.bubbles = [Bubble('history', 'incoming'), Bubble('question', 'incoming')]
    def find(self, _): return 1
    def resolve_layout(self, _, layout): return layout
    def rect(self, _): return (10, 10, 1000, 800)
    def guard(self, *_): pass
    crop = staticmethod(WindowsDesktop.crop)
    def capture(self, _):
        image = Image.new('RGB', (1000, 800), 'white')
        if self.unread: ImageDraw.Draw(image).ellipse((130, 90, 146, 106), fill=(255, 60, 30))
        return image
    def read(self, image):
        return [row('Alice · department')] if image.width == 250 else [row(self.current)]
    def title(self, image, layout, name):
        match = matching_route(self.current, self.routes)
        return bool(match and match['chatId'] == name)
    def click_region(self, hwnd, layout, box, **_):
        self.clicks.append(box); self.current = 'Alice · department'; self.unread = False
        return self.capture(hwnd)
    def select_chat(self, hwnd, layout, name):
        if not self.title(None, layout, name): raise RuntimeError('Unexpected navigation')
        return self.capture(hwnd)
    def messages(self, *_): return self.bubbles


class UnreadSessionTests(unittest.TestCase):
    def test_restart_after_badge_consumed_preserves_pending_read(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'state.json'; driver = UnreadDriver()
            route = dict(chatId='Alice', chatType='direct')
            session = DesktopSession(config(), Store(path), driver); session.set_routes([route])
            session.poll_unread()
            self.assertFalse(driver.unread)
            restarted = DesktopSession(config(), Store(path), driver); restarted.set_routes([route])
            restarted.poll_unread(); restarted.poll_unread()
            self.assertEqual([m['text'] for m in restarted.store.data['pending']], ['question'])

    def test_badge_clears_on_click_but_message_survives_stability_check(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); path = Path(directory)/'state.json'
            session = DesktopSession(config(), Store(path), driver)
            route = dict(chatId='Alice', chatType='direct', id='r', botId='bot', mode='all')
            session.set_routes([route])
            session.poll_unread()
            self.assertFalse(driver.unread)
            self.assertEqual(session.store.data['pending'], [])
            session.poll_unread()
            self.assertEqual([m['text'] for m in session.store.data['pending']], ['question'])
            self.assertEqual(session.store.data['pending'][0]['chatId'], 'Alice')
            session.poll_unread()
            self.assertEqual(len(driver.clicks), 1)
            self.assertEqual(len(session.store.data['pending']), 1)
            session.store.data['pending'] = []; session.store.save()
            driver.unread = True
            restarted = DesktopSession(config(), Store(path), driver); restarted.set_routes([route])
            restarted.poll_unread(); restarted.poll_unread()
            self.assertEqual(restarted.store.data['pending'], [])

    def test_no_badge_and_unregistered_chat_does_not_navigate(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); driver.unread = False
            session = DesktopSession(config(), Store(Path(directory)/'state.json'), driver)
            session.set_routes([dict(chatId='Alice', chatType='direct')])
            session.poll_unread(); session.poll_unread()
            self.assertEqual(driver.clicks, [])
            self.assertEqual(session.store.data['pending'], [])

    def test_empty_unread_chat_cannot_starve_other_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); driver.bubbles = []
            session = DesktopSession(config(), Store(Path(directory)/'state.json'), driver)
            session.set_routes([dict(chatId='Alice', chatType='direct')])
            for _ in range(4): session.poll_unread()
            self.assertEqual(session.unread_pending, set())
            self.assertIsNone(session.active_route)


class CalibratedInputTests(unittest.TestCase):
    def driver(self, *, draft='', wrong_focus=False, lose_focus=False):
        driver = WindowsDesktop.__new__(WindowsDesktop)
        driver.config = config(); driver.foreground = lambda _: None
        driver.rect = lambda _: (0,0,1000,800); driver.last_input = lambda: 1
        driver.guard = lambda *_: None; driver.draft = draft; driver.clicks = []
        driver.click = lambda *args: driver.clicks.append(args)
        driver.verify_draft = lambda h,l,t: driver.draft == t
        def focus():
            bad = wrong_focus or (lose_focus and bool(driver.draft))
            return SimpleNamespace(BoundingRectangle=SimpleNamespace(left=0 if bad else 400,top=0 if bad else 570,right=100 if bad else 900,bottom=100 if bad else 700))
        def send(event):
            _, unit, flag = event
            if not flag & 2: driver.draft += chr(unit)
            return 1
        auto = SimpleNamespace(GetFocusedControl=focus, SendInput=send, KeyboardInput=lambda *args: args,
                               KeyboardEventFlag=SimpleNamespace(KeyDown=0,KeyUp=2,KeyUnicode=4))
        return driver, auto

    def test_literal_text_uses_calibrated_editor_without_labels(self):
        driver, auto = self.driver()
        with patch.dict(sys.modules, {'uiautomation': auto}):
            driver.type_calibrated(1, config()['layout'], 'hello {Enter} {Ctrl}a')
        self.assertEqual(driver.draft, 'hello {Enter} {Ctrl}a')
        self.assertEqual(driver.clicks, [(1,.675,.8)])

    def test_draft_wrong_focus_or_focus_change_stops_input(self):
        for options in (dict(draft='user draft'),dict(wrong_focus=True),dict(lose_focus=True)):
            driver, auto = self.driver(**options)
            with patch.dict(sys.modules, {'uiautomation': auto}), self.assertRaises(DesktopUnavailable):
                driver.type_calibrated(1, config()['layout'], 'reply')
            expected = 'user draft' if options.get('draft') else 'r' if options.get('lose_focus') else ''
            self.assertEqual(driver.draft, expected)


if __name__ == '__main__': unittest.main()
