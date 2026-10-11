"""Opt-in live GPU acceptance through the production stdio bridge (no fixtures)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import wave

ROOT = Path(__file__).resolve().parents[1]


def run(args):
    args.output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, PYTHONUTF8="1", PYTHONNOUSERSITE="1", LEVELUP_MUSIC_DATA=str(args.output),
               LEVELUP_MUSIC_ENGINE_ROOTS=json.dumps({args.engine: str(args.resources)}))
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    log = (args.output / "service.log").open("w", encoding="utf-8")
    def start():
        return subprocess.Popen([str(args.resources / "runtime/python.exe"), "-u", "-B", "-s", str(ROOT / "modules/music_workbench/bridge.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8", env=env, creationflags=subprocess.CREATE_NO_WINDOW)
    child = start()
    def request(action, body=None):
        child.stdin.write(json.dumps({"action": action, "request": body or {}}, ensure_ascii=False) + "\n")
        child.stdin.flush()
        line = child.stdout.readline()
        if not line:
            raise RuntimeError("Bridge exited; inspect service.log")
        result = json.loads(line)
        if "error" in result:
            raise RuntimeError(result["error"])
        return result["result"]
    body = {"engine": args.engine, "mode": "song", "title": "中文歌曲 · 独立资源验收", "prompt": "Gentle acoustic pop, warm expressive female vocal, piano and guitar, clear melody", "lyrics": "[Verse]\n晨光落在窗前\n我们迎着风向前\n把昨天写成诗篇\n让梦想飞过山巅\n\n[Chorus]\n听见心中的声音\n每一步都有回音\n在这温暖的黎明\n与你并肩看风景", "language": "zh", "duration": args.duration, "seed": 20261011}
    body["mode"] = args.mode
    if args.mode == "instrumental":
        body.update(title="纯音乐 · 独立资源验收", lyrics="", prompt="Soft warm piano, acoustic guitar, calm and spacious, instrumental, no vocals")
    reference = None
    try:
        status = request("status")
        assert status["engines"][args.engine]["ready"], status
        assert not status["engines"]["musicgen"]["ready"], "Song engine must work without MusicGen installed"
        if args.reference:
            before = hashlib.sha256(args.reference.read_bytes()).hexdigest()
            reference = request("import_reference", {"path": str(args.reference.resolve())})
            assert hashlib.sha256(args.reference.read_bytes()).hexdigest() == before
            assert (args.output / "references" / (reference["id"] + ".wav")).is_file()
            body["reference_id"] = reference["id"]
        job = request("generate", body)
        started, last = time.monotonic(), None
        while True:
            job = next(j for j in request("status")["jobs"] if j["id"] == job["id"])
            state = (job["status"], job["phase"], job["progress"])
            if state != last:
                print(state, flush=True)
                last = state
            if job["status"] not in ("running", "queued"):
                break
            assert time.monotonic() - started < 3600, "Generation timed out"
            time.sleep(2)
        assert job["status"] == "succeeded", job
        assert job["audio"]["duration"] > min(30, args.duration - 1), job
        audio = args.output / "outputs" / job["id"] / "audio.wav"
        with wave.open(str(audio)) as f:
            assert f.getsampwidth() == 2 and f.getnchannels() in (1, 2)
        trim = request("trim", {"id": job["id"], "start": .5, "end": 2.5, "fade": .1})
        assert trim["audio"]["duration"] == 2
        request("favorite", {"id": job["id"], "favorite": True})
        cancelled = request("generate", dict(body, title="Cancellation check"))
        time.sleep(6)
        assert request("cancel", {"id": cancelled["id"]})["status"] == "cancelled"
        stopping = request("generate", dict(body, title="EOF check"))
        time.sleep(6)
        child.stdin.close()
        child.wait(timeout=20)
        child.stdout.close()
        child = start()
        final = request("status")
        assert not any(j["status"] in ("queued", "running") for j in final["jobs"])
        assert next(j for j in final["jobs"] if j["id"] == job["id"])["favorite"]
        if reference:
            assert job["params"]["reference_id"] == reference["id"]
            assert (args.output / "references" / (reference["id"] + ".wav")).is_file()
        receipt = json.loads((audio.parent / "generation.json").read_text(encoding="utf-8"))
        if args.engine == "yue2":
            assert receipt["quantization"] == "convrot_int8"
            assert receipt["workflow"] == ("melody-cover" if reference else "instrumental-refinement" if args.mode == "instrumental" else "text-to-song")
        (args.output / "acceptance.json").write_text(json.dumps({"generation": job, "receipt": receipt, "reference": reference, "trim": trim, "cancelled": cancelled["id"], "eof": stopping["id"], "afterRestart": final}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"PASSED: {audio}", flush=True)
    finally:
        if child.poll() is None:
            child.stdin.close()
            child.wait(timeout=20)
        child.stdout.close()
        log.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--engine", choices=("acestep", "yue2"), required=True)
    p.add_argument("--resources", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--duration", type=int, default=45, help="Requested duration in seconds; use >30 for long-song acceptance")
    p.add_argument("--mode", choices=("song", "instrumental"), default="song")
    p.add_argument("--reference", type=Path, help="Import a local audio file through the production bridge before generation")
    args = p.parse_args()
    args.resources, args.output = args.resources.resolve(), args.output.resolve()
    run(args)
