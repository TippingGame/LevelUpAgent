from __future__ import annotations

import array
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid
import wave

ROOT = Path(__file__).resolve().parents[1]
VERSION = "1"
MODEL_REVISION = "4c8334b02c6ec4e8664a91979669a501ec497792"
MODEL_FILES = ["config.json", "generation_config.json", "model.safetensors", "preprocessor_config.json", "special_tokens_map.json", "spiece.model", "tokenizer.json", "tokenizer_config.json"]
SONG_SPECS = json.loads((ROOT / "song-resources.json").read_text(encoding="utf-8"))
ENGINES = {"musicgen": {"label": "MusicGen Small", "min": 4, "max": 30, "revision": MODEL_REVISION},
           "acestep": {"label": "ACE-Step 1.5", "min": 10, "max": 600, "revision": SONG_SPECS["acestep"]["modelRevision"]},
           "yue2": {"label": "YuE2", "min": 8, "max": 360, "revision": SONG_SPECS["yue2"]["modelRevision"]}}


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


class Config:
    def __init__(self, data_dir=None):
        self.data = Path(data_dir or os.environ["LEVELUP_MUSIC_DATA"]).resolve()
        self.data.mkdir(parents=True, exist_ok=True)
        self.models = Path(os.environ.get("LEVELUP_MUSIC_MODELS", self.data / "resources")).resolve()
        self.runtime = Path(os.environ.get("LEVELUP_MUSIC_RUNTIME", self.models / "runtime")).resolve()
        # Supplied only by the host. Prompts/IPC requests cannot override paths.
        self.engine_roots = json.loads(os.environ.get("LEVELUP_MUSIC_ENGINE_ROOTS", "{}"))
        self.outputs = self.data / "outputs"
        self.outputs.mkdir(exist_ok=True)

    @property
    def python(self):
        return self.runtime / ("python.exe" if os.name == "nt" else "bin/python")

    @property
    def model(self):
        return self.models / "musicgen-small"

    def paths(self, engine):
        if engine == "musicgen":
            return self.runtime, self.model
        spec = SONG_SPECS[engine]
        root = Path(self.engine_roots.get(engine, self.data / "resources" / spec["resourceVersion"])).resolve()
        return root / "runtime", root / spec["components"][1]



