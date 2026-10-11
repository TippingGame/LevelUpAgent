"""Build the pinned Comfy YuE2 resource pack, independently of the desktop app.

All model files are checksum checked, including files reused from --model-source
(the reference package's app directory). Never import its WebUI/custom nodes.
"""
import argparse
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(ROOT / "scripts/prepare-song-resources.py"))
download, digest, record = (helpers[k] for k in ("download", "digest", "record"))
PYTHON_URL = "https://www.python.org/ftp/python/3.13.12/python-3.13.12-embed-amd64.zip"
PYTHON_SHA = "76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0"
MODELS = [
    ("checkpoints/yue2_3b_int8_convrot.safetensors", 3960938800, "96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6"),
    ("audio_encoders/sheetsage2_bf16.safetensors", 1386868122, "5fd960ce3df281e3f3a889d174584d88f96247711480cf96377b12d7e8b6adc5"),
    ("hdemucs_high_trained.pt", 334697255, "a004b2790d73ffeaa535db458a1a79b539dfdbafbccc31f275d07e632ebd7816"),
]


def prepare(args):
    spec = json.loads((ROOT / "modules/music_workbench/song-resources.json").read_text())["yue2"]
    args.cache.mkdir(parents=True, exist_ok=True)
    dest = args.staging / "runtime"
    if args.only != "models":
        dest.mkdir(parents=True, exist_ok=True)
        archive = args.cache / "python-3.13.12-embed-amd64.zip"
        download(PYTHON_URL, archive, sha=PYTHON_SHA)
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
        (dest / "python313._pth").write_text("python313.zip\n.\nLib/site-packages\nimport site\n", encoding="utf-8")
        packages = dest / "Lib/site-packages"
        wheel = args.cache / "torch-2.11.0+cu130-cp313-cp313-win_amd64.whl"
        download("https://download-r2.pytorch.org/whl/cu130/torch-2.11.0%2Bcu130-cp313-cp313-win_amd64.whl", wheel,
                 1915220980, "339801f2163698a53c7fb3c91883e7f44331d22c34d45acfbce4eff71f2332fa")
        subprocess.run(["uv", "pip", "install", "--python", str(dest / "python.exe"), "--target", str(packages),
                        "--index", "https://download.pytorch.org/whl/cu130", "--index-strategy", "unsafe-best-match",
                        "-r", str(ROOT / "scripts/requirements-yue2-int8.txt"), str(wheel)],
                       check=True, env=dict(os.environ, UV_LINK_MODE="copy"))
        # Include the complete corresponding GPL source, without the WebUI wheel.
        archive = args.cache / f"comfy-{spec['sourceRevision']}.zip"
        subprocess.run(["git", "-C", str(args.source), "archive", "--format=zip", "-o", str(archive), spec["sourceRevision"]], check=True)
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest / "comfy-source")
        code = "import json,sys,torch,torchaudio,sqlite3,av,soundfile; print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'torchaudio':torchaudio.__version__,'cuda':torch.version.cuda}))"
        info = json.loads(subprocess.check_output([str(dest / "python.exe"), "-B", "-s", "-c", code], text=True).strip())
        info.update(engine="yue2", sourceRevision=spec["sourceRevision"], format="comfy-int8")
        record(dest / "ready.json", info)
        lock = subprocess.check_output(["uv", "pip", "freeze", "--python", str(dest / "python.exe"), "--path", str(packages)], text=True)
        (dest / "requirements-lock.txt").write_text(lock, encoding="utf-8")
        record(dest / "provenance.json", {"license": "ComfyUI GPL-3.0 (complete corresponding source in comfy-source/); PSF-2.0; PyTorch BSD; NVIDIA CUDA redistributables; dependency licenses in *.dist-info/", "sources": [PYTHON_URL, "https://download.pytorch.org/whl/cu130", "https://pypi.org", f"https://github.com/Comfy-Org/ComfyUI/tree/{spec['sourceRevision']}"]})
        print(info, flush=True)
    if args.only == "runtime":
        return
    dest = args.staging / "yue2-models"
    dest.mkdir(parents=True, exist_ok=True)
    sources, records = [], []
    hf = f"https://huggingface.co/Comfy-Org/YuE2/resolve/{spec['modelRevision']}"
    for name, size, sha in MODELS:
        target = dest / name
        separation = name.endswith(".pt")
        url = "https://download.pytorch.org/torchaudio/models/hdemucs_high_trained.pt" if separation else f"{hf}/{name}"
        local = args.model_source / ("models/torch/hub/torchaudio/models/" + name if separation else "comfy/ComfyUI/models/" + name) if args.model_source else None
        if not target.exists() and local and local.is_file() and local.stat().st_size == size and digest(local) == sha:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(local, target)
        download(url, target, size, sha)
        records.append({"file": name, "bytes": size, "sha256": sha})
        sources.append(url)
    # Retain conversion/base model notices and the source-separation license.
    notices = [
        (f"{hf}/README.md", "Comfy-YuE2-MODEL_CARD.md"),
        ("https://huggingface.co/m-a-p/YuE2-3B/resolve/8f24312f187763b9854adeec87e437e2b03bbff1/LICENSE", "YuE2-MODEL_LICENSE"),
        ("https://huggingface.co/m-a-p/YuE2-3B/resolve/8f24312f187763b9854adeec87e437e2b03bbff1/THIRD_PARTY_NOTICES.md", "YuE2-NOTICES.md"),
        ("https://huggingface.co/m-a-p/YuE2-3B/resolve/8f24312f187763b9854adeec87e437e2b03bbff1/licenses/SnakeBeta-NVIDIA-MIT.txt", "SnakeBeta-NVIDIA-MIT.txt"),
        ("https://huggingface.co/m-a-p/YuE2-3B/resolve/8f24312f187763b9854adeec87e437e2b03bbff1/licenses/stable-audio-tools-MIT.txt", "stable-audio-tools-MIT.txt"),
        ("https://huggingface.co/m-a-p/SheetSage2/resolve/32c7c7473e7b59e1ed36bd8a8fefbd11ae8d468a/LICENSE", "SheetSage2-LICENSE"),
        ("https://huggingface.co/m-a-p/SheetSage2/resolve/32c7c7473e7b59e1ed36bd8a8fefbd11ae8d468a/README.md", "SheetSage2-MODEL_CARD.md"),
        ("https://huggingface.co/m-a-p/SheetSage2/resolve/32c7c7473e7b59e1ed36bd8a8fefbd11ae8d468a/THIRD_PARTY_NOTICES.md", "SheetSage2-NOTICES.md"),
        ("https://raw.githubusercontent.com/facebookresearch/demucs/e976d93ecc3865e5757426930257e200846a520a/LICENSE", "Demucs-LICENSE"),
    ]
    for url, name in notices:
        download(url, dest / name)
        sources.append(url)
    record(dest / "manifest.json", {"revision": spec["modelRevision"], "files": records})
    record(dest / "provenance.json", {"license": "YuE2 and SheetSage2 CC-BY-NC-4.0; HDEMUCS MIT", "sources": sources})
    print("YuE2 INT8 models verified", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Pinned official ComfyUI Git checkout")
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--model-source", type=Path)
    parser.add_argument("--only", choices=("runtime", "models"))
    prepare(parser.parse_args())
