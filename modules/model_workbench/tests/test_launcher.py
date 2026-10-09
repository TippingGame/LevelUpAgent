import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(MODULE))
import launcher as api


class WorkbenchTest(unittest.TestCase):
    def test_atomic_json_retries_transient_windows_sharing_violation(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'progress.json'
            replace=Path.replace
            attempts=[]
            def transient(path,destination):
                attempts.append(1)
                if len(attempts)<3:
                    raise PermissionError('Windows reader holds the previous file')
                return replace(path,destination)
            with patch.object(Path,'replace',transient):
                api.write(target,{'progress':.5})
            self.assertEqual(api.read(target),{'progress':.5})
            self.assertEqual(len(list(target.parent.iterdir())),1)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root/'lease').touch()
        self.stop_heartbeat = threading.Event()
        def heartbeat():
            while not self.stop_heartbeat.wait(.25):
                (self.root/'lease').touch()
        self.heartbeat = threading.Thread(target=heartbeat,daemon=True)
        self.heartbeat.start()

    def tearDown(self):
        self.stop_heartbeat.set()
        self.heartbeat.join()
        self.temp.cleanup()

    def test_manifest_rejects_incompatible_resources_and_duplicate_parts(self):
        manifest = {**api.RESOURCE_SPEC,'components':{
            name:{'unpackedBytes':1,'sha256':'a'*64,'license':'MIT','sources':['fixed-source'],
                  'parts':[{'name':f'model-workbench-{api.RESOURCE_VERSION}-{api.TARGET}-{name}.tar.part001',
                            'bytes':100,'sha256':'b'*64}]} for name in api.COMPONENTS}}
        self.assertIs(api.validate_manifest(manifest),manifest)
        for key,value in [('resourceVersion','2099.1.1'),('target','linux-x64-cu128'),('cuda','12.8'),
                          ('schemaVersion',1),('releaseTag','v1.2.71')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                api.validate_manifest({**manifest,key:value})
        manifest['components']['texture']['parts'][0]['name']=manifest['components']['runtime']['parts'][0]['name']
        with self.assertRaises(ValueError):api.validate_manifest(manifest)

    def test_app_upgrade_reuses_resource_path_and_pinned_download_location(self):
        self.assertEqual(api.version_root('1.2.71'),api.version_root('1.3.0'))
        self.assertIn('/resources/'+api.RESOURCE_VERSION+'/',api.version_root('1.2.71').as_posix())
        url=api.release_url(api.MANIFEST_NAME)
        self.assertIn('/releases/download/model-workbench-resources/',url)
        self.assertNotIn('1.2.71',url)
        with self.assertRaises(ValueError):api.release_url('../evil')

    def test_rejects_path_traversal_and_invalid_settings(self):
        for ident in ('../x','/root','a'*31,'A'*32):
            with self.assertRaises(ValueError):api.project_dir(self.root,ident)
        with self.assertRaises(ValueError):api.version_root('../1.2.3')
        with self.assertRaises(ValueError):api.validate_request({'stage':'texture','settings':{'viewSize':8192}})
        with self.assertRaises(ValueError):api.validate_request({'stage':'shape','settings':{'steps':True}})

    def archive(self,name,kind=tarfile.REGTYPE,content=b'abc'):
        file=self.root/'test.tar'
        with tarfile.open(file,'w') as tar:
            item=tarfile.TarInfo(name);item.type=kind
            item.size=len(content) if kind==tarfile.REGTYPE else 0
            item.linkname='../outside'
            tar.addfile(item,io.BytesIO(content) if item.size else None)
        return file

    def test_extract_rejects_traversal_symlinks_and_devices(self):
        for name,kind in [('../evil',tarfile.REGTYPE),('/evil',tarfile.REGTYPE),('a\\evil',tarfile.REGTYPE),
                          ('link',tarfile.SYMTYPE),('hard',tarfile.LNKTYPE),('device',tarfile.CHRTYPE)]:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):api.extract_archive(self.archive(name,kind),self.root/'out',3)

    def test_extract_checks_size_and_keeps_executable_permissions(self):
        file=self.archive('bin/worker')
        api.extract_archive(file,self.root/'out',3)
        self.assertEqual((self.root/'out/bin/worker').read_bytes(),b'abc')
        with self.assertRaises(ValueError):api.extract_archive(file,self.root/'small',2)
        with self.assertRaises(ValueError):api.extract_archive(file,self.root/'large',4)

    @unittest.skipIf(sys.platform=='win32','Internal directory aliases are installed in Linux/WSL')
    def test_restores_only_internal_directory_aliases(self):
        (self.root/'lib64').mkdir()
        (self.root/'lib64/crti.o').write_bytes(b'compiler-runtime')
        api.write(self.root/'.directory-links.json',[{'path':'lib','target':'lib64'}])
        api.restore_directory_links(self.root)
        self.assertEqual((self.root/'lib/crti.o').read_bytes(),b'compiler-runtime')
        for path,target in [('../escape','lib64'),('escape','../'),('cycle','.'),('absolute','/tmp'),('lib','lib64')]:
            api.write(self.root/'.directory-links.json',[{'path':path,'target':target}])
            with self.assertRaises(ValueError):api.restore_directory_links(self.root)

    def test_missing_or_expired_lease_cancels(self):
        import os
        self.stop_heartbeat.set()
        self.heartbeat.join()
        api.check_cancel(self.root)
        os.utime(self.root/'lease',(time.time()-40,time.time()-40))
        with self.assertRaises(api.Cancelled):api.check_cancel(self.root)

    def test_failed_worker_does_not_replace_completed_results(self):
        ident='b'*32
        project=self.root/'projects'/ident
        project.mkdir(parents=True)
        original={'id':ident,'stages':{'shape':{'directory':'runs/original'}},'updatedAt':1}
        api.write(project/'project.json',original)
        (project/'input.png').write_bytes(b'input')
        with patch.object(api,'component_ready',return_value=True), patch.object(api,'system_info',return_value={
                'gpus':[{'freeMiB':9000}],'ramAvailableMiB':24000}), patch.object(api,'child',side_effect=RuntimeError('GPU failed')):
            with self.assertRaisesRegex(RuntimeError,'GPU failed'):
                api.generate(self.root,self.root,'1.2.3',{'projectId':ident,'stage':'shape'})
        self.assertEqual(api.read(project/'project.json'),original)

    @unittest.skipIf(sys.platform=='win32','Process-group cancellation is Linux/WSL behavior')
    def test_cancel_terminates_worker_process_group(self):
        (self.root/'cancel').touch()
        started=time.monotonic()
        with self.assertRaises(api.Cancelled):
            api.child(self.root,[sys.executable,'-c','import time; time.sleep(120)'],self.root/'log',{})
        self.assertLess(time.monotonic()-started,8)

    def test_download_resumes_and_verifies_and_restarts_when_range_ignored(self):
        payload=b'known-content-'*2000
        requests=[]
        ignore_range=False
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                offset=int(self.headers.get('Range','bytes=0-').split('=')[1].split('-')[0])
                requests.append(offset)
                offset=0 if ignore_range else offset
                self.send_response(206 if offset else 200)
                self.send_header('Content-Range',f'bytes {offset}-{len(payload)-1}/{len(payload)}')
                self.end_headers();self.wfile.write(payload[offset:])
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        part={'name':'asset.part001','bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
        try:
            for ignore_range in (False,True):
                target=self.root/('asset'+str(ignore_range))
                target.with_suffix('.partial').write_bytes(payload[:100])
                api.download(self.root,f'http://127.0.0.1:{server.server_port}/file',target,part,0,len(payload))
                self.assertEqual(target.read_bytes(),payload)
            self.assertEqual(requests,[100,100])
            part['sha256']='0'*64
            with self.assertRaisesRegex(ValueError,'SHA-256'):
                api.download(self.root,f'http://127.0.0.1:{server.server_port}/file',self.root/'bad',part,0,len(payload))
            self.assertFalse((self.root/'bad').exists())
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_package_roundtrip_offline_install(self):
        spec=importlib.util.spec_from_file_location('packager',MODULE.parents[1]/'scripts/package-model-workbench.py')
        packager=importlib.util.module_from_spec(spec);spec.loader.exec_module(packager)
        staging=self.root/'staging'
        expected={ 'runtime':['python/bin/python','vendor/TripoSG/triposg/pipelines/pipeline_triposg.py','vendor/MV-Adapter/mvadapter/__init__.py'],
            'triposg':['model_index.json'], 'texture':['base/model_index.json','adapter/mvadapter_ig2mv_sd21.safetensors'], 'blender':['blender'] }
        for name,files in expected.items():
            for file in files:
                path=staging/name/file;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'fixture')
            api.write(staging/name/'provenance.json',{'license':'test','sources':['test-fixture']})
        relocation_file=staging/'runtime/python/lib/package/tests/downloads/__init__.py'
        relocation_file.parent.mkdir(parents=True)
        relocation_file.write_bytes(b'relocation-required')
        if sys.platform!='win32':
            sysroot=staging/'runtime/python/sysroot'
            (sysroot/'lib64').mkdir(parents=True)
            (sysroot/'lib64/crti.o').write_bytes(b'linker-startup')
            (sysroot/'lib').symlink_to('lib64',target_is_directory=True)
        output=self.root/'release'
        # macOS /var -> /private/var and other aliased staging paths must
        # produce component-relative aliases rather than escaping the archive.
        package_staging=staging
        if sys.platform!='win32':
            package_staging=self.root/'aliased-staging'
            package_staging.symlink_to(staging,target_is_directory=True)
        manifest=packager.package(package_staging,output,api.RESOURCE_VERSION,part_bytes=5000)
        self.assertTrue(all(len(c['parts'])>1 for c in manifest['components'].values()))
        installed=self.root/'installed';installed.mkdir()
        api.install(self.root,installed,'1.2.3',{'offlineDirectory':str(output)})
        self.assertTrue(all(api.component_ready(installed,name) for name in api.COMPONENTS))
        self.assertEqual((installed/relocation_file.relative_to(staging)).read_bytes(),b'relocation-required')
        if sys.platform!='win32':
            self.assertEqual((installed/'runtime/python/sysroot/lib/crti.o').read_bytes(),b'linker-startup')
        self.assertEqual(api.read(self.root/'operation.json')['status'],'completed')
        # Upgrading the app must not extract or relocate any component again.
        with patch.object(api,'extract_archive',side_effect=AssertionError('unnecessary reinstall')):
            api.install(self.root,installed,'1.3.0',{'offlineDirectory':str(output)})
        self.assertTrue(all(api.component_ready(installed,name) for name in api.COMPONENTS))
        receipt=installed/'runtime/.installed.json'
        original=api.read(receipt)
        api.write(receipt,{**original,'sha256':'0'*64})
        self.assertFalse(api.component_ready(installed,'runtime'))
        api.write(receipt,{**original,'resourceVersion':'2099.1.1'})
        self.assertFalse(api.component_ready(installed,'runtime'))


if __name__=='__main__':unittest.main()