class Store:
    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        self.lock = threading.RLock()

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            with db:
                yield db
        finally:
            # sqlite3's transaction context does not close its file handle.
            db.close()

    def save(self, job, table="jobs"):
        assert table in ("jobs", "drafts")
        with self.lock, self.connect() as db:
            db.execute(f"INSERT OR REPLACE INTO {table} VALUES (?, ?)", (job["id"], json.dumps(job, ensure_ascii=False)))
        return job

    def get(self, job_id, table="jobs"):
        assert table in ("jobs", "drafts")
        with self.connect() as db:
            row = db.execute(f"SELECT data FROM {table} WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise KeyError("找不到该记录")
        return json.loads(row[0])

    def all(self, table="jobs"):
        assert table in ("jobs", "drafts")
        with self.connect() as db:
            rows = db.execute(f"SELECT data FROM {table}").fetchall()
        return sorted((json.loads(r[0]) for r in rows), key=lambda j: j["created_at"], reverse=True)

    def update(self, job_id, **fields):
        with self.lock:
            job = self.get(job_id)
            job.update(fields)
            return self.save(job)


def numeric(value, name, lower, upper, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} 必须是有效数字")
    if not lower <= value <= upper or (integer and int(value) != value):
        raise ValueError(f"{name} 须在 {lower}–{upper} 之间" + ("，且为整数" if integer else ""))
    return int(value) if integer else float(value)


def request_params(body):
    engine = body.get("engine", "musicgen")
    if engine not in (*ENGINES, "sketch"):
        raise ValueError("此引擎尚未接入；请选择已实现的引擎")
    prompt = body.get("prompt", "")
    title = body.get("title", "未命名灵感")
    lyrics = body.get("lyrics", "")
    if not isinstance(prompt, str) or not 3 <= len(prompt.strip()) <= 2000:
        raise ValueError("音乐描述须为 3–2000 个字符")
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 80:
        raise ValueError("作品名须为 1–80 个字符")
    if not isinstance(lyrics, str) or len(lyrics) > 6000:
        raise ValueError("歌词过长")
    mode = body.get("mode", "instrumental")
    language = body.get("language", "auto")
    if mode not in ("instrumental", "song") or language not in ("auto", "zh", "en", "ja"):
        raise ValueError("请选择有效的创作方式和演唱语言")
    if engine in ("musicgen", "sketch") and (mode == "song" or lyrics.strip()):
        raise ValueError("当前引擎只生成纯音乐，不支持歌词")
    if mode == "song" and not lyrics.strip():
        raise ValueError("请填写歌词，或选择纯音乐")
    if engine == "acestep" and (len(prompt.strip()) > 512 or len(lyrics.strip()) > 4096):
        raise ValueError("ACE-Step 音乐描述最多 512 字，歌词最多 4096 字")
    limits = ENGINES.get(engine, ENGINES["musicgen"])
    return {
        "engine": engine, "mode": mode, "language": language,
        "title": title.strip(), "prompt": prompt.strip(), "lyrics": lyrics.strip() if mode == "song" else "",
        "duration": numeric(body.get("duration", 10), "时长", limits["min"], limits["max"]),
        "seed": numeric(body.get("seed", 42), "种子", 0, 2147483647, True),
        "guidance": numeric(body.get("guidance", 3), "提示词强度", 1, 8),
        "bpm": numeric(body.get("bpm", 90), "速度", 40, 200, True),
    }


def new_job(params, kind="generate"):
    return {"id": uuid.uuid4().hex, "kind": kind, "status": "queued", "progress": 0, "phase": "等待开始", "created_at": time.time(), "params": params, "favorite": False, "archived": False, "version": VERSION}


def inspect_wav(path: Path):
    with wave.open(str(path), "rb") as f:
        rate, channels, width, count = f.getframerate(), f.getnchannels(), f.getsampwidth(), f.getnframes()
        if width != 2 or channels not in (1, 2) or count == 0 or count / rate > 650:
            raise ValueError("仅支持不超过 650 秒的单声道/立体声 PCM16 WAV")
        samples = array.array("h", f.readframes(count))
    # WAV PCM is little endian; supported Windows targets are little endian.
    step = max(1, len(samples) // 180)
    peaks = [round(max(abs(x) for x in samples[i:i + step]) / 32768, 4) for i in range(0, len(samples), step)][:180]
    rms = math.sqrt(sum((x / 32768) ** 2 for x in samples) / len(samples))
    return {"sample_rate": rate, "channels": channels, "duration": round(count / rate, 3), "frames": count, "peak": round(max(abs(x) for x in samples) / 32768, 5), "rms": round(rms, 6), "peaks": peaks, "bytes": path.stat().st_size}


def trim_wav(source: Path, target: Path, start, end, fade):
    info = inspect_wav(source)
    start = numeric(start, "开始位置", 0, info["duration"])
    end = numeric(end, "结束位置", 0, info["duration"])
    if end - start < 0.1:
        raise ValueError("保留片段至少需要 0.1 秒")
    fade = numeric(fade, "淡入淡出", 0, min(5, (end - start) / 2))
    with wave.open(str(source), "rb") as src:
        rate, channels = src.getframerate(), src.getnchannels()
        src.setpos(int(start * rate))
        samples = array.array("h", src.readframes(int((end - start) * rate)))
    frame_count = len(samples) // channels
    fade_frames = int(fade * rate)
    if fade_frames:
        # Only the edges change. Iterating the entire song makes long trims
        # needlessly slow and can block the control pipe for tens of seconds.
        for edge in range(fade_frames):
            gain = edge / fade_frames
            for frame in (edge, frame_count - 1 - edge):
                for c in range(channels):
                    samples[frame * channels + c] = int(samples[frame * channels + c] * gain)
    with wave.open(str(target), "wb") as dst:
        dst.setnchannels(channels)
        dst.setsampwidth(2)
        dst.setframerate(rate)
        dst.writeframes(samples.tobytes())
    return inspect_wav(target)
