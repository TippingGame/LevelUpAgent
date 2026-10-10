import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from bridge import Bridge
from backend.core import Config, Store, inspect_wav, new_job


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="levelup audio 中文 ")
        self.config = Config(self.temp.name)
        self.bridge = Bridge(self.config)

    def tearDown(self):
        self.bridge.close()
        self.temp.cleanup()

    def wait(self, job):
        for _ in range(200):
            job = self.bridge.store.get(job["id"])
            if job["status"] not in ("queued", "running"):
                return job
            time.sleep(.05)
        self.fail("Job timed out")

    def sketch(self):
        # Internal synthetic worker is used only to test queue/audio semantics.
        # The production bridge explicitly rejects this engine.
        return self.wait(self.bridge.manager.submit({"engine": "sketch", "prompt": "test rhythm", "duration": 4}))

    def test_real_audio_trim_persistence_and_original_preservation(self):
        job = self.sketch()
        self.assertEqual(job["status"], "succeeded", job)
        source = self.config.outputs / job["id"] / "audio.wav"
        original = source.read_bytes()
        cut = self.bridge.dispatch("trim", {"id": job["id"], "start": .5, "end": 2.5, "fade": .1})
        self.assertEqual(cut["audio"]["duration"], 2)
        self.assertEqual(cut["parent_id"], job["id"])
        self.assertEqual(source.read_bytes(), original)
        self.assertGreater(inspect_wav(self.config.outputs / cut["id"] / "audio.wav")["rms"], .01)
        self.bridge.dispatch("favorite", {"id": job["id"], "favorite": True})
        self.bridge.dispatch("archive", {"id": job["id"], "archived": True})
        self.assertTrue(Store(self.config.data / "library.sqlite3").get(job["id"])["favorite"])
        self.bridge.dispatch("archive", {"id": job["id"], "archived": False})
        self.assertFalse(self.bridge.store.get(job["id"])["archived"])

    def test_missing_model_does_not_fallback_and_unknown_actions_rejected(self):
        for action, body in [("generate", {"prompt": "warm piano"}), ("generate", {"engine": "sketch", "prompt": "warm piano"}), ("install", {}), ("generate", [])]:
            with self.subTest(action=action, body=body), self.assertRaises(ValueError):
                self.bridge.dispatch(action, body)
        self.assertFalse(self.bridge.dispatch("status", {})["ready"])
        self.assertEqual(self.bridge.store.all(), [])

    def test_cancel_queued_job_and_recover_interrupted_queue(self):
        with self.bridge.manager.lock:
            job = self.bridge.manager.submit({"engine": "sketch", "prompt": "test beat"})
            self.bridge.dispatch("cancel", {"id": job["id"]})
        self.assertEqual(self.bridge.store.get(job["id"])["status"], "cancelled")
        self.bridge.close()
        interrupted = new_job({"engine": "musicgen", "title": "unfinished"})
        self.bridge.store.save(interrupted)
        self.bridge = Bridge(self.config)
        self.assertEqual(self.bridge.store.get(interrupted["id"])["status"], "interrupted")

    def test_invalid_trim_cleans_partial_and_leaves_source(self):
        job = self.sketch()
        before = set(self.config.outputs.iterdir())
        for data in [{"start": 2, "end": 1}, {"start": 0, "end": 3, "fade": 2}, {"start": float("nan"), "end": 3}]:
            with self.assertRaises(ValueError):
                self.bridge.dispatch("trim", dict(data, id=job["id"]))
        self.assertEqual(before, set(self.config.outputs.iterdir()))

    def test_stdio_invalid_request_keeps_service_and_eof_exits(self):
        child = subprocess.Popen([sys.executable, "-u", str(ROOT / "bridge.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", env=dict(os.environ, LEVELUP_MUSIC_DATA=str(Path(self.temp.name) / "ipc")))
        output, errors = child.communicate('broken\n{"action":"status"}\n', timeout=10)
        self.assertEqual(child.returncode, 0, errors)
        lines = [json.loads(line) for line in output.splitlines()]
        self.assertIn("error", lines[0])
        self.assertEqual(lines[1]["result"]["jobs"], [])


if __name__ == "__main__":
    unittest.main()
