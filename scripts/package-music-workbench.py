"""Package curated portable runtime and pinned model as immutable Release assets.

No resources are stored in source control or added to the Tauri bundle.
"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / "modules/music_workbench/resources.json").read_text(encoding="utf-8"))
COMPONENTS = ("runtime", "musicgen-small")


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def package(staging, output, part_bytes=1_000_000_000):
    if not 0 < part_bytes < 2_000_000_000:
        raise ValueError("GitHub assets must be below 2 GB")
    output.mkdir(parents=True, exist_ok=True)
    manifest = dict(SPEC, components={})
    prefix = f"music-workbench-{SPEC['resourceVersion']}-{SPEC['target']}"
    index = output / f"{prefix}.json"
    if index.exists():
        raise ValueError("Immutable manifest already exists; use a fresh output directory or resource version")
    for name in COMPONENTS:
        source = staging / name
        provenance = json.loads((source / "provenance.json").read_text(encoding="utf-8"))
        if not provenance.get("license") or not provenance.get("sources"):
            raise ValueError("Missing resource provenance")
        required = ["python.exe", "ready.json", "Lib/site-packages/torch/__init__.py"] if name == "runtime" else ["model.safetensors", "manifest.json", "config.json"]
        if any(not (source / p).is_file() for p in required):
            raise ValueError(f"Incomplete {name} component")
        if name == "musicgen-small":
            model = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
            if model["revision"] != SPEC["modelRevision"]:
                raise ValueError("Unexpected model revision")
            for record in model["files"]:
                path = (source / record["file"]).resolve()
                if not path.is_relative_to(source.resolve()) or path.stat().st_size != record["bytes"] or digest(path) != record["sha256"]:
                    raise ValueError(f"Model checksum mismatch: {record['file']}")
        total = 0
        archive_path = output / f"{name}.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
            for path in sorted(source.rglob("*")):
                if path.is_symlink():
                    raise ValueError(f"Symlinks are not portable: {path}")
                if not path.is_file() or any(p in ("__pycache__", ".git", ".cache") for p in path.relative_to(source).parts) or path.suffix == ".pyc" or path.name == ".installed.json":
                    continue
                total += path.stat().st_size
                archive.write(path, path.relative_to(source).as_posix())
        archive_hash = digest(archive_path)
        parts = []
        with archive_path.open("rb") as stream:
            i = 1
            while block := stream.read(min(part_bytes, 4 * 1024 * 1024)):
                filename = f"{prefix}-{name}.zip.part{i:03}"
                size = 0
                h = hashlib.sha256()
                with (output / filename).open("wb") as part:
                    while block:
                        part.write(block)
                        h.update(block)
                        size += len(block)
                        if size == part_bytes:
                            break
                        block = stream.read(min(part_bytes - size, 4 * 1024 * 1024))
                parts.append(dict(name=filename, bytes=size, sha256=h.hexdigest()))
                i += 1
        archive_path.unlink()
        manifest["components"][name] = dict(unpackedBytes=total, sha256=archive_hash, parts=parts,
                                             license=provenance["license"], sources=provenance["sources"])
        print(f"{name}: {total / 1024**3:.2f} GiB installed; {len(parts)} parts", flush=True)
    index.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    package(args.staging, args.output)
