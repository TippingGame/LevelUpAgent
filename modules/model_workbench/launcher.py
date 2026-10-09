"""Stdlib-only bootstrap for Linux x64 / Windows WSL2. No GPU imports here.

The desktop owns a heartbeat lease. Heavy workers are process groups, isolated
per stage; closing the desktop or cancelling terminates the entire group.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid

MODULE = Path(__file__).resolve().parent
REPOSITORY = 'TippingGame/LevelUpAgent'
RESOURCE_SPEC = json.loads((MODULE/'resources.json').read_text(encoding='utf-8'))
TARGET = RESOURCE_SPEC['target']
RESOURCE_VERSION = RESOURCE_SPEC['resourceVersion']
RESOURCE_TAG = RESOURCE_SPEC['releaseTag']
MANIFEST_NAME = f'model-workbench-{RESOURCE_VERSION}-{TARGET}.json'
COMPONENTS = ('runtime', 'triposg', 'texture', 'blender')
STAGES = {'shape': ('prepare', 'shape', 'export'),
          'texture': ('uv', 'paint', 'bake', 'validate_texture'), 'rig': ('rig',)}
NEEDS = {'shape': ('runtime', 'triposg'), 'texture': ('runtime', 'texture'), 'rig': ('blender',)}
ESTIMATES = {'shape': {'vramMiB': 10500, 'ramMiB': 18000},
             'texture': {'vramMiB': 6000, 'ramMiB': 14000},
             'rig': {'vramMiB': 0, 'ramMiB': 4000}}


def read(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    try:
        for attempt in range(20):
            try:
                temp.replace(path)
                break
            except PermissionError:
                # Windows readers/indexers can briefly hold a file without
                # delete sharing while WSL atomically replaces it on NTFS.
                if attempt == 19:
                    raise
                time.sleep(.05)
    finally:
        temp.unlink(missing_ok=True)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def version_root(version):
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', version):
        raise ValueError('Invalid application version')
    base = Path(os.environ.get('XDG_DATA_HOME', str(Path.home()/'.local/share')))
    return base/'levelup-agent/model-workbench/resources'/RESOURCE_VERSION/TARGET


def project_dir(data, ident):
    if not isinstance(ident, str) or not re.fullmatch(r'[a-f0-9]{32}', ident):
        raise ValueError('Invalid project ID')
    path = data/'projects'/ident
    if not (path/'project.json').is_file():
        raise ValueError('Project does not exist')
    return path


def system_info(root):
    result = {'gpus': [], 'ramTotalMiB': None, 'ramAvailableMiB': None,
              'diskFreeBytes': shutil.disk_usage(root).free, 'platform': TARGET}
    try:
        mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        result.update(ramTotalMiB=int(mem['MemTotal'].split()[0])//1024,
                      ramAvailableMiB=int(mem['MemAvailable'].split()[0])//1024)
    except (OSError, ValueError, KeyError):
        pass
    try:
        output = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,memory.free,driver_version',
                                 '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=8)
        for line in output.stdout.splitlines():
            name, total, free, driver = [part.strip() for part in line.split(',')]
            result['gpus'].append({'name': name, 'totalMiB': int(total), 'freeMiB': int(free), 'driver': driver})
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return result


def component_ready(root, name):
    marker = read(root/name/'.installed.json', {})
    manifest = read(root/'manifest.json', {})
    component = manifest.get('components', {}).get(name, {})
    files = {'runtime': ['python/bin/python', 'vendor/TripoSG/triposg/pipelines/pipeline_triposg.py',
                         'vendor/MV-Adapter/mvadapter/__init__.py'],
             'triposg': ['model_index.json'],
             'texture': ['base/model_index.json', 'adapter/mvadapter_ig2mv_sd21.safetensors', 'provenance.json'],
             'blender': ['blender']}[name]
    return (manifest.get('target') == TARGET and manifest.get('schemaVersion') == 2
            and manifest.get('resourceVersion') == RESOURCE_VERSION
            and manifest.get('cuda') == RESOURCE_SPEC['cuda']
            and marker.get('target') == TARGET
            and marker.get('resourceVersion') == RESOURCE_VERSION
            and bool(component.get('sha256')) and marker.get('sha256') == component['sha256']
            and all((root/name/f).is_file() for f in files))


def status(data, root, version):
    root.mkdir(parents=True, exist_ok=True)
    projects = []
    for file in (data/'projects').glob('*/project.json'):
        project = read(file)
        if project:
            projects.append(project)
    operation = read(data/'operation.json')
    if operation and operation.get('status') == 'running':
        # A hard desktop shutdown must not leave a permanent busy state.
        lease = data/'lease'
        if not lease.exists() or time.time()-lease.stat().st_mtime > 30:
            operation.update(status='interrupted', detail='运行已中断，可以重试；已完成的阶段仍保留。')
    if operation and operation.get('run'):
        progress = read(data/operation['run']/'progress.json')
        if progress:
            operation['worker'] = progress
    manifest = read(root/'manifest.json')
    return {'version': version, 'resourceVersion': RESOURCE_VERSION, 'runtimeRoot': str(root), 'system': system_info(root),
            'components': {name: component_ready(root, name) for name in COMPONENTS},
            'manifest': manifest, 'projects': sorted(projects, key=lambda p: p['updatedAt'], reverse=True),
            'operation': operation, 'estimates': ESTIMATES}


def release_url(filename):
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+', filename):
        raise ValueError('Invalid release asset name')
    return f'https://github.com/{REPOSITORY}/releases/download/{RESOURCE_TAG}/{filename}'


def validate_manifest(manifest, resource_version=RESOURCE_VERSION):
    if (manifest.get('schemaVersion') != 2 or manifest.get('resourceVersion') != resource_version
            or manifest.get('target') != TARGET or manifest.get('cuda') != RESOURCE_SPEC['cuda']
            or manifest.get('releaseTag') != RESOURCE_TAG):
        raise ValueError('资源清单与所需的通用资源版本／CUDA 不匹配。')
    if set(manifest.get('components', {})) != set(COMPONENTS):
        raise ValueError('资源清单缺少组件。')
    names = set()
    for name, component in manifest['components'].items():
        if not isinstance(component.get('unpackedBytes'), int) or component['unpackedBytes'] <= 0:
            raise ValueError('Invalid installed size')
        if not re.fullmatch(r'[0-9a-f]{64}', component.get('sha256', '')):
            raise ValueError('Invalid archive digest')
        if not component.get('license') or not component.get('sources'):
            raise ValueError('组件缺少许可证或来源记录。')
        parts = component.get('parts', [])
        if not parts or len(parts) > 100:
            raise ValueError('Invalid archive parts')
        for part in parts:
            filename = part.get('name', '')
            prefix = f'model-workbench-{resource_version}-{TARGET}-{name}.tar.part'
            if not re.fullmatch(re.escape(prefix)+r'\d{3}', filename) or filename in names:
                raise ValueError('Invalid or duplicate asset name')
            names.add(filename)
            if not isinstance(part.get('bytes'), int) or not 0 < part['bytes'] < 2_000_000_000:
                raise ValueError('每个 Release 文件必须小于 2 GB。')
            if not re.fullmatch(r'[0-9a-f]{64}', part.get('sha256', '')):
                raise ValueError('Invalid part digest')
    return manifest


def fetch_manifest(root):
    try:
        request = urllib.request.Request(release_url(MANIFEST_NAME),
                                         headers={'User-Agent': 'LevelUpAgent-3D'})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('Resource manifest too large')
        manifest = validate_manifest(json.loads(raw))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise RuntimeError(f'通用 3D 资源 {RESOURCE_VERSION} 尚未发布。请稍后重试，或导入该资源版本的离线包。') from exc
        raise
    write(root/'manifest.json', manifest)
    return manifest


class Cancelled(Exception):
    pass


def check_cancel(data):
    if (data/'cancel').exists():
        raise Cancelled('已取消；可以继续下载或重新运行本阶段。')
    lease = data/'lease'
    if not lease.exists() or time.time()-lease.stat().st_mtime > 25:
        raise Cancelled('工作台已关闭，任务已停止。')


def operation(data, **values):
    current = read(data/'operation.json', {})
    current.update(values, updatedAt=time.time())
    write(data/'operation.json', current)


def download(data, url, destination, part, completed, total):
    if destination.is_file() and destination.stat().st_size == part['bytes'] and sha(destination) == part['sha256']:
        return
    temp = destination.with_suffix(destination.suffix+'.partial')
    offset = temp.stat().st_size if temp.exists() else 0
    if offset >= part['bytes']:
        if offset == part['bytes'] and sha(temp) == part['sha256']:
            temp.replace(destination)
            return
        temp.unlink()
        offset = 0
    request = urllib.request.Request(url, headers={'User-Agent': 'LevelUpAgent-3D',
        **({'Range': f'bytes={offset}-'} if offset else {})})
    started, initial = time.monotonic(), offset
    with urllib.request.urlopen(request, timeout=30) as response:
        if offset and response.status == 206:
            if response.headers.get('Content-Range') != f"bytes {offset}-{part['bytes']-1}/{part['bytes']}":
                raise ValueError('下载服务器返回了不匹配的续传范围。')
        elif response.status == 200:
            offset = initial = 0
        else:
            raise ValueError(f'Unexpected download status {response.status}')
        with temp.open('ab' if offset else 'wb') as output:
            last_report = 0
            while True:
                check_cancel(data)
                block = response.read1(1024 * 1024)
                if not block:
                    break
                offset += len(block)
                if offset > part['bytes']:
                    raise ValueError('下载大小超出版本清单。')
                output.write(block)
                if time.monotonic()-last_report > .3:
                    speed = (offset-initial)/max(.01, time.monotonic()-started)
                    operation(data, phase='download', detail=part['name'], downloadedBytes=completed+offset,
                              totalBytes=total, bytesPerSecond=speed, progress=(completed+offset)/total)
                    last_report = time.monotonic()
    operation(data, phase='verify', detail='校验 SHA-256', bytesPerSecond=0)
    if offset != part['bytes'] or sha(temp) != part['sha256']:
        temp.unlink(missing_ok=True)
        raise ValueError('资源大小或 SHA-256 校验失败，请重试下载。')
    temp.replace(destination)


def extract_archive(archive, destination, limit, check=lambda: None, progress=lambda value: None):
    """Only regular files/directories. Never unpack links/devices or path escapes."""
    destination.mkdir(parents=True, exist_ok=True)
    total = 0
    extracted = 0
    with tarfile.open(archive, 'r:*') as tar:
        for item in tar:
            check()
            relative = PurePosixPath(item.name)
            if (relative.is_absolute() or '..' in relative.parts or '\\' in item.name
                    or not (item.isfile() or item.isdir())):
                raise ValueError('Unsafe archive member: '+item.name)
            output = destination.joinpath(*relative.parts)
            if item.isdir():
                output.mkdir(parents=True, exist_ok=True)
                continue
            total += item.size
            if total > limit:
                raise ValueError('Archive exceeds declared installation size')
            output.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(item) as source, output.open('wb') as target:
                while block := source.read(4 * 1024 * 1024):
                    check()
                    target.write(block)
                    extracted += len(block)
                    progress(extracted)
            output.chmod(item.mode & 0o777)
    if total != limit:
        raise ValueError('Archive installation size differs from manifest')


def install(data, root, version, request):
    next_cancel_check = 0
    def check_install_cancel():
        # Windows project data may live on a WSL-mounted NTFS volume. Avoid
        # two cross-filesystem stats per tiny archive entry, retaining <250ms
        # polling while copying/extracting.
        nonlocal next_cancel_check
        if time.monotonic() >= next_cancel_check:
            check_cancel(data)
            next_cancel_check = time.monotonic()+.25
    offline = Path(request['offlineDirectory']) if request.get('offlineDirectory') else None
    manifest = (validate_manifest(read(offline/MANIFEST_NAME, {}))
                if offline else fetch_manifest(root))
    write(root/'manifest.json', manifest)
    selected = request.get('components', list(COMPONENTS))
    if not selected or any(name not in COMPONENTS for name in selected):
        raise ValueError('请选择需要安装的组件。')
    selected = list(dict.fromkeys(selected))
    pending = [name for name in selected if not component_ready(root, name)]
    total = sum(p['bytes'] for n in pending for p in manifest['components'][n]['parts'])
    # Keep resumable parts plus the joined archive until atomic installation finishes.
    needed = total*2 + sum(manifest['components'][n]['unpackedBytes'] for n in pending)
    if shutil.disk_usage(root).free < needed + 1024**3:
        raise ValueError(f'可用磁盘不足，安装临时空间需要约 {needed/1024**3:.1f} GiB。')
    cache = root/'downloads'
    cache.mkdir(exist_ok=True)
    completed = 0
    for name in pending:
        component = manifest['components'][name]
        for part in component['parts']:
            check_cancel(data)
            destination = cache/part['name']
            if offline:
                source = offline/part['name']
                if source.stat().st_size != part['bytes']:
                    raise ValueError('离线资源校验失败：'+part['name'])
                digest, offset, last_report = hashlib.sha256(), 0, 0
                temporary = destination.with_suffix(destination.suffix+'.partial')
                with source.open('rb') as incoming, temporary.open('wb') as outgoing:
                    while block := incoming.read(4*1024*1024):
                        check_install_cancel()
                        digest.update(block)
                        outgoing.write(block)
                        offset += len(block)
                        if time.monotonic()-last_report > .3:
                            operation(data, phase='verify', detail='导入并校验 '+part['name'],
                                      downloadedBytes=completed+offset, totalBytes=total,
                                      bytesPerSecond=0, progress=(completed+offset)/total)
                            last_report = time.monotonic()
                if offset != part['bytes'] or digest.hexdigest() != part['sha256']:
                    temporary.unlink(missing_ok=True)
                    raise ValueError('离线资源校验失败：'+part['name'])
                temporary.replace(destination)
            else:
                download(data, release_url(part['name']), destination, part, completed, total)
            completed += part['bytes']
        operation(data, phase='extract', detail='正在安装 '+name, progress=completed/max(1,total),
                  downloadedBytes=completed, totalBytes=total, bytesPerSecond=0)
        archive = cache/(name+'.tar')
        digest = hashlib.sha256()
        with archive.open('wb') as target:
            for part in component['parts']:
                with (cache/part['name']).open('rb') as source:
                    while block := source.read(4*1024*1024):
                        check_install_cancel()
                        digest.update(block)
                        target.write(block)
        if digest.hexdigest() != component['sha256']:
            raise ValueError('完整资源包校验失败。')
        staging = root/('.install-'+name)
        if staging.exists():
            shutil.rmtree(staging)
        last_extract_report = 0
        def extract_progress(extracted):
            nonlocal last_extract_report
            if time.monotonic()-last_extract_report > .5:
                operation(data, detail=f"正在安装 {name} · {extracted/1024**3:.2f} / {component['unpackedBytes']/1024**3:.2f} GiB")
                last_extract_report = time.monotonic()
        extract_archive(archive, staging, component['unpackedBytes'], check_install_cancel, extract_progress)
        restore_directory_links(staging)
        target = root/name
        # An existing incomplete install can be replaced; a ready install is immutable.
        if target.exists():
            shutil.rmtree(target)
        staging.rename(target)
        if name == 'runtime' and (target/'python/bin/conda-unpack').is_file():
            child(data, [str(target/'python/bin/python'), str(target/'python/bin/conda-unpack')],
                  data/'install.log', env=os.environ.copy())
        write(target/'.installed.json', {'target': TARGET, 'resourceVersion': RESOURCE_VERSION, 'sha256': component['sha256']})
        if not component_ready(root, name):
            (target/'.installed.json').unlink(missing_ok=True)
            raise ValueError(name+' 资源结构不完整。')
        archive.unlink()
        for part in component['parts']:
            (cache/part['name']).unlink(missing_ok=True)
    operation(data, status='completed', phase='installed', progress=1, detail='所选组件已安装并校验')


def restore_directory_links(root):
    root = root.resolve()
    links = read(root/'.directory-links.json', [])
    if not isinstance(links, list) or len(links) > 1000:
        raise ValueError('Invalid directory aliases')
    for item in links:
        path, target = item.get('path',''), item.get('target','')
        relative, destination = PurePosixPath(path), PurePosixPath(target)
        if (not path or not target or relative.is_absolute() or destination.is_absolute()
                or '..' in relative.parts or '\\' in path or '\\' in target):
            raise ValueError('Unsafe directory alias')
        link = root.joinpath(*relative.parts)
        resolved = (link.parent/target).resolve()
        if (not link.parent.resolve().is_relative_to(root) or not resolved.is_relative_to(root)
                or resolved in link.parents or not resolved.is_dir() or link.exists() or link.is_symlink()):
            raise ValueError('Directory alias escapes component or replaces a file')
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target, target_is_directory=True)


def child(data, command, logfile, env):
    with logfile.open('ab', buffering=0) as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   env=env, start_new_session=True)
        try:
            while process.poll() is None:
                check_cancel(data)
                time.sleep(.25)
            if process.returncode:
                with logfile.open('rb') as tail:
                    tail.seek(max(0, logfile.stat().st_size-2500))
                    message = tail.read().decode('utf-8', errors='replace')
                if 'out of memory' in message.lower():
                    raise RuntimeError('显存或内存不足。请关闭其他 GPU 程序，使用节省显存模式，或降低生成质量后重试。')
                detail = next((line for line in reversed(message.splitlines())
                               if re.match(r'^(?:\w+\.)*\w*(?:Error|Exception):', line)
                               and not line.startswith(('Error: script failed', 'Error: Python:'))), '')
                raise RuntimeError(detail or f'阶段运行失败（{process.returncode}），详细信息已保存在本次运行的 run.log。')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def runtime_env(root):
    env = {**os.environ, 'LEVELUP_3D_RUNTIME': str(root), 'PYTHONNOUSERSITE': '1',
           'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'PYTHONUNBUFFERED': '1',
           'CUDA_HOME': str(root/'runtime/cuda'), 'TORCH_EXTENSIONS_DIR': str(root/'cache/torch'),
           'HF_HOME': str(root/'cache/huggingface'), 'XDG_CACHE_HOME': str(root/'cache'),
           'PYTORCH_CUDA_ALLOC_CONF': 'max_split_size_mb:128', 'MAX_JOBS': '4'}
    env['PATH'] = f"{root}/runtime/python/bin:{root}/runtime/cuda/bin:"+env.get('PATH', '')
    env['LD_LIBRARY_PATH'] = f"{root}/runtime/python/lib:{root}/runtime/cuda/lib:/usr/lib/wsl/lib:"+env.get('LD_LIBRARY_PATH','')
    compiler = root/'runtime/python/bin/x86_64-conda-linux-gnu-gcc'
    if compiler.exists():
        env.update(CC=str(compiler), CXX=str(compiler).replace('-gcc','-g++'), CUDAHOSTCXX=str(compiler).replace('-gcc','-g++'))
    return env


def validate_request(request):
    stage = request.get('stage')
    if stage not in STAGES:
        raise ValueError('Invalid stage')
    settings = {'steps': 50 if stage == 'shape' else 30, 'seed': 42, 'triangles': 30000, 'textureSize': 2048,
                'viewSize': 512, 'preset': 'standard', 'memoryMode': 'sequential',
                'prompt': '', 'background': 'alpha', 'cleanup': 'preserve'}
    settings.update(request.get('settings', {}))
    for key, minimum, maximum in [('steps', 10, 60), ('seed', 0, 2147483647), ('triangles', 5000, 100000)]:
        if type(settings[key]) is not int or not minimum <= settings[key] <= maximum:
            raise ValueError('Invalid '+key)
    if settings['textureSize'] not in (1024, 2048) or settings['viewSize'] != 512:
        raise ValueError('Invalid texture resolution')
    if settings['preset'] not in ('draft','standard') or settings['memoryMode'] not in ('model','sequential'):
        raise ValueError('Invalid quality / memory mode')
    if settings['background'] not in ('alpha','white') or len(settings['prompt']) > 2000:
        raise ValueError('Invalid image or prompt settings')
    return stage, settings


def reference_source(project_path, project, settings):
    reference = project.get('reference')
    if reference:
        filename = reference.get('file', '')
        if not isinstance(filename, str) or not re.fullmatch(r'reference-[a-f0-9]{32}\.png', filename):
            raise ValueError('Invalid reference file')
        path = (project_path/filename).resolve()
        if not path.is_relative_to(project_path.resolve()) or not path.is_file():
            raise ValueError('Reference file is missing or outside the project')
        return path, 'alpha'
    shape = project.get('stages', {}).get('shape')
    shape_settings = read(project_path/shape['directory']/'request.json', {}) if shape else {}
    return project_path/'input.png', shape_settings.get('background', settings['background'])


def generate(data, root, version, request):
    stage, settings = validate_request(request)
    if any(not component_ready(root, name) for name in NEEDS[stage]):
        raise ValueError('本阶段依赖尚未安装，请先打开「环境与下载」。')
    hardware = system_info(root)
    if stage != 'rig' and not hardware['gpus']:
        raise ValueError('未检测到 NVIDIA CUDA 显卡。Windows 请检查 WSL2 GPU 驱动。')
    available = hardware.get('ramAvailableMiB')
    if available and available < 3000:
        raise ValueError('当前可用内存不足 3 GiB，请先关闭其他程序。')
    if stage != 'rig' and hardware['gpus'][0]['freeMiB'] < 3500:
        raise ValueError('当前可用显存不足 3.5 GiB，请先释放显存。')
    project_path = project_dir(data, request.get('projectId'))
    project = read(project_path/'project.json')
    previous = 'shape' if stage == 'texture' else 'texture'
    source = project.get('stages', {}).get(previous)
    if stage != 'shape' and not source:
        raise ValueError('请先完成上一个阶段。')
    run = project_path/'runs'/uuid.uuid4().hex
    run.mkdir(parents=True)
    # Prefer the applied Spine cutout, otherwise reprocess the untouched image.
    # Legacy normalized references may have holes in skin and highlights.
    reference, reference_background = reference_source(project_path, project, settings)
    shutil.copyfile(reference, run/'input_0.png')
    settings['referenceBackground'] = reference_background
    if project.get('reference'):
        settings['background'] = 'alpha'
    if stage != 'shape':
        source_path = project_path/source['directory']
        shutil.copyfile(source_path/'model.glb', run/'source_mesh.glb')
        settings.update(baseMeshSha256=sha(run/'source_mesh.glb'), sourceJobId=source['directory'])
    write(run/'request.json', settings)
    operation(data, kind='generate', stage=stage, projectId=project['id'], run=str(run.relative_to(data)))
    env = runtime_env(root)
    for index, phase in enumerate(STAGES[stage]):
        check_cancel(data)
        operation(data, phase=phase, detail='正在运行 '+phase, stageIndex=index,
                  stageCount=len(STAGES[stage]), progress=index/len(STAGES[stage]))
        if stage == 'rig':
            command = [str(root/'blender/blender'), '--background', '--factory-startup', '--python-exit-code', '1',
                       '--python', str(MODULE/'app/rig_worker.py'), '--', str(run)]
        else:
            worker = 'triposg_worker.py' if stage == 'shape' else 'texture_worker.py'
            command = [str(root/'runtime/python/bin/python'), str(MODULE/'app'/worker), phase, '--run', str(run)]
        child(data, command, run/'run.log', env)
    if not (run/'model.glb').is_file() or not (run/'validation.json').is_file():
        raise RuntimeError('输出缺少模型或验证报告，未保存为完成阶段。')
    result = read(run/'validation.json', {})
    if result.get('status') != 'passed-structural-check':
        raise RuntimeError('输出结构检查失败。')
    metrics = [read(run/f'metrics-{phase}.json', {}) for phase in STAGES[stage]]
    result['resources'] = {
        'seconds': sum(item.get('seconds', 0) for item in metrics),
        'peakTorchReservedMiB': max((item.get('peakReservedMiB', 0) for item in metrics), default=0),
        'note': 'PyTorch allocation only; GPU driver and other apps use additional memory.',
    }
    write(run/'validation.json', result)
    project.setdefault('stages', {})[stage] = {'directory': str(run.relative_to(project_path)),
        'completedAt': time.time(), 'version': version, 'resourceVersion': RESOURCE_VERSION, 'validation': result}
    # Previous runs stay on disk. Downstream results from a different shape/texture
    # are detached from the current project so they cannot silently be reused.
    for downstream in (('texture','rig') if stage == 'shape' else ('rig',) if stage == 'texture' else ()):
        project['stages'].pop(downstream, None)
    project['updatedAt'] = time.time()
    write(project_path/'project.json', project)
    operation(data, status='completed', progress=1, detail='阶段完成，结果已保存')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('command', choices=['status','manifest','install','generate'])
    args = parser.parse_args()
    data, root = args.data.resolve(), version_root(args.version)
    data.mkdir(parents=True, exist_ok=True)
    root.mkdir(parents=True, exist_ok=True)
    if args.command == 'status':
        print(json.dumps(status(data, root, args.version), ensure_ascii=False))
        return
    if args.command == 'manifest':
        print(json.dumps(fetch_manifest(root), ensure_ascii=False))
        return
    # Shared resource lock also serializes jobs from different app versions.
    import fcntl
    with (root/'.operation.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        request = json.load(sys.stdin)
        write(data/'operation.json', {'status':'running', 'kind':args.command, 'startedAt':time.time(), 'progress':0})
        try:
            if args.command == 'install':
                install(data, root, args.version, request)
            else:
                generate(data, root, args.version, request)
        except Cancelled as exc:
            operation(data, status='cancelled', detail=str(exc))
        except Exception as exc:
            operation(data, status='failed', detail=str(exc))
            raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
