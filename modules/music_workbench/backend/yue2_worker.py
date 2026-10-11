"""One offline YuE2 job in its own pinned Python environment."""
import json
import os
from pathlib import Path
import sys
import time


def report(phase, progress, **fields):
    print(json.dumps(dict(phase=phase, progress=progress, **fields), ensure_ascii=False), flush=True)


def generate(request):
    # These paths are supplied by the desktop's resource registry, never a prompt.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    import torch
    import soundfile as sf
    from torch.nn.attention import SDPBackend, sdpa_kernel
    from yue2 import YuE2Pipeline
    from yue2.pipeline import SongResult

    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("YuE2 当前需要支持 BF16 的 NVIDIA 显卡。")
    params = request["params"]
    maximum = int(params["duration"] * 25)  # Native codec: 48 kHz / 1920 samples.
    output = Path(request["output"])
    started = time.monotonic()
    torch.cuda.reset_peak_memory_stats()
    total = torch.cuda.get_device_properties(0).total_memory / 2**30
    report("正在校验并加载 YuE2", 2)
    counts = {"abc": 0, "semantic": 0}

    def token(phase, value):
        counts[phase] += 1
        if counts[phase] % 25 == 0:
            base, span, limit = (5, 20, 4096) if phase == "abc" else (25, 50, maximum)
            report("正在规划旋律与段落" if phase == "abc" else "正在生成歌曲", min(base + int(span * counts[phase] / limit), base + span))

    # The released Windows torch wheel does not require an external FlashAttention
    # extension. Eager SDPA uses available efficient/math kernels on Ampere.
    with sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH]):
        with YuE2Pipeline.from_pretrained(
            request["model"], vae=request["vae"], local_files_only=True,
            device="cuda", backend="torch-eager", quantization="none",
            memory_budget_gib=min(total, 24), offload_ar=True,
            vae_core_frames=128 if total <= 16 else 256, progress=False,
        ) as pipe:
            style = params["prompt"]
            lyrics = params.get("lyrics", "") if params.get("mode") == "song" else "[Instrumental]"
            if params.get("mode") != "song":
                style += ", instrumental, no vocals"
            elif params.get("language", "auto") != "auto":
                style += ", " + {"zh": "Mandarin Chinese vocals", "en": "English vocals", "ja": "Japanese vocals"}[params["language"]]
            planning = params.get("planning", "full")
            report("正在规划旋律与段落", 5)
            plan = pipe.plan(style=style, lyrics=lyrics, cot=planning, seed=params["seed"], on_token=token)
            report("正在生成歌曲", 25)
            sampling = {"min_tokens": min(200, maximum), "max_tokens": maximum}
            semantic = pipe.generate_semantic(plan, sampling=sampling, on_token=token)
            report("正在合成人声与伴奏", 76)
            synth_start = time.monotonic()
            # The pinned public pipeline does not expose NAR query chunking.
            # Use its official NAR entrypoint to bound Windows SDPA workspace.
            from yue2.nar import synthesize
            latents = synthesize(
                pipe._load_model(for_nar=True), semantic.plan.prefix, semantic.tokens,
                semantic.plan.request.seed, steps=pipe.generation_config.ode_steps,
                context=pipe.generation_config.context, offload_ar=True, query_chunk_size=512,
                on_progress=lambda completed, total: report("正在合成人声与伴奏", 76 + int(11 * completed / total)),
            ).detach().float().cpu().numpy()
            synth_seconds = time.monotonic() - synth_start
            report("正在分块解码音频", 88)
            decode_start = time.monotonic()
            audio = pipe.decode(latents)
            timing = {"abc": plan.timing, "semantic": semantic.timing,
                      "nar_seconds": synth_seconds, "vae_seconds": time.monotonic() - decode_start,
                      "e2e_seconds": time.monotonic() - started}
            config = pipe.effective_config(plan.request, semantic_sampling=sampling)
            from yue2.storage import identity
            request_id = identity({"request": plan.request.to_dict(), "config": config, "weights": pipe.weights})
            result = SongResult(audio, 48000, semantic, latents, config, pipe.weights, timing, request_id)
            result.save_artifacts(output.parent / "yue2")
            sf.write(output, audio, 48000, subtype="PCM_16")
            warnings = []
            if plan.truncated:
                warnings.append("乐谱规划达到长度上限，请检查段落完整性。")
            if semantic.truncated:
                warnings.append("已达到生成时长上限，结尾或歌词可能未完成；可增加上限后重新生成。")
            metrics = {"seconds": round(time.monotonic() - started, 2), "device": "cuda",
                       "peak_gpu_gb": round(torch.cuda.max_memory_allocated() / 2**30, 3)}
            receipt = {"engine": "yue2", "metrics": metrics, "warnings": warnings,
                       "truncated": result.truncated, "license": "CC-BY-NC-4.0",
                       "model_revision": request.get("model_revision"), "duration_mode": "maximum"}
            (output.parent / "generation.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
            report("音频已保存", 99, metrics=metrics)


if __name__ == "__main__":
    generate(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
