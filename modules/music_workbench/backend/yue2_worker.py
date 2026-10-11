"""Offline INT8 YuE2 inference. Uses pinned Comfy libraries, never its server."""
import copy
import gc
import json
import os
from pathlib import Path
import sys
import time


def report(phase, progress, **fields):
    print(json.dumps(dict(phase=phase, progress=progress, **fields), ensure_ascii=False), flush=True)


def generate(request):
    output = Path(request["output"])
    models = Path(request["model"])
    runtime = Path(sys.executable).parent
    cache = Path(os.environ["LEVELUP_MUSIC_DATA"]) / "cache/yue2"
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                     TQDM_DISABLE="1", TORCH_HOME=str(cache / "torch"),
                     TRITON_CACHE_DIR=str(cache / "triton"), TORCHINDUCTOR_CACHE_DIR=str(cache / "inductor"))
    sys.path.insert(0, str(runtime / "comfy-source"))
    sys.path.insert(0, str(Path(__file__).parent))
    import torch
    import soundfile as sf
    import psutil
    if not torch.cuda.is_available() or torch.cuda.get_device_capability(0)[0] < 8 or not torch.cuda.is_bf16_supported():
        raise RuntimeError("YuE2 INT8 需要支持 BF16 的 NVIDIA 显卡（RTX 30 系及以上），以及兼容 CUDA 13.0 的驱动。")
    from comfy.cli_args import args
    args.disable_dynamic_vram = True
    args.use_pytorch_cross_attention = True
    args.disable_all_custom_nodes = True
    import comfy.sd
    import comfy.sample
    import comfy.utils
    import comfy.model_management as mm
    from comfy.text_encoders.yue2 import CONTEXT
    from yue2_audio import remove_vocals

    params = request["params"]
    maximum = round(params["duration"] * 25)
    started = time.monotonic()
    torch.set_grad_enabled(False)
    torch.cuda.reset_peak_memory_stats()
    state = {"phase": "加载 YuE2 INT8", "start": 2, "end": 4, "last": 0}

    def stage(phase, start, end):
        state.update(phase=phase, start=start, end=end)
        report(phase, start)

    def progress(value, total, preview=None, **kwargs):
        now = time.monotonic()
        if now - state["last"] > 0.5 or value == total:
            state["last"] = now
            report(state["phase"], state["start"] + int((state["end"] - state["start"]) * min(1, value / max(1, total))))

    comfy.utils.set_progress_bar_enabled(False)
    comfy.utils.set_progress_bar_global_hook(progress)
    stage("正在加载 YuE2 INT8", 2, 4)
    model, clip, vae, _ = comfy.sd.load_checkpoint_guess_config(str(models / "checkpoints/yue2_3b_int8_convrot.safetensors"), disable_dynamic=True)
    warnings = []
    truncated = {"abc": False, "semantic": False}
    try:
        style = params["prompt"]
        instrumental = params["mode"] == "instrumental"
        lyrics = "" if instrumental else params["lyrics"]
        if instrumental:
            style += ", instrumental, no vocals"
        elif params.get("language", "auto") != "auto":
            style += ", " + {"zh": "Mandarin Chinese vocals", "en": "English vocals", "ja": "Japanese vocals"}[params["language"]]
        seed = params["seed"]

        def transcribe(audio, start, end):
            stage("正在从音频提取旋律", start, end)
            mm.unload_all_models()
            from comfy.audio_encoders.audio_encoders import load_audio_encoder_from_sd
            encoder = load_audio_encoder_from_sd(comfy.utils.load_torch_file(str(models / "audio_encoders/sheetsage2_bf16.safetensors"), safe_load=True))
            try:
                scores = encoder.generate_abc(audio, 48000, melody_only=True)
                if not scores or not scores[0].strip():
                    raise ValueError("未从参考音频中提取到旋律，请换一段旋律清晰的音频。")
                return scores[0]
            finally:
                mm.unload_all_models()
                del encoder
                gc.collect()
                mm.soft_empty_cache()

        def synthesize(abc, mode, start, end):
            span = end - start
            stage("正在生成音乐片段", start, start + int(span * .7))
            positive = clip.encode_from_tokens_scheduled(clip.tokenize(
                style, lyrics=lyrics, cot=mode if abc.strip() else "off", seed=seed, abc=abc,
                max_tokens=maximum, temperature=1., top_p=.95, top_k=100, repetition_penalty=1.2, cfg_scale=1.))
            truncated["semantic"] |= bool(positive[0][1]["yue2_truncated"])
            frames = positive[0][1]["yue2_frames"]
            if frames < 1:
                raise ValueError("模型没有生成音乐，请更换描述或种子。")
            negative = [[torch.zeros_like(c), copy.copy(options)] for c, options in positive]
            stage("正在合成人声与伴奏" if not instrumental else "正在合成伴奏", start + int(span * .7), start + int(span * .93))
            latent = torch.zeros((1, 64, frames))
            samples = comfy.sample.sample(model, comfy.sample.prepare_noise(latent, seed), 32, 1., "dpm_2", "sgm_uniform", positive, negative, latent, seed=seed, disable_pbar=True)
            del positive, negative, latent
            stage("正在分块解码音频", start + int(span * .93), end)
            audio = vae.decode_tiled(samples, tile_x=128, tile_y=128, overlap=16).cpu().float().movedim(-1, 1)
            audio = audio / max(1., float(audio.std()) * 5)
            return audio

        if request.get("reference"):
            array, rate = sf.read(request["reference"], dtype="float32", always_2d=True)
            if rate != 48000:
                raise ValueError("参考音频格式不匹配，请重新导入。")
            abc = transcribe(torch.from_numpy(array.T).unsqueeze(0), 5, 22)
            mode = "melody"
        else:
            stage("正在规划旋律与段落", 5, 22)
            tokens = clip.tokenize(style, lyrics=lyrics, cot="full", seed=seed, penalty_window=100)
            budget = min(20000, max(4096, round(params["duration"] * 40)), CONTEXT - len(tokens["prefix"]) - 1)
            ids = clip.generate(tokens, max_length=budget, temperature=.7, top_p=.9, top_k=30, repetition_penalty=1.005, seed=seed)
            truncated["abc"] = len(ids) >= budget
            abc, mode = clip.decode(ids), "full"
        (output.parent / "score.abc").write_text(abc, encoding="utf-8")
        audio = synthesize(abc, mode, 23, 52 if instrumental and not request.get("reference") else 90)
        if instrumental:
            mm.unload_all_models()
            stage("正在去除人声", 53 if not request.get("reference") else 91, 60 if not request.get("reference") else 98)
            audio = remove_vocals(audio, models / "hdemucs_high_trained.pt", progress)
            if not request.get("reference"):
                # New package's pure-music workflow: separate, extract melody,
                # regenerate from that melody, then separate the final audio.
                abc = transcribe(audio, 61, 69)
                (output.parent / "instrumental-score.abc").write_text(abc, encoding="utf-8")
                audio = synthesize(abc, "melody", 70, 91)
                mm.unload_all_models()
                stage("正在净化纯音乐", 92, 98)
                audio = remove_vocals(audio, models / "hdemucs_high_trained.pt", progress)
            warnings.append("已自动去人声，仍可能残留哼唱或分离伪影，请试听。")
        if truncated["abc"]:
            warnings.append("乐谱规划达到长度上限，请检查段落完整性。")
        if truncated["semantic"]:
            warnings.append("已达到时长或模型上下文上限，结尾或歌词可能未完成；可增加时长上限或精简描述后重新生成。")
        if not torch.isfinite(audio).all():
            raise ValueError("模型生成了无效采样，请更换种子重试。")
        sf.write(output, audio[0].T.numpy(), 48000, subtype="PCM_16")
        memory = psutil.Process().memory_info()
        metrics = {"seconds": round(time.monotonic() - started, 2), "device": "cuda",
                   "peak_gpu_gb": round(torch.cuda.max_memory_allocated() / 2**30, 3),
                   "peak_ram_gb": round(getattr(memory, "peak_wset", memory.rss) / 2**30, 3)}
        receipt = {"engine": "yue2", "engine_label": "YuE2 INT8", "metrics": metrics, "warnings": warnings, "truncated": truncated,
                   "license": "CC-BY-NC-4.0", "model_revision": request.get("model_revision"),
                   "duration_mode": "maximum", "quantization": "convrot_int8", "reference_id": params.get("reference_id"),
                   "workflow": "instrumental-refinement" if instrumental and not request.get("reference") else "melody-cover" if request.get("reference") else "text-to-song"}
        (output.parent / "generation.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        report("音频已保存", 99, metrics=metrics)
    finally:
        mm.unload_all_models()
        del model, clip, vae
        gc.collect()


if __name__ == "__main__":
    generate(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
