"""Package the verified native Windows resource tree; no installer/compiler needed by users."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT/'modules/model_workbench/resources-windows.json').read_text(encoding='utf-8'))
LABELS = {'runtime': 'Python 3.10 / PyTorch 2.5.1 / CUDA 11.8 (Windows)',
          'triposg': 'TripoSG', 'texture': 'SD2.1 base / MV-Adapter', 'blender': 'Blender 3.6 LTS (Windows)'}


def safe_name(name):
    return bool(name) and not any(c in name for c in '\\:') and all(
        p and p not in ('.', '..') and not p.endswith((' ', '.'))
        and not re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', p, re.I)
        and not any(ord(c) < 32 for c in p) for p in name.split('/'))


def package(staging, output, part_bytes=1_800_000_000):
    staging, output = staging.resolve(), output.resolve()
    if output.is_relative_to(staging) or not 0 < part_bytes < 2_000_000_000:
        raise ValueError('Invalid output or part size')
    if output.exists() and any(output.iterdir()):
        raise ValueError('Use a fresh output directory; immutable resources are never overwritten')
    output.mkdir(parents=True, exist_ok=True)
    manifest = dict(SPEC, components={})
    prefix = f"model-workbench-{SPEC['resourceVersion']}-{SPEC['target']}"
    for name, label in LABELS.items():
        source = staging/name
        provenance = json.loads((source/'provenance.json').read_text(encoding='utf-8'))
        if not provenance.get('license') or not provenance.get('sources'):
            raise ValueError('Missing provenance: '+name)
        archive_path, size = output/(name+'.zip'), 0
        print('Packaging '+name, flush=True)
        seen = set()
        with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
            for file in sorted(source.rglob('*')):
                if file.is_symlink():
                    raise ValueError('Symlinks are not portable: '+str(file))
                relative = file.relative_to(source).as_posix()
                if not file.is_file() or file.suffix == '.pyc' or any(p in ('__pycache__','.git','.cache') for p in file.relative_to(source).parts) or file.name == '.installed.json':
                    continue
                if not safe_name(relative) or relative.casefold() in seen:
                    raise ValueError('Unsafe or duplicate archive path: '+relative)
                seen.add(relative.casefold())
                size += file.stat().st_size
                archive.write(file, relative)
        parts, digest, index = [], hashlib.sha256(), 1
        with archive_path.open('rb') as source:
            while block := source.read(min(part_bytes, 4*1024**2)):
                filename = f'{prefix}-{name}.zip.part{index:03}'
                part_hash, written = hashlib.sha256(), 0
                with (output/filename).open('wb') as target:
                    while block:
                        target.write(block)
                        digest.update(block)
                        part_hash.update(block)
                        written += len(block)
                        if written == part_bytes:
                            break
                        block = source.read(min(part_bytes-written, 4*1024**2))
                parts.append(dict(name=filename, bytes=written, sha256=part_hash.hexdigest()))
                index += 1
        archive_path.unlink()
        manifest['components'][name] = dict(label=label, unpackedBytes=size, sha256=digest.hexdigest(),
                                           parts=parts, license=provenance['license'], sources=provenance['sources'])
        print(f'{name}: {size/1024**3:.2f} GiB installed, {sum(p["bytes"] for p in parts)/1024**3:.2f} GiB archive', flush=True)
    (output/(prefix+'.json')).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staging', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    package(args.staging, args.output)
