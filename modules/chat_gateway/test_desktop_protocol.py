import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from desktop_core import DEFAULT_LAYOUT


class NativeStartupTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows native dependency startup')
    def test_real_native_startup_with_open_stdin_and_eof_shutdown(self):
        script=Path(__file__).with_name('desktop_gateway.py')
        with tempfile.TemporaryDirectory() as directory:
            child=subprocess.Popen([sys.executable,'-u',str(script),'--state',str(Path(directory)/'state.json')],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                env=dict(os.environ,PYTHONUTF8='1',PYTHONIOENCODING='utf-8'))
            frames=queue.Queue()
            def read():
                for line in child.stdout:
                    frames.put(json.loads(line))
            threading.Thread(target=read,daemon=True).start()
            config=dict(type='configure',version=1,account=dict(platform='dingtalk_desktop',
                desktop=dict(version=1,windowTitle='Startup test never selects a window',selfNames=['test'],layout=DEFAULT_LAYOUT)),routes=[])
            try:
                child.stdin.write((json.dumps(config)+'\n').encode());child.stdin.flush()
                first=frames.get(timeout=30)
                self.assertEqual(first.get('status'),'waiting',first)
                child.stdin.close()
                self.assertEqual(child.wait(timeout=5),0)
            finally:
                if child.poll() is None: child.kill();child.wait(timeout=5)
                for pipe in (child.stdin,child.stdout,child.stderr):pipe.close()


class DesktopProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.children=[]; self.addCleanup(self.cleanup)
        self.control=dict(revision=1,chats={'private':[],'group':[]},sendMode='sent')
        self.save_control()
        self.routes=[dict(id=t,botId='bot-'+t,chatType=t,chatId=n,paused=False,topicId='') for t,n in [('direct','private'),('group','group')]]
        self.config=dict(type='configure',version=1,account=dict(platform='dingtalk_desktop',desktop=dict(version=1,windowTitle='Fixture',selfNames=['机器人'],layout=DEFAULT_LAYOUT)),routes=self.routes)
        self.launch()
    def cleanup(self):
        for process in self.children:
            if process.poll() is None:
                process.kill(); process.wait(timeout=5)
            for pipe in (process.stdin,process.stdout,process.stderr): pipe.close()
    def save_control(self):
        temp=self.root/'control.tmp'; temp.write_text(json.dumps(self.control),encoding='utf-8');os.replace(temp,self.root/'control.json')
    def launch(self):
        script=Path(__file__).resolve().parents[2]/'scripts/chatbots-mock-desktop.py'
        self.process=subprocess.Popen([sys.executable,'-u',str(script),str(self.root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=dict(os.environ,PYTHONUTF8='1'))
        self.children.append(self.process); self.frames=queue.Queue(); self.persisted={}
        output, frames, persisted=self.process.stdout,self.frames,self.persisted
        def read():
            for line in iter(output.readline,b''):
                frame=json.loads(line)
                if frame.get('type')=='fixture_state':
                    persisted['value']=frame['state']
                else:
                    frames.put(frame)
        threading.Thread(target=read,daemon=True).start()
        self.send(self.config)
    def send(self,frame):
        self.process.stdin.write((json.dumps(frame)+'\n').encode());self.process.stdin.flush()
    def frame(self,kind,timeout=15):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            try: frame=self.frames.get(timeout=.2)
            except queue.Empty:
                if self.process.poll() is not None: self.fail('Child exited: '+self.process.stderr.read().decode())
                continue
            if frame.get('type')==kind:return frame
        self.fail('Timed out waiting for '+kind)
    def wait_for(self, predicate, timeout=15):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            if predicate(): return
            if self.process.poll() is not None:
                self.fail('Child exited: '+self.process.stderr.read().decode('utf-8'))
            time.sleep(.05)
        self.fail('Timed out waiting for fixture state')
    def lines(self,name):
        path=self.root/name
        return [json.loads(line) for line in path.read_text('utf-8').splitlines() if line] if path.exists() else []
    def state(self):
        # Do not lock the child's replacement target on Windows. The fixture
        # reports snapshots only after real fsync + replace; inspect disk once
        # the child has exited, when no writer can race the test's file handle.
        if self.process.poll() is not None:
            return json.loads((self.root/'state.json').read_text('utf-8'))
        return self.persisted.get('value',{})
    def test_actual_child_receives_direct_and_group_mentions_with_durable_ack(self):
        self.wait_for(lambda: len(self.state().get('chats',{}))==2)
        self.control['revision']=2
        self.control['chats']={'private':[dict(text='first private',direction='incoming')], 'group':[dict(text='ordinary group',direction='incoming'),dict(text='@机器人 问题',direction='incoming'),dict(text='@其他人 问题',direction='incoming')]}
        self.save_control()
        first=self.frame('inbound')
        # Deliberately lose ACK. Child must repeat the same platform-independent ID.
        repeated=self.frame('inbound')
        self.assertEqual(first['message']['messageId'],repeated['message']['messageId'])
        self.send(dict(type='ack',requestId=repeated['requestId'],ok=True))
        second=self.frame('inbound')
        self.send(dict(type='ack',requestId=second['requestId'],ok=True))
        self.wait_for(lambda:not self.state()['pending'])
        self.process.stdin.close();self.process.wait(timeout=5)
        self.assertEqual(self.state()['pending'],[])
        texts={first['message']['text'],second['message']['text']}
        self.assertEqual(texts,{'first private','@机器人 问题'})
        group=next(f['message'] for f in (first,second) if f['message']['chatType']=='group')
        self.assertTrue(group['mentioned'])
    def test_child_deferred_delivery_can_resume_but_unknown_never_retries(self):
        delivery=dict(id='d1',inbound=dict(chatType='direct',chatId='private'),text='literal {Enter}')
        self.control['sendMode']='deferred';self.save_control()
        self.send(dict(type='send',delivery=delivery))
        self.assertEqual(self.frame('delivery')['status'],'deferred')
        self.assertEqual(self.lines('dispatches.jsonl'),[])
        self.control['sendMode']='sent';self.save_control()
        self.send(dict(type='send',delivery=delivery))
        self.assertEqual(self.frame('delivery')['status'],'sent')
        self.control['sendMode']='unknown';self.save_control()
        uncertain=dict(delivery,id='d2')
        self.send(dict(type='send',delivery=uncertain))
        self.assertEqual(self.frame('delivery')['status'],'delivery_unknown')
        self.process.stdin.close();self.process.wait(timeout=5)
        self.launch()
        self.send(dict(type='send',delivery=uncertain))
        self.assertEqual(self.frame('delivery')['status'],'delivery_unknown')
        self.assertEqual(len(self.lines('dispatches.jsonl')),2)
    def test_eof_terminates_child_while_driver_is_blocked(self):
        self.control['sendMode']='block';self.save_control()
        self.send(dict(type='send',delivery=dict(id='blocked',inbound=dict(chatType='direct',chatId='private'),text='test')))
        self.wait_for(lambda:len(self.lines('dispatches.jsonl'))==1)
        self.process.stdin.close()
        self.assertEqual(self.process.wait(timeout=5),0)
        self.assertEqual(self.state()['attempts']['blocked'],'delivery_unknown')


if __name__=='__main__':unittest.main()
