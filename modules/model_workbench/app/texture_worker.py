"""Geometry-conditioned texturing in isolated, reproducible subprocess stages."""
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
sys.path.insert(0, str(ROOT/'runtime/vendor/MV-Adapter'))

AZIMUTHS = [-90, 0, 90, 180, 90, 90]
ELEVATIONS = [0, 0, 0, 0, 89.99, -89.99]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def geometry(path, uv_size=2048):
    from mvadapter.utils.mesh_utils import load_mesh, get_orthogonal_camera, NVDiffRastContextWrapper
    mesh = load_mesh(str(path), rescale=True, default_uv_size=uv_size, device='cuda')
    cameras = get_orthogonal_camera(elevation_deg=ELEVATIONS, azimuth_deg=AZIMUTHS,
        distance=[1.8] * 6, left=-.55, right=.55, bottom=-.55, top=.55, device='cuda')
    return mesh, cameras, NVDiffRastContextWrapper('cuda', context_type='cuda')


def uv(run, config):
    import numpy as np
    import trimesh
    import xatlas
    import torch
    from PIL import Image
    from mvadapter.utils.mesh_utils import render
    from mvadapter.utils import make_image_grid, tensor_to_image
    report(run, 'uv', 0, '检查来源网格，保存清理副本')
    source = run / 'source_mesh.glb'
    if sha(source) != config['baseMeshSha256']:
        raise RuntimeError('Source mesh changed after the texture task was created')
    mesh = trimesh.load(source, force='mesh', process=False)
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    parts = sorted(mesh.split(only_watertight=False), key=lambda m: len(m.faces), reverse=True)
    removed = []
    mesh.export(run / 'clean_mesh.glb')
    save_json(run / 'cleanup.json', {'method': config.get('cleanup', 'preserve'),
        'sourceSha256': config['baseMeshSha256'], 'cleanSha256': sha(run/'clean_mesh.glb'),
        'removedComponents': removed, 'removedTriangles': sum(p['triangles'] for p in removed),
        'remainingTriangles': len(mesh.faces), 'shapeSmoothing': False})
    from app.mesh_geometry import render as render_preview
    render_preview(run/'clean_mesh.glb',run,prefix='clean')
    report(run, 'uv', .15, '展开 UV，保留顶点与表面对应关系')
    atlas = xatlas.Atlas()
    atlas.add_mesh(np.asarray(mesh.vertices, dtype=np.float32), np.asarray(mesh.faces, dtype=np.uint32))
    pack = xatlas.PackOptions()
    pack.resolution = config['textureSize']
    pack.padding = 8
    atlas.generate(pack_options=pack)
    mapping, faces, coords = atlas[0]
    uvmesh = trimesh.Trimesh(mesh.vertices[mapping], faces, process=False)
    uvmesh.visual = trimesh.visual.TextureVisuals(uv=coords,
        material=trimesh.visual.material.PBRMaterial(baseColorTexture=Image.new('RGB',(2,2),(128,128,128)),
                                                    metallicFactor=0., roughnessFactor=.85))
    uvmesh.export(run / 'uv_mesh.glb')
    np.savez_compressed(run/'uv-mapping.npz', source_vertex=mapping, faces=faces, uv=coords)
    save_json(run/'uv-info.json', {'method':'xatlas 0.0.9', 'textureSize':config['textureSize'],
        'paddingTexels':8, 'uvMeshSha256':sha(run/'uv_mesh.glb'), 'triangles':len(faces),
        'verticesBeforeSeams':len(mesh.vertices), 'verticesAfterSeams':len(uvmesh.vertices),
        'surfacePositionError':float(np.max(np.abs(uvmesh.vertices-mesh.vertices[mapping]))),
        'atlasUtilization':float(atlas.utilization)})
    report(run, 'uv', .6, '从同一网格渲染六视角几何条件')
    size = config['viewSize']
    gm, cams, ctx = geometry(run/'uv_mesh.glb', config['textureSize'])
    with torch.no_grad():
        rendered = render(ctx, gm, cams, height=size, width=size, render_attr=False, normal_background=0.)
        positions = (rendered.pos+.5).clamp(0,1)
        normals = (rendered.normal*.5+.5).clamp(0,1)
        controls = torch.cat([positions,normals],dim=-1).permute(0,3,1,2)
        np.savez_compressed(run/'geometry-controls.npz', control=controls.cpu().half().numpy(),
            masks=rendered.mask.cpu().numpy(), depth=rendered.depth.cpu().numpy())
        make_image_grid(tensor_to_image(positions,batched=True),rows=2).save(run/'control-positions.png')
        make_image_grid(tensor_to_image(normals,batched=True),rows=2).save(run/'control-normals.png')
    save_json(run/'cameras.json', {'azimuthDegrees':AZIMUTHS,'elevationDegrees':ELEVATIONS,
        'distance':1.8,'orthographicExtent':[-.55,.55,-.55,.55],
        'sourceCoordinates':'Y up, +Z reference front',
        'renderCoordinates':'[x, -z, y] / max(abs(source_position)) * 0.5',
        'c2w':cams.c2w.cpu().tolist(),'mvp':cams.mvp_mtx.cpu().tolist(),
        'viewOrder':['front','side_a','back','side_b','top','bottom']})
    report(run, 'uv', 1, 'UV 与六视角条件已保存')


