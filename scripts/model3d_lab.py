"""Detachable 3D backend preflight. Standard library only; never installs or infers.

The CLI emits one JSON object for LevelUpAgent's existing localTool node.
It deliberately does not call a backend ready before a real inference smoke test.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
import struct
import subprocess
import sys
import time

PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = PROJECT / "modules" / "model3d" / "lgm-lab.manifest.json"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def contained_path(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError("Module paths must be nonempty relative paths using forward slashes")
    if Path(relative).is_absolute() or PureWindowsPath(relative).drive or ".." in relative.split("/"):
        raise ValueError("Module path escapes its root: " + relative)
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Module path escapes its root: " + relative)
    return path


def load_manifest(path: Path) -> dict:
    data = read_json(path)
    if data.get("schemaVersion") != 1 or data.get("backendId") != "lgm-lab":
        raise ValueError("Only schemaVersion=1 and backendId=lgm-lab are supported by this validation slice")
    files = data.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("Module manifest has no required files")
    seen = set()
    for item in files:
        relative = item.get("path")
        contained_path(Path.cwd(), relative)
        if relative in seen:
            raise ValueError("Duplicate module path: " + relative)
        seen.add(relative)
        if "bytes" in item and (type(item["bytes"]) is not int or item["bytes"] <= 0):
            raise ValueError("File size must be a positive integer")
        if "sha256" in item and (len(item["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in item["sha256"])):
            raise ValueError("Invalid SHA-256 in module manifest")
    return data


def hidden_run(argv: list[str], timeout: int = 20) -> subprocess.CompletedProcess:
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    return subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, shell=False, **options)


def python_probe(executable: Path, imports: list[str]) -> dict:
    if not executable.is_file():
        return {"status": "missing", "path": str(executable)}
    # Inspect availability without importing torch, starting CUDA, or JIT-compiling extensions.
    code = """import importlib.util,json,sys
names=json.loads(sys.argv[1]); found={}
for name in names:
 try: found[name]=importlib.util.find_spec(name) is not None
 except (ImportError,ValueError,ModuleNotFoundError): found[name]=False
