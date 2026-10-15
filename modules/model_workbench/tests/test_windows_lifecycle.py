"""Exercise the actual launcher polling and Windows kernel job with live descendants."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

MODULE = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == 'nt', 'Windows Job Object lifecycle')
class WindowsLifecycle(unittest.TestCase):
    def run_tree(self, action):
        with tempfile.TemporaryDirectory(prefix='model 生命周期 ') as directory:
            data = Path(directory)
            (data/'lease').touch()
            child = data/'worker.py'
            child.write_text('import subprocess,sys,os,json,time\nfrom pathlib import Path\n'
                'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(90)"])\n'
                'Path(sys.argv[1]).write_text(json.dumps([os.getpid(),p.pid]))\ntime.sleep(90)\n', encoding='utf-8')
            driver = data/'driver.py'
            driver.write_text('import sys,os\nfrom pathlib import Path\n'
                f'sys.path.insert(0,{str(MODULE)!r})\n'
                'import launcher\nfrom windows_process_tree import own_process_tree\nown_process_tree()\n'
                f'launcher.child(Path({str(data)!r}),[sys.executable,{str(child)!r},{str(data/"pids.json")!r}],Path({str(data/"run.log")!r}),os.environ.copy())\n', encoding='utf-8')
            env = os.environ.copy()
            env.pop('LEVELUP_3D_PARENT_PID', None)
            owner = None
            if action == 'owner-exit':
                owner = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(90)'], creationflags=subprocess.CREATE_NO_WINDOW)
                env['LEVELUP_3D_PARENT_PID'] = str(owner.pid)
            process = subprocess.Popen([sys.executable, str(driver)], env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.WaitForSingleObject.restype = wintypes.DWORD
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handles = []
            try:
                deadline = time.monotonic()+10
                while not (data/'pids.json').exists() and time.monotonic()<deadline:
                    self.assertIsNone(process.poll())
                    time.sleep(.05)
                for pid in json.loads((data/'pids.json').read_text()):
                    handle = kernel.OpenProcess(0x100000, False, pid)
                    self.assertTrue(handle)
                    handles.append(handle)
                if action == 'cancel':
                    (data/'cancel').touch()
                elif action == 'kill':
                    process.kill()
                else:
                    owner.kill(); owner.wait(timeout=5)
                process.wait(timeout=10)
                for handle in handles:
                    self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0, 'A descendant survived')
            finally:
                if process.poll() is None: process.kill(); process.wait(timeout=5)
                if owner and owner.poll() is None: owner.kill(); owner.wait(timeout=5)
                for handle in handles: kernel.CloseHandle(handle)

    def test_cancel_cleans_workers_and_grandchildren(self):
        self.run_tree('cancel')

    def test_killed_launcher_cleans_workers_and_grandchildren(self):
        self.run_tree('kill')

    def test_desktop_exit_cleans_workers_and_grandchildren(self):
        self.run_tree('owner-exit')


if __name__ == '__main__': unittest.main()