def paint(run, config):
    import numpy as np
    import torch
    from PIL import Image
    from safetensors.torch import load_file
    from mvadapter.pipelines.pipeline_mvadapter_i2mv_sd import MVAdapterI2MVSDPipeline
    from mvadapter.models.attention_processor import DecoupledMVRowColSelfAttnProcessor2_0
    from mvadapter.schedulers.scheduling_shift_snr import ShiftSNRScheduler
    from mvadapter.utils import make_image_grid
    from scripts.inference_ig2mv_sd import preprocess_image
    from app.image_preparation import prepare_reference
    report(run, 'paint', 0, '载入本地 SD2.1 与 MV-Adapter')
    weights = ROOT/'texture'
    pipe = MVAdapterI2MVSDPipeline.from_pretrained(str(weights/'base'),
        torch_dtype=torch.float16, variant='fp16', use_safetensors=True, local_files_only=True)
    pipe.scheduler = ShiftSNRScheduler.from_scheduler(pipe.scheduler, shift_mode='interpolated', shift_scale=8.)
    pipe.init_custom_adapter(num_views=6, self_attn_processor=DecoupledMVRowColSelfAttnProcessor2_0,
                             copy_attn_weights=False)
    state = load_file(str(weights/'adapter/mvadapter_ig2mv_sd21.safetensors'), device='cpu')
    pipe._load_custom_adapter(state)
    del state
    pipe.unet.to(dtype=torch.float16)
    pipe.cond_encoder.to(dtype=torch.float16)
    pipe.enable_vae_slicing()
    pipe.enable_vae_tiling()
    if config.get('memoryMode') == 'sequential':
        pipe.enable_sequential_cpu_offload()
    else:
        pipe.enable_model_cpu_offload()
    # cond_encoder is not a registered diffusers component in upstream MV-Adapter.
    def load_condition(module, inputs):
        module.to('cuda')
    pipe.cond_encoder.register_forward_pre_hook(load_condition)
    def offload_condition(module, inputs, output):
        module.to('cpu')
        torch.cuda.empty_cache()
    pipe.cond_encoder.register_forward_hook(offload_condition)
    size = config['viewSize']
    cutout, preprocessing = prepare_reference(Image.open(run/'input_0.png'), config.get('referenceBackground', config.get('background', 'alpha')))
    cutout.save(run/'reference.png')
    save_json(run/'preprocessing.json', {**preprocessing, 'sourceSha256':sha(run/'input_0.png')})
    reference = preprocess_image(cutout, size, size)
    reference.save(run/'prepared.png')
    controls = torch.from_numpy(np.load(run/'geometry-controls.npz')['control']).to('cuda')
    def step_callback(pipeline, step, timestep, values):
        total_steps = len(pipeline.scheduler.timesteps)
        report(run,'paint',.1+.85*(step+1)/total_steps,f"生成贴图视角 {step+1}/{total_steps}")
        return values
    with torch.inference_mode():
        images = pipe(config.get('prompt') or 'high quality, clean stylized character, consistent colors',
            height=size,width=size,num_images_per_prompt=6,control_image=controls,
            control_conditioning_scale=1.,reference_image=reference,reference_conditioning_scale=1.,
            num_inference_steps=config['steps'],guidance_scale=3.,
            generator=torch.Generator(device='cuda').manual_seed(config['seed']),
            negative_prompt='watermark, text, deformed, extra eyes, noisy, blurry, low contrast',
            callback_on_step_end=step_callback).images
    for i,im in enumerate(images):
        im.save(run/f'view_{i}.png')
    make_image_grid(images,rows=2).save(run/'views.png')
    save_json(run/'paint-info.json', {'backend':'MV-Adapter SD2.1 image+geometry',
        'viewSize':size,'steps':config['steps'],'guidanceScale':3.,'seed':config['seed'],
        'memoryMode':config['memoryMode'],'referenceSha256':sha(run/'input_0.png'),
        'weightsRevisions':json.loads((ROOT/'texture/provenance.json').read_text()),
        'lightingRemoved':False,'pbrGenerated':False})
    report(run, 'paint', 1, '六视角颜色已生成；下一阶段释放扩散模型')


