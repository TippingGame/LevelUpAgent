import ctypes
from contextlib import nullcontext
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch
from desktop_background import BackgroundDesktop
from desktop_core import Bubble, DEFAULT_LAYOUT
from desktop_windows import DesktopDeferred, DesktopUnavailable
from desktop_gateway import DesktopSession


class BackgroundTests(unittest.TestCase):
    def driver(self):
        d = BackgroundDesktop.__new__(BackgroundDesktop)
        d.stopped = lambda: False
        d.unlocked = lambda: True
        d.rect = lambda _: (0,0,1000,800)
        d.user = SimpleNamespace(IsWindow=lambda _:True, IsIconic=lambda _:False,
            GetForegroundWindow=lambda:99, GetAncestor=lambda *_:99)
        d.last_input = lambda: self.fail('must not consult global input')
        d.idle = lambda: self.fail('must not wait for global idle')
        return d

    def test_other_foreground_app_never_blocks_guard(self):
        d=self.driver()
        for stamp in range(10): d.guard(1,(0,0,1000,800),stamp)
        with self.assertRaises(DesktopUnavailable): d.foreground(1)

    def test_human_in_dingtalk_defers_without_stealing_focus(self):
        d=self.driver();d.user.GetAncestor=lambda *_:1
        with self.assertRaises(DesktopDeferred): d.guard(1,d.rect(1))

    def test_lock_shutdown_minimize_and_geometry_fail_closed(self):
        for change in (lambda d:setattr(d,'unlocked',lambda:False),
                       lambda d:setattr(d,'stopped',lambda:True),
                       lambda d:setattr(d.user,'IsIconic',lambda _:True),
                       lambda d:setattr(d,'rect',lambda _:(1,0,1000,800))):
            d=self.driver();change(d)
            with self.assertRaises(DesktopUnavailable): d.guard(1,(0,0,1000,800))

    def test_literal_utf16_and_partial_write_never_retry(self):
        for fail in (False,True):
            d=self.driver();units=[];clicks=[]
            d.native_target=lambda _:2
            d.verify_draft=lambda h,l,t: not t or bytes(b for u in units for b in u.to_bytes(2,'little')).decode('utf-16-le')==t
            d.click=lambda *args:clicks.append(args)
            d.editor=lambda *_:SimpleNamespace(BoundingRectangle=SimpleNamespace(left=310,top=560,right=970,bottom=704))
            d.editor_text=lambda _:''
            def message(h,target,rect,code,unit,param):
                self.assertEqual(code,0x102);units.append(unit)
                if fail:raise DesktopUnavailable('partial')
            d.message=message
            with patch.dict(sys.modules,{'uiautomation':SimpleNamespace(UIAutomationInitializerInThread=nullcontext)}):
                if fail:
                    with self.assertRaises(DesktopUnavailable):d.type_reply(1,DEFAULT_LAYOUT,'中文 {Enter} 😀')
                    self.assertEqual(len(units),1)
                else:
                    d.type_reply(1,DEFAULT_LAYOUT,'中文 {Enter} 😀')
                    self.assertEqual(len(clicks),1)

    def test_control_characters_never_reach_window(self):
        d=self.driver();d.verify_draft=lambda *_:True
        with patch.dict(sys.modules,{'uiautomation':SimpleNamespace()}):
            for character in (chr(10),chr(13),chr(9),chr(0),chr(127)):
                with self.assertRaises(DesktopUnavailable):d.type_reply(1,DEFAULT_LAYOUT,'text'+character)

    def test_bounded_message_failure_does_not_retry(self):
        d=self.driver();d.native_target=lambda _:2;calls=[]
        d.user.SendMessageTimeoutW=lambda *args:calls.append(args) or 0
        with self.assertRaises(DesktopUnavailable):d.message(1,2,d.rect(1),0x102,65,1)
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][4:6],(0x22,1500))

    def test_send_flattens_lines_and_requires_echo_and_empty_draft(self):
        for receipt in (True,False):
            d=self.driver();state={'draft':'','clicked':False};intent=[]
            d.find=lambda _:1;d.select_chat=lambda *_:'image';d.capture=lambda _:'image'
            d.title=lambda *_:True;d.native_target=lambda _:2
            d.verify_draft=lambda h,l,t:state['draft']==t
            d.messages=lambda *_:[Bubble('first second    third','outgoing')] if state['clicked'] and receipt else []
            d.type_reply=lambda h,l,t:state.update(draft=t)
            def click(*_):
                self.assertEqual(state['draft'],'first second    third')
                state.update(clicked=True,draft='')
            d.click=click
            with patch('desktop_background.time.sleep',lambda _:None):
                status=d.send_reply(dict(windowTitle='x',layout=DEFAULT_LAYOUT),'test','first'+chr(10)+'second'+chr(9)+'third',lambda:intent.append(True))
            self.assertEqual(status,'sent' if receipt else 'delivery_unknown')
            self.assertEqual(intent,[True])

    def test_existing_draft_stops_before_durable_intent(self):
        d=self.driver();d.find=lambda _:1;d.select_chat=lambda *_:None;d.capture=lambda _:'image'
        d.title=lambda *_:True;d.verify_draft=lambda *_:False
        with self.assertRaises(DesktopDeferred):
            d.send_reply(dict(windowTitle='x',layout=DEFAULT_LAYOUT),'test','reply',lambda:self.fail('no intent'))

    def test_scan_ignores_other_apps_input_and_rechecks_chat(self):
        for same_chat in (True,False):
            d=self.driver();d.find=lambda _:1;d.select_chat=lambda *_:'image'
            d.messages=lambda *_:[Bubble('new','incoming')];d.capture=lambda _:'image'
            d.title=lambda *_:same_chat
            session=DesktopSession.__new__(DesktopSession)
            session.driver=d;session.config=dict(windowTitle='x',layout=DEFAULT_LAYOUT)
            seen=[];session.observe=lambda route,bubbles:seen.append(bubbles)
            if same_chat:
                session.scan(dict(chatId='test'));self.assertEqual(len(seen),1)
            else:
                with self.assertRaises(DesktopUnavailable):session.scan(dict(chatId='test'))
                self.assertEqual(seen,[])


if __name__=='__main__': unittest.main()
