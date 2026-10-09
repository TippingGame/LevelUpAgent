"""Editable humanoid landmark rig, Blender bone-heat skinning and motion clips.

Coordinates are normalized in glTF Y-up space: X/Z centered, Y from feet to
head. This is a starting rig for separated-limb humanoids, not AI retopology.
"""
import json
import math
from pathlib import Path
import struct
import sys
import zipfile

import bpy
import bmesh
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.worker import save_json, report

JOINTS = {
    'hips': [0,.48,0], 'spine':[0,.57,0], 'chest':[0,.68,0],
    'neck':[0,.76,0], 'head':[0,.83,0], 'headTip':[0,.98,0],
}
for side, sign in [('L',1),('R',-1)]:
    for name, point in {'shoulder':[.17,.70,0], 'elbow':[.30,.56,0],
                        'wrist':[.39,.43,0], 'hand':[.44,.38,0],
                        'hip':[.10,.48,0], 'knee':[.10,.27,0],
                        'ankle':[.10,.06,0], 'toe':[.10,.035,.12]}.items():
        JOINTS[name+side] = [sign*point[0], *point[1:]]


def unweighted(mesh, armature):
    deform = {group.index for group in mesh.vertex_groups if group.name in armature.bones}
    return sum(not any(g.group in deform and g.weight > 1e-7 for g in v.groups) for v in mesh.data.vertices)


def proxy_weights(mesh, rig, height):
    """Solve heat weights on a clean volume; transfer them to the original UV mesh."""
    proxy = mesh.copy()
    proxy.data = mesh.data.copy()
    proxy.name = 'SkinningProxy'
    bpy.context.collection.objects.link(proxy)
    proxy.parent = None
    proxy.modifiers.clear()
    proxy.vertex_groups.clear()
    bpy.ops.object.select_all(action='DESELECT')
    proxy.select_set(True)
    bpy.context.view_layer.objects.active = proxy
    voxel_size = height/128
    remesh = proxy.modifiers.new('Skinning volume', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = voxel_size
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    # Detached shells/floaters can make Blender's heat solver singular. The
    # largest body is only the temporary solver domain; export retains every
    # original vertex, its UVs and all detached accessories.
    bm = bmesh.new()
    bm.from_mesh(proxy.data)
    unseen, islands = set(bm.verts), []
    while unseen:
        seed = unseen.pop()
        island, queue = {seed}, [seed]
        while queue:
            vertex = queue.pop()
            for edge in vertex.link_edges:
                other = edge.other_vert(vertex)
                if other in unseen:
                    unseen.remove(other); island.add(other); queue.append(other)
        islands.append(island)
    if not islands:
        bm.free()
        raise ValueError('无法构建蒙皮计算体积，请检查模型。')
    largest = max(islands, key=len)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v not in largest], context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(proxy.data); bm.free()
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    if unweighted(proxy, rig.data):
        bpy.data.objects.remove(proxy, do_unlink=True)
        raise ValueError('自动权重求解失败；请调整关节位置，或先分离粘连肢体。')
    mesh.vertex_groups.clear()
    for group in proxy.vertex_groups:
        mesh.vertex_groups.new(name=group.name)
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    transfer = mesh.modifiers.new('Transfer skin weights', 'DATA_TRANSFER')
    transfer.object = proxy
    transfer.use_vert_data = True
    transfer.data_types_verts = {'VGROUP_WEIGHTS'}
    transfer.vert_mapping = 'POLYINTERP_NEAREST'
    transfer.layers_vgroup_select_src = 'ALL'
    transfer.layers_vgroup_select_dst = 'NAME'
    bpy.ops.object.modifier_apply(modifier=transfer.name)
    bpy.data.objects.remove(proxy, do_unlink=True)
    return voxel_size


