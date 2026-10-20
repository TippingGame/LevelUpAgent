import unittest
import sys
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch
from desktop_core import Bubble, DEFAULT_LAYOUT, is_mention
from desktop_windows import WindowsDesktop, DesktopUnavailable, DesktopDeferred, text_bubbles, bubble_regions, mention_action_text, action_card_rows, aligned_ocr_text


class BubbleImageTests(unittest.TestCase):
    def test_outgoing_ocr_fragments_keep_left_to_right_order(self):
        rows=[dict(text='prefix',confidence=.99,x=32,y=26,w=143,h=24),
              dict(text='middle',confidence=.99,x=166,y=25,w=165,h=23),
              dict(text='end.',confidence=.99,x=323,y=27,w=218,h=22)]
        self.assertEqual(aligned_ocr_text(rows,555),'prefix middle end.')
        rows[2]['x']=420
        self.assertIsNone(aligned_ocr_text(rows,600))

    def test_rounded_outgoing_corners_do_not_expand_single_line_ocr_crop(self):
        from PIL import Image,ImageDraw
        image=Image.new('RGB',(240,60),(240,242,244));draw=ImageDraw.Draw(image)
        draw.rounded_rectangle((0,0,239,59),radius=10,fill=(194,229,255))
        draw.rectangle((15,18,200,36),fill='black')
        driver=WindowsDesktop.__new__(WindowsDesktop);driver.prepare=lambda:None
        sizes=[]
        def ocr(pixels,**kwargs):
            sizes.append(pixels.shape[:2]);return ([['exact.',.99]],None)
        driver.ocr=ocr
        self.assertEqual(driver.read_single_line(image),'exact.')
        self.assertLess(sizes[0][0],40)

    def action_rows(self):
        return [dict(text='@测试用户',confidence=.99,x=32,y=29,w=71,h=20),
                dict(text='在吗',confidence=.99,x=107,y=30,w=38,h=20),
                dict(text='收到',confidence=.99,x=48,y=80,w=57,h=21),
                dict(text='回复',confidence=.99,x=183,y=82,w=37,h=20)]

    def test_mention_action_footer_is_excluded_and_inline_fragments_are_joined(self):
        text=mention_action_text(self.action_rows(),252,54)
        self.assertEqual(text,'@测试用户 在吗')
        self.assertTrue(is_mention(text,['测试用户']))
        self.assertFalse(is_mention(text,['其他用户']))

    def test_highlighted_mention_is_ocrd_separately_from_adjacent_sentence(self):
        from PIL import Image,ImageDraw
        body=Image.new('RGB',(252,102),'white')
        ImageDraw.Draw(body).rounded_rectangle((15,14,92,37),radius=4,fill=(0,128,255))
        calls=[]
        def read(image):
            calls.append(image.size)
            if len(calls)==1:return [dict(text='@测试用户',confidence=.99,x=16,y=12,w=74,h=23)]
            return self.action_rows()[1:]
        rows=action_card_rows(body,54,read)
        self.assertEqual(mention_action_text(rows,252,54),'@测试用户 在吗')
        self.assertEqual(len(calls),2)

    def test_uncertain_or_multiple_highlighted_mentions_are_skipped(self):
        from PIL import Image,ImageDraw
        body=Image.new('RGB',(252,102),'white');draw=ImageDraw.Draw(body)
        draw.rectangle((15,14,92,37),fill=(0,128,255))
        self.assertEqual(action_card_rows(body,54,lambda _:[dict(text='@测试用户',confidence=.96)]),[])
        draw.rectangle((110,14,190,37),fill=(0,128,255))
        calls=[]
        self.assertEqual(action_card_rows(body,54,lambda _:calls.append(True)),[])
        self.assertEqual(calls,[])

    def test_mention_cards_require_exact_footer_labels_and_confident_ocr(self):
        for index,field,value in [(0,'confidence',.89),(2,'text','查看'),(3,'text','转发'),
                                  (3,'x',90),(0,'text','普通文字'),(1,'x',95)]:
            with self.subTest(index=index,field=field,value=value):
                rows=self.action_rows();rows[index][field]=value
                self.assertIsNone(mention_action_text(rows,252,54))

    def test_mention_cards_reject_crossing_dividers_and_multiple_columns(self):
        for extra in [dict(text='separator',confidence=.99,x=20,y=60,w=40,h=20),
                      dict(text='column',confidence=.99,x=200,y=29,w=20,h=20),
                      dict(text='footer',confidence=.99,x=110,y=80,w=20,h=20)]:
            self.assertIsNone(mention_action_text(self.action_rows()+[extra],252,54))

    def test_known_mention_card_uses_full_ocr_and_strips_action_buttons(self):
        from PIL import Image,ImageDraw
        image=Image.new('RGB',(800,480),(240,242,244));draw=ImageDraw.Draw(image)
        draw.rounded_rectangle((75,100,326,201),radius=9,fill='white')
        draw.line((75,154,326,154),fill=(233,233,233),width=1)
        self.assertEqual(bubble_regions(image),[])
        self.assertEqual(bubble_regions(image,include_actions=True),[(75,100,252,102,'incoming',54)])
        driver=WindowsDesktop.__new__(WindowsDesktop);driver.read=lambda _:self.action_rows()
        self.assertEqual(driver.messages(image,{'messages':[0,0,1,1]}),[Bubble('@测试用户 在吗','incoming')])
        driver.read=lambda _:self.action_rows()[:-1]
        self.assertEqual(driver.messages(image,{'messages':[0,0,1,1]}),[])

    def test_divided_outgoing_or_multi_separator_cards_remain_excluded(self):
        from PIL import Image,ImageDraw
        for left in [75,450]:
            image=Image.new('RGB',(800,480),(240,242,244));draw=ImageDraw.Draw(image)
            draw.rounded_rectangle((left,100,left+251,201),radius=9,fill='white')
            draw.line((left,154,left+251,154),fill=(233,233,233),width=1)
            if left==75:draw.line((left,140,left+251,140),fill=(233,233,233),width=1)
            self.assertEqual(bubble_regions(image,include_actions=True),[])

    def test_visual_draft_never_treats_unrecognized_visible_glyph_as_empty(self):
        from PIL import Image,ImageDraw
        image=Image.new('RGB',(200,80),(240,242,244));draw=ImageDraw.Draw(image)
        draw.line((10,5,10,29),fill='black',width=1)
        driver=WindowsDesktop.__new__(WindowsDesktop);driver.capture=lambda _:image;driver.read=lambda _:[]
        self.assertTrue(driver.visual_draft(1,{'editor':[0,0,1,1]})['empty'])
        draw.rectangle((20,10,27,26),fill='black')
        self.assertEqual(driver.visual_draft(1,{'editor':[0,0,1,1]}),dict(empty=False,text=None))

    def test_visual_draft_retries_scaled_ocr_without_fuzzy_punctuation_matching(self):
        from PIL import Image,ImageDraw
        image=Image.new('RGB',(200,80),(240,242,244));ImageDraw.Draw(image).rectangle((20,10,100,28),fill='black')
        driver=WindowsDesktop.__new__(WindowsDesktop);driver.capture=lambda _:image
        calls=[]
        def read(im):
            calls.append(im.size)
            return [dict(text='check.' if len(calls)==3 else 'check',confidence=.99,x=1,y=1)]
        driver.read=read
        self.assertEqual(driver.visual_draft(1,{'editor':[0,0,1,1]},'check.')['text'],'check.')
        self.assertEqual(len(calls),3)

    def test_exact_single_line_fallback_keeps_punctuation_required(self):
        from PIL import Image,ImageDraw
        image=Image.new('RGB',(200,80),(240,242,244));ImageDraw.Draw(image).rectangle((20,10,100,28),fill='black')
        driver=WindowsDesktop.__new__(WindowsDesktop);driver.capture=lambda _:image
        driver.read=lambda _:[dict(text='check',confidence=.99,x=1,y=1)]
        driver.read_single_line=lambda _:'check.'
        self.assertEqual(driver.visual_draft(1,{'editor':[0,0,1,1]},'check.')['text'],'check.')
        driver.read_single_line=lambda _:'check!'
        self.assertNotEqual(driver.visual_draft(1,{'editor':[0,0,1,1]},'check.')['text'],'check.')

    def test_single_line_ocr_requires_confidence_and_rejects_wrapped_text(self):
        from PIL import Image,ImageDraw
        image=Image.new('RGB',(200,80),'white');draw=ImageDraw.Draw(image)
        draw.rectangle((20,10,80,28),fill='black')
        driver=WindowsDesktop.__new__(WindowsDesktop);driver.prepare=lambda:None
        driver.ocr=lambda *a,**kw:([['check.',.99]],None)
        self.assertEqual(driver.read_single_line(image),'check.')
        driver.ocr=lambda *a,**kw:([['check.',.96]],None)
        self.assertIsNone(driver.read_single_line(image))
        draw.rectangle((20,42,80,60),fill='black')
        driver.ocr=lambda *a,**kw:self.fail('must not flatten two lines')
        self.assertIsNone(driver.read_single_line(image))

    def test_scaled_canvas_colored_divider_remains_one_action_card(self):
        from PIL import Image,ImageDraw
        image=Image.new('RGB',(1600,960),(240,242,244));draw=ImageDraw.Draw(image)
        draw.rounded_rectangle((150,200,653,403),radius=18,fill='white')
        draw.rectangle((150,307,653,310),fill=(240,242,244))
        regions=bubble_regions(image,include_actions=True)
        self.assertEqual(len(regions),1)
        self.assertIsNotNone(regions[0][5])

    def test_calibrated_regions_exclude_avatar_rails_nested_icons_and_card_dividers(self):
        from PIL import Image, ImageDraw
        image=Image.new('RGB',(800,480),(240,242,244)); draw=ImageDraw.Draw(image)
        draw.rounded_rectangle((75,12,115,64),radius=9,fill='white')
        draw.rounded_rectangle((680,90,720,142),radius=9,fill=(194,229,255))
        draw.rounded_rectangle((15,12,58,55),radius=9,fill=(0,140,255))
        draw.rounded_rectangle((740,90,782,132),radius=9,fill=(0,140,255))
        draw.rounded_rectangle((260,190,720,335),radius=9,fill='white')
        draw.line((272,290,708,290),fill=(233,233,233),width=2)
        draw.rectangle((660,208,688,236),fill=(0,140,255))
        found=bubble_regions(image)
        self.assertEqual([(x,y,side) for x,y,_,_,side in found],[(75,12,'incoming'),(680,90,'outgoing')])
    def test_clipped_and_photographic_regions_are_not_plain_messages(self):
        from PIL import Image,ImageDraw
        import numpy as np
        image=Image.new('RGB',(800,480),(240,242,244));draw=ImageDraw.Draw(image)
        draw.rectangle((75,0,200,40),fill='white')
        pixels=np.asarray(image).copy();pixels[100:200,75:210]=np.random.default_rng(7).integers(0,255,(100,135,3),dtype='uint8')
        self.assertEqual(bubble_regions(Image.fromarray(pixels)),[])
    def test_message_ocr_uses_padded_bodies_and_skips_uncertain_content(self):
        from PIL import Image,ImageDraw
        image=Image.new('RGB',(800,480),(240,242,244));draw=ImageDraw.Draw(image)
        draw.rounded_rectangle((75,12,115,64),radius=9,fill='white')
        driver=WindowsDesktop.__new__(WindowsDesktop)
        sizes=[]
        def read(crop):
            sizes.append(crop.size)
            return [dict(text='1',confidence=.95,x=20,y=25,w=10,h=16)]
        driver.read=read
        self.assertEqual(driver.messages(image,{'messages':[0,0,1,1]}),[Bubble('1','incoming')])
        self.assertEqual(sizes,[(65,77)])
        driver.read=lambda _: [dict(text='?',confidence=.75,x=20,y=25,w=10,h=16)]
        self.assertEqual(driver.messages(image,{'messages':[0,0,1,1]}),[])
    def test_uniform_text_bubbles_exclude_image_text_and_sender_labels(self):
        from PIL import Image, ImageDraw
        import numpy as np
        image = Image.new('RGB', (1000,600), 'white')
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((55,50,260,100), radius=12, fill=(243,243,243))
        draw.rounded_rectangle((700,130,940,205), radius=12, fill=(205,223,255))
        pixels=np.asarray(image).copy()
        pixels[250:380,55:260]=np.random.default_rng(0).integers(0,255,(130,205,3),dtype='uint8')
        image=Image.fromarray(pixels)
        rows=[dict(text='question',x=70,y=66,w=100,h=18,confidence=.99),
              dict(text='answer one',x=715,y=146,w=140,h=18,confidence=.99),
              dict(text='answer two',x=715,y=175,w=140,h=18,confidence=.99),
              dict(text='sender name',x=60,y=20,w=140,h=18,confidence=.99),
              dict(text='image caption',x=70,y=270,w=140,h=18,confidence=.99)]
        bubbles=text_bubbles(image,rows)
        self.assertEqual(bubbles,[Bubble('question','incoming'),Bubble('answer one\nanswer two','outgoing')])


