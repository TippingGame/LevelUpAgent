"""Window discovery regressions; no mouse, keyboard, OCR or chat access."""
import ctypes
from ctypes import wintypes
import os
from pathlib import PureWindowsPath
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from desktop_windows import DesktopUnavailable, WindowPlacement, WindowsDesktop


class WindowDetectionTests(unittest.TestCase):
    def driver(self, windows, *, enumeration_ok=True, process_names=None):
        driver = WindowsDesktop.__new__(WindowsDesktop)
        closed = []

        def enumerate_windows(callback, context):
            for handle in windows:
                self.assertTrue(callback(handle, context))
            return enumeration_ok

        def process_id(handle, pointer):
            ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD)).contents.value = handle
            return 1

        def process_path(handle, flags, buffer, size):
            buffer.value = windows[handle].get('exe', 'DingTalk.exe')
            return not windows[handle].get('query_failed', False)

        def title(handle, buffer, size):
            buffer.value = windows[handle].get('title', '钉钉')
            return len(buffer.value)

        def placement(handle, pointer):
            value = ctypes.cast(pointer, ctypes.POINTER(WindowPlacement)).contents
            self.assertEqual(value.length, ctypes.sizeof(WindowPlacement))
            value.rcNormalPosition = wintypes.RECT(*windows[handle].get('normal', (100, 100, 1485, 966)))
            return not windows[handle].get('placement_failed', False)

        def rect(handle):
            if windows[handle].get('closed'):
                raise DesktopUnavailable('窗口已关闭')
            return windows[handle].get('rect', (100, 100, 1385, 866))

        driver.user = SimpleNamespace(
            EnumWindows=enumerate_windows,
            IsWindowVisible=lambda h: windows[h].get('visible', True),
            GetWindowThreadProcessId=process_id,
            GetWindowTextW=title,
            IsIconic=lambda h: windows[h].get('minimized', False),
            GetWindowPlacement=placement,
        )
        driver.kernel = SimpleNamespace(
            OpenProcess=lambda access, inherit, pid: 0 if windows[pid].get('denied') else pid,
            QueryFullProcessImageNameW=process_path,
            CloseHandle=closed.append,
        )
        driver.rect = rect
        driver.process_names = lambda: process_names or {}
        # Keep the fake Win32 callback usable on non-Windows test runners too.
        callback_patch = patch('desktop_windows.ctypes.WINFUNCTYPE', lambda *args: lambda fn: fn, create=True)
        callback_patch.start()
        self.addCleanup(callback_patch.stop)
        return driver, closed

    def test_minimized_main_window_uses_restored_size_and_remains_discoverable(self):
        driver, closed = self.driver({1: dict(minimized=True, rect=(-32000, -32000, 160, 28))})
        self.assertEqual(driver.windows(), [dict(handle=1, title='钉钉', width=1385, height=866, minimized=True)])
        self.assertEqual(closed, [1])
        with self.assertRaisesRegex(DesktopUnavailable, '已最小化'):
            driver.find('钉钉')

    def test_restored_window_uses_current_size_not_previous_normal_placement(self):
        driver, _ = self.driver({1: dict(rect=(0, 0, 1920, 1080), normal=(0, 0, 800, 600))})
        self.assertEqual(driver.windows(), [dict(handle=1, title='钉钉', width=1920, height=1080, minimized=False)])
        self.assertEqual(driver.find('钉钉'), 1)

    def test_shadow_tray_small_helpers_and_other_processes_stay_excluded(self):
        driver, closed = self.driver({
            1: dict(title=''), 2: dict(visible=False),
            3: dict(exe='browser.exe'), 4: dict(rect=(0, 0, 300, 200)),
            5: dict(minimized=True, normal=(0, 0, 300, 200)),
            6: dict(exe='DingTalk.exe.bak'), 7: dict(exe='DingTalkApp.exe'),
        })
        self.assertEqual([w['handle'] for w in driver.windows()], [7])
        self.assertEqual(closed, [1, 3, 4, 5, 6, 7])

    def test_failed_or_disappearing_windows_do_not_hide_other_candidates(self):
        driver, closed = self.driver({
            1: dict(denied=True), 2: dict(query_failed=True),
            3: dict(minimized=True, placement_failed=True), 4: dict(closed=True), 5: {},
        })
        self.assertEqual([w['handle'] for w in driver.windows()], [5])
        self.assertEqual(closed, [2, 3, 4, 5])

    def test_duplicate_titles_are_not_silently_selected(self):
        driver, _ = self.driver({1: {}, 2: dict(minimized=True)})
        with self.assertRaisesRegex(DesktopUnavailable, '唯一钉钉窗口'):
            driver.find('钉钉')

    def test_enumeration_failure_is_not_reported_as_no_windows(self):
        driver, _ = self.driver({}, enumeration_ok=False)
        with self.assertRaisesRegex(DesktopUnavailable, '无法枚举'):
            driver.windows()

    def test_open_process_denied_uses_exact_snapshot_pid_and_name(self):
        driver, closed = self.driver({1: dict(denied=True)}, process_names={1: 'dingtalk.exe'})
        self.assertEqual(driver.find('钉钉'), 1)
        self.assertEqual(closed, [])

    def test_path_query_failure_uses_snapshot_and_closes_process_handle(self):
        driver, closed = self.driver({1: dict(query_failed=True)}, process_names={1: 'dingding.exe'})
        self.assertEqual(driver.find('钉钉'), 1)
        self.assertEqual(closed, [1])

    def test_title_alone_or_a_different_snapshot_pid_never_authorizes_a_window(self):
        for names in ({}, {2: 'dingtalk.exe'}, {1: 'browser.exe'}, {1: 'dingtalk.exe.bak'}):
            with self.subTest(names=names):
                driver, _ = self.driver({1: dict(denied=True)}, process_names=names)
                self.assertEqual(driver.windows(), [])

    def test_successful_path_lookup_cannot_be_overridden_by_stale_snapshot(self):
        driver, _ = self.driver({1: dict(exe='browser.exe')}, process_names={1: 'dingtalk.exe'})
        self.assertEqual(driver.windows(), [])

    def test_windows_path_and_case_are_handled_explicitly(self):
        driver, _ = self.driver({1: dict(exe=r'C:\Program Files (x86)\DingDing\DINGTALK.EXE')})
        self.assertEqual(driver.find('钉钉'), 1)

    def test_probe_reports_exclusions_and_deduplicates_without_returning_hidden_windows(self):
        driver, _ = self.driver({
            1: dict(visible=False), 2: dict(visible=False), 3: dict(rect=(0, 0, 500, 300)),
            4: dict(title=''), 5: dict(denied=True),
            6: dict(minimized=True, placement_failed=True), 7: dict(closed=True),
        })
        result = driver.probe_windows()
        self.assertEqual(result['windows'], [])
        self.assertEqual([d['code'] for d in result['diagnostics']],
                         ['hidden', 'too_small', 'untitled', 'process_unverified', 'geometry_unavailable', 'window_closed'])
        self.assertTrue(all(d['detail'] for d in result['diagnostics']))

    def test_successful_probe_does_not_warn_about_normal_helper_windows(self):
        driver, _ = self.driver({1: dict(visible=False), 2: dict(title=''), 3: {}})
        result = driver.probe_windows()
        self.assertEqual([w['handle'] for w in result['windows']], [3])
        self.assertEqual(result['diagnostics'], [])

    def test_custom_apps_are_enumerated_then_bound_to_process_and_window(self):
        driver, _ = self.driver({1: dict(exe='Example.exe', title='Chat A'), 2: dict(exe='browser.exe', title='Chat A')})
        driver.config = dict(application='custom')
        self.assertEqual(len(driver.windows()), 2)
        driver.config = dict(application='custom', processName='example.exe', windowHandle=1)
        self.assertEqual(driver.find('Title changed while chatting'), 1)
        self.assertEqual(driver.windows()[0]['processName'], 'example.exe')
        driver.config['windowHandle'] = 2
        with self.assertRaises(DesktopUnavailable): driver.find('Missing title')

    def test_selected_handle_disambiguates_same_title_without_guessing(self):
        driver, _ = self.driver({1: {}, 2: {}})
        driver.config = dict(application='dingtalk', windowHandle=2)
        self.assertEqual(driver.find('钉钉'), 2)


@unittest.skipUnless(os.name == 'nt', 'Windows process snapshot integration')
class NativeProcessSnapshotTests(unittest.TestCase):
    def test_snapshot_finds_this_python_process(self):
        driver = WindowsDesktop()
        names = driver.process_names()
        # Store Python/venv launchers may differ from the actual process image.
        process = driver.kernel.OpenProcess(0x1000, False, os.getpid())
        self.assertTrue(process)
        try:
            size = wintypes.DWORD(32768)
            path = ctypes.create_unicode_buffer(size.value)
            self.assertTrue(driver.kernel.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(size)))
            self.assertEqual(names[os.getpid()], PureWindowsPath(path.value).name.lower())
        finally:
            driver.kernel.CloseHandle(process)

    def test_invalid_snapshot_returns_no_unverified_names(self):
        driver = WindowsDesktop.__new__(WindowsDesktop)
        driver.kernel = SimpleNamespace(
            CreateToolhelp32Snapshot=lambda *args: ctypes.c_void_p(-1).value,
            CloseHandle=lambda *args: self.fail('Invalid snapshot must not be closed'),
        )
        self.assertEqual(driver.process_names(), {})


if __name__ == '__main__':
    unittest.main()