print(json.dumps({'version':list(sys.version_info[:3]),'executable':sys.executable,'imports':found}))
"""
    try:
        result = hidden_run([str(executable), "-I", "-c", code, json.dumps(imports)])
        if result.returncode:
            return {"status": "probe_failed", "path": str(executable), "exitCode": result.returncode, "error": result.stderr[-1200:]}
        return {"status": "inspected", **json.loads(result.stdout)}
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return {"status": "probe_failed", "path": str(executable), "error": str(exc)}


def gpu_probe() -> dict:
    executable = shutil.which("nvidia-smi")
    if not executable and Path("/usr/lib/wsl/lib/nvidia-smi").is_file():
        executable = "/usr/lib/wsl/lib/nvidia-smi"
    if not executable:
        return {"status": "unavailable", "devices": []}
    try:
        result = hidden_run([executable, "--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"], 10)
        if result.returncode:
            return {"status": "probe_failed", "devices": [], "exitCode": result.returncode}
        devices = []
        for line in result.stdout.strip().splitlines():
            name, total, free, driver = [value.strip() for value in line.split(",")]
            devices.append({"name": name, "totalMiB": int(total), "freeMiB": int(free), "driverVersion": driver})
        return {"status": "inspected", "devices": devices}
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return {"status": "probe_failed", "devices": [], "error": str(exc)}


def inspect_files(manifest: dict, root: Path, verify_hashes: bool = False) -> list[dict]:
    results = []
    for item in manifest["files"]:
        path = contained_path(root, item["path"])
        row = {"path": item["path"], "role": item["role"]}
        if not path.is_file():
            row["status"] = "missing"
        else:
            row["actualBytes"] = path.stat().st_size
            if row["actualBytes"] == 0 or ("bytes" in item and item["bytes"] != row["actualBytes"]):
                row["status"] = "size_mismatch"
            elif verify_hashes and item.get("sha256"):
                digest = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                row["status"] = "verified" if digest.hexdigest() == item["sha256"] else "hash_mismatch"
            else:
                row["status"] = "present_unverified"
        results.append(row)
    return results


def doctor(manifest_path: Path, root: Path, verify_hashes: bool = False, probe_hardware: bool = True) -> dict:
    manifest = load_manifest(manifest_path)
    platform_key = "windows" if os.name == "nt" else "linux" if sys.platform.startswith("linux") else "unsupported"
    files = inspect_files(manifest, root, verify_hashes)
    runtime_relative = manifest["runtime"]["python"].get(platform_key)
    runtime = python_probe(contained_path(root, runtime_relative), manifest["runtime"]["imports"]) if runtime_relative else {"status": "unsupported_platform"}
    blockers = [{"code": "module_file_" + row["status"], "path": row["path"]} for row in files if row["status"] not in {"verified", "present_unverified"}]
    if runtime["status"] != "inspected":
        blockers.append({"code": "runtime_" + runtime["status"]})
    else:
        if runtime["version"][:2] != manifest["runtime"]["pythonVersion"]:
            blockers.append({"code": "python_version_mismatch", "expected": manifest["runtime"]["pythonVersion"], "actual": runtime["version"]})
        for name, found in runtime["imports"].items():
            if not found:
                blockers.append({"code": "missing_import", "name": name})
    gpu = gpu_probe() if probe_hardware else {"status": "not_probed", "devices": []}
    if probe_hardware and not gpu.get("devices"):
        blockers.append({"code": "nvidia_gpu_not_confirmed"})
    if not verify_hashes:
        blockers.append({"code": "weight_integrity_not_verified", "remedy": "Run doctor --verify-hashes after installing files"})
    # Metadata/import availability alone cannot certify CUDA ABI, inference, mesh quality or Unity compatibility.
    blockers.append({"code": "inference_smoke_test_not_run"})
    if verify_hashes and any(row["role"] == "weight" and row["status"] != "verified" for row in files):
        blockers.append({"code": "weight_integrity_not_verified"})
    return {
        "schemaVersion": 1, "kind": "model3d-preflight", "backendId": manifest["backendId"],
        "status": "blocked" if any(row["code"] != "inference_smoke_test_not_run" for row in blockers) else "requires_smoke_test",
        "moduleRoot": str(root.resolve()), "moduleVersion": manifest["version"],
        "runtime": runtime, "gpu": gpu, "files": files, "blockers": blockers,
        "generationExecuted": False, "dependenciesInstalled": False,
        "scope": "Validation tooling only; not an inference, CUDA ABI, mesh quality or Unity import certification",
    }


def sizing(manifest_path: Path) -> dict:
    manifest = load_manifest(manifest_path)
    weights = [item for item in manifest["files"] if item["role"] == "weight"]
    total = sum(item["bytes"] for item in weights)
    return {"kind": "model3d-size-inventory", "backendId": manifest["backendId"], "unit": "decimal MB = 1000000 bytes", "primaryWeightBytes": total, "primaryWeightMB": round(total / 1_000_000, 3), "primaryWeightMiB": round(total / (1024 * 1024), 3), "files": weights, "excluded": ["Python and PyTorch/CUDA", "other dependencies and compiled extensions", "auxiliary preprocessing/perceptual weights", "download caches and temporary files", "generated assets"], "compressedInstallerIncrementMeasured": False}


def plan(manifest_path: Path, root: Path, image: Path | None) -> dict:
    manifest = load_manifest(manifest_path)
    source = None
    if image is not None:
        if not image.is_file():
            raise ValueError("Input image does not exist")
        with image.open("rb") as stream:
            header = stream.read(16)
        if not (header.startswith(b"\x89PNG\r\n\x1a\n") or header.startswith(b"\xff\xd8\xff")):
            raise ValueError("Validation plan currently accepts PNG or JPEG input")
        source = {"path": str(image.resolve()), "bytes": image.stat().st_size}
    return {"kind": "model3d-run-plan", "status": "planned_not_executed", "backendId": manifest["backendId"], "moduleRoot": str(root.resolve()), "input": source, "inputRequired": source is None,
            "stages": [
                {"id": "preprocess", "output": "centered RGBA image with retained transform"},
                {"id": "multiview", "backend": "ImageDream", "output": "4 images and generator-conditioned camera manifest"},
                {"id": "gaussian", "backend": "LGM big fixed-rotation checkpoint", "output": "Gaussian PLY"},
                {"id": "mesh", "backend": "LGM convert.py", "output": "UV-textured GLB; independently measure peak VRAM"},
                {"id": "validate", "output": "structural checks, view comparisons and Unity import report"}],
            "policy": {"referenceImageAuthoritative": True, "allowMinorViewInconsistency": True, "maxConcurrentGpuStages": 1, "preserveSourceAndIntermediates": True, "onContradictoryTopology": "filter_or_regenerate_auxiliary_views"},
            "generationExecuted": False, "runnerImplemented": False,
            "nextGate": "Install an isolated supported runtime; verify weight hashes; implement and run inference smoke test"}


def verify_glb(path: Path) -> dict:
    """Read container + mesh metadata without loading GPU assets. Not a geometry/Unity validator."""
    size = path.stat().st_size
    with path.open("rb") as stream:
        header = stream.read(12)
        if len(header) != 12:
            raise ValueError("Truncated GLB header")
        magic, version, declared = struct.unpack("<4sII", header)
        if magic != b"glTF" or version != 2 or declared != size:
            raise ValueError("GLB magic/version/declared length mismatch")
        doc = None
        binary_bytes = None
        while stream.tell() < size:
            chunk_header = stream.read(8)
            if len(chunk_header) != 8:
                raise ValueError("Truncated GLB chunk header")
            length, kind = struct.unpack("<I4s", chunk_header)
            if length % 4 or stream.tell() + length > size:
                raise ValueError("Invalid GLB chunk length")
            if doc is None and kind != b"JSON":
                raise ValueError("First GLB chunk must be JSON")
            if kind == b"JSON":
                if doc is not None or length > 16 * 1024 * 1024:
                    raise ValueError("Duplicate or oversized GLB JSON chunk")
                doc = json.loads(stream.read(length).decode("utf-8"))
            elif kind == b"BIN\x00":
                if binary_bytes is not None:
                    raise ValueError("Duplicate GLB BIN chunk")
                binary_bytes = length
                stream.seek(length, 1)
            else:
                stream.seek(length, 1)
    if not isinstance(doc, dict) or doc.get("asset", {}).get("version") != "2.0":
        raise ValueError("GLB requires asset.version=2.0")
    accessors, views, buffers = doc.get("accessors", []), doc.get("bufferViews", []), doc.get("buffers", [])
    external = [item["uri"] for key in ("buffers", "images") for item in doc.get(key, []) if isinstance(item, dict) and item.get("uri") and not item["uri"].startswith("data:")]
    for index, buffer in enumerate(buffers):
        length = buffer.get("byteLength")
        if type(length) is not int or length < 0:
            raise ValueError("Invalid buffer byteLength")
        if not buffer.get("uri") and (index != 0 or binary_bytes is None or not (length <= binary_bytes <= length + 3)):
            raise ValueError("GLB embedded buffer does not match BIN chunk")
    primitives = [primitive for mesh in doc.get("meshes", []) for primitive in mesh.get("primitives", [])]
    if not primitives:
        raise ValueError("GLB contains no mesh primitives; a splat container is not a mesh")
    vertex_count = 0
    for primitive in primitives:
        index = primitive.get("attributes", {}).get("POSITION")
        if type(index) is not int or not 0 <= index < len(accessors):
            raise ValueError("Mesh primitive has no valid POSITION accessor")
        accessor = accessors[index]
        count = accessor.get("count")
        if accessor.get("type") != "VEC3" or type(count) is not int or count <= 0:
            raise ValueError("Mesh POSITION accessor must contain vertices")
        vertex_count += count
        view_index = accessor.get("bufferView")
        if type(view_index) is not int or not 0 <= view_index < len(views):
            raise ValueError("Sparse/compressed POSITION data requires a full glTF validator")
        view = views[view_index]
        buffer_index = view.get("buffer")
        if type(buffer_index) is not int or not 0 <= buffer_index < len(buffers):
            raise ValueError("POSITION bufferView references an invalid buffer")
        component_bytes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}.get(accessor.get("componentType"))
        if not component_bytes:
            raise ValueError("Unsupported POSITION component type")
        offset, view_offset, view_length = accessor.get("byteOffset", 0), view.get("byteOffset", 0), view.get("byteLength", 0)
        element_size = component_bytes * 3
        stride = view.get("byteStride", element_size)
        if any(type(n) is not int or n < 0 for n in (offset, view_offset, view_length, stride)) or stride < element_size:
            raise ValueError("Invalid POSITION storage layout")
        if offset + (count - 1) * stride + element_size > view_length or view_offset + view_length > buffers[buffer_index]["byteLength"]:
            raise ValueError("POSITION data exceeds its buffer range")
    return {"kind": "model3d-artifact-check", "status": "structural_check_passed", "path": str(path.resolve()), "representation": "mesh", "bytes": size, "meshPrimitiveCount": len(primitives), "positionCountSummedPerPrimitive": vertex_count, "hasUVOnAllPrimitives": all("TEXCOORD_0" in p.get("attributes", {}) for p in primitives), "materialCount": len(doc.get("materials", [])), "externalResourcesNotValidated": external, "unityImportVerified": False, "geometryQualityVerified": False, "fullGltfValidationPerformed": False}


def build_blueprint(manifest_path: Path, root: Path) -> dict:
    now = int(time.time() * 1000)
    args = [str(Path(sys.executable).resolve()), str(Path(__file__).resolve()), "doctor", "--manifest", str(manifest_path.resolve()), "--root", str(root.resolve())]
    if os.name == "nt":
        # Current LevelUpAgent Windows run_command uses PowerShell; single quotes prevent interpolation.
        command = "& " + " ".join("'" + value.replace("'", "''") + "'" for value in args)
    else:
        import shlex
        command = shlex.join(args)
    template = {"id": "model3d-lab-doctor", "name": "3D 模块环境检查", "description": "只检查环境与文件，不下载、不生成模型；blocked 是检查结论，不代表工具运行失败。", "inputSchema": [], "outputSchema": [{"id": "stdout", "name": "检查报告", "type": "json", "source": "{{stdout}}"}], "command": command, "argumentTemplate": "", "workdirMode": "custom", "workdir": str(PROJECT), "createdAt": now, "updatedAt": now}
    nodes = [
        {"id": "model3d-doctor", "type": "constellation", "position": {"x": 0, "y": 0}, "data": {"kind": "localTool", "label": "3D 模块环境检查", "status": "idle", "toolTemplateId": template["id"], "toolTemplate": template, "toolInputs": {}}},
        {"id": "model3d-report", "type": "constellation", "position": {"x": 430, "y": 0}, "data": {"kind": "output", "label": "环境报告（不生成模型）", "status": "idle"}},
    ]
    return {"kind": "levelup-constellation", "graph": {"schemaVersion": 1, "id": "model3d-validation", "title": "3D 可拆卸模块验证", "nodes": nodes, "edges": [{"id": "doctor-to-report", "source": "model3d-doctor", "sourceHandle": "text", "target": "model3d-report", "targetHandle": "media", "type": "smoothstep", "data": {"valueType": "text"}}], "createdAt": now, "updatedAt": now}, "blueprints": []}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["doctor", "size", "plan", "verify-glb", "blueprint"])
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--root", type=Path, default=PROJECT / "artifacts" / "model3d-validation" / "modules" / "lgm-lab" / "0.1.0")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--file", type=Path)
    parser.add_argument("--verify-hashes", action="store_true")
    parser.add_argument("--strict", action="store_true", help="Return exit 2 if doctor reports blockers; default doctor exit 0 returns a completed diagnostic report")
    args = parser.parse_args()
    try:
        if args.command == "doctor": result = doctor(args.manifest, args.root, args.verify_hashes)
        elif args.command == "size": result = sizing(args.manifest)
        elif args.command == "plan": result = plan(args.manifest, args.root, args.image)
        elif args.command == "blueprint":
            load_manifest(args.manifest)
            result = build_blueprint(args.manifest, args.root)
        else:
            if args.file is None: raise ValueError("verify-glb requires --file")
            result = verify_glb(args.file)
        exit_code = 2 if args.strict and result.get("status") in {"blocked", "requires_smoke_test"} else 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError, struct.error) as exc:
        result = {"status": "error", "error": str(exc), "generationExecuted": False}
        exit_code = 1
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    print(text, end="")
    return exit_code


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
