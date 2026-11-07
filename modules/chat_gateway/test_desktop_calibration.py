"""Manual calibration and unread routing; synthetic pixels, no external chats."""
import copy
from pathlib import Path
import tempfile
import unittest
import sys
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image, ImageDraw
from desktop_calibration import red_badges, conversation_candidates, conversation_title_rows, notification_entry
from desktop_core import Bubble, MessageTracker, matching_route, validate_config
from desktop_gateway import DesktopSession, Store
from desktop_windows import WindowsDesktop, DesktopUnavailable, DesktopDeferred


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
        short = dict(chatId='测试'); long = dict(chatId='测试联系人')
        self.assertEqual(matching_route('测试联系人（设计部） 在线', [short, long]), long)
        self.assertIsNone(matching_route('Alice Bob', [dict(chatId='Alice'), dict(chatId='Alice')]))
        self.assertIsNone(matching_route('Other', [short]))
        self.assertIsNone(matching_route('测试联系人（设计部）', [short, dict(long, paused=True)]))

    def test_badge_is_associated_with_title_not_next_preview_line(self):
        routes = [dict(chatId='Alice'), dict(chatId='Bob')]
        badge = dict(x=30, y=10, w=16, h=16)
        self.assertEqual(conversation_candidates([row('Alice · team'), row('Bob said hello', 50)], [badge], routes)[0][0], routes[0])
        self.assertEqual(conversation_candidates([row('Alice'), row('Alice', 110)], [badge], routes), [])
        self.assertEqual(conversation_candidates([row('Unknown')], [badge], routes), [])

    def test_preview_mention_does_not_hide_another_unique_heading(self):
        lines = [row('Alice', 20), row('Hello', 48), row('Bob', 110), row('Alice said hello', 138)]
        routes = [dict(chatId='Alice'), dict(chatId='Bob')]
        badge = dict(x=30, y=10, w=16, h=16)
        self.assertEqual(conversation_candidates(lines, [badge], routes), [(routes[0], lines[0])])
        # Never collapse two genuine close, same-name headings.
        self.assertEqual(conversation_candidates([row('Alice', 20), row('Alice', 48)], [badge], routes), [])
        # A registered heading below another person's heading is not a preview.
        self.assertEqual(conversation_candidates([row('Alice', 20), row('Bob', 110), row('Alice', 138)], [badge], routes), [])

    def test_whole_navigation_rail_never_clicks_oa_or_ding_badge(self):
        image = Image.new('RGB', (1000, 800), 'white')
        layout = dict(config()['layout'], notification=[0, 0, .1, .8])
        ImageDraw.Draw(image).ellipse((72, 110, 86, 124), fill=(255, 60, 30))
        lines = [row('Messages', 30), row('DING', 110), row('OA Approval', 300)]
        entry = notification_entry(image, layout, lambda _: lines, 'dingtalk')
        self.assertFalse(entry['unread'])
        self.assertLess(entry['box'][3], .1)
        unresolved = notification_entry(image, layout, lambda _: lines[1:], 'dingtalk')
        self.assertIsNone(unresolved['box'])
        self.assertFalse(unresolved['unread'])
        self.assertIn('范围过大', unresolved['detail'])

    def test_resolved_messages_and_generic_compact_entry(self):
        image = Image.new('RGB', (1000, 800), 'white')
        ImageDraw.Draw(image).ellipse((72, 32, 86, 46), fill=(255, 60, 30))
        layout = dict(config()['layout'], notification=[0, 0, .1, .8])
        entry = notification_entry(image, layout, lambda _: [row('Messages', 30), row('DING', 110)], 'dingtalk')
        self.assertTrue(entry['unread'])
        self.assertLess(entry['box'][3], .1)
        compact = notification_entry(image, config()['layout'], lambda _: [], 'custom')
        self.assertTrue(compact['unread'])
        self.assertEqual(compact['box'], config()['layout']['notification'])

    def test_badge_column_inside_sidebar_is_observed_not_clicked(self):
        layout = dict(config()['layout'], notification=[.1, .1, .15, .8])
        entry = notification_entry(Image.new('RGB', (1000, 800), 'white'), layout, lambda _: [], 'custom')
        self.assertIsNone(entry['box'])

    def test_title_ignores_preview_mentions_but_keeps_real_duplicate_guard(self):
        driver = WindowsDesktop.__new__(WindowsDesktop)
        driver.config = config(); driver.routes = [dict(chatId='Alice')]
        image = Image.new('RGB', (1000, 800), 'white')
        sidebar = [row('Alice', 20), row('Hello', 48), row('Bob', 110), row('Alice said hello', 138)]
        driver.read = lambda crop: sidebar if crop.width == 250 else [row('Alice · team')]
        self.assertTrue(driver.title(image, config()['layout'], 'Alice'))
        sidebar[2] = row('Alice', 110)
        self.assertFalse(driver.title(image, config()['layout'], 'Alice'))

    def test_unread_first_view_latest_only_then_restart_deduplicates(self):
        tracker = MessageTracker()
        old, latest = Bubble('old', 'incoming'), Bubble('latest', 'incoming')
        events = tracker.observe([old, latest], 'alice', unread=True)
        self.assertEqual([b.text for _, b in events], ['latest'])
        resumed = MessageTracker(copy.deepcopy(tracker.state))
        self.assertEqual(resumed.observe([old, latest], 'alice', unread=True), [])
        self.assertEqual(resumed.observe([Bubble('reply', 'outgoing')], 'alice', unread=True), [])

    def test_badge_over_dark_avatar_and_smaller_numeric_preview(self):
        image = Image.new('RGB', (300, 180), 'white'); draw = ImageDraw.Draw(image)
        draw.rectangle((20, 30, 70, 85), fill=(35, 30, 25))
        draw.ellipse((55, 20, 75, 40), fill=(255, 65, 30))
        draw.text((61, 22), '1', fill='white')
        badges = red_badges(image)
        self.assertEqual(len(badges), 1)
        title = dict(row('222 · team', 26), x=80, h=21)
        preview = dict(row('2222222222 hello', 56), x=80, h=15)
        route = dict(chatId='222')
        self.assertEqual(conversation_candidates([title, preview], badges, [route]), [(route, title)])

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
    def click_region(self, hwnd, layout, box, before_click=None, **_):
        if before_click: before_click()
        self.clicks.append(box); self.current = 'Alice · department'; self.unread = False
        return self.capture(hwnd)
    def select_chat(self, hwnd, layout, name):
        if not self.title(None, layout, name): raise RuntimeError('Unexpected navigation')
        return self.capture(hwnd)
    def messages(self, *_): return self.bubbles


