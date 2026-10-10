"""Curate a relocatable Windows Python tree from the validated isolated venv.

Run on the release builder, never on end-user machines. The resulting tree
contains the interpreter, stdlib and locked inference packages, no venv paths.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import os


def prepare(base, venv, output):
    if output.exists():
        raise ValueError("Use a fresh staging directory")
    output.mkdir(parents=True)
    for filename in ["python.exe", "python3.dll", "python310.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"]:
        shutil.copy2(base / filename, output / filename)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", "test", "tests", "idlelib", "ensurepip", "tkinter")
    shutil.copytree(base / "DLLs", output / "DLLs")
    shutil.copytree(base / "Lib", output / "Lib", ignore=lambda p, names: list(ignore(p, names)) + (["site-packages"] if Path(p) == base / "Lib" else []))
    shutil.copytree(venv / "Lib/site-packages", output / "Lib/site-packages", ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "pip", "pip-*.dist-info", "*.pth"))
    # Explicit isolated search path makes the runtime independent of registry,
    # the builder's interpreter, environment PYTHONPATH and user site-packages.
    (output / "python310._pth").write_text(".\nDLLs\nLib\nLib/site-packages\n", encoding="utf-8")
    probe = subprocess.run([str(output / "python.exe"), "-c", "import json,sqlite3,ssl,torch,transformers,numpy; from transformers import AutoProcessor,MusicgenForConditionalGeneration; print(json.dumps({'torch':torch.__version__,'transformers':transformers.__version__,'cuda':torch.cuda.is_available()}))"], check=True, text=True, capture_output=True, env=dict(os.environ, PYTHONUTF8="1"))
    info = json.loads(probe.stdout.strip().splitlines()[-1])
    if info["torch"] != "2.8.0+cu128" or info["transformers"] != "4.57.6":
        raise ValueError("Runtime does not match the pinned resource set")
    (output / "ready.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    (output / "provenance.json").write_text(json.dumps({"license": "Python PSF; PyTorch BSD-3-Clause; Transformers Apache-2.0; NVIDIA redistributable CUDA runtime terms; see bundled distribution licenses", "sources": ["https://www.python.org/downloads/release/python-31011/", "https://download.pytorch.org/whl/cu128/torch/", "https://pypi.org/project/transformers/4.57.6/"], "versions": info}, indent=2), encoding="utf-8")
    print(json.dumps(info), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-python", type=Path, required=True)
    parser.add_argument("--venv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.base_python.resolve(), args.venv.resolve(), args.output.resolve())