class SendDriver(WindowsDesktop):
    def __init__(self):
        self.stopped=lambda:False
        self.auto_input=None
        self.clicks=0
        self.draft=''
        self.wrong_title=False
        self.human=False
        self.receipt=True
        self.user=type('User',(),dict(GetForegroundWindow=lambda _:1))()
    def idle(self): return 10
    def find(self,title): return 1
    def foreground(self,hwnd): pass
    def select_chat(self,*args): return 'image'
    def rect(self,hwnd): return (0,0,1000,800)
    def last_input(self): return 1
    def unlocked(self): return not self.human
    def capture(self,hwnd): return 'image'
    def messages(self,*args): return [Bubble('new question','incoming')] + ([Bubble('reply','outgoing')] if self.clicks and self.receipt else [])
    def type_reply(self,hwnd,layout,text): self.draft=text; return 1
    def title(self,*args): return not self.wrong_title
    def verify_draft(self,hwnd,layout,text): return self.draft==text
    def click(self,*args): self.clicks+=1; self.draft=''


class GuardedSendTests(unittest.TestCase):
    def setUp(self):
        self.driver=SendDriver()
        self.config=dict(windowTitle='DingTalk',layout=DEFAULT_LAYOUT)
        self.intent=[]
        self.sleep=patch('desktop_windows.time.sleep',lambda _:None)
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
    def send(self):
        return self.driver.send_reply(self.config,'Test','reply',lambda:self.intent.append(True))
    def test_receipt_required(self):
        self.assertEqual(self.send(),'sent')
        self.assertEqual(self.driver.clicks,1)
        self.assertEqual(self.intent,[True])
    def test_no_visible_echo_is_unknown(self):
        self.driver.receipt=False
        self.assertEqual(self.send(),'delivery_unknown')
    def test_wrong_title_prevents_click(self):
        self.driver.wrong_title=True
        with self.assertRaises(DesktopUnavailable): self.send()
        self.assertEqual(self.driver.clicks,0)
        self.assertEqual(self.driver.draft,'')
        self.assertEqual(self.intent,[])
    def test_human_activity_or_shutdown_prevents_typing_and_click(self):
        for field in ('human','stopped'):
            self.driver=SendDriver()
            setattr(self.driver,field,True if field=='human' else lambda:True)
            with self.assertRaises(DesktopUnavailable): self.send()
            self.assertEqual(self.driver.clicks,0)
            self.assertEqual(self.driver.draft,'')


