"""Deterministic procedural sketch for offline device checks. This is NOT an AI model."""
import array
import json
import math
from pathlib import Path
import random
import sys
import wave

request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
p = request["params"]
rate = 24000
rng = random.Random(p["seed"])
beat = 60 / p["bpm"]
roots = [130.81, 103.83, 155.56, 116.54]
pcm = array.array("h")
for i in range(int(p["duration"] * rate)):
    t = i / rate
    root = roots[int(t / (4 * beat)) % 4]
    chord = sum(math.sin(2 * math.pi * root * ratio * t) for ratio in (1, 1.25, 1.5)) * 0.1
    phase = t % beat
    kick = math.sin(2 * math.pi * (48 * phase + 8 * (1 - math.exp(-phase * 35)))) * math.exp(-phase * 18) * .24
    hat_phase = t % (beat / 2)
    hat = (rng.random() * 2 - 1) * math.exp(-hat_phase * 85) * .07
    envelope = min(1, t / .2, (p["duration"] - t) / .4)
    pcm.append(int((chord + kick + hat) * envelope * 26000))
    if i % rate == 0:
        print(json.dumps({"progress": int(t / p["duration"] * 95), "phase": "合成节拍草稿（非 AI）"}), flush=True)
with wave.open(request["output"], "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(rate)
    wav.writeframes(pcm.tobytes())
