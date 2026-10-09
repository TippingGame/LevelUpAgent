"""Acquire pinned, safetensors-only SD2.1 components; no remote Python code.

The original Stability AI endpoint is unavailable. This explicitly uses the
sd2-community archive and records exact source revisions and file hashes.
"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.request

SOURCES = {
    'base': ('sd2-community/stable-diffusion-2-1-base','4e63672c03103b6c636b8fb4119ba982469b2955'),
    'adapter': ('huanngzh/mv-adapter','6de4033df6b53366f3c009d22f5ec434bb55e59f'),
}


def fetch_file(root, kind, repo, revision, item):
    name = item['rfilename']
    destination = root/kind/name
    destination.parent.mkdir(parents=True,exist_ok=True)
    expected = item.get('lfs',{}).get('sha256')
    def checksum(path):
        with path.open('rb') as stream:
            result = hashlib.sha256()
            for block in iter(lambda: stream.read(4*1024*1024),b''): result.update(block)
        return result.hexdigest()
    if destination.exists() and destination.stat().st_size == item['size']:
        digest = checksum(destination)
        if not expected or digest == expected:
            return {'path':destination.relative_to(root).as_posix(), 'bytes':item['size'], 'sha256':digest}
    if item['size'] > 1024*1024:
        import importlib.util
        spec=importlib.util.spec_from_file_location('download_model_asset',Path(__file__).with_name('download-model-asset.py'))
        downloader=importlib.util.module_from_spec(spec);spec.loader.exec_module(downloader)
        downloader.transfer({'path':str(destination.resolve()),'bytes':item['size'],'sha256':expected,
            'sourceUrl':f'https://huggingface.co/{repo}/resolve/{revision}/{name}'},12,direct_cdn=True)
        return {'path':destination.relative_to(root).as_posix(), 'bytes':item['size'], 'sha256':checksum(destination)}
    with urllib.request.urlopen(f'https://huggingface.co/{repo}/resolve/{revision}/{name}',timeout=45) as source:
        destination.write_bytes(source.read())
    if destination.stat().st_size != item['size']: raise ValueError('Source size mismatch: '+name)
    return {'path':destination.relative_to(root).as_posix(), 'bytes':item['size'], 'sha256':checksum(destination)}


def main(root):
    files = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = []
        for kind,(repo,revision) in SOURCES.items():
            with urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true',timeout=30) as stream:
                metadata = json.load(stream)
            for item in metadata['siblings']:
                name = item['rfilename']
                wanted = ((kind == 'base' and (name.endswith(('.json','.txt','.md')) or name.endswith('.fp16.safetensors')))
                          or (kind == 'adapter' and name in ('mvadapter_ig2mv_sd21.safetensors','README.md')))
                if wanted: futures.append(pool.submit(fetch_file,root,kind,repo,revision,item))
        for future in concurrent.futures.as_completed(futures): files.append(future.result())
    # Preserve license texts alongside the weights, including the archived
    # SD2 license that the base repository's model card links to.
    pinned = json.loads((Path(__file__).resolve().parents[1]/
        'packaging/model-workbench/sd21-sources.json').read_text(encoding='utf-8'))
    for entry in pinned['files']:
        if not Path(entry['path']).name.startswith('LICENSE'):
            continue
        url = entry['sourceUrl'].replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/')
        with urllib.request.urlopen(url, timeout=45) as stream:
            payload = stream.read()
        if len(payload) != entry['bytes'] or hashlib.sha256(payload).hexdigest() != entry['sha256']:
            raise ValueError('License checksum mismatch: '+entry['path'])
        destination = root/entry['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)
        files.append(entry)
    # Runtime loads the explicit fp16 variant; preserve upstream file names.
    provenance = {'license':'SD2.1: CreativeML Open RAIL++-M; MV-Adapter: Apache-2.0',
        'sources':[f'https://huggingface.co/{repo}/tree/{revision}' for repo,revision in SOURCES.values()],
        'originalModel':'stabilityai/stable-diffusion-2-1-base',
        'archiveNote':'Original endpoint returned HTTP 401; sd2-community archive used explicitly.',
        'files':sorted(files,key=lambda value:value['path'])}
    (root/'provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'files':len(files),'bytes':sum(f['bytes'] for f in files)}),flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True,type=Path)
    main(parser.parse_args().output)