def main(run):
    config = json.loads((run/'request.json').read_text())
    joints = config.get('joints', JOINTS)
    if set(joints) != set(JOINTS) or any(len(v) != 3 or any(not math.isfinite(c) or abs(c)>2 for c in v) for v in joints.values()):
        raise ValueError('关节坐标无效，请恢复默认关节或重新调整。')
    report(run, 'rig', .02, '载入模型，构建可编辑的人形骨架')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(run/'source_mesh.glb'))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if not meshes:
        raise ValueError('No mesh to rig')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    mesh = bpy.context.object
    mesh.name = 'Character'
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # glTF duplicates vertices at UV seams. Bone heat needs connected geometry;
    # weld coincident positions while retaining UV coordinates on face loops.
    before_weld = len(mesh.data.vertices)
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    scale = max(mesh.dimensions)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=max(1e-8, scale*1e-6))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh.data)
    bm.free()
    vertices = [v.co for v in mesh.data.vertices]
    low = Vector([min(v[i] for v in vertices) for i in range(3)])
    high = Vector([max(v[i] for v in vertices) for i in range(3)])
    center = (low+high)/2
    height = high.z-low.z
    if height < 1e-6:
        raise ValueError('模型高度为零。')
    def point(key):
        x,y,z = joints[key]
        return Vector((center.x+x*height, center.y-z*height, low.z+y*height))
    bones = [('pelvis','hips','spine',None), ('spine','spine','chest','pelvis'),
             ('chest','chest','neck','spine'), ('neck','neck','head','chest'),
             ('head','head','headTip','neck')]
    for side in ('L','R'):
        bones += [('clavicle.'+side,'chest','shoulder'+side,'chest'),
                  ('upper_arm.'+side,'shoulder'+side,'elbow'+side,'clavicle.'+side),
                  ('forearm.'+side,'elbow'+side,'wrist'+side,'upper_arm.'+side),
                  ('hand.'+side,'wrist'+side,'hand'+side,'forearm.'+side),
                  ('thigh.'+side,'hip'+side,'knee'+side,'pelvis'),
                  ('calf.'+side,'knee'+side,'ankle'+side,'thigh.'+side),
                  ('foot.'+side,'ankle'+side,'toe'+side,'calf.'+side)]
    armature = bpy.data.armatures.new('HumanoidSkeleton')
    rig = bpy.data.objects.new('HumanoidRig',armature)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, start, end, parent in bones:
        bone = armature.edit_bones.new(name)
        bone.head, bone.tail = point(start), point(end)
        if (bone.tail-bone.head).length < height*.005:
            raise ValueError('关节重叠：'+name)
        if parent:
            bone.parent = armature.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    report(run, 'rig', .2, '计算自动蒙皮权重')
    mesh.select_set(True)
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    method, proxy_voxel_size = 'bone-heat', None
    if unweighted(mesh, armature):
        report(run, 'rig', .3, '使用清理后的计算体积求解权重，保留原模型与 UV')
        proxy_voxel_size = proxy_weights(mesh, rig, height)
        method = 'voxel-proxy-heat-transfer'
    deform = {group.index for group in mesh.vertex_groups if group.name in armature.bones}
    missing = 0
    maximum_error = 0
    for vertex in mesh.data.vertices:
        weights = sorted([(g.group,g.weight) for g in vertex.groups if g.group in deform and g.weight>1e-7], key=lambda v:-v[1])[:4]
        total = sum(w for _,w in weights)
        if total < 1e-7:
            missing += 1
            continue
        for group in mesh.vertex_groups:
            group.remove([vertex.index])
        for index, weight in weights:
            mesh.vertex_groups[index].add([vertex.index], weight/total, 'REPLACE')
        maximum_error = max(maximum_error,abs(sum(w/total for _,w in weights)-1))
    if missing:
        save_json(run/'rig-diagnostics.json', {'unweightedVertices':missing})
        raise ValueError(f'{missing} 个顶点没有蒙皮权重；请调整关节位置，或先在建模软件中分离粘连肢体。')
    report(run, 'rig', .55, '制作待机、行走与挥手基础动作')
    bpy.context.scene.render.fps = 24
    rig.animation_data_create()
    clips = config.get('clips', ['Idle','Walk','Wave'])
    if not clips or any(clip not in ('Idle','Walk','Wave') for clip in clips):
        raise ValueError('请选择有效的基础动作。')
    for clip in dict.fromkeys(clips):
        action = bpy.data.actions.new(clip)
        rig.animation_data.action = action
        for bone in rig.pose.bones:
            bone.rotation_mode = 'XYZ'
        for frame in range(1,50,4):
            phase = (frame-1)/48*math.tau
            for bone in rig.pose.bones:
                bone.rotation_euler = (0,0,0)
            rig.pose.bones['spine'].rotation_euler.x = math.sin(phase)*.025
            if clip == 'Walk':
                for side, sign in [('L',1),('R',-1)]:
                    wave = math.sin(phase)*sign
                    rig.pose.bones['thigh.'+side].rotation_euler.x = wave*.38
                    rig.pose.bones['calf.'+side].rotation_euler.x = max(0,-wave)*.55
                    rig.pose.bones['upper_arm.'+side].rotation_euler.x = -wave*.25
            elif clip == 'Wave':
                rig.pose.bones['upper_arm.L'].rotation_euler.z = -.85
                rig.pose.bones['forearm.L'].rotation_euler.z = -1.0 + math.sin(phase)*.22
                rig.pose.bones['hand.L'].rotation_euler.x = math.sin(phase*2)*.16
            for bone in rig.pose.bones:
                bone.keyframe_insert(data_path='rotation_euler',frame=frame,group=bone.name)
        track = rig.animation_data.nla_tracks.new()
        track.name = clip
        track.strips.new(clip,1,action)
        rig.animation_data.action = None
    for track in rig.animation_data.nla_tracks:
        track.mute = False
    bpy.context.scene.frame_set(1)
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = rig
    report(run, 'rig', .8, '导出 GLB、FBX 与可编辑 Blender 工程')
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(run/'character.blend'))
    bpy.ops.export_scene.gltf(filepath=str(run/'model.glb'), export_format='GLB', use_selection=True,
                              export_animations=True, export_nla_strips=True)
    bpy.ops.export_scene.fbx(filepath=str(run/'character.fbx'), use_selection=True,
                            add_leaf_bones=False, bake_anim=True, bake_anim_use_nla_strips=True,
                            bake_anim_use_all_actions=False, path_mode='COPY', embed_textures=True)
    with (run/'model.glb').open('rb') as stream:
        magic, version, length, json_length, kind = struct.unpack('<4sIIII',stream.read(20))
        doc = json.loads(stream.read(json_length))
    if magic != b'glTF' or not doc.get('skins') or len(doc.get('animations',[])) < len(set(clips)):
        raise ValueError('导出检查失败：GLB 缺少骨架或动作。')
    validation = {'status':'passed-structural-check','outputKind':'rigged-mesh',
        'skins':len(doc['skins']),'animations':len(doc['animations']), 'bones':len(bones),
        'unweightedVertices':missing,'maximumWeightSumError':maximum_error,
        'verticesBeforeWeld':before_weld,'verticesAfterWeld':len(mesh.data.vertices),
        'weightMethod':method,'proxyVoxelSize':proxy_voxel_size,
        'maxInfluences':4,'bytes':length, 'clips':[a.get('name') for a in doc['animations']],
        'limitations':['基础人形骨架与程序动作；请检查关节变形，非动捕或通用 AI 绑定。',
                       '当前导出未代替 Unity / Unreal 的导入验收。']}
    save_json(run/'validation.json',validation)
    with zipfile.ZipFile(run/'delivery.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for name in ('model.glb','character.blend','character.fbx','request.json','validation.json'):
            archive.write(run/name,name)
    report(run, 'rig', 1, '蒙皮与动作已保存，请在预览中检查变形')


if __name__ == '__main__':
    main(Path(sys.argv[sys.argv.index('--')+1]).resolve())
