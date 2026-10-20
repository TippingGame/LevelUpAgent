import asyncio
import io
import json
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock
import gateway


class Normalization(unittest.TestCase):
    def test_feishu_uses_message_id_not_event_id_and_actual_self_mention(self):
        raw = {'header': {'event_id': 'delivery-1'}, 'event': {'sender': {'sender_type': 'user', 'sender_id': {'open_id': 'human'}}, 'message': {'message_id': 'stable-message', 'chat_id': 'chat', 'chat_type': 'group', 'message_type': 'text', 'thread_id': 'topic', 'content': json.dumps({'text': '@_user_1 hello'}), 'mentions': [{'key': '@_user_1', 'id': {'open_id': 'self'}}]}}}
        message = gateway.normalize_feishu(raw, 'self')
        self.assertEqual(message['messageId'], 'stable-message')
        self.assertTrue(message['mentioned'])
        self.assertEqual(message['text'], 'hello')
        self.assertEqual(message['topicId'], 'topic')
        self.assertFalse(gateway.normalize_feishu(raw, 'someone-else')['mentioned'])
        raw['event']['sender']['sender_type'] = 'app'
        self.assertTrue(gateway.normalize_feishu(raw, 'self')['senderBot'])

    def test_dingtalk_context_is_not_sent_to_host(self):
        raw = {'msgId': 'message', 'conversationType': '1', 'conversationId': 'chat', 'senderId': 'human', 'chatbotUserId': 'robot', 'msgtype': 'text', 'text': {'content': 'hi'}, 'sessionWebhook': 'https://secret', 'sessionWebhookExpiredTime': 123}
        message = gateway.normalize_dingtalk(raw)
        self.assertEqual(message['chatType'], 'direct')
        self.assertNotIn('secret', json.dumps(message))
        raw['msgtype'] = 'picture'
        self.assertEqual(gateway.normalize_dingtalk(raw)['text'], '')

    def test_onebot_segments_are_plain_text_and_self_is_filtered(self):
        raw = {'post_type': 'message', 'message_type': 'group', 'message_id': 123, 'group_id': 99, 'user_id': 3, 'message': [{'type': 'at', 'data': {'qq': '42'}}, {'type': 'text', 'data': {'text': 'hello'}}, {'type': 'image', 'data': {'url': 'secret'}}]}
        message = gateway.normalize_onebot(raw, '42')
        self.assertEqual(message['text'], 'hello')
        self.assertTrue(message['mentioned'])
        self.assertFalse(message['senderBot'])
        raw['user_id'] = 42
        self.assertTrue(gateway.normalize_onebot(raw, '42')['senderBot'])

    def test_receive_waits_for_host_ack_and_rejects_failed_commit(self):
        output = io.StringIO()
        loop = asyncio.new_event_loop()
        ipc = gateway.IPC({}, loop)
        errors = []
        def receive():
            try:
                ipc.receive_sync({'messageId': 'one', 'text': 'hello'})
            except Exception as exc:
                errors.append(type(exc).__name__)
        with patch.object(gateway, 'PROTOCOL', output):
            worker = threading.Thread(target=receive)
            worker.start()
            deadline = time.monotonic() + 1
            while not output.getvalue() and time.monotonic() < deadline:
                time.sleep(.005)
            self.assertTrue(worker.is_alive(), 'SDK callback must wait for durable commit')
            request = json.loads(output.getvalue())
            done, result = ipc.pending[request['requestId']]
            result.append(False)
            done.set()
            worker.join(2)
        self.assertEqual(errors, ['RuntimeError'])
        loop.close()


