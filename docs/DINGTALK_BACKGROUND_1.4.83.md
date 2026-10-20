# 钉钉后台窗口收发（1.4.83）

2026-10-21 在用户已登录的 Windows 钉钉和授权测试群（实际标题“测试”）验证。

## 实现

生产网关默认使用 BackgroundDesktop。通过唯一的 DingChatWnd 子窗口及同进程校验，使用有 1.5 秒超时的 SendMessageTimeoutW 定向发送 WM_CHAR 与窗口内按钮消息。不调用全局 SendInput、剪贴板、SetCursorPos、SetForegroundWindow、UIA SetFocus 或 AttachThreadInput。没有退回前台输入的降级路径。

扫描不再等待全局键鼠空闲，也不因其他应用的输入时间戳变化而放弃消息。截图通过 PrintWindow 取得钉钉窗口画面。标题、空草稿、完整写入内容、一次发送、新增对应发出气泡及草稿清空仍逐项核对。写入前持久化发送意图；超时、部分写入或无法确认结果均保留 delivery_unknown，不自动重发。

直接切回钉钉时暂停，避免后台切换会话与用户手动编辑冲突；回到其他应用后继续未开始写入的回复。已有草稿不覆盖。模型多行回复显示为单段，换行转换为空格、制表符转换为四个空格，禁止将控制字符作为 Enter 发出。

## 实测证据

- 只读 UIA 与后台截图可用；UIA ValuePattern/Legacy SetValue 返回 E_NOTIMPL，并会激活钉钉窗口，因此生产后台路径禁止这些写入接口。
- 原型定向写入及发送：前台窗口、鼠标位置、全局输入时间戳不变，出现对应发出气泡且草稿清空。
- 生产驱动干扰测试：另一个前台测试窗口收到 **169** 个真实键盘字符，同时鼠标移动 **169** 次；后台发送成功，前台始终不变，仅记录一次发送意图，草稿最终为空。
- 可复现脚本：scripts/verify-dingtalk-background.py --chat 测试 --send。必须先获得目标聊天授权。脚本仅向自己的前台输入框注入测试键鼠事件；产品后台驱动不注入全局输入。
- 本地证据：artifacts/dingtalk-background-review/report.json、sent.png。截图含真实聊天，不提交公共仓库。
- 70 项桌面 Python 测试通过，包含持久化发送、EOF 退出、后台干扰独立性、控制字符、UTF-16 字面文本、错误及空草稿保护。

以上真实测试确认的是本地发送行为，不等同服务器或接收者回执；真实新消息接收、模型调用和自动答复的额外结果另行记录。

## 支持边界

钉钉可被其他应用遮挡，用户可正常使用其他应用。窗口仍须打开、非最小化，Windows 保持登录且解锁。关闭到托盘、最小化和锁屏不受支持；没有修改系统锁屏策略或绕过登录。未知钉钉结构、布局改变、低置信 OCR、同名或截断标题会停止并给出原因。OCR 只能读取当前可见消息，不能保证不漏消息或获取完整历史。

## 调研依据

- pywinauto 官方远程执行说明区分全局输入和 silent methods，明确应用兼容性限制： https://github.com/pywinauto/pywinauto/blob/master/docs/remote_execution.txt
- pywinauto HwndWrapper.send_chars 使用定向 WM_CHAR： https://github.com/pywinauto/pywinauto/blob/master/pywinauto/controls/hwndwrapper.py
- Microsoft SendMessageTimeoutW 的超时、进程退出与挂起语义： https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw

只采用机制并结合本机实测实现，没有复制第三方自动回复项目或引入 Hook、客户端补丁、账号令牌读取。

附加实时接收窗口：本轮 180 秒监听未产生新入站事件（钉钉仍在前台而暂停），没有将此窗口记为真实收发通过。真实后台发送与键鼠干扰成功证据独立保留。
