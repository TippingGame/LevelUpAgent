"""Explicitly authorized chat only. Sends one diagnostic through production code.

Own foreground test window receives real keyboard/mouse activity concurrently.
No inputs are injected after that window loses foreground. Captures local proof,
not a claim of server acknowledgment or real inbound/model acceptance.
"""
import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import threading
import time
import tkinter as tk

parser=argparse.ArgumentParser()
parser.add_argument('--chat',required=True)
parser.add_argument('--send',action='store_true',required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'modules/chat_gateway'))
from desktop_background import BackgroundDesktop
from desktop_gateway import DesktopSession, Store
import uiautomation as auto

driver=BackgroundDesktop();hwnd=driver.find('钉钉');layout=driver.detect_layout(hwnd)
assert driver.title(driver.capture(hwnd),layout,args.chat),'Open the authorized test chat first'
assert driver.verify_draft(hwnd,layout,''),'Existing draft; stop'
output=root/'artifacts/dingtalk-background-review';output.mkdir(exist_ok=True,parents=True)
window=tk.Tk();window.title('LevelUp background interference verification')
window.geometry('520x220+30+30')
tk.Label(window,text='This test types only into this test entry.').pack()
entry=tk.Entry(window,width=55);entry.pack();window.update();window.focus_force();entry.focus_force();window.update()
foreground=driver.user.GetForegroundWindow()
window_id=driver.user.GetAncestor(window.winfo_id(),2)
driver.user.SetForegroundWindow(window_id)  # Only the diagnostic's own window.
entry.focus_force()
print('Waiting up to 40 seconds for the diagnostic window to be foreground.',flush=True)
for _ in range(400):
    if foreground==window_id:break
    window.update();time.sleep(.1);foreground=driver.user.GetForegroundWindow()
assert foreground==window_id, f'Test window not foreground: {foreground}, expected {window_id}; no messages sent'
original_cursor=wintypes.POINT();driver.user.GetCursorPos(ctypes.byref(original_cursor))
report={'chat':args.chat,'foreground':foreground,'status':'running','keys':0,'cursorMoves':0,'inputActivityObserved':False,'focusPreserved':True,'intents':0}
initial_input=driver.last_input();done=threading.Event();stop=threading.Event()
driver.stopped=stop.is_set
message='后台验证 1483：其他应用正常输入，机器人独立发送。'
def intent():report['intents']+=1
def work():
    try:
        report['status']=driver.send_reply(dict(windowTitle='钉钉',layout=layout),args.chat,message,intent)
        driver.capture(hwnd).save(str(output/'sent.png'))
        report['draftEmpty']=driver.verify_draft(hwnd,layout,'')
        config=dict(version=1,windowTitle='钉钉',selfNames=['LevelUp'],layout=layout)
        session=DesktopSession(config,Store(output/'scan-state.json'),driver)
        route=dict(id='background-read-proof',botId='proof',chatId=args.chat,chatType='group')
        session.set_routes([route])
        session.scan(route);session.scan(route)
        report['backgroundScanBaseline']=session.key(route) in session.started
    except Exception as exc:report.update(status='error',error=type(exc).__name__+': '+str(exc))
    finally:done.set()
threading.Thread(target=work,daemon=True).start()
def tick():
    if driver.user.GetForegroundWindow()!=foreground:
        report['focusPreserved']=False;stop.set()
    elif not done.is_set():
        # Test input goes only to our verified foreground edit; no clipboard.
        for flag in (auto.KeyboardEventFlag.KeyDown,auto.KeyboardEventFlag.KeyUp):
            auto.SendInput(auto.KeyboardInput(0,ord('a'),auto.KeyboardEventFlag.KeyUnicode|flag))
        report['keys']+=1
        driver.user.SetCursorPos(60+(report['keys']%100),150)
        report['cursorMoves']+=1
        report['inputActivityObserved'] |= driver.last_input()!=initial_input
    if done.is_set():
        report['entryCharacters']=len(entry.get())
        report['passed']=(report['status']=='sent' and report['focusPreserved'] and report['inputActivityObserved'] and report['entryCharacters']>5 and report.get('draftEmpty') and report.get('backgroundScanBaseline'))
        (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False),flush=True)
        driver.user.SetCursorPos(original_cursor.x,original_cursor.y)
        window.destroy()
    else:window.after(120,tick)
window.after(120,tick);window.mainloop()
sys.exit(0 if report.get('passed') else 1)
