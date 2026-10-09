"""Isolated TripoSG stages. Inference uses only pinned local code and weights."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import sys
import time
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.worker import ROOT, save_json, report
sys.path[:0] = [str(ROOT/'runtime/vendor/TripoSG'), str(ROOT/'runtime/vendor/TripoSG/scripts')]


def prepare(run, config):
    import numpy as np
    import torch
    from PIL import Image
    # Production accepts an explicit cutout; no restricted RMBG model is shipped.
    report(run, 'prepare', 0, '整理参考图')
    image = Image.open(run/'input_0.png').convert('RGBA')
    image.thumbnail((2048, 2048))
    rgba = np.array(image)
    alpha = rgba[..., 3]
    if alpha.min() >= 250:
        # White-background mode is deliberately limited and visible in the UI.
        if config.get('background') != 'white':
            raise ValueError('请使用透明 PNG，或选择白底图模式。')
        alpha = np.where(np.any(rgba[..., :3] < 245, axis=-1), 255, 0).astype('uint8')
        rgba[..., 3] = alpha
    ys, xs = np.where(alpha > 8)
    if not len(xs) or len(xs) >= alpha.size * .99:
        raise ValueError('没有检测到清晰主体；请先去除背景。')
    cutout = Image.fromarray(rgba).crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1))
    side = max(cutout.size)
    canvas = Image.new('RGBA', (int(side*1.2), int(side*1.2)), (255,255,255,0))
    canvas.paste(cutout, ((canvas.width-cutout.width)//2, (canvas.height-cutout.height)//2))
    canvas.save(run/'reference.png')
    white = Image.new('RGB', canvas.size, 'white')
    white.paste(canvas, mask=canvas.getchannel('A'))
    white.save(run/'prepared.png')
    save_json(run/'preprocessing.json', {'method': config.get('background', 'alpha'),
        'sourceSha256': hashlib.sha256((run/'input_0.png').read_bytes()).hexdigest()})
    report(run, 'prepare', 1, '参考图已准备')


def shape(run, config):
    import numpy as np
    import torch
    import trimesh
    from PIL import Image
    from triposg.pipelines.pipeline_triposg import TripoSGPipeline
    report(run, 'shape', 0, '载入 TripoSG 形状模型')
    pipe = TripoSGPipeline.from_pretrained(
        str(ROOT/'triposg'), torch_dtype=torch.float16, local_files_only=True,
        use_safetensors=True).to('cuda')
    report(run, 'shape', .05, '从参考图生成三维形状')

    def step_callback(pipeline, step, timestep, values):
        report(run, 'shape', .05+.65*(step+1)/config['steps'], f"形状生成 {step+1}/{config['steps']}")
        if step+1 == config['steps']:
            # These modules are no longer used by the subsequent SDF decoder.
            pipeline.transformer.to('cpu')
            pipeline.image_encoder_dinov2.to('cpu')
            torch.cuda.empty_cache()
            report(run, 'shape', .72, '解码表面网格')
        return values

    depth = 8 if config['preset'] == 'draft' else 9
    with torch.inference_mode():
        result = pipe(image=Image.open(run/'prepared.png').convert('RGB'),
                      generator=torch.Generator(device='cuda').manual_seed(config['seed']),
                      num_inference_steps=config['steps'], guidance_scale=7.0,
                      flash_octree_depth=depth, callback_on_step_end=step_callback)
    mesh = result.meshes[0]
    if not len(mesh.faces) or not np.isfinite(mesh.vertices).all():
        raise RuntimeError('TripoSG did not produce valid finite geometry')
    mesh.export(run/'raw_mesh.glb')
    save_json(run/'shape-info.json', {'backend':'triposg', 'rawVertices':len(mesh.vertices),
              'rawTriangles':len(mesh.faces), 'flashOctreeDepth':depth, 'guidanceScale':7.0,
              'numTokens':2048, 'outputKind':'untextured-mesh', 'weightsRevision':
              '2c1c516d22d58db486a058d98d31bb6177344e06'})
    report(run, 'shape', 1, '原始高精度网格已保存')


def export(run, config):
    import numpy as np
    import trimesh
    import pymeshlab
    from app.mesh_geometry import validate, render
    report(run, 'export', 0, '保留原始网格并生成减面版')
    raw = trimesh.load(run/'raw_mesh.glb', force='mesh', process=False)
    mesh = raw.copy()
    if len(mesh.faces) > config['triangles']:
        ms = pymeshlab.MeshSet()
        ms.add_mesh(pymeshlab.Mesh(vertex_matrix=np.asarray(mesh.vertices), face_matrix=np.asarray(mesh.faces)))
        ms.meshing_decimation_quadric_edge_collapse(targetfacenum=config['triangles'],
                                                   preservetopology=True, preservenormal=True)
        reduced = ms.current_mesh()
        mesh = trimesh.Trimesh(reduced.vertex_matrix(), reduced.face_matrix(), process=False)
    mesh.export(run/'model.glb')
    report(run, 'export', .25, '检查 GLB 几何与拓扑')
    result = validate(run/'model.glb')
    save_json(run/'raw-validation.json', validate(run/'raw_mesh.glb'))
    report(run, 'export', .45, '从导出 GLB 渲染灰模转台')
    render(run/'model.glb', run)
    report(run, 'export', .72, '渲染原始网格以检查减面损失')
    render(run/'raw_mesh.glb', run, prefix='raw-mesh')
    # Completion evidence appears only after all required artifacts are saved.
    save_json(run/'validation.json', result)
    report(run, 'export', 1, '灰模 GLB、转台与检查报告已保存')


def main():
    import ctypes
    import signal
    parent = os.getppid()
    ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0)
    if os.getppid() != parent:
        raise SystemExit('Parent process exited')
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['prepare','shape','export'])
    parser.add_argument('--run', type=Path, required=True)
    args = parser.parse_args()
    run = args.run.resolve()
    config = json.loads((run/'request.json').read_text(encoding='utf-8'))
    import random
    import numpy as np
    import torch
    random.seed(config['seed']); np.random.seed(config['seed']); torch.manual_seed(config['seed'])
    if not torch.cuda.is_available():
        raise RuntimeError('TripoSG requires a CUDA GPU')
    torch.cuda.set_per_process_memory_fraction(.85)
    torch.cuda.reset_peak_memory_stats()
    started = time.time()
    metrics = {'stage':args.stage, 'backend':'triposg', 'startedAt':started,
               'gpu':torch.cuda.get_device_name(), 'torch':torch.__version__, 'cuda':torch.version.cuda,
               'implementationVersion':'0.2.0', 'status':'running', 'pytorchMemoryFraction':.85}
    try:
        globals()[args.stage](run, config)
        torch.cuda.synchronize()
        metrics['status'] = 'completed'
    except Exception as exc:
        metrics.update(status='failed', error=str(exc), traceback=traceback.format_exc())
        raise
    finally:
        metrics.update(seconds=round(time.time()-started,3),
                       peakAllocatedMiB=round(torch.cuda.max_memory_allocated()/2**20,1),
                       peakReservedMiB=round(torch.cuda.max_memory_reserved()/2**20,1))
        save_json(run/f'metrics-{args.stage}.json', metrics)


if __name__ == '__main__':
    main()
