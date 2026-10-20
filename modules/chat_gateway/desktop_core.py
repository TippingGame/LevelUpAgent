"""Pure desktop-chat rules. No OS calls, model access, or platform credentials."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import hashlib
import json
import re
import unicodedata


def normalized(text):
    return unicodedata.normalize('NFKC', str(text)).replace('\u200b', '').strip()


def title_matches(observed, expected):
    # Never collapse distinct chat names (spaces or parenthesized numbers).
    return bool(normalized(expected)) and normalized(observed) == normalized(expected)


def is_mention(text, names):
    value = normalized(text)
    for name in names:
        name = normalized(name).lstrip('@')
        if name and re.search(r'@\s*' + re.escape(name) + r'(?=$|[\s\u2005\u2006,，:：!！?？。.、])', value):
            return True
    return False


@dataclass(frozen=True)
class Bubble:
    text: str
    direction: str  # incoming / outgoing / unknown
    sender: str = ''

    @property
    def signature(self):
        return (normalized(self.text), self.direction, normalized(self.sender))


class MessageTracker:
    """Only a verified append to an overlapping viewport is new.

    Startup, loss of overlap, and scrolling backwards establish a baseline.
    The caller persists state and commits it only after the host acknowledges.
    """
    def __init__(self, state=None):
        self.state = state or {'previous': [], 'serial': 0, 'history': []}

    def observe(self, bubbles, chat_id):
        # Persist fingerprints, not a second plaintext copy of chat history.
        current = [hashlib.sha256(json.dumps(b.signature, ensure_ascii=False).encode()).hexdigest() for b in bubbles]
        old = self.state.get('previous', [])
        # An observed empty chat is a valid baseline, unlike no observation yet.
        initialized = self.state.get('initialized', bool(old))
        additions = []
        history = self.state.setdefault('history', [])
        # Re-visiting a known viewport after scrolling must not replay messages.
        revisited = bool(current) and any(current == history[i:i+len(current)] for i in range(max(0, len(history)-len(current)+1)))
        if old and current != old and not revisited:
            overlap = next((n for n in range(min(len(old), len(current)), 0, -1)
                            if old[-n:] == current[:n]), 0)
            if overlap:
                additions = bubbles[overlap:]
        elif initialized and not old and not history and current:
            additions = bubbles
        result = []
        for bubble in additions:
            if bubble.direction != 'incoming' or not normalized(bubble.text):
                continue
            self.state['serial'] = int(self.state.get('serial', 0)) + 1
            identity = f'{chat_id}|{self.state["serial"]}|{bubble.signature}'
            result.append((hashlib.sha256(identity.encode()).hexdigest(), bubble))
        self.state['previous'] = current
        self.state['initialized'] = True
        if not revisited:
            overlap = next((n for n in range(min(len(history), len(current)), 0, -1) if history[-n:] == current[:n]), 0)
            self.state['history'] = (history + current[overlap:])[-500:]
        return result


def outgoing_added(before, after, text):
    # OCR inserts line breaks when a single message wraps in the viewport.
    def receipt_text(value):
        return re.sub(r'\s+', '', normalized(value))
    target = receipt_text(text)
    return (Counter(receipt_text(b.text) for b in after if b.direction == 'outgoing')[target]
            > Counter(receipt_text(b.text) for b in before if b.direction == 'outgoing')[target])


def valid_box(box):
    return (isinstance(box, list) and len(box) == 4
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in box)
            and 0 <= box[0] < box[2] <= 1 and 0 <= box[1] < box[3] <= 1)


DEFAULT_LAYOUT = {
    'title': [0.33, 0.045, 0.81, 0.10],
    'messages': [0.30, 0.12, 0.985, 0.64],
    'editor': [0.31, 0.70, 0.97, 0.88],
    'send': [0.93, 0.94],
    'sidebar': [0.105, 0.15, 0.285, 0.97],
}


def validate_config(config):
    if config.get('version') != 1:
        raise ValueError('Unsupported desktop configuration')
    if not isinstance(config.get('windowTitle'), str) or not config['windowTitle'].strip():
        raise ValueError('Choose one DingTalk window')
    aliases = config.get('selfNames', [])
    if not isinstance(aliases, list) or not 1 <= len(aliases) <= 10 or any(not isinstance(n, str) or not n.strip() or len(n) > 80 for n in aliases):
        raise ValueError('Enter your exact DingTalk @ display name')
    layout = config.get('layout', {})
    for region in ('title', 'messages', 'editor', 'sidebar'):
        if not valid_box(layout.get(region)):
            raise ValueError('Calibrate the ' + region + ' region')
    point = layout.get('send')
    if not isinstance(point, list) or len(point) != 2 or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 <= v <= 1 for v in point):
        raise ValueError('Calibrate the send button')
    return config
