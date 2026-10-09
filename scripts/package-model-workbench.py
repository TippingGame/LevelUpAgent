"""Build reusable GitHub Release resources without putting them in Tauri.

Input: four curated directories (runtime, triposg, texture, blender), each with
provenance.json. Output: independent tar archives split below GitHub's 2 GB limit
and an immutable resource-version manifest. App releases reuse these resources.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'modules/model_workbench'))
from launcher import COMPONENTS, TARGET, RESOURCE_SPEC, RESOURCE_VERSION, validate_manifest


def package(staging, output, version, part_bytes=1_800_000_000, components=None):
    if not 0 < part_bytes < 2_000_000_000:
        raise ValueError('Part size must be below 2 GB')
    if output.resolve().is_relative_to(staging.resolve()):
        raise ValueError('Output must be outside the source tree')
    output.mkdir(parents=True, exist_ok=True)
    destination = output/f'model-workbench-{version}-{TARGET}.json'
    if components is not None:
        if not components or any(name not in COMPONENTS for name in components):
            raise ValueError('Invalid component selection')
        manifest = validate_manifest(json.loads(destination.read_text(encoding='utf-8')),version)
    else:
        manifest = {**RESOURCE_SPEC,'resourceVersion':version,'components':{}}
    labels = {'runtime':'Python 3.10 / PyTorch 2.5.1 / CUDA 11.8', 'triposg':'TripoSG',
              'texture':'SD2.1 base / MV-Adapter image + geometry','blender':'Blender 3.6 LTS'}
    for name in components or COMPONENTS:
        source = staging/name
        provenance = json.loads((source/'provenance.json').read_text(encoding='utf-8'))
        if not provenance.get('license') or not provenance.get('sources'):
            raise ValueError(name+' is missing license/source provenance')
        archive = output/(name+'.tar')
        total = 0
        directory_links = []
        # Dereference only curated files: Python/Blender distributions use
        # internal symlinks, but the client never needs to extract symlinks.
        with tarfile.open(archive,'w',dereference=True,format=tarfile.PAX_FORMAT) as tar:
            for file in sorted(source.rglob('*')):
                relative = file.relative_to(source)
                if file.is_symlink() and file.is_dir():
                    if not file.resolve().is_relative_to(source.resolve()):
                        raise ValueError('Directory alias escapes component: '+str(relative))
                    directory_links.append({'path':relative.as_posix(),
                        'target':os.path.relpath(file.resolve(),file.parent).replace('\\','/')})
                    continue
                # conda-unpack references the complete packed Python tree,
                # including legitimate package data named "downloads" and
                # bytecode. Filtering those files breaks prefix relocation.
                packed_python = name == 'runtime' and relative.parts[0] == 'python'
                if not packed_python and any(p in ('__pycache__','.git','.cache','downloads','torch_extensions') for p in relative.parts):
                    continue
                if not file.is_file() or file.name in ('.installed.json','.directory-links.json') or file.name.endswith('.partial'):
                    continue
                info = tar.gettarinfo(str(file),str(relative).replace('\\','/'))
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                total += info.size
                with file.open('rb') as stream:
                    tar.addfile(info,stream)
            # Keep tar entries regular files. Restore only validated internal
            # directory aliases after extraction, avoiding duplicated Python
            # trees while preserving compiler sysroot layout.
            payload=json.dumps(directory_links,sort_keys=True).encode('utf-8')
            info=tarfile.TarInfo('.directory-links.json')
            info.size=len(payload)
            info.mode=0o600
            tar.addfile(info,io.BytesIO(payload))
            total+=len(payload)
        digest = hashlib.sha256()
        parts = []
        with archive.open('rb') as stream:
            index = 1
            while True:
                block = stream.read(min(part_bytes,4*1024*1024))
                if not block:
                    break
                filename = f'model-workbench-{version}-{TARGET}-{name}.tar.part{index:03}'
                part_hash, size = hashlib.sha256(), 0
                with (output/filename).open('wb') as target:
                    while block:
                        target.write(block)
                        digest.update(block)
                        part_hash.update(block)
                        size += len(block)
                        if size >= part_bytes:
                            break
                        block = stream.read(min(part_bytes-size,4*1024*1024))
                parts.append({'name':filename,'bytes':size,'sha256':part_hash.hexdigest()})
                index += 1
        archive.unlink()
        manifest['components'][name] = {'label':labels[name],'unpackedBytes':total,
            'sha256':digest.hexdigest(),'parts':parts,'license':provenance['license'],'sources':provenance['sources']}
        print(f'{name}: {total/1024**3:.2f} GiB installed, {len(parts)} Release part(s)', flush=True)
    validate_manifest(manifest,version)
    temporary = destination.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    temporary.replace(destination)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staging',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--version',default=RESOURCE_VERSION,help='Independent resource version pinned by resources.json')
    parser.add_argument('--component',action='append',choices=COMPONENTS,help='Rebuild a component in an unpublished resource set')
    args = parser.parse_args()
    if args.version != RESOURCE_VERSION:
        raise SystemExit('Resource version must match modules/model_workbench/resources.json')
    package(args.staging,args.output,args.version,components=args.component)
