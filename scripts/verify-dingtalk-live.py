"""Explicitly scoped real-client transport check. No model or platform credentials.

Run only for a user-authorized chat. Existing history establishes a baseline.
This exercises the production gateway; synthetic messages are never injected.
"""
import argparse
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--chat', required=True)
parser.add_argument('--chat-type', choices=['direct','group'], default='direct')
parser.add_argument('--self-name', action='append', default=[])
parser.add_argument('--send', action='store_true')
parser.add_argument('--seconds', type=int, default=180)
parser.add_argument('--max-replies', type=int, default=2)
parser.add_argument('--trace', action='store_true')
args = parser.parse_args()
if not 1 <= args.max_replies <= 3 or not 10 <= args.seconds <= 3600:
    parser.error('Limit test to 1–3 replies and 10–3600 seconds')
if args.seconds > 600 and args.max_replies != 1:
    parser.error('Acceptance windows longer than ten minutes allow only one reply')
if args.chat_type=='group' and not args.self_name:
    parser.error('Group test requires an explicit --self-name for mention matching')
root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root/'modules/chat_gateway'))
from desktop_windows import WindowsDesktop
driver = WindowsDesktop()
hwnd = driver.find('钉钉')
layout = driver.detect_layout(hwnd)
if not driver.title(driver.capture(hwnd), layout, args.chat):
    raise RuntimeError('Open the explicitly authorized chat before starting this test')
editor = driver.inspect_editor(hwnd, layout)
if not editor['readable'] or not editor['draftEmpty']:
    raise RuntimeError('The authorized chat editor must be readable and empty')
run = root/'artifacts/chatbots-live-20261020'/('transport-'+uuid.uuid4().hex[:8])
run.mkdir(parents=True)
environment = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
command = [sys.executable, str(root/'modules/chat_gateway/desktop_gateway.py'), '--state', str(run/'state.json')]
if args.trace:
    command = [sys.executable, '-c', "import sys,runpy,faulthandler;faulthandler.dump_traceback_later(20,repeat=True);p=sys.argv.pop(1);sys.path.insert(0,str(__import__('pathlib').Path(p).parent));runpy.run_path(p,run_name='__main__')", *command[1:]]
error_log = (run/'gateway-stderr.log').open('w', encoding='utf-8')
child = subprocess.Popen(command, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=error_log, text=True, encoding='utf-8',
                         env=environment, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
frames = queue.Queue()
def read():
    for line in child.stdout:
        try: frames.put(json.loads(line))
        except ValueError: frames.put({'type':'protocol_error','detail':'Invalid NDJSON'})
threading.Thread(target=read,daemon=True).start()
def write(frame):
    child.stdin.write(json.dumps(frame,ensure_ascii=False)+'\n'); child.stdin.flush()
records=[]; sent_ids=set(); seen=set(); awaiting={}; live_since=None
route=dict(id='live-scoped-test',botId='live-transport-check',chatType=args.chat_type,chatId=args.chat,topicId='',paused=False)
write(dict(type='configure',version=1,account=dict(id='live-private-test',platform='dingtalk_desktop',
           desktop=dict(version=1,windowTitle='钉钉',selfNames=args.self_name or ['LevelUp 测试'],layout=layout)),routes=[route]))
started_at=datetime.now(timezone.utc)
expires_at=started_at+timedelta(seconds=args.seconds)
print(json.dumps(dict(started=True,run=str(run),chat=args.chat,send=args.send,limit=args.max_replies,
                     startedAt=started_at.isoformat(),expiresAt=expires_at.isoformat()),ensure_ascii=False),flush=True)
deadline=time.monotonic()+args.seconds
stop_reason='timeout'
try:
    while time.monotonic()<deadline and child.poll() is None:
        try: frame=frames.get(timeout=.5)
        except queue.Empty: continue
        records.append(frame)
        print(json.dumps(frame,ensure_ascii=False),flush=True)
        if frame.get('type')=='status' and frame.get('status')=='online' and live_since is None:
            live_since=time.monotonic()
            print('READY: stable history baseline established; send a new test message now.',flush=True)
        if frame.get('type')=='inbound':
            message=frame['message']; mid=message['messageId']
            write(dict(type='ack',requestId=frame['requestId'],ok=True))
            if message['chatId'] != args.chat or message['chatType'] != args.chat_type or mid in seen: continue
            if args.chat_type=='group' and not message.get('mentioned'): continue
            seen.add(mid)
            if args.send and len(sent_ids)<args.max_replies:
                ident='live-'+uuid.uuid4().hex
                delivery=dict(id=ident,text='【LevelUp 测试】已收到你的新消息，钉钉桌面自动回复链路测试。',inbound=message)
                awaiting[ident]=delivery; sent_ids.add(ident)
                write(dict(type='send',delivery=delivery))
        if frame.get('type')=='delivery':
            if frame['status']=='deferred':
                time.sleep(6)
                write(dict(type='send',delivery=awaiting[frame['id']]))
            else:
                awaiting.pop(frame['id'],None)
                if frame['status']!='sent' or len(sent_ids)>=args.max_replies:
                    stop_reason='delivery_'+frame['status']
                    break
finally:
    if child.poll() is not None and stop_reason=='timeout' and time.monotonic()<deadline:
        stop_reason='gateway_exited'
    child.stdin.close()
    try: child.wait(timeout=8)
    except subprocess.TimeoutExpired: child.kill(); child.wait()
    child.stdout.close(); error_log.close()
    report=dict(chat=args.chat,chatType=args.chat_type,selfNames=args.self_name,sendAuthorized=args.send,model='fixed diagnostic reply; no LLM validation',
                newMessages=len(seen),replyAttempts=len(sent_ids),frames=records,layout=layout,
                startedAt=started_at.isoformat(),expiresAt=expires_at.isoformat(),
                endedAt=datetime.now(timezone.utc).isoformat(),stopReason=stop_reason)
    (run/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(stopped=True,report=str(run/'report.json'),newMessages=len(seen),replyAttempts=len(sent_ids)),ensure_ascii=False),flush=True)
