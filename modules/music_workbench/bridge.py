"""Host-owned JSON-lines IPC. No listening port, HTTP server, or system Python.

Closing the host pipe cancels the worker tree; a crash is recovered by JobManager.
Only this small control plane is shipped inside the desktop application.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backend.core import Config, ENGINES, ROOT, Store, new_job, trim_wav, write_json
from backend.engine import JobManager, readiness


class Bridge:
    def __init__(self, config):
        self.config = config
        self.store = Store(config.data / "library.sqlite3")
        self.manager = JobManager(config, self.store)

    def dispatch(self, action, body):
        if not isinstance(body, dict):
            raise ValueError("Invalid audio request")
        if action == "status":
            engines = {}
            for engine in ENGINES:
                model, runtime = readiness(self.config, engine)
                engines[engine] = {"ready": model and bool(runtime), "modelReady": model, "runtimeReady": bool(runtime)}
            return {"ready": any(e["ready"] for e in engines.values()), "engines": engines, "jobs": self.store.all()}
        if action == "generate":
            if body.get("engine", "musicgen") not in ENGINES:
                raise ValueError("请选择已安装的音频引擎")
            return self.manager.submit(body)
        if action == "import_reference":
            _, ready = readiness(self.config, "yue2")
            if not ready:
                raise ValueError("请先安装 YuE2 INT8 运行环境。")
            source = body.get("path")
            if not isinstance(source, str) or not source or len(source) > 4096:
                raise ValueError("请选择本地参考音频。")
            reference_id = uuid.uuid4().hex
            target = self.config.references / (reference_id + ".wav")
            runtime, _ = self.config.paths("yue2")
            python = runtime / ("python.exe" if os.name == "nt" else "bin/python")
            try:
                result = subprocess.run([str(python), "-B", "-s", str(ROOT / "backend/yue2_audio.py"), source, str(target)],
                                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
                                        env=dict(os.environ, PYTHONUTF8="1"), creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                if result.returncode:
                    raise ValueError("参考音频导入失败：" + result.stderr[-1000:])
                info = dict(json.loads(result.stdout), id=reference_id)
                write_json(target.with_suffix(".json"), info)
                return info
            except Exception:
                target.unlink(missing_ok=True)
                raise
        if action == "cancel":
            return self.manager.cancel(body["id"])
        if action in ("favorite", "archive"):
            field = "favorite" if action == "favorite" else "archived"
            if not isinstance(body.get(field), bool):
                raise ValueError("Invalid library flag")
            return self.store.update(body["id"], **{field: body[field]})
        if action == "trim":
            source = self.store.get(body["id"])
            if source["status"] != "succeeded" or "audio" not in source:
                raise ValueError("请先选择已生成的音频")
            job = new_job(dict(source["params"], title=source["params"]["title"][:72] + " · 剪辑"))
            directory = self.config.outputs / job["id"]
            directory.mkdir()
            audio = directory / "audio.wav"
            try:
                info = trim_wav(self.config.outputs / source["id"] / "audio.wav", audio,
                                body["start"], body["end"], body.get("fade", 0.1))
                job.update(status="succeeded", phase="剪辑已保存", progress=100,
                           parent_id=source["id"], audio=info, finished_at=time.time(),
                           sha256=hashlib.sha256(audio.read_bytes()).hexdigest(),
                           license=source.get("license"), model_revision=source.get("model_revision"),
                           engine_label=source.get("engine_label"),
                           warnings=source.get("warnings", []), truncated=source.get("truncated"),
                           edit={"start": body["start"], "end": body["end"], "fade": body.get("fade", 0.1)})
                write_json(directory / "metadata.json", job)
                return self.store.save(job)
            except Exception:
                audio.unlink(missing_ok=True)
                directory.rmdir()
                raise
        raise ValueError("Unsupported audio action")

    def close(self):
        self.manager.close()


def main():
    bridge = Bridge(Config())
    try:
        for line in sys.stdin:
            try:
                if len(line) > 65536:
                    raise ValueError("Audio request exceeds 64 KiB")
                request = json.loads(line)
                result = {"result": bridge.dispatch(request["action"], request.get("request", {}))}
            except Exception as error:
                result = {"error": str(error)[-3000:]}
            print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        bridge.close()


if __name__ == "__main__":
    main()
