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
from desktop_core import MessageTracker, validate_config, is_mention, DEFAULT_LAYOUT
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

    def set_routes(self, routes):
        if any(r.get('scope', 'exact') != 'exact' for r in routes):
            raise ValueError('Desktop automation requires explicitly registered chat titles')
        self.routes = [r for r in routes if r.get('chatType') in ('direct', 'group') and not r.get('paused') and r.get('chatId') and not r.get('topicId')]
        keys = {self.key(r) for r in self.routes}
        self.started.intersection_update(keys)
        self.stable = {k:v for k,v in self.stable.items() if k in keys}
        self.store.data['pending'] = [m for m in self.store.data['pending'] if any(self.key(r) == self.key(m) and r.get('id') == m.get('_routeId') and r.get('botId') == m.get('_botId') for r in self.routes)]
        self.store.save()

    @staticmethod
    def key(route):
        return route['chatType'] + ':' + route['chatId']

    def observe(self, route, bubbles):
        key = self.key(route)
        signatures = [b.signature for b in bubbles]
        # Require two identical observations; do not ingest a partially rendered bubble.
        stable = self.stable.get(key) == signatures
        self.stable[key] = signatures
        if not stable:
            return
        state = copy.deepcopy(self.store.data['chats'].get(key))
        tracker = MessageTracker(state)
        if key not in self.started:
            tracker.state['previous'] = []
            tracker.state['initialized'] = False
            self.started.add(key)
        events = tracker.observe(bubbles, key)
        for message_id, bubble in events:
            mention = is_mention(bubble.text, self.config['selfNames'])
            if route['chatType'] == 'group' and route.get('mode', 'mention') != 'all' and not mention:
                continue
            # OCR cannot authenticate a group speaker: isolate each event's speaker memory.
            sender = ('desktop-peer:' + hashlib.sha256(key.encode()).hexdigest()[:24]) if route['chatType'] == 'direct' else 'desktop-unverified:' + message_id[:24]
            self.store.data['pending'].append(dict(messageId=message_id, chatType=route['chatType'], chatId=route['chatId'], topicId='', senderId=sender, text=bubble.text.encode('utf-8')[:16000].decode('utf-8', errors='ignore'), mentioned=mention, senderBot=False, _routeId=route.get('id'), _botId=route.get('botId')))
        self.store.data['chats'][key] = tracker.state
        self.store.save()

    def scan(self, route):
        driver = self.driver
        hwnd = driver.find(self.config['windowTitle'])
        image = driver.select_chat(hwnd, self.config['layout'], route['chatId'])
        rect = driver.rect(hwnd)
        bubbles = driver.messages(image, self.config['layout'])
        driver.guard(hwnd, rect)
        if not driver.title(driver.capture(hwnd), self.config['layout'], route['chatId']):
            raise DesktopUnavailable('读取期间聊天标题变化，稍后重试')
        self.observe(route, bubbles)

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
    from desktop_background import BackgroundDesktop
    if config.get('version') != 1 or config.get('type') != 'configure' or config['account']['platform'] != 'dingtalk_desktop':
        raise ValueError('Unsupported desktop protocol')
    session = DesktopSession(config['account']['desktop'], Store(state_path), BackgroundDesktop())
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
                session.scan(route)
                if session.key(route) in session.started:
                    status('online', '本地桌面监听中：' + route['chatId'])
                else:
                    status('waiting', '正在建立历史消息基线：' + route['chatId'])
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
        driver = WindowsDesktop()
        result = dict(windows=driver.windows())
        if request.get('windowTitle'):
            result.update(driver.preview(request['windowTitle'], request.get('layout') or DEFAULT_LAYOUT, request.get('autoLayout') is True))
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
