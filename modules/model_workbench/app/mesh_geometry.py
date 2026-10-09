"""Geometry-only validation and preview, usable by the TripoSG runtime."""
from pathlib import Path
import hashlib
import json
import math


def validate(path):
    import numpy as np
    import trimesh
    from pygltflib import GLTF2
    scene = trimesh.load(path, force='scene', process=False)
    parts = list(scene.geometry.values())
    if not parts or any(len(m.faces) == 0 or not np.isfinite(m.vertices).all() for m in parts):
        raise RuntimeError('GLB has no finite triangle geometry')
    gltf = GLTF2().load(str(path))
    primitives = [p for mesh in gltf.meshes for p in mesh.primitives]
    combined = trimesh.load(path, force='mesh', process=False)
    combined.merge_vertices(merge_tex=True, merge_norm=True)
    return {'status': 'passed-structural-check', 'outputKind': 'untextured-mesh',
            'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'vertices': sum(len(m.vertices) for m in parts), 'triangles': sum(len(m.faces) for m in parts),
            'hasUV': all(p.attributes.TEXCOORD_0 is not None for p in primitives),
            'hasTexture': bool(gltf.images), 'skins': len(gltf.skins), 'animations': len(gltf.animations),
            'bounds': scene.bounds.tolist(), 'watertight': bool(combined.is_watertight),
            'windingConsistent': bool(combined.is_winding_consistent),
            'signedVolume': float(combined.volume) if combined.is_watertight else None,
            'components': len(combined.split(only_watertight=False)),
            'nearZeroAreaTriangles': int(np.sum(combined.area_faces < 1e-10)),
            'selfIntersectionsChecked': False, 'unityImportTested': False, 'unrealImportTested': False,
            'limitations': ['Untextured geometry; no UV, skin or animation promised',
                            'Structural validity does not prove riggable topology']}


def render(path, output, prefix='mesh', size=384, texture=False):
    import numpy as np
    import torch
    import torch.nn.functional as F
    import trimesh
    import nvdiffrast.torch as dr
    from PIL import Image
    mesh = trimesh.load(path, force='mesh', process=False)
    # Preview only: center and frame; never rescale exported geometry.
    center = mesh.bounds.mean(axis=0)
    radius = float(np.linalg.norm(mesh.vertices-center, axis=1).max())
    distance = radius / math.sin(math.radians(40)/2) * 1.12
    v = torch.as_tensor(np.array(mesh.vertices-center, dtype='float32'), device='cuda')
    vn = torch.as_tensor(np.array(mesh.vertex_normals, dtype='float32'), device='cuda').contiguous()
    f = torch.as_tensor(np.array(mesh.faces, dtype='int32'), device='cuda')
    ctx = dr.RasterizeCudaContext()
    tex = uv = None
    if texture:
        from PIL import ImageOps
        material = mesh.visual.material
        bitmap = material.baseColorTexture
        if bitmap is None or mesh.visual.uv is None:
            raise RuntimeError('Texture preview requires a material image and UVs')
        tex = torch.as_tensor(np.array(ImageOps.flip(bitmap.convert('RGB')),dtype='float32')/255.,device='cuda')[None].contiguous()
        uv = torch.as_tensor(np.array(mesh.visual.uv,dtype='float32'),device='cuda').contiguous()
    near, far = .01, max(100, distance*4)
    proj = torch.tensor([[1/math.tan(math.radians(20)),0,0,0],
                         [0,1/math.tan(math.radians(20)),0,0],
                         [0,0,-(far+near)/(far-near),-2*far*near/(far-near)],
                         [0,0,-1,0]], dtype=torch.float32, device='cuda')
    frames = []
    with torch.no_grad():
        for angle in range(0, 360, 15):
            # TripoSG export convention is Y up. Camera +Z is the reference view.
            a = math.radians(angle)
            pos = np.array([math.sin(a), .08, math.cos(a)], dtype='float32')
            pos = pos / np.linalg.norm(pos) * distance
            z = pos / np.linalg.norm(pos)
            x = np.cross([0,1,0], z); x = x / np.linalg.norm(x)
            y = np.cross(z, x)
            pose = np.eye(4, dtype='float32'); pose[:3,:3] = np.stack([x,y,z],axis=1); pose[:3,3] = pos
            view = torch.inverse(torch.as_tensor(pose, device='cuda'))
            clip = (F.pad(v,(0,1),value=1) @ view.T @ proj.T).unsqueeze(0).contiguous()
            rast, _ = dr.rasterize(ctx, clip, f, (size,size))
            alpha = dr.antialias((rast[..., -1:] > 0).float(),rast,clip,f).clamp(0,1)
            normals, _ = dr.interpolate(vn.unsqueeze(0),rast,f)
            normals = F.normalize(normals,dim=-1) @ view[:3,:3].T
            light = (.32 + .68 * normals[...,2:3].abs()).clamp(0,1)
            color = light*torch.tensor([.72,.77,.84],device='cuda')
            if texture:
                texcoord,_ = dr.interpolate(uv[None],rast,f)
                color = dr.texture(tex,texcoord,filter_mode='linear',boundary_mode='clamp') * (.65+.35*normals[...,2:3].abs())
            bg = torch.tensor([.10,.15,.20],device='cuda')
            # nvdiffrast uses bottom-up rows; image files use top-down rows.
            rgb = ((color*alpha+bg*(1-alpha))[0].flip(0).cpu().numpy()*255).clip(0,255).astype('uint8')
            frames.append(Image.fromarray(rgb))
    frames[0].save(output/f'{prefix}-turntable.gif',save_all=True,append_images=frames[1:],duration=100,loop=0)
    Image.fromarray(np.concatenate([np.array(frames[i]) for i in (0,6,12,18)],axis=1)).save(output/f'{prefix}.png')
