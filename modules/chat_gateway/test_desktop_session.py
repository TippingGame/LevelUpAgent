import copy
import json
from pathlib import Path
import tempfile
import unittest
from desktop_core import Bubble, DEFAULT_LAYOUT, MessageTracker
from desktop_gateway import DesktopSession, Store
from desktop_windows import DesktopDeferred


class FakeDesktop:
    def __init__(self):
        self.calls = 0
        self.result = 'sent'
        self.before_error = False
        self.after_error = False
        self.busy = False

    def send_reply(self, config, title, text, intent):
        if self.busy:
            raise DesktopDeferred('Human interaction before any input')
        if self.before_error:
            raise RuntimeError('Wrong target or existing draft')
        intent()
        self.calls += 1
        if self.after_error:
            raise RuntimeError('Receipt unavailable')
        return self.result


class DesktopSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state.json'
        self.driver = FakeDesktop()
        self.config = dict(version=1, windowTitle='钉钉', selfNames=['机器人'], layout=copy.deepcopy(DEFAULT_LAYOUT))
        self.session = DesktopSession(self.config, Store(self.path), self.driver)
        self.route = dict(chatId='测试私聊', chatType='direct', paused=False, topicId='')
        self.session.set_routes([self.route])

    def observe(self, bubbles, route=None):
        self.session.observe(route or self.route, bubbles)
        self.session.observe(route or self.route, bubbles)

    def test_stability_baseline_ack_and_restart(self):
        first = Bubble('旧消息', 'incoming')
        self.observe([first])
        self.assertEqual(self.session.store.data['pending'], [])
        new = Bubble('新问题', 'incoming')
        self.session.observe(self.route, [first,new])
        self.assertEqual(self.session.store.data['pending'], [])
        self.session.observe(self.route, [first,new])
        pending = self.session.store.data['pending']
        self.assertEqual(len(pending), 1)
        restarted = DesktopSession(self.config, Store(self.path), self.driver)
        self.assertEqual(restarted.store.data['pending'], pending)
        restarted.observe(self.route, [first,new])
        restarted.observe(self.route, [first,new])
        self.assertEqual(len(restarted.store.data['pending']), 1)

    def test_first_message_after_stable_empty_chat_is_received(self):
        self.observe([])
        self.observe([Bubble('第一条新消息', 'incoming')])
        self.assertEqual([m['text'] for m in self.session.store.data['pending']], ['第一条新消息'])

    def test_temporary_empty_ocr_does_not_replay_known_history(self):
        first = Bubble('known message', 'incoming')
        self.observe([first])
        self.observe([])
        self.observe([first])
        self.assertEqual(self.session.store.data['pending'], [])

    def test_busy_before_input_defers_same_delivery_without_send_intent(self):
        self.driver.busy = True
        self.assertEqual(self.session.deliver(self.delivery()), 'deferred')
        self.assertEqual(self.session.store.data['attempts'], {})
        self.assertEqual(self.driver.calls, 0)
        self.driver.busy = False
        self.assertEqual(self.session.deliver(self.delivery()), 'sent')
        self.assertEqual(self.driver.calls, 1)

    def test_defer_after_input_is_uncertain_and_never_retried(self):
        def unsafe_driver(config, title, text, intent):
            intent()
            self.driver.calls += 1
            raise DesktopDeferred('Human interaction after possible input')
        self.driver.send_reply = unsafe_driver
        self.assertEqual(self.session.deliver(self.delivery()), 'delivery_unknown')
        self.assertEqual(self.session.deliver(self.delivery()), 'delivery_unknown')
        self.assertEqual(self.driver.calls, 1)

    def test_mentions_only_and_sender_memory_isolation(self):
        group = dict(self.route, chatType='group', chatId='测试群')
        self.session.set_routes([self.route,group])
        a = Bubble('你好', 'incoming')
        b = Bubble('@其他人 问题', 'incoming')
        c = Bubble('@机器人 第一问', 'incoming')
        d = Bubble('@机器人 第二问', 'incoming')
        self.observe([a], group)
        self.observe([a,b], group)
        self.assertEqual(self.session.store.data['pending'], [])
        self.observe([a,b,c,d], group)
        pending = self.session.store.data['pending']
        self.assertEqual(len(pending), 2)
        self.assertTrue(all(m['mentioned'] for m in pending))
        self.assertNotEqual(pending[0]['senderId'], pending[1]['senderId'])

    def test_scroll_back_and_forward_does_not_replay(self):
        tracker = MessageTracker()
        a,b,c,d = [Bubble(t,'incoming') for t in ('a','b','c','d')]
        tracker.observe([a,b,c], 'x')
        tracker.observe([a,b], 'x')
        self.assertEqual(tracker.observe([b,c], 'x'), [])
        self.assertEqual(tracker.observe([a,b,c], 'x'), [])
        self.assertEqual(len(tracker.observe([b,c,d], 'x')), 1)

    def test_group_all_text_opt_in_preserves_baseline_and_outgoing_filter(self):
        group = dict(self.route, chatType='group', chatId='测试群', mode='all')
        self.session.set_routes([group])
        old = Bubble('旧消息', 'incoming')
        plain = Bubble('不用提及的普通群消息', 'incoming')
        outgoing = Bubble('机器人答复', 'outgoing')
        self.observe([old], group)
        self.observe([old, plain, outgoing], group)
        pending = self.session.store.data['pending']
        self.assertEqual([m['text'] for m in pending], [plain.text])
        self.assertFalse(pending[0]['mentioned'])

    def test_wildcard_routes_are_refused_in_desktop_driver(self):
        with self.assertRaisesRegex(ValueError, 'registered'):
            self.session.set_routes([dict(self.route, scope='all', chatId='*')])

    def delivery(self):
        return dict(id='delivery-1', inbound=dict(chatId='测试私聊',chatType='direct'), text='literal {Ctrl}a')

    def test_confirmed_send_is_not_repeated(self):
        self.assertEqual(self.session.deliver(self.delivery()), 'sent')
        self.assertEqual(self.session.deliver(self.delivery()), 'sent')
        self.assertEqual(self.driver.calls, 1)

    def test_uncertain_send_survives_restart_without_retry(self):
        self.driver.after_error = True
        self.assertEqual(self.session.deliver(self.delivery()), 'delivery_unknown')
        restarted = DesktopSession(self.config, Store(self.path), self.driver)
        restarted.set_routes([self.route])
        self.assertEqual(restarted.deliver(self.delivery()), 'delivery_unknown')
        self.assertEqual(self.driver.calls, 1)

    def test_pre_dispatch_failure_and_unbound_route_never_type(self):
        self.driver.before_error = True
        self.assertEqual(self.session.deliver(self.delivery()), 'failed')
        self.session.set_routes([dict(self.route, paused=True)])
        self.assertEqual(self.session.deliver(dict(self.delivery(), id='other')), 'failed')
        self.assertEqual(self.driver.calls, 0)

    def test_delivery_diagnostics_expose_known_errors_without_arbitrary_exception_text(self):
        self.driver.before_error = True
        self.assertEqual(self.session.deliver(self.delivery()), 'failed')
        self.assertEqual(self.session.delivery_detail, 'RuntimeError')
        self.driver.before_error = False
        self.driver.busy = True
        self.assertEqual(self.session.deliver(dict(self.delivery(),id='busy')), 'deferred')
        self.assertEqual(self.session.delivery_detail, 'Human interaction before any input')

    def test_invalid_state_is_not_reset(self):
        self.path.write_text('{corrupt',encoding='utf-8')
        with self.assertRaises(json.JSONDecodeError):
            Store(self.path)

    def test_outgoing_never_becomes_inbound(self):
        first=Bubble('old','incoming')
        self.observe([first])
        self.observe([first,Bubble('@机器人 hello','outgoing')])
        self.assertEqual(self.session.store.data['pending'],[])
        self.assertNotIn('old', self.path.read_text('utf-8'))


if __name__ == '__main__':
    unittest.main()