class ForegroundTests(unittest.TestCase):
    def test_accessibility_focus_is_verified_before_proceeding(self):
        driver=SendDriver();state={'hwnd':2,'calls':0}
        driver.user=SimpleNamespace(GetForegroundWindow=lambda:state['hwnd'],SetForegroundWindow=lambda _:False)
        def focus():state.update(hwnd=1,calls=state['calls']+1)
        auto=SimpleNamespace(UIAutomationInitializerInThread=nullcontext,ControlFromHandle=lambda _:SimpleNamespace(SetFocus=focus))
        with patch.dict(sys.modules,{'uiautomation':auto}),patch('desktop_windows.time.sleep',lambda _:None):
            WindowsDesktop.foreground(driver,1)
        self.assertEqual(state['calls'],1)

    def test_refused_foreground_is_deferred_without_typing(self):
        driver=SendDriver();driver.user=SimpleNamespace(GetForegroundWindow=lambda:2,SetForegroundWindow=lambda _:False)
        auto=SimpleNamespace(UIAutomationInitializerInThread=nullcontext,ControlFromHandle=lambda _:SimpleNamespace(SetFocus=lambda:None))
        with patch.dict(sys.modules,{'uiautomation':auto}),patch('desktop_windows.time.sleep',lambda _:None):
            with self.assertRaises(DesktopDeferred):WindowsDesktop.foreground(driver,1)
        self.assertEqual(driver.draft,'');self.assertEqual(driver.clicks,0)

    def test_human_activity_blocks_foreground_request(self):
        driver=SendDriver();driver.idle=lambda:0
        driver.user=SimpleNamespace(GetForegroundWindow=lambda:2,SetForegroundWindow=lambda _:self.fail('must not activate'))
        with self.assertRaises(DesktopDeferred):WindowsDesktop.foreground(driver,1)