def bake(run, config):
    import numpy as np
    import torch
    import trimesh
    from PIL import Image
    from scipy import ndimage
    from mvadapter.utils.mesh_utils import CameraProjection
    from mvadapter.utils.mesh_utils.uv import uv_precompute
    report(run, 'bake', 0, '投影到 UV，检查遮挡与视角权重')
    size = config['textureSize']
    mesh, cameras, ctx = geometry(run/'uv_mesh.glb', size)
    projector = CameraProjection('torch-native', None, 'cuda', context_type='cuda')
    images = [Image.open(run/f'view_{i}.png').convert('RGB') for i in range(6)]
    with torch.no_grad():
        output = projector(images,mesh,cameras,from_scratch=True,poisson_blending=False,
            depth_grad_dilation=5,depth_grad_threshold=.1,uv_exp_blend_alpha=3,
            uv_exp_blend_view_weight=torch.tensor([1.5,1,1,1,.75,.75]),
            aoi_cos_valid_threshold=.2,uv_size=size,uv_padding=False,return_dict=True)
        occupied = uv_precompute(ctx,mesh,size,size).uv_mask.cpu().numpy()
        valid = output.uv_proj_mask.cpu().numpy() & occupied
        texture = (output.uv_proj.cpu().numpy()*255).clip(0,255).astype('uint8')
    if not valid.any():
        raise RuntimeError('No surface texels received a visible projection')
    Image.fromarray(texture).save(run/'basecolor-projected.png')
    Image.fromarray(valid.astype('uint8')*255).save(run/'projection-mask.png')
    Image.fromarray(occupied.astype('uint8')*255).save(run/'uv-mask.png')
    report(run, 'bake', .65, '在各 UV 岛内补齐漏涂并扩展接缝边缘')
    # Baseline completion is explicit and deterministic. Keep its mask so filled
    # pixels can never be mistaken for observed or semantically reconstructed ones.
    islands,count = ndimage.label(occupied)
    filled = texture.copy()
    no_evidence_islands = 0
    for label, box in enumerate(ndimage.find_objects(islands), start=1):
        if box is None:
            continue
        region = islands[box] == label
        support = valid[box] & region
        if not support.any():
            no_evidence_islands += 1
            continue
        indices = ndimage.distance_transform_edt(~support,return_distances=False,return_indices=True)
        patch = filled[box]
        missing = region & ~support
        patch[missing] = texture[box][tuple(indices[:,missing])]
    # Any entirely unseen tiny island and exterior gutter use nearest observed
    # surface color; this is a baseline, not a claim of learned hole completion.
    supported = occupied & (islands > 0)
    if no_evidence_islands:
        indices = ndimage.distance_transform_edt(~valid,return_distances=False,return_indices=True)
        for label,box in enumerate(ndimage.find_objects(islands),start=1):
            if box is not None and not (valid[box] & (islands[box] == label)).any():
                region = islands == label
                filled[region] = texture[tuple(indices[:,region])]
    distance,indices = ndimage.distance_transform_edt(~supported,return_indices=True)
    gutter = (~occupied) & (distance <= 12)
    filled[gutter] = filled[tuple(indices[:,gutter])]
    image = Image.fromarray(filled)
    image.save(run/'basecolor.png')
    Image.fromarray((occupied & ~valid).astype('uint8')*255).save(run/'completion-mask.png')
    target = trimesh.load(run/'uv_mesh.glb',force='mesh',process=False)
    target.visual.material = trimesh.visual.material.PBRMaterial(baseColorTexture=image,
        metallicFactor=0.,roughnessFactor=.85,baseColorFactor=[1.,1.,1.,1.])
    target.export(run/'model.glb')
    save_json(run/'texture-info.json', {'textureSize':[size,size],
        'projectionCoverage':float(valid.sum()/occupied.sum()),'surfaceTexels':int(occupied.sum()),
        'completionTexels':int((occupied & ~valid).sum()),'islandsWithoutProjection':no_evidence_islands,
        'completionMethod':'nearest visible texel within UV island; nearest visible fallback for unseen islands',
        'gutterTexels':12,'roughnessFactor':.85,'metallicFactor':0,
        'materialKind':'RGB appearance; constant roughness and metallic, not recovered PBR',
        'uvMeshSha256':sha(run/'uv_mesh.glb'),'textureSha256':sha(run/'basecolor.png')})
    report(run, 'bake', 1, '颜色贴图与 GLB 已保存')