class UnreadSessionTests(unittest.TestCase):
    def session(self, directory, driver, cfg=None):
        session = DesktopSession(cfg or config(), Store(Path(directory)/'state.json'), driver)
        session.set_routes([dict(chatId='Alice', chatType='direct')])
        return session

    def test_broad_nav_badge_does_not_click_menu_center(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); driver.unread = False
            cfg = config(); cfg['layout']['notification'] = [0, 0, .09, .8]
            image = driver.capture(1)
            ImageDraw.Draw(image).ellipse((60, 110, 76, 126), fill=(255, 60, 30))
            driver.capture = lambda _: image
            session = self.session(directory, driver, cfg)
            status = session.poll_unread(); session.poll_unread()
            self.assertEqual(len(driver.clicks), 1)
            self.assertGreater(driver.clicks[0][0], .1, 'Only the registered sidebar row may be clicked')
            self.assertEqual(session.store.data['pending'], [], 'No badge means baseline, not unread history')

    def test_current_bound_chat_is_read_even_when_nav_region_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); driver.unread = False; driver.current = 'Alice'
            cfg = config(); cfg['layout']['notification'] = [0, 0, .09, .8]
            session = self.session(directory, driver, cfg)
            session.poll_unread(); session.poll_unread()
            driver.bubbles.append(Bubble('new live message', 'incoming'))
            session.poll_unread(); session.poll_unread()
            self.assertEqual(driver.clicks, [])
            self.assertEqual([m['text'] for m in session.store.data['pending']], ['new live message'])

    def test_outgoing_only_loading_frames_keep_unread_for_incoming_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            driver=UnreadDriver();driver.bubbles=[Bubble('earlier outgoing','outgoing')]
            session=self.session(directory,driver)
            session.poll_unread();session.poll_unread()
            self.assertIn('direct:Alice',session.unread_pending)
            driver.bubbles.append(Bubble('new incoming','incoming'))
            session.poll_unread();session.poll_unread()
            self.assertEqual([m['text'] for m in session.store.data['pending']],['new incoming'])

    def test_failed_entry_click_is_not_repeated_and_reports_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); driver.unread = False
            image = driver.capture(1)
            ImageDraw.Draw(image).ellipse((60, 30, 76, 46), fill=(255, 60, 30))
            driver.capture = lambda _: image
            driver.read = lambda _: [row('Unknown')]
            def click(h,l,b,before_click=None,**kw):
                if before_click: before_click()
                driver.clicks.append(b)
                return image
            driver.click_region = click
            session = self.session(directory, driver)
            with patch('desktop_gateway.time.monotonic', side_effect=[100,100,100,200,200,200,300,300,300]):
                session.poll_unread(); status = session.poll_unread(); session.poll_unread()
            self.assertEqual(len(driver.clicks), 1)
            self.assertIn('停止重复点击', status[1])

    def test_visible_registered_list_never_triggers_entry_click(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); driver.unread = False
            image = driver.capture(1)
            ImageDraw.Draw(image).ellipse((60, 30, 76, 46), fill=(255, 60, 30))
            driver.capture = lambda _: image
            session = self.session(directory, driver)
            status = session.poll_unread()
            self.assertEqual(len(driver.clicks), 1)
            self.assertNotEqual(driver.clicks[0], config()['layout']['notification'])
            self.assertEqual(driver.current, 'Alice · department')

    def entry_driver(self):
        driver = UnreadDriver(); driver.unread = False
        image = driver.capture(1)
        ImageDraw.Draw(image).ellipse((60, 30, 76, 46), fill=(255, 60, 30))
        driver.capture = lambda _: image
        driver.read = lambda _: [row('Unknown')]
        return driver, image

    def test_entry_then_conversation_click_reads_latest_unread_once(self):
        with tempfile.TemporaryDirectory() as directory:
            driver, entry_image = self.entry_driver()
            driver.phase = 'menu'
            sidebar_image = Image.new('RGB', (1000, 800), 'white')
            ImageDraw.Draw(sidebar_image).ellipse((130, 90, 146, 106), fill=(255, 60, 30))
            clean = Image.new('RGB', (1000, 800), 'white')
            driver.capture = lambda _: entry_image if driver.phase == 'menu' else sidebar_image if driver.phase == 'list' else clean
            def read(crop):
                if crop.width == 250: return [row('Unknown' if driver.phase == 'menu' else 'Alice · team')]
                return [row(driver.current)]
            driver.read = read
            def click(h,l,b,before_click=None,**kw):
                if before_click: before_click()
                driver.clicks.append(b)
                if driver.phase == 'menu': driver.phase = 'list'
                else: driver.phase = 'chat'; driver.current = 'Alice · team'
                return driver.capture(h)
            driver.click_region = click
            session = self.session(directory, driver)
            session.poll_unread(); session.poll_unread(); session.poll_unread()
            self.assertEqual(len(driver.clicks), 2)
            self.assertEqual(driver.clicks[0], config()['layout']['notification'])
            self.assertGreater(driver.clicks[1][0], .1)
            self.assertEqual([m['text'] for m in session.store.data['pending']], ['question'])

    def test_entry_timeout_and_flickering_badge_do_not_repeat_navigation(self):
        with tempfile.TemporaryDirectory() as directory:
            driver, image = self.entry_driver()
            def click(h,l,b,before_click=None,**kw):
                if before_click: before_click()
                driver.clicks.append(b)
                raise DesktopUnavailable('simulated post-click capture failure')
            driver.click_region = click
            session = self.session(directory, driver)
            with self.assertRaises(DesktopUnavailable): session.poll_unread()
            driver.capture = lambda _: Image.new('RGB', (1000, 800), 'white')
            self.assertIn('停止重复点击', session.poll_unread()[1])
            driver.capture = lambda _: image
            self.assertIn('停止重复点击', session.poll_unread()[1])
            self.assertEqual(len(driver.clicks), 1)

    def test_human_idle_deferral_does_not_consume_entry_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            driver, image = self.entry_driver()
            driver.click_region = lambda *a,**kw: (_ for _ in ()).throw(DesktopDeferred('busy'))
            session = self.session(directory, driver)
            with self.assertRaises(DesktopDeferred): session.poll_unread()
            self.assertIsNone(session.navigation_attempted)
            def click(h,l,b,before_click=None,**kw):
                if before_click: before_click()
                driver.clicks.append(b)
                return image
            driver.click_region = click
            session.poll_unread()
            self.assertEqual(len(driver.clicks), 1)

    def test_failed_conversation_click_cools_down_without_consuming_unread(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver()
            def click(h,l,b,before_click=None,**kw):
                if before_click: before_click()
                driver.clicks.append(b)
                return driver.capture(h)
            driver.click_region = click
            session = self.session(directory, driver)
            with patch('desktop_gateway.time.monotonic', return_value=100):
                with self.assertRaisesRegex(DesktopUnavailable, '冷却 15 秒'): session.poll_unread()
                session.poll_unread()
            self.assertEqual(len(driver.clicks), 1)
            self.assertTrue(driver.unread)
            self.assertEqual(session.store.data['pending'], [])
            with patch('desktop_gateway.time.monotonic', return_value=116):
                with self.assertRaises(DesktopUnavailable): session.poll_unread()
            self.assertEqual(len(driver.clicks), 2)

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
            driver.read = lambda _: [row('未绑定会话')]
            session = DesktopSession(config(), Store(Path(directory)/'state.json'), driver)
            session.set_routes([dict(chatId='Alice', chatType='direct')])
            session.poll_unread(); session.poll_unread()
            self.assertEqual(driver.clicks, [])
            self.assertEqual(session.store.data['pending'], [])

    def test_visible_bound_chat_without_badge_establishes_baseline_then_receives_new_text(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); driver.unread = False
            session = self.session(directory, driver)
            session.poll_unread(); session.poll_unread()
            self.assertEqual(len(driver.clicks), 1)
            self.assertEqual(session.store.data['pending'], [])
            self.assertEqual(session.unread_pending, set())
            driver.bubbles.append(Bubble('new without badge', 'incoming'))
            session.poll_unread(); session.poll_unread()
            self.assertEqual([m['text'] for m in session.store.data['pending']], ['new without badge'])

    def test_no_badge_fallback_skips_paused_and_duplicate_titles(self):
        for rows, paused in (([row('Alice')], True), ([row('Alice',20),row('Alice',120)],False)):
            with self.subTest(paused=paused), tempfile.TemporaryDirectory() as directory:
                driver = UnreadDriver(); driver.unread = False
                driver.read = lambda image:rows if image.width==250 else [row('other')]
                session = self.session(directory, driver)
                session.set_routes([dict(chatId='Alice',chatType='direct',paused=paused)])
                session.poll_unread(); session.poll_unread()
                self.assertEqual(driver.clicks, [])

    def test_no_badge_checks_rotate_without_rapid_conversation_switches(self):
        with tempfile.TemporaryDirectory() as directory:
            driver=UnreadDriver();driver.unread=False
            driver.read=lambda image:[row('Alice',20),row('Bob',120)] if image.width==250 else [row(driver.current)]
            def click(h,l,box,before_click=None):
                if before_click:before_click()
                driver.clicks.append(box)
                driver.current='Alice' if box[1]<.2 else 'Bob'
                return driver.capture(h)
            driver.click_region=click
            session=self.session(directory,driver)
            session.set_routes([dict(chatId=name,chatType='direct') for name in ('Alice','Bob')])
            with patch('desktop_gateway.time.monotonic',return_value=100):
                session.poll_unread();session.poll_unread()
            self.assertEqual(driver.current,'Alice')
            with patch('desktop_gateway.time.monotonic',return_value=114):session.poll_unread()
            self.assertEqual(len(driver.clicks),1)
            with patch('desktop_gateway.time.monotonic',return_value=116):
                session.poll_unread();session.poll_unread()
            self.assertEqual(driver.current,'Bob')
            self.assertEqual(len(driver.clicks),2)
            self.assertEqual(session.store.data['pending'],[])

    def test_send_interrupt_after_click_preserves_cleared_unread_badge(self):
        from desktop_gateway import ObservationInterrupted
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); session = self.session(directory,driver)
            click = driver.click_region
            def interrupt(*args,**kwargs):
                click(*args,**kwargs)
                raise ObservationInterrupted()
            driver.click_region = interrupt
            with self.assertRaises(ObservationInterrupted): session.poll_unread()
            self.assertFalse(driver.unread)
            self.assertIn('direct:Alice',session.store.data['unread'])
            driver.click_region = click
            session.poll_unread(); session.poll_unread()
            self.assertEqual([m['text'] for m in session.store.data['pending']], ['question'])

    def test_empty_unread_chat_cannot_starve_other_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = UnreadDriver(); driver.bubbles = []
            session = DesktopSession(config(), Store(Path(directory)/'state.json'), driver)
            session.set_routes([dict(chatId='Alice', chatType='direct')])
            for _ in range(4): session.poll_unread()
            self.assertEqual(session.unread_pending, set())
            self.assertIsNone(session.active_route)