class FakeEditor:
    HasKeyboardFocus = True
    def __init__(self, value='', kind='value', partial=False):
        self.value, self.kind, self.partial = value, kind, partial
        self.writes = []
        self.BoundingRectangle=SimpleNamespace(left=310,top=560,right=970,bottom=704)
    @property
    def Value(self): return self.value
    def GetValuePattern(self):
        if self.kind != 'value': raise RuntimeError('No value pattern')
        return self
    def GetTextPattern(self):
        if self.kind != 'text': raise RuntimeError('No text pattern')
        return SimpleNamespace(DocumentRange=SimpleNamespace(GetText=lambda _:self.value))
    def GetLegacyIAccessiblePattern(self):
        if self.kind != 'legacy': raise RuntimeError('No legacy pattern')
        return self
    def SetValue(self, value):
        self.writes.append(value)
        self.value=value[:2] if self.partial else value
        if self.partial: raise RuntimeError('Provider failed after partial write')
    def SetFocus(self): pass


class EditorCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.driver=SendDriver()
        self.control=FakeEditor()
        self.driver.editor=lambda *_:self.control
        self.driver.visual_draft=lambda *_:dict(empty=not self.control.value,text=self.control.value)
        self.driver.verify_draft=lambda h,l,t:WindowsDesktop.verify_draft(self.driver,h,l,t)
        self.units=[]
        def send_input(event):
            vk,unit,flag=event
            if not flag & 2:
                self.units.append(chr(unit));self.control.value+=chr(unit)
            return 1
        self.auto=SimpleNamespace(UIAutomationInitializerInThread=nullcontext,SendInput=send_input,
            KeyboardInput=lambda vk,unit,flag:(vk,unit,flag),
            KeyboardEventFlag=SimpleNamespace(KeyUnicode=4,KeyDown=0,KeyUp=2))
        patcher=patch.dict(sys.modules,{'uiautomation':self.auto});patcher.start();self.addCleanup(patcher.stop)
    def type(self,text):
        return WindowsDesktop.type_reply(self.driver,1,DEFAULT_LAYOUT,text)
    def test_legacy_editor_handles_multiline_without_keyboard(self):
        self.control.kind='legacy'
        self.type('第一行\n第二行 {Enter}')
        self.assertEqual(self.control.value,'第一行\n第二行 {Enter}')
        self.assertEqual(self.units,[])
    def test_keyboard_fallback_never_parses_key_syntax(self):
        self.control.kind='text'
        self.type('文字 {Ctrl}a {Enter}')
        self.assertEqual(''.join(self.units),'文字 {Ctrl}a {Enter}')
    def test_partial_setter_never_appends_duplicate_reply(self):
        self.control.partial=True
        with self.assertRaises(DesktopUnavailable): self.type('abcdef')
        self.assertEqual(self.control.value,'ab')
        self.assertEqual(len(self.control.writes),1)
        self.assertEqual(self.units,[])
    def test_preview_never_writes_or_exposes_existing_draft(self):
        self.control.value='PRIVATE DRAFT'
        report=WindowsDesktop.inspect_editor(self.driver,1,DEFAULT_LAYOUT)
        self.assertTrue(report['readable'])
        self.assertFalse(report['draftEmpty'])
        self.assertNotIn('PRIVATE DRAFT',str(report))
        self.assertEqual(self.control.writes,[])

    def test_focus_click_fallback_requires_verified_focus_and_empty_draft(self):
        self.control.HasKeyboardFocus=False
        points=[]
        def click(hwnd,x,y):
            points.append((x,y));self.control.HasKeyboardFocus=True
        self.driver.click=click
        self.type('verified focus')
        self.assertEqual(len(points),1)
        self.assertEqual(self.control.value,'verified focus')

    def test_focus_fallback_never_types_when_provider_still_reports_no_focus(self):
        self.control.HasKeyboardFocus=False
        with self.assertRaises(DesktopUnavailable):self.type('must not write')
        self.assertEqual(self.control.writes,[])

    def test_visually_nonempty_editor_blocks_when_uia_lies_about_empty_value(self):
        self.driver.visual_draft=lambda *_:dict(empty=False,text=None)
        with self.assertRaises(DesktopUnavailable):self.type('must not overwrite')
        self.assertEqual(self.control.writes,[])
        self.assertFalse(self.driver.verify_draft(1,DEFAULT_LAYOUT,''))


    def test_unknown_editor_is_reported_without_mutation(self):
        self.control.kind='unknown'
        report=WindowsDesktop.inspect_editor(self.driver,1,DEFAULT_LAYOUT)
        self.assertFalse(report['readable'])
        self.assertEqual(self.control.writes,[])


