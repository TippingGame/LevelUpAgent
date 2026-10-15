"""Own descendants with a Windows Job Object, without a system service."""
import ctypes
from ctypes import wintypes
import os

_job = None
_parent = None


def parent_exited():
    """Keep an owner process handle so PID reuse cannot keep an orphan alive."""
    global _parent
    if os.name != 'nt' or not os.environ.get('LEVELUP_3D_PARENT_PID'):
        return False
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    if _parent is None:
        _parent = kernel.OpenProcess(0x100000, False, int(os.environ['LEVELUP_3D_PARENT_PID']))
    return not _parent or kernel.WaitForSingleObject(_parent, 0) != 0x102

def own_process_tree():
    """The kernel terminates descendants if this process exits or is killed.

    Assign the launcher before it creates children, avoiding the race between
    spawning a worker and assigning it. The non-inheritable handle intentionally
    lives until process exit; closing it early would kill this launcher too.
    """
    global _job
    if os.name != 'nt' or _job is not None:
        return
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    class BASIC(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit',ctypes.c_int64),('PerJobUserTimeLimit',ctypes.c_int64),
                    ('LimitFlags',wintypes.DWORD),('MinimumWorkingSetSize',ctypes.c_size_t),
                    ('MaximumWorkingSetSize',ctypes.c_size_t),('ActiveProcessLimit',wintypes.DWORD),
                    ('Affinity',ctypes.c_size_t),('PriorityClass',wintypes.DWORD),
                    ('SchedulingClass',wintypes.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(name,ctypes.c_uint64) for name in ['ReadOperationCount','WriteOperationCount',
                    'OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount']]
    class EXTENDED(ctypes.Structure):
        _fields_ = [('BasicLimitInformation',BASIC),('IoInfo',IO),
                    ('ProcessMemoryLimit',ctypes.c_size_t),('JobMemoryLimit',ctypes.c_size_t),
                    ('PeakProcessMemoryUsed',ctypes.c_size_t),('PeakJobMemoryUsed',ctypes.c_size_t)]
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p,wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE,wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None,None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    info = EXTENDED()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(job,9,ctypes.byref(info),ctypes.sizeof(info)):
        error = ctypes.get_last_error()
        kernel.CloseHandle(job)
        raise ctypes.WinError(error)
    if not kernel.AssignProcessToJobObject(job,kernel.GetCurrentProcess()):
        error = ctypes.get_last_error()
        kernel.CloseHandle(job)
        raise ctypes.WinError(error)
    _job = job
