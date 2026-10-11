"""Bounded local audio decoding and HDEMUCS separation for YuE2."""
import json
from pathlib import Path
import sys


def normalize_reference(source, target):
    import av
    import soundfile as sf
    import numpy as np
    if not source.is_file() or not 0 < source.stat().st_size <= 256 * 1024**2:
        raise ValueError("参考音频须为不超过 256 MiB 的本地文件。")
    count = 0
    with av.open(str(source)) as container, sf.SoundFile(str(target), "w", samplerate=48000, channels=2, subtype="PCM_16") as output:
        if not container.streams.audio:
            raise ValueError("文件中没有音频。")
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=48000)

        def save(frames):
            nonlocal count
            for frame in frames:
                data = frame.to_ndarray().T
                count += len(data)
                if count > 600 * 48000:
                    raise ValueError("参考音频最长 600 秒，请先裁剪。")
                if not np.isfinite(data).all():
                    raise ValueError("参考音频包含无效采样。")
                output.write(data)

        for frame in container.decode(audio=0):
            save(resampler.resample(frame))
        save(resampler.resample(None))
    if count < 48000:
        raise ValueError("参考音频至少需要 1 秒。")
    return {"duration": round(count / 48000, 3), "name": source.name[:160]}


def remove_vocals(audio, weights, progress):
    import torch
    import torchaudio
    import gc
    # All track-length buffers remain on the CPU. Only a bounded window uses VRAM.
    mix = torchaudio.functional.resample(audio[0], 48000, 44100)
    mean, std = mix.mean(), mix.mean(0).std().clamp_min(1e-6)
    normalized = (mix - mean) / std
    model = torchaudio.models.hdemucs_high(sources=["drums", "bass", "other", "vocals"])
    model.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True))
    model.eval().to("cuda")
    length = mix.shape[-1]
    chunk, overlap = 44100 * 8, 44100
    result, weight = torch.zeros_like(mix), torch.zeros(length)
    # Do not add a tiny trailing window already covered by the previous chunk.
    starts = range(0, max(1, length - overlap), chunk - overlap)
    try:
        for index, start in enumerate(starts):
            end = min(length, start + chunk)
            segment = normalized[:, start:end].unsqueeze(0).to("cuda")
            with torch.inference_mode():
                estimate = model(segment)[0, :3].sum(0).cpu()
            window = torch.ones(end - start)
            edge = min(overlap, end - start)
            if start:
                window[:edge] *= torch.linspace(0, 1, edge)
            if end < length:
                window[-edge:] *= torch.linspace(1, 0, edge)
            result[:, start:end] += estimate * window
            weight[start:end] += window
            progress(index + 1, len(starts))
            del segment, estimate
        result = result / weight.clamp_min(1e-6) * std + mean
        return torchaudio.functional.resample(result, 44100, 48000)[:, :audio.shape[-1]].unsqueeze(0)
    finally:
        del model
        gc.collect()
        torch.cuda.empty_cache()


if __name__ == "__main__":
    target = Path(sys.argv[2])
    try:
        print(json.dumps(normalize_reference(Path(sys.argv[1]), target), ensure_ascii=False), flush=True)
    except Exception as error:
        target.unlink(missing_ok=True)
        print(str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