class LayoutDetectionTests(unittest.TestCase):
    def node(self,kind='',name='',cls='',rect=(0,0,1280,800),children=()):
        left,top,right,bottom=rect
        return SimpleNamespace(ControlTypeName=kind,Name=name,ClassName=cls,IsOffscreen=False,
            BoundingRectangle=SimpleNamespace(left=left,top=top,right=right,bottom=bottom,
                width=lambda:right-left,height=lambda:bottom-top),GetChildren=lambda:list(children))
    def test_unique_native_controls_calibrate_without_focus_or_input(self):
        nodes=[self.node(cls='im_chat::ChatBubbleWidget',rect=(477,112,1279,467)),
               self.node('EditControl','请输入消息',rect=(476,570,1281,743)),
               self.node('ButtonControl','发送',rect=(1147,745,1231,783)),
               self.node('ListControl','filterboxconvlist',rect=(81,100,472,800))]
        root=self.node(children=nodes);driver=SendDriver();driver.rect=lambda _: (0,0,1280,800)
        with patch.dict(sys.modules,{'uiautomation':SimpleNamespace(UIAutomationInitializerInThread=nullcontext,ControlFromHandle=lambda _:root)}):
            layout=driver.detect_layout(1)
            self.assertEqual(layout['send'],[1189/1280,764/800])
            self.assertEqual(layout['messages'][0],477/1280)
            nodes.append(nodes[1])
            with self.assertRaises(DesktopUnavailable):driver.detect_layout(1)


if __name__=='__main__': unittest.main()
