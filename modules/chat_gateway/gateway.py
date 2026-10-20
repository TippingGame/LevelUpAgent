"""Account-isolated text gateway. Protocol v1 uses inherited stdin/stdout only.

Host owns routing, knowledge, provider requests and durable delivery state. SDKs
own authentication/reconnection; this process never loads agent credentials.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import sys
import threading
import time
import uuid
from urllib.parse import urlparse

MAX_FRAME = 65536
PROTOCOL = sys.stdout


def normalize_feishu(raw, self_id):
    event = raw.get('event', {})
    message = event.get('message', {})
    sender = event.get('sender', {})
    content = json.loads(message.get('content') or '{}')
    text = content.get('text', '') if message.get('message_type') == 'text' else ''
    mentions = message.get('mentions') or []
    mentioned = any(m.get('id', {}).get('open_id') == self_id for m in mentions)
    for mention in mentions:
        if mention.get('id', {}).get('open_id') == self_id:
            text = text.replace(mention.get('key') or '\0', '').strip()
    return dict(messageId=message.get('message_id', ''),
                chatType='direct' if message.get('chat_type') == 'p2p' else 'group',
                chatId=message.get('chat_id', ''), topicId=message.get('thread_id') or '',
                senderId=sender.get('sender_id', {}).get('open_id', ''),
                text=text, mentioned=mentioned, senderBot=sender.get('sender_type') != 'user')


def normalize_dingtalk(raw):
    return dict(messageId=raw.get('msgId', ''),
                chatType='direct' if str(raw.get('conversationType')) == '1' else 'group',
                chatId=raw.get('conversationId', ''), topicId='',
                senderId=raw.get('senderId', ''),
                text=(raw.get('text') or {}).get('content', '') if raw.get('msgtype') == 'text' else '',
                mentioned=bool(raw.get('isInAtList')),
                senderBot=raw.get('senderId') == raw.get('chatbotUserId'))


def normalize_onebot(raw, self_id):
    group = raw.get('message_type') == 'group'
    parts = raw.get('message') or []
    # Require structured segments: never interpret CQ codes as instructions or media.
    if not isinstance(parts, list):
        parts = [{'type': 'text', 'data': {'text': parts}}] if isinstance(parts, str) else []
    text = ''.join(str(s.get('data', {}).get('text', '')) for s in parts if s.get('type') == 'text')
    return dict(messageId=str(raw.get('message_id', '')), chatType='group' if group else 'direct',
                chatId=str(raw.get('group_id') if group else raw.get('user_id', '')), topicId='',
                senderId=str(raw.get('user_id', '')), text=text,
                mentioned=any(s.get('type') == 'at' and str(s.get('data', {}).get('qq')) == self_id for s in parts),
                senderBot=str(raw.get('user_id')) == self_id or raw.get('post_type') == 'message_sent')


class IPC:
    def __init__(self, account, loop):
        self.account, self.loop = account, loop
        self.lock = threading.Lock()
        self.pending = {}
        self.adapter = None
        self.closed = asyncio.Event()
        self.send_lock = asyncio.Lock()

    def emit(self, value):
        data = json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n'
        if len(data.encode('utf-8')) > MAX_FRAME:
            raise ValueError('Frame too large')
        with self.lock:
            PROTOCOL.write(data)
            PROTOCOL.flush()

    def status(self, status):
        self.emit(dict(type='status', status=status))

    def receive_sync(self, message):
        request_id = uuid.uuid4().hex
        done = threading.Event()
        result = []
        with self.lock:
            if len(self.pending) >= 64:
                raise RuntimeError('Inbound queue full')
            self.pending[request_id] = (done, result)
        try:
            # Truncate oversized text, but preserve identifiers for idempotency.
            message['text'] = message.get('text', '').encode('utf-8')[:16000].decode('utf-8', errors='ignore')
            self.emit(dict(type='inbound', requestId=request_id, message=message))
            if not done.wait(2) or not result or not result[0]:
                raise RuntimeError('Host did not commit inbound message')
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    async def receive(self, message):
        await asyncio.to_thread(self.receive_sync, message)

    async def send(self, delivery):
        async with self.send_lock:
            try:
                state = await asyncio.wait_for(self.adapter.send(delivery), 30)
            except Exception:
                # A connection failure after dispatch cannot prove non-delivery.
                state = 'delivery_unknown'
            self.emit(dict(type='delivery', id=delivery['id'], status=state))

    def reader(self):
        try:
            while True:
                line = sys.stdin.buffer.readline(MAX_FRAME + 1)
                if not line or len(line) > MAX_FRAME or not line.endswith(b'\n'):
                    break
                value = json.loads(line)
                if value.get('type') == 'ack':
                    with self.lock:
                        item = self.pending.get(value.get('requestId'))
                        if item:
                            item[1].append(value.get('ok') is True)
                            item[0].set()
                elif value.get('type') == 'send':
                    asyncio.run_coroutine_threadsafe(self.send(value['delivery']), self.loop)
        finally:
            self.loop.call_soon_threadsafe(self.closed.set)


class Feishu:
    def __init__(self, ipc, secret):
        self.ipc, self.secret, self.token, self.expires, self.self_id = ipc, secret, '', 0, ''
        self.token_lock = asyncio.Lock()

    async def access_token(self):
        import httpx
        async with self.token_lock:
            if time.monotonic() < self.expires:
                return self.token
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
                    json={'app_id': self.ipc.account['appId'], 'app_secret': self.secret})
                response.raise_for_status()
                data = response.json()
            if data.get('code') != 0 or not data.get('tenant_access_token'):
                raise RuntimeError('Feishu authentication rejected')
            self.token = data['tenant_access_token']
            self.expires = time.monotonic() + max(30, int(data.get('expire', 7200)) - 120)
            return self.token

    async def start(self):
        import httpx
        token = await self.access_token()
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get('https://open.feishu.cn/open-apis/bot/v3/info', headers={'Authorization': 'Bearer ' + token})
            data = response.json()
            self.self_id = data.get('bot', {}).get('open_id', '')
        if not self.self_id:
            raise RuntimeError('Could not resolve Feishu bot identity')
        def run():
            asyncio.set_event_loop(asyncio.new_event_loop())
            import lark_oapi as lark
            def receive(event):
                raw = json.loads(lark.JSON.marshal(event))
                tenant = self.ipc.account.get('tenantId')
                if tenant and raw.get('header', {}).get('tenant_key') != tenant:
                    return
                # Synchronous handler blocks SDK ack until the host commits SQLite.
                self.ipc.receive_sync(normalize_feishu(raw, self.self_id))
            handler = lark.EventDispatcherHandler.builder('', '').register_p2_im_message_receive_v1(receive).build()
            class Client(lark.ws.Client):
                async def _connect(client_self):
                    await super()._connect()
                    self.ipc.status('online')
            client = Client(self.ipc.account['appId'], self.secret, event_handler=handler, log_level=lark.LogLevel.ERROR)
            client.on_reconnecting = lambda: self.ipc.status('connecting')
            client.start()
        # SDK owns a separate event loop; daemon exits with this isolated process.
        def supervise():
            try:
                run()
            except Exception:
                self.ipc.loop.call_soon_threadsafe(self.ipc.closed.set)
        threading.Thread(target=supervise, daemon=True).start()
        await self.ipc.closed.wait()

    async def send(self, delivery):
        import httpx
        token = await self.access_token()
        message = delivery['inbound']
        # Plain text only; no automatic mentions, card fallback or hidden retries.
        body = dict(msg_type='text', content=json.dumps({'text': delivery['text']}, ensure_ascii=False), uuid=delivery['id'])
        url = 'https://open.feishu.cn/open-apis/im/v1/messages/' + message['messageId'] + '/reply'
        if message.get('topicId'):
            body['reply_in_thread'] = True
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            response = await client.post(url, headers={'Authorization': 'Bearer ' + token}, json=body)
        if response.status_code >= 500:
            return 'delivery_unknown'
        data = response.json()
        return 'sent' if response.is_success and data.get('code') == 0 else 'failed'


class DingTalk:
    def __init__(self, ipc, secret):
        self.ipc, self.secret, self.contexts = ipc, secret, {}

    async def start(self):
        import dingtalk_stream as sdk
        adapter = self
        class Handler(sdk.ChatbotHandler):
            async def process(self, callback):
                raw = callback.data
                message = normalize_dingtalk(raw)
                tenant = adapter.ipc.account.get('tenantId')
                if tenant and raw.get('senderCorpId') != tenant:
                    return 200, 'IGNORED'
                # Expiring reply URLs remain solely in this process, never in SQLite.
                adapter.contexts[message['messageId']] = (raw.get('sessionWebhook', ''), raw.get('sessionWebhookExpiredTime', 0))
                if len(adapter.contexts) > 1000:
                    adapter.contexts.pop(next(iter(adapter.contexts)))
                try:
                    await adapter.ipc.receive(message)
                    return 200, 'OK'
                except Exception:
                    return 500, 'RETRY'
        self.client = sdk.DingTalkStreamClient(sdk.Credential(self.ipc.account['appId'], self.secret))
        self.client.register_callback_handler(sdk.ChatbotMessage.TOPIC, Handler())
        async def observe():
            previous = False
            while True:
                connected = bool(self.client.websocket and not self.client.websocket.closed)
                if connected != previous:
                    self.ipc.status('online' if connected else 'connecting')
                    previous = connected
                await asyncio.sleep(1)
        observer = asyncio.create_task(observe())
        try:
            await self.client.start()
        finally:
            observer.cancel()

    async def send(self, delivery):
        import httpx
        context = self.contexts.get(delivery['inbound']['messageId'])
        if not context:
            return 'failed'
        endpoint, expiry = context
        parsed = urlparse(endpoint)
        if parsed.scheme != 'https' or parsed.hostname != 'oapi.dingtalk.com' or parsed.username or parsed.port not in (None, 443) or int(expiry or 0) <= int(time.time() * 1000):
            return 'failed'
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            response = await client.post(endpoint, json={'msgtype': 'text', 'text': {'content': delivery['text']}})
        if response.status_code >= 500:
            return 'delivery_unknown'
        return 'sent' if response.is_success and response.json().get('errcode') == 0 else 'failed'


class QQ:
    def __init__(self, ipc, secret):
        self.ipc, self.secret = ipc, secret

    async def start(self):
        import botpy
        from botpy.gateway import BotWebSocket
        adapter = self
        class DurableWebSocket(BotWebSocket):
            async def on_message(self, ws, message):
                previous = self._session['last_seq']
                try:
                    await super().on_message(ws, message)
                except Exception:
                    # The SDK updates resume sequence before dispatch. A failed
                    # commit must restore it so reconnect can replay the event.
                    self._session['last_seq'] = previous
                    raise
            async def on_closed(self, code, message):
                adapter.ipc.status('connecting')
                await super().on_closed(code, message)
        class Client(botpy.Client):
            async def bot_connect(self, session):
                connection = DurableWebSocket(session, self._connection)
                try:
                    await connection.ws_connect()
                except Exception as exc:
                    adapter.ipc.status('connecting')
                    await connection.on_error(exc)
            def ws_dispatch(self, event, *args, **kwargs):
                # botpy normally schedules user callbacks after returning. Commit the
                # host inbox synchronously before this dispatch returns instead.
                if event in ('group_at_message_create', 'c2c_message_create'):
                    message = args[0]
                    group = event == 'group_at_message_create'
                    sender = message.author.member_openid if group else message.author.user_openid
                    adapter.ipc.receive_sync(dict(messageId=message.id, chatType='group' if group else 'direct', chatId=message.group_openid if group else sender, topicId='', senderId=sender, text=message.content or '', mentioned=group, senderBot=False))
                    return
                return super().ws_dispatch(event, *args, **kwargs)
            async def on_ready(self):
                adapter.ipc.status('online')
            async def on_resumed(self):
                adapter.ipc.status('online')
        self.client = Client(intents=botpy.Intents(public_messages=True), is_sandbox=False, bot_log=False, ext_handlers=False)
        await self.client.start(appid=self.ipc.account['appId'], secret=self.secret)

    async def send(self, delivery):
        message = delivery['inbound']
        import httpx
        from urllib.parse import quote
        # Reuse SDK token refresh, but do a single send: SDK retries connection resets.
        token = self.client.http._token
        await token.check_token()
        scope = 'groups' if message['chatType'] == 'group' else 'users'
        url = 'https://api.sgroup.qq.com/v2/' + scope + '/' + quote(message['chatId'], safe='') + '/messages'
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            response = await client.post(url, headers={'Authorization': token.get_string(), 'X-Union-Appid': self.ipc.account['appId']},
                json=dict(msg_type=0, msg_id=message['messageId'], msg_seq=1, content=delivery['text']))
        if response.status_code >= 500:
            return 'delivery_unknown'
        return 'sent' if response.is_success and response.json().get('id') else 'failed'


class OneBot:
    def __init__(self, ipc, secret):
        self.ipc, self.secret, self.pending, self.socket = ipc, secret, {}, None

    async def call(self, action, params):
        echo = uuid.uuid4().hex
        result = asyncio.get_running_loop().create_future()
        self.pending[echo] = result
        try:
            await self.socket.send(json.dumps(dict(action=action, params=params, echo=echo)))
            return await asyncio.wait_for(result, 20)
        finally:
            self.pending.pop(echo, None)

    async def start(self):
        import websockets
        endpoint = self.ipc.account['endpoint']
        parsed = urlparse(endpoint)
        if parsed.scheme != 'ws' or parsed.hostname not in ('127.0.0.1', '::1') or parsed.username or parsed.password or parsed.query or parsed.fragment or not self.secret:
            raise ValueError('OneBot requires authenticated loopback WebSocket')
        async with websockets.connect(endpoint, extra_headers={'Authorization': 'Bearer ' + self.secret}, max_size=MAX_FRAME, open_timeout=15) as socket:
            self.socket = socket
            async def read():
                async for line in socket:
                    raw = json.loads(line)
                    if raw.get('echo') in self.pending:
                        future = self.pending[raw['echo']]
                        if not future.done():
                            future.set_result(raw)
                    elif raw.get('post_type') in ('message', 'message_sent') and str(raw.get('self_id')) == self.ipc.account['appId']:
                        await self.ipc.receive(normalize_onebot(raw, self.ipc.account['appId']))
            reader = asyncio.create_task(read())
            try:
                login = await self.call('get_login_info', {})
                if login.get('status') != 'ok' or str(login.get('data', {}).get('user_id')) != self.ipc.account['appId']:
                    raise RuntimeError('OneBot account identity mismatch')
                self.ipc.status('online')
                await reader
            finally:
                reader.cancel()

    async def send(self, delivery):
        message = delivery['inbound']
        group = message['chatType'] == 'group'
        result = await self.call('send_group_msg' if group else 'send_private_msg',
            {('group_id' if group else 'user_id'): int(message['chatId']),
             'message': [{'type': 'text', 'data': {'text': delivery['text']}}], 'auto_escape': True})
        return 'sent' if result.get('status') == 'ok' and result.get('retcode') == 0 else 'failed'


def check():
    for name in ('lark_oapi', 'dingtalk_stream', 'botpy', 'websockets', 'httpx'):
        importlib.import_module(name)


async def main(config):
    account = config['account']
    if config.get('version') != 1 or config.get('type') != 'configure':
        raise ValueError('Unsupported protocol')
    ipc = IPC(account, asyncio.get_running_loop())
    ipc.adapter = {'feishu': Feishu, 'dingtalk': DingTalk, 'qq': QQ, 'onebot': OneBot}[account['platform']](ipc, config['secret'])
    threading.Thread(target=ipc.reader, daemon=True).start()
    ipc.status('connecting')
    service = asyncio.create_task(ipc.adapter.start())
    closed = asyncio.create_task(ipc.closed.wait())
    await asyncio.wait((service, closed), return_when=asyncio.FIRST_COMPLETED)
    # Some SDK loops swallow cancellation. Process-level exit is the boundary.
    os._exit(0)


if __name__ == '__main__':
    # SDKs may log request URLs/tokens. They get no access to protocol stdout.
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
    logging.disable(logging.CRITICAL)
    if '--check' in sys.argv:
        check()
        sys.exit(0)
    # Give blocking SDK discovery HTTP calls a finite timeout.
    import requests
    original_request = requests.sessions.Session.request
    def bounded_request(self, *args, **kwargs):
        kwargs.setdefault('timeout', 15)
        return original_request(self, *args, **kwargs)
    requests.sessions.Session.request = bounded_request
    first = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if len(first) > MAX_FRAME:
        sys.exit(2)
    asyncio.run(main(json.loads(first)))
