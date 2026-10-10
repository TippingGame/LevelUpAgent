"""Host-owned JSON-lines IPC. No listening port, HTTP server, or system Python.

Closing the host pipe cancels the worker tree; a crash is recovered by JobManager.
Only this small control plane is shipped inside the desktop application.
"""
import hashlib
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backend.core import Config, Store, new_job, trim_wav, write_json
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
            model, runtime = readiness(self.config)
            return {"ready": model and bool(runtime), "jobs": self.store.all()}
        if action == "generate":
            if body.get("engine", "musicgen") != "musicgen":
                raise ValueError("请选择 MusicGen Small")
            return self.manager.submit(dict(body, engine="musicgen"))
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
