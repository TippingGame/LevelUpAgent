"""Shared worker paths and durable progress, independent of the research app."""
import os
import time
from pathlib import Path
from launcher import write as save_json

ROOT = Path(os.environ['LEVELUP_3D_RUNTIME'])


def report(run, phase, progress, detail=''):
    save_json(run / 'progress.json', {
        'phase': phase, 'progress': progress, 'detail': detail, 'time': time.time()})
    print(f'[{phase}] {progress:.0%} {detail}', flush=True)
