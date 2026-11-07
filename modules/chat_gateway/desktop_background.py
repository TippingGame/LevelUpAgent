"""DingTalk background transport. Global input and focus fallbacks are forbidden.

UIA is read-only: the tested SetValue provider activates the window then fails.
Window messages are bounded and each reply requires visible draft/echo checks.
"""
import ctypes
from ctypes import wintypes
import time
from desktop_core import normalized, outgoing_added
from desktop_windows import WindowsDesktop, DesktopUnavailable, DesktopDeferred


class BackgroundDesktop(WindowsDesktop):
    def _bind(self):
        super()._bind()
        for name, args, result in [
            ('FindWindowExW', [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR], wintypes.HWND),
            ('IsChild', [wintypes.HWND, wintypes.HWND], wintypes.BOOL),
            ('ScreenToClient', [wintypes.HWND, ctypes.POINTER(wintypes.POINT)], wintypes.BOOL),
            ('ChildWindowFromPointEx', [wintypes.HWND, wintypes.POINT, wintypes.UINT], wintypes.HWND),
            ('SendMessageTimeoutW', [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)], wintypes.LPARAM),
        ]:
            function = getattr(self.user, name)
            function.argtypes, function.restype = args, result

    def foreground(self, hwnd):
        raise DesktopUnavailable('后台模式禁止激活窗口')

    def native_target(self, hwnd):
        target = self.user.FindWindowExW(hwnd, 0, 'DingChatWnd', None)
        if not target or self.user.FindWindowExW(hwnd, target, 'DingChatWnd', None):
            raise DesktopUnavailable('当前钉钉未提供唯一后台聊天窗口，请升级或重新校准')
        root_pid, target_pid = wintypes.DWORD(), wintypes.DWORD()
        self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(root_pid))
        self.user.GetWindowThreadProcessId(target, ctypes.byref(target_pid))
        if (not root_pid.value or root_pid.value != target_pid.value
                or not self.user.IsChild(hwnd, target) or not self.user.IsWindowVisible(target)):
            raise DesktopUnavailable('后台聊天窗口身份核对失败')
        return target

    def observe_guard(self, hwnd, rect):
        if self.stopped() or not self.unlocked():
            raise DesktopUnavailable('桌面已锁定或宿主已停止')
        if not self.user.IsWindow(hwnd) or self.user.IsIconic(hwnd) or self.rect(hwnd) != rect:
            raise DesktopUnavailable('钉钉窗口关闭、最小化或布局变化')

    def guard(self, hwnd, rect, input_stamp=None):
        self.observe_guard(hwnd, rect)
        foreground = self.user.GetForegroundWindow()
        if (foreground == hwnd or (foreground and self.user.GetAncestor(foreground, 2) == hwnd)) and self.idle() < 5:
            # A native click can activate DingTalk without any new user input.
            # Do not mistake earlier input in another app for typing in DingTalk.
            # Any subsequent physical input changes the stamp and still stops us.
            if getattr(self, 'activation_input', None) != (hwnd, self.last_input()):
                raise DesktopDeferred('钉钉后台模式：最近 5 秒正在操作钉钉，暂缓点击和发送；切换到其他应用可继续')

    def message(self, hwnd, target, rect, code, wparam, lparam):
        self.guard(hwnd, rect)
        # Text is restricted to DingTalk's chat renderer. Pointer navigation may
        # target its outer message rail, which is outside DingChatWnd.
        if code == 0x0102:
            native = self.native_target(hwnd)
            if target != native and not self.user.IsChild(native, target):
                raise DesktopUnavailable('后台文字目标不属于聊天窗口')
            if getattr(self, 'config', {}).get('version') == 2:
                area = self.config['layout']['editor']
                point = wintypes.POINT(rect[0] + int((area[0]+area[2])/2*rect[2]),
                                      rect[1] + int((area[1]+area[3])/2*rect[3]))
                if self.pointer_target(hwnd, point) != target:
                    raise DesktopUnavailable('后台输入栏窗口已变化，停止写入')
        self.verify_pointer_target(hwnd, target)
        if not self.is_foreground(hwnd) and code in (0x0201, 0x0202):
            self.activation_input = (hwnd, self.last_input())
        result = ctypes.c_size_t()
        # ABORTIFHUNG | ERRORONEXIT; timeout means uncertain mutation, no retry.
        if not self.user.SendMessageTimeoutW(target, code, wparam, lparam, 0x22, 1500, ctypes.byref(result)):
            raise DesktopUnavailable('后台窗口消息超时或被拒绝，停止且不自动重试')

    def verify_pointer_target(self, hwnd, target):
        root_pid, target_pid = wintypes.DWORD(), wintypes.DWORD()
        self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(root_pid))
        self.user.GetWindowThreadProcessId(target, ctypes.byref(target_pid))
        if (not root_pid.value or root_pid.value != target_pid.value
                or not (target == hwnd or self.user.IsChild(hwnd, target))
                or not self.user.IsWindowVisible(target)):
            raise DesktopUnavailable('后台点击窗口身份核对失败')

    def pointer_target(self, hwnd, point):
        target = self.native_target(hwnd)
        tx, ty, tw, th = self.rect(target)
        if not (tx <= point.x < tx + tw and ty <= point.y < ty + th):
            target = hwnd
        # Modern clients have native list/editor children under DingChatWnd.
        # Address the actual child at the calibrated point instead of stopping
        # at its outer container. This never uses global cursor hit-testing.
        for _ in range(20):
            local = wintypes.POINT(point.x, point.y)
            if not self.user.ScreenToClient(target, ctypes.byref(local)):
                raise DesktopUnavailable('后台坐标转换失败')
            child = self.user.ChildWindowFromPointEx(target, local, 7)
            if not child or child == target:
                self.verify_pointer_target(hwnd, target)
                return target
            self.verify_pointer_target(hwnd, child)
            target = child
        raise DesktopUnavailable('后台点击窗口层级异常')

    def click(self, hwnd, x, y):
        rect = self.rect(hwnd)
        self.guard(hwnd, rect)
        point = wintypes.POINT(rect[0] + int(x * rect[2]), rect[1] + int(y * rect[3]))
        if not (rect[0] <= point.x < rect[0]+rect[2] and rect[1] <= point.y < rect[1]+rect[3]):
            raise DesktopUnavailable('校准点击位置不在应用窗口中')
        target = self.pointer_target(hwnd, point)
        tx, ty, tw, th = self.rect(target)
        if not (tx <= point.x < tx + tw and ty <= point.y < ty + th):
            raise DesktopUnavailable('校准点击位置不在后台聊天窗口中')
        if not self.user.ScreenToClient(target, ctypes.byref(point)) or not (0 <= point.x <= 32767 and 0 <= point.y <= 32767):
            raise DesktopUnavailable('后台坐标转换失败')
        packed = (point.y << 16) | point.x
        self.message(hwnd, target, rect, 0x0201, 1, packed)
        self.message(hwnd, target, rect, 0x0202, 0, packed)

    def select_chat(self, hwnd, layout, title):
        rect = self.rect(hwnd)
        self.observe_guard(hwnd, rect)
        image = self.capture(hwnd)
        if self.title(image, layout, title):
            return image
        time.sleep(.15)
        self.observe_guard(hwnd, rect)
        image = self.capture(hwnd)
        if self.title(image, layout, title):
            return image
        self.guard(hwnd, rect)
        if not self.verify_draft(hwnd, layout, ''):
            raise DesktopDeferred('无法确认当前输入框为空；请检查草稿，若为空请暂停连接并重新校准输入区')
        matches = self.sidebar_matches(image, layout, title)
        if len(matches) != 1:
            raise DesktopUnavailable('列表中未找到唯一包含该名称的会话；请使用更完整的名称，或调整会话栏框选')
        row, box = matches[0], layout['sidebar']
        self.guard(hwnd, rect)
        self.click(hwnd, box[0] + (row['x'] + row['w']/2)/image.width, box[1] + (row['y'] + row['h']/2)/image.height)
        time.sleep(.3)
        self.guard(hwnd, rect)
        image = self.capture(hwnd)
        if not self.title(image, layout, title):
            raise DesktopUnavailable('后台切换聊天后的标题核对失败；新版钉钉请暂停连接，选择「前台兼容模式」并保存后重连')
        return image

    def type_reply(self, hwnd, layout, text):
        import uiautomation as auto
        rect = self.rect(hwnd)
        self.guard(hwnd, rect)
        if any(ord(char) < 32 or ord(char) == 127 for char in text):
            raise DesktopUnavailable('后台文字输入不支持控制字符，请使用单段回复')
        if not self.verify_draft(hwnd, layout, ''):
            raise DesktopDeferred('输入框已有草稿，未覆盖')
        if getattr(self, 'config', {}).get('version') == 2:
            box = layout['editor']
            x, y = (box[0]+box[2])/2, (box[1]+box[3])/2
        else:
            with auto.UIAutomationInitializerInThread():
                control = self.editor(hwnd, layout)
                if normalized(self.editor_text(control)):
                    raise DesktopUnavailable('输入框已有草稿，未覆盖')
                bounds = control.BoundingRectangle
                x = ((bounds.left + bounds.right)/2 - rect[0])/rect[2]
                y = ((bounds.top + bounds.bottom)/2 - rect[1])/rect[3]
        # Use local window messages; the client may activate itself in response.
        self.click(hwnd, x, y)
        if not self.verify_draft(hwnd, layout, ''):
            raise DesktopUnavailable('写入前出现草稿，未覆盖')
        # Newer clients host the editor in a native child of DingChatWnd.
        # Sending WM_CHAR to the container succeeds at Win32 level but the
        # editor receives nothing. Resolve the same calibrated input point.
        point = wintypes.POINT(rect[0] + int(x * rect[2]), rect[1] + int(y * rect[3]))
        target = self.pointer_target(hwnd, point)
        native = self.native_target(hwnd)
        if target != native and not self.user.IsChild(native, target):
            raise DesktopUnavailable('输入栏未定位到聊天子窗口，未写入')
        units = text.encode('utf-16-le')
        for offset in range(0, len(units), 2):
            if offset % 160 == 0:
                self.delivery_progress(f'正在写入回复（{offset//2}/{len(units)//2}）')
            self.message(hwnd, target, rect, 0x0102, int.from_bytes(units[offset:offset+2], 'little'), 1)
        self.guard(hwnd, rect)
        self.delivery_progress('正在核对输入栏文字')
        if not self.verify_draft(hwnd, layout, text):
            raise DesktopUnavailable('后台写入结果未通过画面核对，保留草稿且不发送')

    def send_reply(self, config, title, text, before_dispatch):
        if not text.strip() or len(text) > 4000:
            raise DesktopUnavailable('桌面回复限 1–4000 字符')
        # CR/LF could submit before verification. Render multiline model text
        # as one paragraph; never forward control characters to WM_CHAR.
        text = ' '.join(text.splitlines()).replace(chr(9), '    ')
        if any(ord(char) < 32 or ord(char) == 127 for char in text):
            raise DesktopUnavailable('回复包含不支持的控制字符')
        hwnd = self.find(config['windowTitle'])
        layout = self.resolve_layout(hwnd, config['layout'])
        self.delivery_progress('正在打开目标会话')
        self.select_chat(hwnd, layout, title)
        rect = self.rect(hwnd)
        self.guard(hwnd, rect)
        image = self.capture(hwnd)
        self.delivery_progress('正在核对会话标题与空输入栏')
        if not self.title(image, layout, title) or not self.verify_draft(hwnd, layout, ''):
            raise DesktopDeferred('发送前标题或空草稿未通过核对，等待人工处理')
        self.native_target(hwnd)
        before = self.messages(image, layout)
        self.guard(hwnd, rect)
        before_dispatch()
        self.delivery_progress('正在写入回复')
        self.type_reply(hwnd, layout, text)
        self.delivery_progress('正在核对发送前标题与回复文字')
        if not self.title(self.capture(hwnd), layout, title) or not self.verify_draft(hwnd, layout, text):
            raise DesktopUnavailable('发送前聊天标题或草稿核对失败')
        self.guard(hwnd, rect)
        self.delivery_progress('正在点击发送按钮')
        self.click(hwnd, *layout['send'])
        self.delivery_progress('正在确认发出气泡与空输入栏；请勿手动重复发送')
        for _ in range(12):
            time.sleep(.3)
            self.guard(hwnd, rect)
            image = self.capture(hwnd)
            if not self.title(image, layout, title):
                break
            if outgoing_added(before, self.messages(image, layout), text) and self.verify_draft(hwnd, layout, ''):
                return 'sent'
        return 'delivery_unknown'


