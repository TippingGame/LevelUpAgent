import ctypes
from contextlib import nullcontext
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch
from desktop_background import BackgroundDesktop, CompatibleDesktop, desktop_driver
from desktop_core import Bubble, DEFAULT_LAYOUT
from desktop_windows import DesktopDeferred, DesktopUnavailable
from desktop_gateway import DesktopSession


class BackgroundTests(unittest.TestCase):
    def driver(self):
        d = BackgroundDesktop.__new__(BackgroundDesktop)
        d.stopped = lambda: False
        d.unlocked = lambda: True
        d.rect = lambda _: (0,0,1000,800)
        d.resolve_layout = lambda hwnd, layout: layout
        d.user = SimpleNamespace(IsWindow=lambda _:True, IsIconic=lambda _:False,
            GetForegroundWindow=lambda:99, GetAncestor=lambda *_:99, IsChild=lambda *_:True)
        d.pointer_target=lambda *_:2
        d.last_input = lambda: self.fail('must not consult global input')
        d.idle = lambda: self.fail('must not wait for global idle')
        return d

    def test_other_foreground_app_never_blocks_guard(self):
        d=self.driver()
        for stamp in range(10): d.guard(1,(0,0,1000,800),stamp)
        with self.assertRaises(DesktopUnavailable): d.foreground(1)

    def test_human_in_dingtalk_defers_without_stealing_focus(self):
        d=self.driver();d.user.GetAncestor=lambda *_:1
        d.idle=lambda:1
        with self.assertRaises(DesktopDeferred): d.guard(1,d.rect(1))

    def test_idle_foreground_dingtalk_can_continue_background_input(self):
        d=self.driver();d.user.GetAncestor=lambda *_:1;d.idle=lambda:5
        d.guard(1,d.rect(1))

    def test_reading_current_chat_does_not_wait_for_human_idle(self):
        d=self.driver();d.user.GetAncestor=lambda *_:1
        d.capture=lambda _:'current';d.title=lambda *_:True
        d.observe_guard(1,d.rect(1))
        self.assertEqual(d.select_chat(1,DEFAULT_LAYOUT,'Alice'),'current')

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

    def test_manual_background_editor_does_not_require_uia_labels(self):
        d=self.driver();d.config={'version':2};units=[];clicks=[]
        d.native_target=lambda _:2
        d.editor=lambda *_:self.fail('manual calibration must not search UIA labels')
        d.verify_draft=lambda h,l,t: not t or ''.join(chr(u) for u in units)==t
        d.click=lambda *args:clicks.append(args)
        d.message=lambda h,target,rect,code,unit,param:units.append(unit)
        with patch.dict(sys.modules,{'uiautomation':SimpleNamespace()}):
            d.type_reply(1,dict(DEFAULT_LAYOUT,editor=[.4,.6,.8,.9]),'测试草稿')
        self.assertEqual(len(clicks),1)
        self.assertAlmostEqual(clicks[0][1],.6)
        self.assertAlmostEqual(clicks[0][2],.75)

    def test_message_rail_outside_chat_uses_own_child_without_global_hit_test(self):
        d=self.driver();d.native_target=lambda _:2
        d.pointer_target=lambda h,p:BackgroundDesktop.pointer_target(d,h,p)
        d.rect=lambda h: (200,50,800,750) if h==2 else (0,0,1000,800)
        d.user.ScreenToClient=lambda *_:True
        d.user.ChildWindowFromPointEx=lambda h,p,f:3 if h in (1,3) else h
        checked=[];d.verify_pointer_target=lambda h,t:checked.append(t)
        self.assertEqual(d.pointer_target(1,ctypes.wintypes.POINT(30,90)),3)
        self.assertTrue(checked)
        self.assertEqual(d.pointer_target(1,ctypes.wintypes.POINT(300,600)),2)

    def test_chat_container_resolves_its_native_list_child(self):
        d=self.driver();d.native_target=lambda _:2
        d.pointer_target=lambda h,p:BackgroundDesktop.pointer_target(d,h,p)
        d.user.ScreenToClient=lambda *_:True
        d.user.ChildWindowFromPointEx=lambda h,p,f:4
        checked=[];d.verify_pointer_target=lambda h,t:checked.append(t)
        self.assertEqual(d.pointer_target(1,ctypes.wintypes.POINT(300,300)),4)
        self.assertEqual(checked,[4,4])

    def test_pointer_messages_recheck_window_identity(self):
        d=self.driver();calls=[]
        d.verify_pointer_target=lambda h,t: (_ for _ in ()).throw(DesktopUnavailable('wrong process'))
        d.user.SendMessageTimeoutW=lambda *args:calls.append(args) or 1
        with self.assertRaises(DesktopUnavailable):d.message(1,3,d.rect(1),0x201,1,0)
        self.assertEqual(calls,[])

    def test_text_uses_calibrated_child_and_rejects_changed_target(self):
        d=self.driver();d.native_target=lambda _:2;calls=[]
        d.config={'version':2,'layout':DEFAULT_LAYOUT}
        d.pointer_target=lambda *_:4
        d.verify_pointer_target=lambda *_:None
        d.user.SendMessageTimeoutW=lambda *args:calls.append(args) or 1
        d.message(1,4,d.rect(1),0x102,65,1)
        self.assertEqual(calls[0][0],4)
        d.pointer_target=lambda *_:5
        with self.assertRaisesRegex(DesktopUnavailable,'输入栏窗口已变化'):
            d.message(1,4,d.rect(1),0x102,66,1)
        self.assertEqual(len(calls),1)
        d.user.IsChild=lambda *_:False
        with self.assertRaisesRegex(DesktopUnavailable,'不属于聊天窗口'):
            d.message(1,6,d.rect(1),0x102,66,1)
        self.assertEqual(len(calls),1)

    def test_typing_addresses_editor_child_instead_of_outer_container(self):
        d=self.driver();d.config={'version':2};d.native_target=lambda _:2
        d.pointer_target=lambda *_:4
        d.verify_draft=lambda *_:True;d.click=lambda *_:None;targets=[]
        d.message=lambda h,target,*args:targets.append(target)
        with patch.dict(sys.modules,{'uiautomation':SimpleNamespace()}):
            d.type_reply(1,DEFAULT_LAYOUT,'test')
        self.assertEqual(targets,[4,4,4,4])

    def test_bounded_message_failure_does_not_retry(self):
        d=self.driver();d.native_target=lambda _:2;calls=[]
        d.verify_pointer_target=lambda *_:None
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

    def test_transient_title_miss_does_not_switch_an_already_open_chat(self):
        d=self.driver();frames=iter(['stale','current'])
        d.capture=lambda _:next(frames);d.title=lambda image,*_:image=='current'
        d.sidebar_matches=lambda *_:self.fail('must not search when current title recovers')
        d.click=lambda *_:self.fail('must not click')
        with patch('desktop_background.time.sleep',lambda _:None):
            self.assertEqual(d.select_chat(1,DEFAULT_LAYOUT,'111'),'current')

    def test_switch_still_requires_postclick_exact_title(self):
        d=self.driver();d.capture=lambda _:'image';d.title=lambda *_:False;d.verify_draft=lambda *_:True
        from PIL import Image
        d.capture=lambda _:Image.new('RGB',(1000,800))
        d.sidebar_matches=lambda *_:[dict(x=10,y=20,w=30,h=20)]
        clicks=[];d.click=lambda *args:clicks.append(args)
        with patch('desktop_background.time.sleep',lambda _:None):
            with self.assertRaisesRegex(DesktopUnavailable,'前台兼容模式'):
                d.select_chat(1,DEFAULT_LAYOUT,'111')
        self.assertEqual(len(clicks),1)

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

    def test_scan_uses_resolved_regions_for_selection_messages_and_title(self):
        d=self.driver();d.find=lambda _:1;d.capture=lambda _:'image'
        native=dict(DEFAULT_LAYOUT,editor=[.38,.72,.99,.93])
        d.resolve_layout=lambda *_:native
        layouts=[]
        d.select_chat=lambda h,l,t:layouts.append(l) or 'image'
        d.messages=lambda i,l:layouts.append(l) or [Bubble('new','incoming')]
        d.title=lambda i,l,t:layouts.append(l) or True
        session=DesktopSession.__new__(DesktopSession)
        session.driver=d;session.config=dict(windowTitle='x',layout=DEFAULT_LAYOUT)
        session.observe=lambda *_:None
        self.assertEqual(session.scan(dict(chatId='test')),[Bubble('new','incoming')])
        self.assertEqual(layouts,[native,native,native])


