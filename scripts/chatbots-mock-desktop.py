"""Test-only desktop driver for the real NDJSON child loop. Never bundled.

This fixture is deliberately a protocol simulation: it never opens Windows or
claims DingTalk compatibility. Production code has no mock-driver switch.
"""
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'modules/chat_gateway'))
from desktop_core import Bubble
import desktop_background
from desktop_windows import DesktopDeferred
import desktop_gateway

directory = Path(sys.argv[1])


class ReportingStore(desktop_gateway.Store):
    def save(self):
        super().save()
        # Observe completed durable commits over the test-only protocol, so a
        # parent polling state.json never locks the Windows replacement target.
        desktop_gateway.emit(dict(type='fixture_state', state=self.data))


class ProtocolFixture:
    auto_input = None
    stopped = lambda self: False
    def prepare(self): pass
    def control(self):
        return json.loads((directory/'control.json').read_text('utf-8'))
    def find(self, title): return 'fixture-only'
    def idle(self): return 60
    def last_input(self): return 1
    def rect(self, hwnd): return (0,0,1000,800)
    def guard(self, hwnd, rect): pass
    def capture(self, hwnd): return 'fixture'
    def title(self, image, layout, title): return True
    def select_chat(self, hwnd, layout, title): return title
    def messages(self, title, layout):
        control = self.control()
        # Record observations so tests can wait for an actual completed baseline.
        with (directory/'observations.jsonl').open('a', encoding='utf-8') as out:
            out.write(json.dumps(dict(title=title, revision=control['revision']))+'\n')
        return [Bubble(**b) for b in control.get('chats', {}).get(title, [])]
    def send_reply(self, config, title, text, intent):
        mode = self.control().get('sendMode', 'sent')
        if mode == 'deferred':
            raise DesktopDeferred('Fixture simulates human activity before input')
        intent()
        with (directory/'dispatches.jsonl').open('a', encoding='utf-8') as out:
            out.write(json.dumps(dict(title=title, text=text))+'\n')
        if mode == 'unknown':
            raise RuntimeError('Fixture simulates no visible receipt')
        if mode == 'block':
            time.sleep(90)  # EOF watcher must terminate the child during this.
        return 'sent'


desktop_background.BackgroundDesktop = ProtocolFixture
desktop_gateway.Store = ReportingStore
first = sys.stdin.buffer.readline(desktop_gateway.MAX_FRAME+1)
desktop_gateway.run(json.loads(first), directory/'state.json')