class CompatibleDesktop(WindowsDesktop):
    """Explicitly selected foreground input for newer native DingTalk clients."""

    def guard(self, hwnd, rect, input_stamp=None):
        if input_stamp is not None:
            return super().guard(hwnd, rect, input_stamp)
        # Reading a stable chat may run while covered. Only input needs focus
        # and an unchanged global input stamp, enforced by the base driver.
        if self.stopped() or not self.unlocked():
            raise DesktopUnavailable('桌面已锁定或宿主已停止')
        if not self.user.IsWindow(hwnd) or self.user.IsIconic(hwnd) or self.rect(hwnd) != rect:
            raise DesktopUnavailable('钉钉窗口关闭、最小化或布局变化')

    def select_chat(self, hwnd, layout, title):
        image = self.capture(hwnd)
        if self.title(image, layout, title):
            return image
        if not self.verify_draft(hwnd, layout, ''):
            raise DesktopDeferred('当前聊天输入框未确认空白；请先处理草稿再切换聊天')
        return super().select_chat(hwnd, layout, title)

    def send_reply(self, config, title, text, before_dispatch):
        hwnd = self.find(config['windowTitle'])
        layout = self.resolve_layout(hwnd, config['layout'])
        if config.get('version') == 2:
            text = ' '.join(text.splitlines()).replace(chr(9), '    ')
        return super().send_reply(dict(config, layout=layout), title, text, before_dispatch)


def desktop_driver(config):
    mode = config.get('inputMode', 'background')
    if mode == 'foreground':
        driver = CompatibleDesktop()
    elif mode == 'background':
        driver = BackgroundDesktop()
    else:
        raise ValueError('Unsupported desktop input mode')
    driver.config = config
    return driver
