from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import threading
import time

from .core import ROOT, ENGINES, MODEL_FILES, MODEL_REVISION, inspect_wav, new_job, request_params, write_json

def readiness(config, engine="musicgen"):
    runtime_path, model_path = config.paths(engine)
    marker = model_path / "manifest.json"
    model_ok = False
    if marker.exists():
        try:
            manifest = json.loads(marker.read_text(encoding="utf-8"))
            records = {r["file"]: r for r in manifest["files"]}
            required = MODEL_FILES if engine == "musicgen" else (
                ["acestep-v15-turbo/model.safetensors", "vae/diffusion_pytorch_model.safetensors", "Qwen3-Embedding-0.6B/model.safetensors"] if engine == "acestep" else ["YuE2-3B/model.safetensors", "YuE2-Vae/model.safetensors"])
            model_ok = manifest["revision"] == ENGINES[engine]["revision"] and all(name in records for name in required) and all(
                (model_path / name).resolve().is_relative_to(model_path) and (model_path / name).is_file() and (model_path / name).stat().st_size == record["bytes"] for name, record in records.items())
        except (KeyError, ValueError, OSError):
            pass
    runtime_info = {}
    marker_runtime = runtime_path / "ready.json"
    if marker_runtime.exists() and (runtime_path / ("python.exe" if os.name == "nt" else "bin/python")).exists():
        try:
            runtime_info = json.loads(marker_runtime.read_text(encoding="utf-8"))
            if engine != "musicgen" and runtime_info.get("engine") != engine:
                runtime_info = {}
        except (ValueError, OSError):
            pass
    return model_ok, runtime_info


class JobManager:
    def __init__(self, config, store):
        self.config, self.store = config, store
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.process = None
        self.active_id = None
        for job in store.all():
            if job["status"] in ("queued", "running"):
                store.update(job["id"], status="interrupted", phase="上次服务已停止，可重新生成", finished_at=time.time())
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def submit(self, body):
        params = request_params(body)
        if params["engine"] in ENGINES:
            ok, runtime = readiness(self.config, params["engine"])
            if not ok or not runtime:
                raise ValueError("请先到环境与下载安装 " + ENGINES[params["engine"]]["label"])
        with self.lock:
            if sum(j["status"] in ("queued", "running") for j in self.store.all()) >= 8:
                raise ValueError("队列已满，请等待当前任务完成")
            job = new_job(params)
            parent = body.get("parent_id")
            if parent:
                self.store.get(parent)
                job["parent_id"] = parent
            self.store.save(job)
            self.wake.set()
            return job

    def cancel(self, job_id):
        with self.lock:
            job = self.store.get(job_id)
            if job["status"] not in ("queued", "running"):
                return job
            note = "已取消"
            job = self.store.update(job_id, status="cancelled", phase=note, finished_at=time.time())
            if self.active_id == job_id and self.process and self.process.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"], capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    os.killpg(self.process.pid, signal.SIGTERM)
            return job

    def close(self):
        self.stopping.set()
        with self.lock:
            if self.active_id:
                self.cancel(self.active_id)
        self.wake.set()
        self.thread.join(timeout=4)

    def is_cancelled(self, job_id):
        return self.stopping.is_set() or self.store.get(job_id)["status"] == "cancelled"

    def report(self, job_id, **fields):
        with self.lock:
            if not self.is_cancelled(job_id):
                self.store.update(job_id, **fields)

    def loop(self):
        while not self.stopping.is_set():
            self.wake.wait(1)
            self.wake.clear()
            with self.lock:
                jobs = [j for j in reversed(self.store.all()) if j["status"] == "queued"]
                if not jobs:
                    continue
                job = jobs[0]
                self.active_id = job["id"]
                self.store.update(job["id"], status="running", started_at=time.time(), phase="准备任务")
            try:
                self.run(job)
            except Exception as e:
                error = str(e)[-3000:]
                if "out of memory" in error.lower():
                    error = "内存或显存不足。请关闭其他生成任务，缩短音频时长后重试。\n" + error
                self.report(job["id"], status="failed", phase="任务失败", error=error, finished_at=time.time())
            finally:
                with self.lock:
                    self.process = None
                    self.active_id = None
                self.wake.set()

    def subprocess(self, job, command, directory):
        env = dict(os.environ, PYTHONUTF8="1", PYTHONUNBUFFERED="1", LEVELUP_MUSIC_DATA=str(self.config.data), LEVELUP_MUSIC_MODELS=str(self.config.models), LEVELUP_MUSIC_RUNTIME=str(self.config.runtime), HF_HUB_DISABLE_TELEMETRY="1")
        with self.lock:
            if self.is_cancelled(job["id"]):
                return
            self.process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0, start_new_session=os.name != "nt")
            process = self.process
        tail = []
        with (directory / "worker.log").open("w", encoding="utf-8") as log:
            for line in process.stdout:
                log.write(line)
                log.flush()
                tail = (tail + [line.rstrip()])[-18:]
                try:
                    msg = json.loads(line)
                    fields = {k: msg[k] for k in ("progress", "phase", "metrics") if k in msg}
                    if fields:
                        self.report(job["id"], **fields)
                except (ValueError, TypeError):
                    pass
            code = process.wait()
            process.stdout.close()
        if code and not self.is_cancelled(job["id"]):
            raise RuntimeError("\n".join(tail))

    def run(self, job):
        directory = self.config.outputs / job["id"]
        directory.mkdir(exist_ok=True)
        output = directory / "audio.wav"
        engine = job["params"]["engine"]
        runtime, model = self.config.paths(engine) if engine in ENGINES else (None, None)
        request = {"params": job["params"], "model": str(model), "output": str(output), "model_revision": ENGINES[engine]["revision"] if engine in ENGINES else None}
        if engine == "yue2":
            request.update(model=str(model / "YuE2-3B"), vae=str(model / "YuE2-Vae"))
        write_json(directory / "request.json", request)
        python = runtime / ("python.exe" if os.name == "nt" else "bin/python") if runtime else sys.executable
        worker = ROOT / "backend" / f"{engine}_worker.py"
        self.subprocess(job, [str(python), str(worker), str(directory / "request.json")], directory)
        with self.lock:
            if self.is_cancelled(job["id"]):
                return
            fields = {"status": "succeeded", "progress": 100, "phase": "已完成", "finished_at": time.time()}
            if job["kind"] == "generate":
                info = inspect_wav(output)
                if info["rms"] < 0.00001:
                    raise ValueError("生成音频为空或近乎静音，请更换种子重试")
                fields.update(audio=info, sha256=hashlib.sha256(output.read_bytes()).hexdigest(), model_revision=request["model_revision"], license="CC-BY-NC-4.0" if job["params"]["engine"] == "musicgen" else "见引擎授权")
                if (directory / "generation.json").is_file():
                    receipt = json.loads((directory / "generation.json").read_text(encoding="utf-8"))
                    fields.update({k: receipt[k] for k in ("metrics", "warnings", "truncated", "license", "duration_mode") if k in receipt})
                    if fields.get("warnings"):
                        fields["phase"] = "音频已生成，请查看提示"
                fields["artifacts"] = {"audio": str(output), "metadata": str(directory / "metadata.json"), "request": str(directory / "request.json")}
            final = self.store.update(job["id"], **fields)
            write_json(directory / "metadata.json", final)
