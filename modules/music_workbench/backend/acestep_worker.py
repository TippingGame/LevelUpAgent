"""One offline ACE-Step 1.5 Turbo job, using the native DiT inference API."""
import json
import os
from pathlib import Path
import sys
import time


def report(phase, progress, **fields):
    print(json.dumps(dict(phase=phase, progress=progress, **fields), ensure_ascii=False), flush=True)


def generate(request):
    output = Path(request["output"])
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      ACESTEP_CHECKPOINTS_DIR=request["model"], ACESTEP_DISABLE_TQDM="1",
                      HF_HOME=str(output.parent / "cache"))
    import torch
    import soundfile as sf
    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music

    if not torch.cuda.is_available():
        raise RuntimeError("ACE-Step 1.5 当前的 Windows 运行环境需要 NVIDIA 显卡及兼容 CUDA 12.8 的驱动。")
    params = request["params"]
    started = time.monotonic()
    torch.cuda.reset_peak_memory_stats()
    report("正在加载 ACE-Step 1.5", 2)
    handler = AceStepHandler()
    handler._progress_estimates_path = str(output.parent / "progress-estimates.json")
    handler.temp_dir = str(output.parent / "acestep")
    status, ready = handler.initialize_service(
        project_root=str(output.parent), config_path="acestep-v15-turbo", device="cuda",
        use_flash_attention=False, compile_model=False, offload_to_cpu=True,
        offload_dit_to_cpu=True, quantization=None, use_mlx_dit=False, vae_checkpoint="official",
    )
    if not ready:
        raise RuntimeError(status)
    report("正在生成音乐", 15)
    last = 15

    def progress(value, desc="", **_):
        nonlocal last
        if isinstance(value, (int, float)):
            last = max(last, min(95, int(value * 80 + 15)))
        report("正在解码音频" if "decod" in desc.lower() else "正在生成音乐", last)

    song = params.get("mode") == "song"
    result = generate_music(
        dit_handler=handler, llm_handler=None,
        params=GenerationParams(
            caption=params["prompt"], lyrics=params.get("lyrics", "") if song else "[Instrumental]",
            instrumental=not song, vocal_language=params.get("language", "auto").replace("auto", "unknown"),
            duration=params["duration"], seed=params["seed"], inference_steps=8,
            thinking=False, use_cot_metas=False, use_cot_caption=False, use_cot_language=False,
        ),
        config=GenerationConfig(batch_size=1, use_random_seed=False, seeds=[params["seed"]], audio_format="wav"),
        save_dir=None, progress=progress,
    )
    if not result.success or not result.audios:
        raise RuntimeError(result.error or result.status_message or "ACE-Step 未返回音频")
    audio = result.audios[0]
    tensor = audio["tensor"].detach().cpu().float()
    if not torch.isfinite(tensor).all():
        raise RuntimeError("生成音频包含无效采样，请更换种子重试。")
    sf.write(output, tensor.T.numpy(), audio["sample_rate"], subtype="PCM_16")
    metrics = {"seconds": round(time.monotonic() - started, 2), "device": "cuda",
               "peak_gpu_gb": round(torch.cuda.max_memory_allocated() / 2**30, 3)}
    receipt = {"engine": "acestep", "metrics": metrics, "warnings": [], "license": "MIT; Qwen3 Apache-2.0",
               "model_revision": request.get("model_revision"), "duration_mode": "target",
               "thinking": False, "inference_steps": 8}
    (output.parent / "generation.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    report("音频已保存", 99, metrics=metrics)


if __name__ == "__main__":
    generate(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