class CompatibleModeTests(unittest.TestCase):
    def driver(self):
        d=CompatibleDesktop.__new__(CompatibleDesktop)
        d.stopped=lambda:False;d.unlocked=lambda:True;d.rect=lambda _:(0,0,1000,800)
        d.last_input=lambda:7
        d.user=SimpleNamespace(IsWindow=lambda _:True,IsIconic=lambda _:False,
                               GetForegroundWindow=lambda:99,GetAncestor=lambda h,_:h)
        return d

    def test_legacy_accounts_remain_background_and_foreground_requires_selection(self):
        background, foreground = SimpleNamespace(), SimpleNamespace()
        with patch('desktop_background.BackgroundDesktop',return_value=background),patch('desktop_background.CompatibleDesktop',return_value=foreground):
            self.assertIs(desktop_driver({}),background)
            self.assertIs(desktop_driver({'inputMode':'background'}),background)
            self.assertIs(desktop_driver({'inputMode':'foreground'}),foreground)
            self.assertEqual(foreground.config['inputMode'], 'foreground')
            with self.assertRaises(ValueError):desktop_driver({'inputMode':'unknown'})

    def test_reads_do_not_need_focus_but_input_requires_same_window_and_input_stamp(self):
        d=self.driver();rect=d.rect(1)
        d.guard(1,rect)
        with self.assertRaises(DesktopUnavailable):d.guard(1,rect,7)
        # New native Qt input children may own focus inside the selected root.
        d.user.GetForegroundWindow=lambda:2;d.user.GetAncestor=lambda *_:1
        d.guard(1,rect,7)
        with self.assertRaises(DesktopDeferred):d.guard(1,rect,6)
        d.user.IsIconic=lambda _:True
        with self.assertRaises(DesktopUnavailable):d.guard(1,rect)

    def test_chat_switch_never_leaves_an_unverified_draft(self):
        d=self.driver();d.capture=lambda _:'image';d.title=lambda *_:False
        d.verify_draft=lambda *_:False
        with self.assertRaises(DesktopDeferred):d.select_chat(1,DEFAULT_LAYOUT,'other')

    def test_send_uses_resolved_layout_and_foreground_guarded_implementation(self):
        d=self.driver();d.find=lambda _:1
        native=dict(DEFAULT_LAYOUT,editor=[.32,.78,.97,.91]);d.resolve_layout=lambda *_:native
        config=dict(windowTitle='钉钉',layout=DEFAULT_LAYOUT)
        with patch('desktop_windows.WindowsDesktop.send_reply',return_value='sent') as send:
            self.assertEqual(d.send_reply(config,'222','test',None),'sent')
            self.assertEqual(send.call_args.args[0]['layout'],native)
            self.assertEqual(config['layout'],DEFAULT_LAYOUT)


if __name__=='__main__': unittest.main()