class CalibratedInputTests(unittest.TestCase):
    def test_navigation_skips_draft_recognition_in_both_modes(self):
        for mode in ('foreground', 'background'):
            driver = WindowsDesktop.__new__(WindowsDesktop)
            driver.config = dict(config(),inputMode=mode)
            driver.rect = lambda _:(0,0,1000,800);driver.guard = lambda *_:None
            driver.verify_draft = lambda *_:self.fail('Draft OCR must not run during navigation')
            driver.idle = lambda:60;driver.foreground = lambda _:None
            clicks=[];driver.click = lambda *args:clicks.append(args)
            driver.capture = lambda _:'selected'
            with patch('desktop_windows.time.sleep'):
                self.assertEqual(driver.click_region(1,config()['layout'],[.1,.2,.3,.4]),'selected')
            self.assertEqual(len(clicks),1)

    def test_navigation_intent_is_after_guard_and_before_uncertain_click(self):
        driver = WindowsDesktop.__new__(WindowsDesktop)
        driver.config = dict(config(), inputMode='background')
        driver.rect = lambda _: (0,0,1000,800)
        driver.guard = lambda *_: (_ for _ in ()).throw(DesktopDeferred('busy'))
        intent = []
        with self.assertRaises(DesktopDeferred):
            driver.click_region(1, config()['layout'], [.01,.01,.1,.1], before_click=lambda: intent.append(True))
        self.assertEqual(intent, [])
        driver.guard = lambda *_: None
        def click(*_):
            self.assertEqual(intent, [True])
            raise DesktopUnavailable('uncertain pointer result')
        driver.click = click
        with self.assertRaises(DesktopUnavailable):
            driver.click_region(1, config()['layout'], [.01,.01,.1,.1], before_click=lambda: intent.append(True))
        self.assertEqual(intent, [True])

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
