"""Live decoder checks run in the prepared YuE2 runtime; control-only CI skips them."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

HELPER = Path(__file__).resolve().parents[1] / "backend/yue2_audio.py"


@unittest.skipUnless(importlib.util.find_spec("av") and importlib.util.find_spec("soundfile"), "Requires the portable YuE2 decoder")
class ReferenceAudioTest(unittest.TestCase):
    def decode(self, source, target):
        return subprocess.run([sys.executable, "-B", "-s", str(HELPER), str(source), str(target)], capture_output=True, timeout=30)

    def test_mono_resampling_preserves_source(self):
        with tempfile.TemporaryDirectory(prefix="参考音频 ") as directory:
            source, target = Path(directory) / "input.wav", Path(directory) / "output.wav"
            with wave.open(str(source), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                audio.writeframes(b"\x00\x10\x00\xf0" * 16000)
            original = source.read_bytes()
            result = self.decode(source, target)
            self.assertEqual(result.returncode, 0, result.stderr)
            with wave.open(str(target)) as audio:
                self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getnframes()), (48000, 2, 2, 96000))
            self.assertEqual(source.read_bytes(), original)

    def test_empty_and_too_short_files_leave_no_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "bad.wav", Path(directory) / "partial.wav"
            for frames in (b"", b"\x00\x10" * 100):
                with wave.open(str(source), "wb") as audio:
                    audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                    audio.writeframes(frames)
                self.assertNotEqual(self.decode(source, target).returncode, 0)
                self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
