"""DingTalk desktop IPC adapter. No platform credential or network listener.

Visible text only; OCR observations are not authenticated platform events.
Initial views are baselines. Durable pending frames survive host ack failures.
All Windows operations run serially on the main thread.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import uuid
from desktop_core import MessageTracker, validate_config, is_mention, DEFAULT_LAYOUT, matching_route
from desktop_windows import DesktopDeferred, DesktopUnavailable

MAX_FRAME = 65536
PROTOCOL = sys.stdout


class Store:
    def __init__(self, path):
        self.path = Path(path)
        # Corrupt state must stop, never silently lose deduplication/send intent.
        self.data = json.loads(self.path.read_text('utf-8')) if self.path.exists() else dict(version=1, chats={}, pending=[], attempts={})
        if self.data.get('version') != 1:
            raise ValueError('Unsupported desktop state')

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        with temp.open('w', encoding='utf-8') as f:
            json.dump(self.data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, self.path)


class DesktopSession:
    def __init__(self, config, store, driver):
        self.config = validate_config(config)
        self.store, self.driver = store, driver
        self.routes = []
        self.started = set()
        self.stable = {}
        self.unread_pending = set(store.data.get('unread', [])) if config['version'] == 2 else set()
        self.active_route = None
        self.next_route = 0
        self.last_navigation = 0
        self.navigation_attempted = None
        self.unread_attempts = {}
        self.retry_after = {}

    def set_routes(self, routes):
        if any(r.get('scope', 'exact') != 'exact' for r in routes):
            raise ValueError('Desktop automation requires explicitly registered chat titles')
        self.route_rules = [r for r in routes if r.get('chatType') in ('direct', 'group') and r.get('chatId') and not r.get('topicId')]
        self.routes = [r for r in self.route_rules if not r.get('paused')]
        self.driver.routes = self.route_rules
        keys = {self.key(r) for r in self.routes}
        self.started.intersection_update(keys)
        self.stable = {k:v for k,v in self.stable.items() if k in keys}
        self.unread_pending.intersection_update(keys)
        if self.active_route and self.key(self.active_route) not in keys:
            self.active_route = None
        if not self.active_route:
            self.active_route = next((r for r in self.routes if self.key(r) in self.unread_pending), None)
        self.store.data['unread'] = sorted(self.unread_pending)
        self.store.data['pending'] = [m for m in self.store.data['pending'] if any(self.key(r) == self.key(m) and r.get('id') == m.get('_routeId') and r.get('botId') == m.get('_botId') for r in self.routes)]
        self.store.save()

    @staticmethod
    def key(route):
        return route['chatType'] + ':' + route['chatId']

    def observe(self, route, bubbles, unread=False):
        key = self.key(route)
        if unread:
            self.unread_pending.add(key)
        signatures = [b.signature for b in bubbles]
        # Require two identical observations; do not ingest a partially rendered bubble.
        stable = self.stable.get(key) == signatures
        self.stable[key] = signatures
        if not stable:
            return
        state = copy.deepcopy(self.store.data['chats'].get(key))
        tracker = MessageTracker(state)
        if key not in self.started and self.config['version'] == 1:
            tracker.state['previous'] = []
            tracker.state['initialized'] = False
        self.started.add(key)
        events = tracker.observe(bubbles, key, unread=key in self.unread_pending)
        if bubbles and bubbles[-1].direction == 'incoming':
            self.unread_pending.discard(key)
        self.store.data['unread'] = sorted(self.unread_pending)
        for message_id, bubble in events:
            mention = is_mention(bubble.text, self.config['selfNames'])
            if route['chatType'] == 'group' and route.get('mode', 'mention') != 'all' and not mention:
                continue
            # OCR cannot authenticate a group speaker: isolate each event's speaker memory.
            sender = ('desktop-peer:' + hashlib.sha256(key.encode()).hexdigest()[:24]) if route['chatType'] == 'direct' else 'desktop-unverified:' + message_id[:24]
            self.store.data['pending'].append(dict(messageId=message_id, chatType=route['chatType'], chatId=route['chatId'], topicId='', senderId=sender, text=bubble.text.encode('utf-8')[:16000].decode('utf-8', errors='ignore'), mentioned=mention, senderBot=False, _routeId=route.get('id'), _botId=route.get('botId')))
        self.store.data['chats'][key] = tracker.state
        self.store.save()

    def poll_unread(self):
        """Only enter unread registered conversations; observe the open chat too.

        Retain the unread token across the click that clears the badge and the
        two stable OCR frames. Unknown names never become routes implicitly.
        """
        from desktop_calibration import red_badges, conversation_candidates, conversation_title_rows, notification_entry
        driver = self.driver
        hwnd = driver.find(self.config['windowTitle'])
        layout = driver.resolve_layout(hwnd, self.config['layout'])
        rect = driver.rect(hwnd)
        getattr(driver, 'observe_guard', driver.guard)(hwnd, rect)
        image = driver.capture(hwnd)
        sidebar = driver.crop(image, layout['sidebar'])
        lines = driver.read(sidebar)
        badges = red_badges(sidebar)
        candidates = conversation_candidates(lines, badges, self.route_rules)
        candidates = [item for item in candidates if time.monotonic() >= self.retry_after.get(self.key(item[0]), 0)]
        entry = notification_entry(image, layout, driver.read, self.config.get('application', 'dingtalk'))
        visible_routes = [matching_route(r['text'], self.route_rules) for r in conversation_title_rows(lines, self.route_rules)]
        titles = driver.read(driver.crop(image, layout['title']))
        current = matching_route('\n'.join(r['text'] for r in titles if r['confidence'] >= .8), self.route_rules)
        if current and not driver.title(image, layout, current['chatId']):
            current = None
        # Read visible chats directly. Try an unchanged entry badge once only;
        # a failed navigation must not turn into repeated blind menu clicks.
        # Key retries to calibration, not jittering OCR coordinates or badges.
        signature = tuple(layout['notification']) if entry['box'] and entry['unread'] else None
        if any(visible_routes) or current or candidates:
            self.navigation_attempted = None
        navigation_waiting = self.navigation_attempted is not None
        navigated = False
        if (signature and not candidates and not any(visible_routes) and not current
                and not (self.active_route and self.key(self.active_route) in self.unread_pending)):
            if signature == self.navigation_attempted:
                navigation_waiting = True
            elif time.monotonic() - self.last_navigation > 10:
                def navigation_intent():
                    self.navigation_attempted = signature
                    self.last_navigation = time.monotonic()
                image = driver.click_region(hwnd, layout, entry['box'], require_empty=False, before_click=navigation_intent)
                navigation_waiting = True
                navigated = True
        if navigated:
            sidebar = driver.crop(image, layout['sidebar'])
            lines, badges = driver.read(sidebar), red_badges(sidebar)
            candidates = conversation_candidates(lines, badges, self.route_rules)
            candidates = [item for item in candidates if time.monotonic() >= self.retry_after.get(self.key(item[0]), 0)]
        route = self.active_route
        if route and self.key(route) in self.unread_pending:
            # Finish reading this chat before consuming another badge.
            pass
        elif candidates:
            route, row = candidates[self.next_route % len(candidates)]
            self.next_route += 1
            if not driver.title(image, layout, route['chatId']):
                area = layout['sidebar']
                box = [area[0]+row['x']/image.width, area[1]+row['y']/image.height,
                       area[0]+(row['x']+row['w'])/image.width, area[1]+(row['y']+row['h'])/image.height]
                def conversation_intent():
                    # A failed/uncertain navigation should not hammer the same
                    # row every scan. Other unread conversations can continue.
                    self.retry_after[self.key(route)] = time.monotonic() + 15
                image = driver.click_region(hwnd, layout, box, before_click=conversation_intent)
            if not driver.title(image, layout, route['chatId']):
                raise DesktopUnavailable('未读会话切换后的标题未命中名称，已冷却 15 秒；请核对标题栏、会话栏及执行方式')
            self.retry_after.pop(self.key(route), None)
            self.unread_pending.add(self.key(route))
            self.active_route = route
            self.store.data['unread'] = sorted(self.unread_pending)
            self.store.save()
        else:
            route = current
            if navigated:
                titles = driver.read(driver.crop(image, layout['title']))
                route = matching_route('\n'.join(r['text'] for r in titles if r['confidence'] >= .8), self.route_rules)
                if route and not driver.title(image, layout, route['chatId']):
                    route = None
            self.active_route = route
        if not route:
            if navigation_waiting:
                return ('waiting', '已点击消息入口，但仍未找到已绑定会话；停止重复点击，请检查会话栏框选、绑定名称及后台点击兼容性')
            if not entry['box']:
                return ('waiting', entry['detail'])
            headings = conversation_title_rows(lines, self.route_rules)
            if not headings:
                return ('waiting', '会话栏未识别到文字；请检查窗口画面和会话栏框选，实时识别预览可查看结果')
            if not badges:
                return ('online', f'会话栏识别到 {len(headings)} 行文字，未检测到未读红点；当前标题未匹配已绑定名称（DING、审批红点不作为聊天未读）')
            return ('waiting', f'会话栏检测到 {len(badges)} 个红点，但未找到唯一的已绑定名称；请在实时识别预览核对会话名称、绑定规则和暂停状态')
        key = self.key(route)
        if key in self.unread_pending:
            self.unread_attempts[key] = self.unread_attempts.get(key, 0) + 1
        try:
            bubbles = self.scan(route)
        finally:
            if key not in self.unread_pending:
                self.unread_attempts.pop(key, None)
            elif self.unread_attempts.get(key, 0) >= 4:
                # One unread image/media-only chat must not starve other chats.
                self.unread_pending.discard(key)
                self.store.data['unread'] = sorted(self.unread_pending)
                self.store.save()
                self.unread_attempts.pop(key, None)
                self.retry_after[key] = time.monotonic() + 15
                self.active_route = None
        return self.scan_status(route, bubbles)

    def scan(self, route):
        driver = self.driver
        hwnd = driver.find(self.config['windowTitle'])
        layout = driver.resolve_layout(hwnd, self.config['layout'])
        image = driver.select_chat(hwnd, layout, route['chatId'])
        rect = driver.rect(hwnd)
        bubbles = driver.messages(image, layout)
        getattr(driver, 'observe_guard', driver.guard)(hwnd, rect)
        if not driver.title(driver.capture(hwnd), layout, route['chatId']):
            raise DesktopUnavailable('读取期间聊天标题变化，稍后重试')
        self.observe(route, bubbles)
        return bubbles

    def scan_status(self, route, bubbles):
        title = route['chatId']
        if not bubbles:
            return ('waiting', f'未识别到可读文本消息：{title}；若聊天中已有文字，请暂停连接并重新校准消息区、核对识别预览')
        if self.key(route) not in self.started:
            return ('waiting', f'正在建立历史消息基线：{title}（识别 {len(bubbles)} 条；历史消息不回复）')
        incoming = sum(b.direction == 'incoming' for b in bubbles)
        trigger = '群聊仅 @ 我的显示名时触发' if route['chatType'] == 'group' and route.get('mode', 'mention') != 'all' else '仅处理基线之后的新消息'
        return ('online', f'本地桌面监听中：{title}；识别 {len(bubbles)} 条（收到 {incoming} 条）；{trigger}')

    def deliver(self, delivery):
        self.delivery_detail = ''
        ident = delivery['id']
        attempts = self.store.data['attempts']
        if ident in attempts:
            return attempts[ident] if attempts[ident] in ('sent', 'failed') else 'delivery_unknown'
        inbound = delivery['inbound']
        if not any(self.key(r) == self.key(inbound) for r in self.routes):
            return 'failed'
        dispatched = False
        def intent():
            nonlocal dispatched
            attempts[ident] = 'delivery_unknown'
            self.store.save()
            dispatched = True
        try:
            status = self.driver.send_reply(self.config, inbound['chatId'], delivery['text'], intent)
        except DesktopDeferred as exc:
            self.delivery_detail = str(exc)[:200]
            if not dispatched:
                return 'deferred'  # Host retains the exact reply; no key or send clicked.
            status = 'delivery_unknown'
        except Exception as exc:
            self.delivery_detail = str(exc)[:200] if isinstance(exc, DesktopUnavailable) else type(exc).__name__
            status = 'delivery_unknown' if dispatched else 'failed'
        attempts[ident] = status
        # Keep all uncertain intents; bounded confirmed history, host also deduplicates.
        confirmed = [k for k,v in attempts.items() if v != 'delivery_unknown']
        for old in confirmed[:-2000]:
            del attempts[old]
        self.store.save()
        return status


def emit(value):
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n'
    if len(data.encode('utf-8')) > MAX_FRAME:
        raise ValueError('Frame too large')
    PROTOCOL.write(data)
    PROTOCOL.flush()


def run(config, state_path):
    from desktop_background import desktop_driver
    if config.get('version') != 1 or config.get('type') != 'configure' or config['account']['platform'] != 'dingtalk_desktop':
        raise ValueError('Unsupported desktop protocol')
    session = DesktopSession(config['account']['desktop'], Store(state_path), desktop_driver(config['account']['desktop']))
    session.set_routes(config.get('routes', []))
    frames, closed = queue.Queue(maxsize=64), threading.Event()
    session.driver.stopped = closed.is_set
    # Initialization cannot send or touch chats. Start the EOF guard before
    # any scanning/delivery, but only after native dependencies finish loading.
    session.driver.prepare()
    def read():
        try:
            while True:
                line = sys.stdin.buffer.readline(MAX_FRAME + 1)
                if not line or len(line) > MAX_FRAME or not line.endswith(b'\n'):
                    break
                frames.put(json.loads(line), timeout=3)
        finally:
            closed.set()
            # Host crash/exit must stop a blocked OCR/UIA call from later sending.
            os._exit(0)
    threading.Thread(target=read, daemon=True).start()
    awaiting = None
    next_scan, index, last_status = 0, 0, None
    def status(state, detail):
        nonlocal last_status
        value = (state, detail)
        if value != last_status:
            emit(dict(type='status', status=state, detail=detail[:300]))
            last_status = value
    if session.config.get('inputMode') == 'foreground':
        status('waiting', '前台兼容模式已启动；发送前等待键鼠空闲 5 秒，并激活钉钉')
    else:
        status('waiting', '后台接入已启动；等待绑定聊天，请在其他应用中正常使用键鼠')
    while not closed.is_set():
        try:
            frame = frames.get(timeout=.1)
        except queue.Empty:
            frame = {}
        if frame.get('type') == 'routes':
            session.set_routes(frame.get('routes', []))
        elif frame.get('type') == 'ack' and awaiting and frame.get('requestId') == awaiting[0]:
            if frame.get('ok'):
                session.store.data['pending'] = [m for m in session.store.data['pending'] if m['messageId'] != awaiting[1]]
                session.store.save()
            awaiting = None
        elif frame.get('type') == 'send':
            delivery = frame['delivery']
            result = session.deliver(delivery)
            emit(dict(type='delivery', id=delivery['id'], status=result, detail=session.delivery_detail))
            if result == 'deferred':
                status('waiting', session.delivery_detail or '钉钉正在使用或有草稿；原回复保留排队')
            elif result != 'sent':
                status('waiting', session.delivery_detail or '发送未获确认；查看收发记录与钉钉草稿，不会自动重发')
        if awaiting and time.monotonic() - awaiting[2] > 3:
            awaiting = None
        if not awaiting and session.store.data['pending']:
            message = session.store.data['pending'][0]
            request_id = uuid.uuid4().hex
            emit(dict(type='inbound', requestId=request_id, message=message))
            awaiting = (request_id, message['messageId'], time.monotonic())
        if not awaiting and time.monotonic() >= next_scan:
            next_scan = time.monotonic() + 1.5
            if not session.routes:
                status('waiting', '请开启机器人并绑定私聊或群聊标题')
                continue
            route = session.routes[index % len(session.routes)]
            index += 1
            try:
                if session.config['version'] == 2:
                    status(*session.poll_unread())
                else:
                    bubbles = session.scan(route)
                    status(*session.scan_status(route, bubbles))
            except Exception as exc:
                # These diagnostics contain local adapter errors, never credentials.
                status('waiting', str(exc)[:200])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--state')
    args = parser.parse_args()
    if args.check:
        if os.name != 'nt' or not (3, 10) <= sys.version_info[:2] < (3, 13):
            raise RuntimeError('Requires Windows and Python 3.10–3.12')
        import PIL, uiautomation, rapidocr_onnxruntime  # noqa: F401
        return
    from desktop_windows import WindowsDesktop
    if args.probe:
        request = json.loads(sys.stdin.buffer.readline(MAX_FRAME + 1))
        config = request.get('config') or request
        if request.get('config'):
            validate_config(config)
        driver = WindowsDesktop(config)
        result = driver.probe_windows()
        if request.get('windowTitle'):
            result.update(driver.preview(request['windowTitle'], request.get('layout') or DEFAULT_LAYOUT, capture_only=request.get('captureOnly') is True))
        PROTOCOL.write(json.dumps(result, ensure_ascii=False) + '\n')
        return
    if not args.state:
        raise ValueError('Host must provide state path')
    line = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if len(line) > MAX_FRAME:
        raise ValueError('Frame too large')
    run(json.loads(line), args.state)


if __name__ == '__main__':
    # OCR dependencies must never write diagnostics into protocol stdout.
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
    try:
        main()
    except Exception as exc:
        emit(dict(type='status', status='error', detail=str(exc)[:300]))
        sys.exit(1)
