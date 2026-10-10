"""Invoked ONLY in the isolated MusicGen environment. Never downloads on inference."""
import json
import os
from pathlib import Path
import sys
import time

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def event(progress, phase):
    print(json.dumps({"progress": progress, "phase": phase}, ensure_ascii=False), flush=True)


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    event(5, "正在载入本地模型")
    import numpy as np
    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration, StoppingCriteria, StoppingCriteriaList, set_seed
    import wave

    params = request["params"]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.set_num_threads(min(8, os.cpu_count() or 4))
    set_seed(params["seed"])
    started = time.time()
    processor = AutoProcessor.from_pretrained(request["model"], local_files_only=True)
    model = MusicgenForConditionalGeneration.from_pretrained(request["model"], local_files_only=True, torch_dtype=torch.float32, attn_implementation="eager").to(device)
    inputs = processor(text=[params["prompt"]], padding=True, return_tensors="pt").to(device)
    tokens = int(params["duration"] * model.audio_encoder.config.frame_rate)

    class Progress(StoppingCriteria):
        last = 0
        def __call__(self, input_ids, scores, **kwargs):
            step = input_ids.shape[-1]
            if step - self.last >= 25:
                self.last = step
                event(min(93, 15 + int(step / tokens * 78)), f"正在创作 · {min(step, tokens)} / {tokens} 音频步")
            return False

    event(15, "开始生成 · " + device.upper())
    with torch.inference_mode():
        audio = model.generate(**inputs, do_sample=True, guidance_scale=params["guidance"], max_new_tokens=tokens, stopping_criteria=StoppingCriteriaList([Progress()]))
    event(96, "保存音频与生成记录")
    data = audio[0].detach().cpu().float().numpy().T
    data = np.nan_to_num(data)
    # Preserve headroom; do not amplify quiet results or normalize every file to 0 dBFS.
    peak = float(np.max(np.abs(data)))
    if peak > 0.98:
        data *= 0.98 / peak
    rate = model.audio_encoder.config.sampling_rate
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2")
    with wave.open(request["output"], "wb") as wav:
        wav.setnchannels(pcm.shape[1] if pcm.ndim > 1 else 1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())
    print(json.dumps({"metrics": {"device": device, "torch": torch.__version__, "seconds": round(time.time() - started, 2), "peak_gpu_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 3) if device == "cuda" else 0}}), flush=True)


if __name__ == "__main__":
    main()