class OneBotProtocol(unittest.IsolatedAsyncioTestCase):
    async def test_real_stdio_process_auth_receive_send_and_exit(self):
        import websockets
        received_send = asyncio.Event()
        async def peer(ws, path):
            self.assertEqual(ws.request_headers.get('Authorization'), 'Bearer local-test-token')
            async for raw in ws:
                request = json.loads(raw)
                if request['action'] == 'get_login_info':
                    await ws.send(json.dumps({'status': 'ok', 'retcode': 0, 'echo': request['echo'], 'data': {'user_id': 42}}))
                    await ws.send(json.dumps({'post_type': 'message', 'self_id': 42, 'message_type': 'private', 'message_id': 7, 'user_id': 8, 'message': [{'type': 'text', 'data': {'text': 'test'}}]}))
                else:
                    self.assertEqual(request['action'], 'send_private_msg')
                    self.assertEqual(request['params']['message'], [{'type': 'text', 'data': {'text': '[CQ:at,qq=all] literal'}}])
                    received_send.set()
                    await ws.send(json.dumps({'status': 'ok', 'retcode': 0, 'echo': request['echo'], 'data': {'message_id': 9}}))
        async with websockets.serve(peer, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            child = await asyncio.create_subprocess_exec(sys.executable, '-u', str(Path(gateway.__file__)), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            def write(value):
                child.stdin.write((json.dumps(value) + '\n').encode())
            write({'type': 'configure', 'version': 1, 'account': {'id': 'test', 'platform': 'onebot', 'appId': '42', 'endpoint': 'ws://127.0.0.1:' + str(port)}, 'secret': 'local-test-token'})
            try:
                message = None
                delivered = False
                for _ in range(10):
                    frame = json.loads(await asyncio.wait_for(child.stdout.readline(), 5))
                    if frame['type'] == 'inbound':
                        message = frame['message']
                        write({'type': 'ack', 'requestId': frame['requestId'], 'ok': True})
                        write({'type': 'send', 'delivery': {'id': 'delivery', 'inbound': message, 'text': '[CQ:at,qq=all] literal'}})
                    if frame['type'] == 'delivery':
                        self.assertEqual(frame['status'], 'sent')
                        delivered = True
                        break
                self.assertTrue(delivered)
                self.assertEqual(message['messageId'], '7')
                self.assertTrue(received_send.is_set())
                await next(iter(server.websockets)).close()
                child.stdin.close()
                await asyncio.wait_for(child.wait(), 5)
            finally:
                if child.returncode is None:
                    child.kill()
                    await child.wait()


class OfficialAdapters(unittest.IsolatedAsyncioTestCase):
    def ipc(self, platform):
        ipc = gateway.IPC({'appId': '42', 'platform': platform, 'tenantId': ''}, asyncio.get_running_loop())
        ipc.receive_sync = lambda message: self.received.append(message)
        ipc.receive = AsyncMock(side_effect=lambda message: self.received.append(message))
        ipc.status = lambda status: None
        self.received = []
        return ipc

    async def test_qq_sdk_dispatch_commits_synchronously_and_rolls_back_resume_sequence(self):
        import botpy
        from types import SimpleNamespace
        from botpy.gateway import BotWebSocket
        ipc = self.ipc('qq')
        adapter = gateway.QQ(ipc, 'unused')
        with patch.object(botpy.Client, 'start', AsyncMock()):
            await adapter.start()
        msg = SimpleNamespace(id='qq-message', group_openid='group', content='Hello', author=SimpleNamespace(member_openid='human'))
        adapter.client.ws_dispatch('group_at_message_create', msg)
        self.assertEqual(len(self.received), 1)
        self.assertEqual(self.received[0]['chatType'], 'group')
        direct = SimpleNamespace(id='qq-direct', content='Direct text', author=SimpleNamespace(user_openid='direct-human'))
        adapter.client.ws_dispatch('c2c_message_create', direct)
        self.assertEqual(self.received[-1]['chatType'], 'direct')
        self.assertEqual(self.received[-1]['chatId'], 'direct-human')
        session = {'last_seq': 9}
        adapter.client._connection = SimpleNamespace(parser={})
        async def fail(ws_self):
            await ws_self.on_message(None, '{}')
        async def mutate_then_fail(ws_self, ws, message):
            ws_self._session['last_seq'] = 10
            raise RuntimeError('host commit failed')
        with patch.object(BotWebSocket, 'ws_connect', fail), patch.object(BotWebSocket, 'on_message', mutate_then_fail), patch.object(BotWebSocket, 'on_error', AsyncMock()):
            await adapter.client.bot_connect(session)
        self.assertEqual(session['last_seq'], 9)

    async def test_dingtalk_sdk_callback_ack_follows_host_commit(self):
        import dingtalk_stream as sdk
        from types import SimpleNamespace
        ipc = self.ipc('dingtalk')
        adapter = gateway.DingTalk(ipc, 'unused')
        with patch.object(sdk.DingTalkStreamClient, 'start', AsyncMock()):
            await adapter.start()
        handler = adapter.client.callback_handler_map[sdk.ChatbotMessage.TOPIC]
        raw = dict(msgId='one', conversationType='2', conversationId='group', senderId='human', chatbotUserId='bot', msgtype='text', text={'content': 'Hi'}, isInAtList=True)
        result = await handler.process(SimpleNamespace(data=raw))
        self.assertEqual(result[0], 200)
        self.assertEqual(len(self.received), 1)
        ipc.receive = AsyncMock(side_effect=RuntimeError('SQLite failed'))
        self.assertEqual((await handler.process(SimpleNamespace(data=raw)))[0], 500)

    async def test_feishu_official_dispatcher_preserves_message_id_and_propagates_commit_failure(self):
        import lark_oapi as lark
        raw = {'schema': '2.0', 'header': {'event_id': 'attempt-1', 'event_type': 'im.message.receive_v1', 'create_time': '1', 'tenant_key': 'tenant', 'app_id': '42'}, 'event': {'sender': {'sender_type': 'user', 'sender_id': {'open_id': 'human'}}, 'message': {'message_id': 'stable', 'chat_id': 'chat', 'chat_type': 'p2p', 'message_type': 'text', 'content': json.dumps({'text': 'hi'})}}}
        seen = []
        def receive(event):
            seen.append(gateway.normalize_feishu(json.loads(lark.JSON.marshal(event)), 'self'))
            raise RuntimeError('SQLite failed')
        handler = lark.EventDispatcherHandler.builder('', '').register_p2_im_message_receive_v1(receive).build()
        with self.assertRaises(RuntimeError):
            handler._do_without_validation(json.dumps(raw).encode())
        self.assertEqual(seen[0]['messageId'], 'stable')

    async def test_official_senders_single_attempt_token_refresh_and_rejection(self):
        import httpx
        from types import SimpleNamespace
        calls = []
        class Client:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, url, **kwargs):
                calls.append((url, kwargs))
                if '/auth/' in url: return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'ephemeral', 'expire': 7200}, request=httpx.Request('POST', url))
                if 'dingtalk' in url: return httpx.Response(200, json={'errcode': 0})
                return httpx.Response(200, json={'code': 0, 'id': 'sent'})
        delivery = {'id': 'idempotency', 'inbound': {'messageId': 'message', 'chatId': 'chat', 'chatType': 'group'}, 'text': 'plain text'}
        with patch.object(httpx, 'AsyncClient', Client):
            feishu = gateway.Feishu(self.ipc('feishu'), 'secret')
            self.assertEqual(await feishu.send(delivery), 'sent')
            self.assertEqual(calls[-1][1]['json']['uuid'], 'idempotency')
            await feishu.send(delivery)
            self.assertEqual(sum('/auth/' in c[0] for c in calls), 1)
            ding = gateway.DingTalk(self.ipc('dingtalk'), 'secret')
            ding.contexts['message'] = ('https://oapi.dingtalk.com/robot/send?session=secret', int(time.time() * 1000) + 60000)
            self.assertEqual(await ding.send(delivery), 'sent')
            ding.contexts['message'] = ('https://evil.example/robot/send', int(time.time() * 1000) + 60000)
            before = len(calls)
            self.assertEqual(await ding.send(delivery), 'failed')
            self.assertEqual(len(calls), before)
            qq = gateway.QQ(self.ipc('qq'), 'secret')
            token = SimpleNamespace(check_token=AsyncMock(), get_string=lambda: 'QQBot ephemeral')
            qq.client = SimpleNamespace(http=SimpleNamespace(_token=token))
            self.assertEqual(await qq.send(delivery), 'sent')
            token.check_token.assert_awaited_once()
            self.assertEqual(calls[-1][1]['json']['msg_seq'], 1)
        class FailingClient(Client):
            async def post(self, url, **kwargs):
                calls.append((url, kwargs)); raise httpx.ReadTimeout('unknown delivery')
        with patch.object(httpx, 'AsyncClient', FailingClient):
            before = len(calls)
            with self.assertRaises(httpx.ReadTimeout): await qq.send(delivery)
            self.assertEqual(len(calls), before + 1)

    async def test_expired_context_rate_limits_and_server_uncertainty(self):
        import httpx
        from types import SimpleNamespace
        calls = []
        response_status = 429
        class Client:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, url, **kwargs):
                calls.append(url)
                if '/auth/' in url:
                    return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'ephemeral', 'expire': 7200}, request=httpx.Request('POST', url))
                return httpx.Response(response_status, json={'code': 999, 'errcode': 999})
        delivery = {'id': 'outbox', 'inbound': {'messageId': 'm', 'chatId': 'group', 'chatType': 'group'}, 'text': 'answer'}
        feishu = gateway.Feishu(self.ipc('feishu'), 'secret')
        ding = gateway.DingTalk(self.ipc('dingtalk'), 'secret')
        qq = gateway.QQ(self.ipc('qq'), 'secret')
        qq.client = SimpleNamespace(http=SimpleNamespace(_token=SimpleNamespace(check_token=AsyncMock(), get_string=lambda: 'QQBot ephemeral')))
        with patch.object(httpx, 'AsyncClient', Client):
            await feishu.access_token()
            feishu.expires = 0
            await feishu.access_token()
            self.assertEqual(sum('/auth/' in url for url in calls), 2)
            ding.contexts['m'] = ('https://oapi.dingtalk.com/robot/send?session=ephemeral', int(time.time() * 1000) - 1)
            before = len(calls)
            self.assertEqual(await ding.send(delivery), 'failed')
            self.assertEqual(len(calls), before, 'Expired replies must fail before network dispatch')
            ding.contexts['m'] = ('https://oapi.dingtalk.com/robot/send?session=ephemeral', int(time.time() * 1000) + 60000)
            for response_status, expected in [(429, 'failed'), (503, 'delivery_unknown')]:
                for adapter in (feishu, ding, qq):
                    before = len(calls)
                    self.assertEqual(await adapter.send(delivery), expected)
                    self.assertEqual(len(calls), before + 1, 'Do not blindly retry platform sends')


if __name__ == '__main__':
    unittest.main()
