import unittest
from desktop_core import Bubble, MessageTracker, title_matches, is_mention, outgoing_added, validate_config, DEFAULT_LAYOUT


class DesktopRulesTests(unittest.TestCase):
    def test_private_new_only_and_no_self_loop(self):
        tracker = MessageTracker()
        old = Bubble('Earlier conversation', 'incoming')
        self.assertEqual(tracker.observe([old], 'private-a'), [])
        new = Bubble('New question', 'incoming')
        self.assertEqual(len(tracker.observe([old, new], 'private-a')), 1)
        self.assertEqual(tracker.observe([old, new], 'private-a'), [])
        self.assertEqual(tracker.observe([old, new, Bubble('Answer', 'outgoing')], 'private-a'), [])

    def test_group_mentions_are_exact(self):
        for text in ('@小明 你好', '请问 @小明：什么时候？', '@小明\u2005问一下', '＠小明 你好'):
            self.assertTrue(is_mention(text, ['小明']), text)
        for text in ('@小明同学 你好', '小明说了什么', '@另一个人 你好', '@所有人 通知'):
            self.assertFalse(is_mention(text, ['小明']), text)

    def test_repeated_identical_messages_get_distinct_ids(self):
        tracker = MessageTracker()
        message = Bubble('hello', 'incoming')
        tracker.observe([message], 'a')
        first = tracker.observe([message, message], 'a')[0][0]
        second = tracker.observe([message, message, message], 'a')[0][0]
        self.assertNotEqual(first, second)

    def test_scroll_and_lost_overlap_do_not_replay_history(self):
        tracker = MessageTracker()
        a, b, c = [Bubble(t, 'incoming') for t in ('a', 'b', 'c')]
        tracker.observe([b, c], 'a')
        self.assertEqual(tracker.observe([a, b], 'a'), [])
        self.assertEqual(tracker.observe([c], 'a'), [])

    def test_restart_keeps_dedup_baseline(self):
        a = Bubble('a', 'incoming')
        tracker = MessageTracker()
        tracker.observe([a], 'a')
        resumed = MessageTracker(tracker.state.copy())
        self.assertEqual(resumed.observe([a], 'a'), [])

    def test_sender_ambiguity_does_not_cross_chat(self):
        self.assertTrue(title_matches(' 测试群 ', '测试群'))
        self.assertFalse(title_matches('测试群 (20)', '测试群'))
        self.assertFalse(title_matches('A B', 'AB'))
        self.assertFalse(title_matches('测试群二', '测试群'))
        self.assertFalse(title_matches('', '测试群'))
        self.assertFalse(title_matches('同名', ''))

    def test_receipt_requires_new_outgoing_echo(self):
        reply = Bubble('ok', 'outgoing')
        self.assertFalse(outgoing_added([reply], [reply], 'ok'))
        self.assertTrue(outgoing_added([reply], [reply, reply], 'ok'))
        self.assertFalse(outgoing_added([], [Bubble('ok', 'incoming')], 'ok'))
        self.assertTrue(outgoing_added([], [Bubble('wrapped\nreply', 'outgoing')], 'wrapped reply'))

    def test_configuration_requires_regions_and_identity(self):
        config = dict(version=1, windowTitle='钉钉', selfNames=['自己'], layout=dict(DEFAULT_LAYOUT))
        self.assertEqual(validate_config(config), config)
        with self.assertRaises(ValueError):
            validate_config(dict(config, selfNames=[]))
        with self.assertRaises(ValueError):
            validate_config(dict(config, layout=dict(DEFAULT_LAYOUT, messages=[0, 0, 2, 1])))


if __name__ == '__main__':
    unittest.main()
