"""Prepare isolated Windows song engines; never modify an existing Python install.

Run with Python 3.12 and requests installed; uv must be on PATH. Model files are
pinned to HF commits and verified before recording provenance. --model-source
reuses matching files from a local directory (YuE2: YuE2-3B and YuE2-Vae).
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import zipfile

import requests

ROOT = Path(__file__).resolve().parents[1]
SPECS = json.loads((ROOT / "modules/music_workbench/song-resources.json").read_text())
PYTHON_URL = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"
PYTHON_SHA = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def record(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def pinned_source(args, spec):
    # Export the commit, preserving any user edits in the reference checkout.
    args.cache.mkdir(parents=True, exist_ok=True)
    archive = args.cache / f"{args.engine}-{spec['sourceRevision']}.zip"
    subprocess.run(["git", "-C", str(args.source), "archive", "--format=zip", "-o", str(archive), spec["sourceRevision"]], check=True)
    source = args.cache / f"{args.engine}-{spec['sourceRevision']}"
    with zipfile.ZipFile(archive) as z:
        z.extractall(source)
    return source


def download(url, path, size=None, sha=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and (size is None or path.stat().st_size == size) and (sha is None or digest(path) == sha):
        return
    partial = path.with_name(path.name + ".partial")
    if size and sha and size >= 512 * 1024**2:
        # Some download gateways buffer multi-GB responses. Bounded Range
        # requests also let resource builders resume without fetching a full file.
        parts_dir = path.with_name(path.name + ".ranges")
        parts_dir.mkdir(exist_ok=True)
        chunk_size = 16 * 1024**2
        def fetch_range(start):
            end = min(size, start + chunk_size) - 1
            part = parts_dir / str(start)
            if part.exists() and part.stat().st_size == end - start + 1:
                return part
            for attempt in range(4):
                try:
                    response = requests.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=(30, 90))
                    response.raise_for_status()
                    if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{size}" or len(response.content) != end - start + 1:
                        raise ValueError(f"Invalid byte range for {path.name}")
                    part.write_bytes(response.content)
                    return part
                except (requests.RequestException, ValueError):
                    if attempt == 3:
                        raise
                    time.sleep(1 + attempt)
        with ThreadPoolExecutor(max_workers=12) as pool:
            parts = list(pool.map(fetch_range, range(0, size, chunk_size)))
        with partial.open("wb") as stream:
            for part in parts:
                with part.open("rb") as block:
                    shutil.copyfileobj(block, stream, 4 * 1024**2)
        if digest(partial) != sha:
            raise ValueError(f"Checksum mismatch: {path.name}; discard cached ranges before retrying")
        partial.replace(path)
        for part in parts:
            part.unlink()
        parts_dir.rmdir()
        print(f"Verified {path.name}: {size:,} bytes", flush=True)
        return
    offset = partial.stat().st_size if partial.exists() else 0
    if size and offset >= size:
        partial.unlink()
        offset = 0
    with requests.get(url, headers={"Range": f"bytes={offset}-"} if offset else {}, stream=True, timeout=(30, 90)) as response:
        response.raise_for_status()
        if response.status_code != 206:
            offset = 0
        with partial.open("ab" if offset else "wb") as stream:
            for chunk in response.iter_content(4 * 1024 * 1024):
                stream.write(chunk)
    if size and partial.stat().st_size != size:
        raise ValueError(f"Incomplete download: {path.name}")
    if sha and digest(partial) != sha:
        partial.unlink()
        raise ValueError(f"Checksum mismatch: {path.name}")
    partial.replace(path)
    print(f"Downloaded {path.name}: {path.stat().st_size:,} bytes", flush=True)


def models(args, spec):
    name = spec["components"][1]
    dest = args.staging / name
    dest.mkdir(parents=True, exist_ok=True)
    repos = [("ACE-Step/Ace-Step1.5", spec["modelRevision"], "")] if args.engine == "acestep" else [
        ("m-a-p/YuE2-3B", spec["modelRevision"], "YuE2-3B"),
        ("m-a-p/YuE2-Vae", spec["vaeRevision"], "YuE2-Vae")]
    records, sources = [], []
    for repo, revision, folder in repos:
        response = requests.get(f"https://huggingface.co/api/models/{repo}/revision/{revision}", params={"blobs": "true"}, timeout=60)
        response.raise_for_status()
        info = response.json()
        assert info["sha"] == revision
        files = [f for f in info["siblings"] if (
            f["rfilename"].startswith(("acestep-v15-turbo/", "vae/", "Qwen3-Embedding-0.6B/")) or f["rfilename"] == "README.md"
        )] if args.engine == "acestep" else [f for f in info["siblings"] if f["rfilename"] in (
            "model.safetensors", "config.json", "generation_config.json", "yue2_generation_config.json", "qwen.tiktoken", "weights_manifest.json", "LICENSE", "MODEL_LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"
        ) or f["rfilename"].startswith("licenses/")]
        def fetch(f):
            relative = Path(folder) / f["rfilename"]
            target = dest / relative
            expected = f.get("lfs", {}).get("sha256")
            local = args.model_source / relative if args.model_source else None
            if not target.exists() and local and local.is_file() and expected and digest(local) == expected:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(local, target)
            download(f"https://huggingface.co/{repo}/resolve/{revision}/{f['rfilename']}", target, f["size"], expected)
            return {"file": relative.as_posix(), "bytes": target.stat().st_size, "sha256": digest(target)}
        with ThreadPoolExecutor(max_workers=4) as pool:
            records.extend(pool.map(fetch, files))
        sources.append(f"https://huggingface.co/{repo}/tree/{revision}")
    if args.engine == "acestep":
        # Official handler syncs these same files on first load. Package them
        # from the pinned source up front so installed model resources stay immutable.
        source = pinned_source(args, spec)
        for file in (source / "acestep/models/turbo").glob("*.py"):
            if file.name == "__init__.py":
                continue
            target = dest / "acestep-v15-turbo" / file.name
            shutil.copy2(file, target)
            relative = target.relative_to(dest).as_posix()
            records = [r for r in records if r["file"] != relative]
            records.append({"file": relative, "bytes": target.stat().st_size, "sha256": digest(target)})
        shutil.copy2(source / "LICENSE", dest / "ACE-Step-LICENSE")
        download("https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md", dest / "Qwen3-MODEL_CARD.md")
        download("https://www.apache.org/licenses/LICENSE-2.0.txt", dest / "Qwen3-APACHE-2.0.txt")
        sources.append(f"https://github.com/ace-step/ACE-Step-1.5/tree/{spec['sourceRevision']}")
        sources.append("https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3")
    record(dest / "manifest.json", {"revision": spec["modelRevision"], "files": records})
    record(dest / "provenance.json", {"license": "MIT; Qwen3 Apache-2.0" if args.engine == "acestep" else "CC-BY-NC-4.0", "sources": sources})
    print(f"{args.engine} models verified", flush=True)


def runtime(args, spec):
    source_root = pinned_source(args, spec)
    dest = args.staging / "runtime"
    dest.mkdir(parents=True, exist_ok=True)
    archive = args.cache / "python-3.12.10-embed-amd64.zip"
    download(PYTHON_URL, archive, sha=PYTHON_SHA)
    with zipfile.ZipFile(archive) as z:
        z.extractall(dest)
    (dest / "python312._pth").write_text("python312.zip\n.\nLib/site-packages\nimport site\n", encoding="utf-8")
    packages = dest / "Lib/site-packages"
    torch_version = "2.7.1" if args.engine == "acestep" else "2.10.0"
    torch_deps = [f"torch=={torch_version}+cu128"]
    if args.engine == "acestep":
        torch_deps += ["torchaudio==2.7.1+cu128"]
        wheel = args.cache / "torch-2.7.1+cu128-cp312-cp312-win_amd64.whl"
        download("https://download.pytorch.org/whl/cu128/torch-2.7.1%2Bcu128-cp312-cp312-win_amd64.whl", wheel, 3273024349, "2bb8c05d48ba815b316879a18195d53a6472a03e297d971e916753f8e1053d30")
        torch_deps[0] = str(wheel)
    env = dict(os.environ, UV_LINK_MODE="copy")
    if args.torch_source:
        import importlib.metadata
        dist = importlib.metadata.Distribution.at(args.torch_source / f"torch-{torch_version}+cu128.dist-info")
        if dist.version != f"{torch_version}+cu128":
            raise ValueError("Local torch version does not match the engine")
        for name in ("torch", f"torch-{torch_version}+cu128.dist-info", "torchgen", "functorch"):
            if (args.torch_source / name).is_dir():
                shutil.copytree(args.torch_source / name, packages / name, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    subprocess.run(["uv", "pip", "install", "--python", str(dest / "python.exe"), "--target", str(packages), "--index-url", "https://download.pytorch.org/whl/cu128", *torch_deps], check=True, env=env)
    # PyTorch's index mirrors only a subset of general package versions. Exact
    # inference pins are also resolved against PyPI; CUDA torch remains pinned.
    subprocess.run(["uv", "pip", "install", "--python", str(dest / "python.exe"), "--target", str(packages), "--index", "https://download.pytorch.org/whl/cu128", "--index-strategy", "unsafe-best-match", "-r", str(ROOT / f"scripts/requirements-{args.engine}.txt"), f"torch=={torch_version}+cu128"], check=True, env=env)
    package = "acestep" if args.engine == "acestep" else "yue2"
    source = source_root / ("acestep" if args.engine == "acestep" else "src/yue2")
    shutil.copytree(source, packages / package, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*_test.py", "tests"))
    notices = dest / "licenses" / args.engine
    notices.mkdir(parents=True, exist_ok=True)
    for filename in ("LICENSE", "MODEL_LICENSE", "THIRD_PARTY_NOTICES.md", "pyproject.toml"):
        if (source_root / filename).is_file():
            shutil.copy2(source_root / filename, notices / filename)
    if (source_root / "licenses").is_dir():
        shutil.copytree(source_root / "licenses", notices / "third-party", dirs_exist_ok=True)
    code = "import json,sys,torch,soundfile,sqlite3; " + (
        "from acestep.handler import AceStepHandler; from acestep.inference import generate_music; " if args.engine == "acestep" else "from yue2 import YuE2Pipeline; "
    ) + "print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cuda':torch.version.cuda}))"
    probe = subprocess.check_output([str(dest / "python.exe"), "-B", "-s", "-c", code], text=True, env=dict(env, PYTHONUTF8="1"))
    info = json.loads(probe.strip().splitlines()[-1])
    info.update(engine=args.engine, sourceRevision=spec["sourceRevision"])
    record(dest / "ready.json", info)
    lock = subprocess.check_output(["uv", "pip", "freeze", "--python", str(dest / "python.exe"), "--path", str(packages)], text=True)
    (dest / "requirements-lock.txt").write_text(lock, encoding="utf-8")
    record(dest / "provenance.json", {"license": "PSF-2.0; PyTorch BSD; NVIDIA CUDA redistributables; engine and dependency licenses in licenses/ and *.dist-info/", "sources": [PYTHON_URL, "https://download.pytorch.org/whl/cu128", "https://pypi.org", f"https://github.com/{'ace-step/ACE-Step-1.5' if args.engine == 'acestep' else 'multimodal-art-projection/YuE'}/tree/{spec['sourceRevision']}"]})
    print(info, flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--engine", choices=SPECS, required=True)
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--staging", type=Path, required=True)
    p.add_argument("--cache", type=Path, required=True)
    p.add_argument("--model-source", type=Path)
    p.add_argument("--torch-source", type=Path, help="Reuse an exact-version local wheel installation")
    p.add_argument("--only", choices=("runtime", "models"))
    args = p.parse_args()
    if args.engine == "yue2":
        p.error("YuE2 INT8 now uses scripts/prepare-yue2-int8.py; see docs/YUE2_261011_UPGRADE.md")
    args.staging = args.staging.resolve()
    args.cache = args.cache.resolve()
    spec = SPECS[args.engine]
    if args.only != "models":
        runtime(args, spec)
    if args.only != "runtime":
        models(args, spec)
