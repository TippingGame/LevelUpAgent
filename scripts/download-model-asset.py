"""Proxy-aware, resumable parallel ranges; verify complete official SHA256.

State and downloaded ranges survive restarts. Existing sequential .part bytes
are reused once; no partial file is ever published as a model weight.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import time
import urllib.request
import hashlib
from pathlib import Path
ROOT = Path.cwd()
def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4*1024*1024), b''): result.update(block)
    return result.hexdigest()
def download(entry):
    path = ROOT/entry['path']
    with urllib.request.urlopen(entry['sourceUrl'],timeout=60) as source:
        path.write_bytes(source.read())
    if path.stat().st_size != entry['bytes'] or (entry.get('sha256') and digest(path) != entry['sha256']):
        raise ValueError('Download verification failed')
    return entry


def transfer(entry, connections, direct_cdn=False):
    path = ROOT/entry['path']
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size == entry['bytes']:
        sha = digest(path)
        if not entry.get('sha256') or sha == entry['sha256']:
            return {**entry, 'actualSha256':sha, 'verified':True}
    if entry['bytes'] < 1024*1024:
        return download(entry)
    part = path.with_name(path.name+'.ranges')
    state_path = path.with_name(path.name+'.ranges.json')
    if state_path.exists() and part.exists():
        state = json.loads(state_path.read_text())
        if state['sha256'] != entry['sha256']:
            raise ValueError('Stale range download manifest')
    else:
        previous = path.with_name(path.name+'.partial')
        offset = previous.stat().st_size if previous.exists() else 0
        with part.open('wb') as out:
            if offset:
                with previous.open('rb') as src:
                    while block := src.read(8*1024*1024):
                        out.write(block)
            out.truncate(entry['bytes'])
        state = {'sha256':entry['sha256'], 'prefix':offset, 'chunk':8*1024*1024, 'done':[]}
    done = set(state['done'])
    ranges = [(a,min(a+state['chunk'],entry['bytes'])-1)
              for a in range(state['prefix'],entry['bytes'],state['chunk']) if a not in done]
    started = last = time.monotonic()
    initial = state['prefix'] + sum(min(state['chunk'],entry['bytes']-a) for a in done)
    completed = initial
    print(f"Range download {entry['path']}: reuse {initial/1e6:.1f} MB", flush=True)
    cdn_url = None
    if direct_cdn:
        request = urllib.request.Request(entry['sourceUrl']+'?download=true',headers={'Range':'bytes=0-0'})
        with urllib.request.urlopen(request,timeout=45) as response:
            cdn_url = response.url
        if not cdn_url.startswith('https://'):
            raise RuntimeError('Non-HTTPS download redirect rejected')
    def fetch(bounds):
        a,b = bounds
        for attempt in range(4):
            try:
                req = urllib.request.Request(cdn_url or entry['sourceUrl']+f'?download=true&range_start={a}',
                      headers={'Range':f'bytes={a}-{b}', 'User-Agent':'LevelUpGaussian-Research/0.2'})
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if cdn_url else urllib.request.build_opener()
                with opener.open(req,timeout=40) as response:
                    expected = f"bytes {a}-{b}/{entry['bytes']}"
                    if response.status != 206 or response.headers.get('Content-Range') != expected:
                        raise RuntimeError('Incorrect HTTP range response')
                    chunks = []
                    received = 0
                    chunk_started = time.monotonic()
                    while received < b-a+1:
                        data = response.read1(min(1024*1024,b-a+1-received))
                        if not data:
                            break
                        chunks.append(data); received += len(data)
                        if time.monotonic()-chunk_started > 120:
                            raise RuntimeError('Range transfer exceeded 120 seconds; retrying this range')
                    data = b''.join(chunks)
                if len(data) != b-a+1:
                    raise RuntimeError('Incomplete range')
                with part.open('r+b') as out:
                    out.seek(a); out.write(data)
                return a,b-a+1
            except Exception as exc:
                reason = str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
                print(f"Range {a} attempt {attempt+1}: {reason}",flush=True)
                if attempt == 3:
                    raise
                time.sleep(2*(attempt+1))
    with ThreadPoolExecutor(max_workers=connections) as pool:
        futures = [pool.submit(fetch,bounds) for bounds in ranges]
        for future in as_completed(futures):
            a, size = future.result()
            done.add(a); completed += size
            state['done'] = sorted(done)
            temp_state = state_path.with_suffix('.json.tmp')
            temp_state.write_text(json.dumps(state))
            temp_state.replace(state_path)
            now = time.monotonic()
            if now-last >= 15 or completed == entry['bytes']:
                print(f"{entry['path']}: {completed/1e6:.1f}/{entry['bytes']/1e6:.1f} MB; {(completed-initial)/1e6/(now-started):.2f} MB/s",flush=True)
                last = now
    sha = digest(part)
    if part.stat().st_size != entry['bytes'] or sha != entry['sha256']:
        raise RuntimeError('Complete weight size/SHA256 mismatch')
    part.replace(path)
    state_path.unlink()
    print('Verified '+entry['path'],flush=True)
    return {**entry,'actualSha256':sha,'verified':True}