def validate_texture(run, config):
    import numpy as np
    import trimesh
    from app.mesh_geometry import validate, render
    report(run, 'validate_texture', 0, '重载带贴图 GLB，检查 UV / 材质 / 几何')
    result = validate(run/'model.glb')
    if not result['hasUV'] or not result['hasTexture']:
        raise RuntimeError('Textured output is missing UVs or an embedded texture')
    before = trimesh.load(run/'uv_mesh.glb',force='mesh',process=False)
    after = trimesh.load(run/'model.glb',force='mesh',process=False)
    if before.faces.shape != after.faces.shape or not np.array_equal(before.faces,after.faces):
        raise RuntimeError('Texturing changed triangle topology')
    error = float(np.max(np.abs(before.vertices-after.vertices)))
    if error > 1e-6:
        raise RuntimeError('Texturing changed mesh positions')
    result.update(outputKind='textured-mesh',textureSize=list(after.visual.material.baseColorTexture.size),
        maxSurfacePositionError=error, sourceJobId=config['sourceJobId'],
        baseMeshSha256=config['baseMeshSha256'],limitations=[
            'Generated RGB appearance can contain drawn lighting; constant roughness/metallic',
            'Unseen texels are marked and filled deterministically',
            'Skinning, animation and engine import require separate validation'])
    render(run/'model.glb',run,prefix='clay')
    render(run/'model.glb',run,texture=True)
    save_json(run/'validation.json',result)
    report(run,'validate_texture',1,'贴图模型已重载检查并生成转台')


def main():
    import ctypes
    import signal
    parent = os.getppid()
    ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)
    if os.getppid() != parent:
        raise SystemExit('Parent process exited')
    parser=argparse.ArgumentParser()
    parser.add_argument('stage',choices=['uv','paint','bake','validate_texture'])
    parser.add_argument('--run',type=Path,required=True)
    args=parser.parse_args()
    run=args.run.resolve()
    config=json.loads((run/'request.json').read_text())
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('Texture backend requires CUDA')
    torch.cuda.set_per_process_memory_fraction(.85)
    torch.cuda.reset_peak_memory_stats()
    started=time.time()
    metrics={'stage':args.stage,'backend':'mvadapter','startedAt':started,'status':'running',
             'torch':torch.__version__,'cuda':torch.version.cuda,'gpu':torch.cuda.get_device_name(),
             'pytorchMemoryFraction':.85}
    try:
        globals()[args.stage](run,config)
        torch.cuda.synchronize()
        metrics['status']='completed'
    except Exception as exc:
        metrics.update(status='failed',error=str(exc),traceback=traceback.format_exc())
        raise
    finally:
        metrics.update(seconds=time.time()-started,peakAllocatedMiB=torch.cuda.max_memory_allocated()/2**20,
                       peakReservedMiB=torch.cuda.max_memory_reserved()/2**20)
        save_json(run/f'metrics-{args.stage}.json',metrics)


if __name__ == '__main__':
    main()
