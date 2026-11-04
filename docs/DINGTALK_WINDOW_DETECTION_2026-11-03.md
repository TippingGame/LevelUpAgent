# 钉钉窗口检测兼容修复与空列表诊断（R2）

基于 `main` 提交 `82c13e0b8683d6fd15a38733a151df67644a3ae9`，应用版本保持 1.4.85。

## 补丁制作环境定位结果（2026-11-03）

- 用户明确反馈：钉钉主窗口已经展开，点击后显示“未检测到钉钉窗口”。不能将这一现象归因于下拉框锁定或最小化；此前交付的这两项修复不构成原始问题已解决的证明。
- 已安装 LevelUpAgent 1.4.85，钉钉版本 9.0.5.261027007。
- 钉钉主窗口展开时，原始源码与已安装应用的生产 `desktop_gateway.py --probe` 均返回一个标题为“钉钉”、尺寸 1385 × 866 的窗口。已安装的 `desktop_windows.py` 与拉取的源码 SHA256 一致。
- 按应用相同的 `CREATE_NO_WINDOW` 后台进程选项、现有 Python 环境及 UTF-8 设置连续复测三次，旧版本都成功。因此未复现用户此前展开时的空列表，原始触发条件尚未确认。
- 代码检查确认：`OpenProcess` 或 `QueryFullProcessImageNameW` 失败时，旧版本直接丢弃该窗口，不提供原因。R2 在路径读取失败时改用 Windows 进程快照核对窗口 PID 对应的准确程序名；仍要求为 DingTalk.exe / DingDing.exe / DingTalkApp.exe，绝不只凭标题把任意窗口认作钉钉。此兼容修复不等于已确认用户当时遇到了权限或路径查询失败。
- 应用内已有启用中的桌面账号，页面同时停留在另一个空白的“添加账号”表单。实机点击“检测钉钉窗口”后，下拉框仍被锁定并显示“先检测并选择窗口”，也没有检测成功提示。后台识别成功，但用户看不到返回的选项，容易认为没有识别到客户端。
- 代码还存在独立的最小化漏检：先用 `GetWindowRect` 的尺寸过滤，再读取 `IsIconic`。最小化后 Windows 返回图标尺寸（例如 160 × 28），正常主窗口因此被过滤，现有“已最小化”提示无法出现。该分支通过模拟 Win32 回归验证，未切换本机真实钉钉的最小化状态。
- 本机账号当时的等待原因是“当前钉钉聊天有草稿”，与窗口识别是两个问题；本次没有删除草稿或放宽发送保护。

## 修改

1. `src/components/ChatDesktopSetup.tsx`：检测结果独立显示窗口数量、标题、尺寸与最小化状态，空列表显示后端诊断原因。连接运行时解释选择和校准锁定原因，空选择提示改为“连接运行中；暂停后选择窗口”。保留暂停后才能校准的互斥保护。重新检测前清除旧结果，避免失败后残留过期成功提示。
2. `modules/chat_gateway/desktop_windows.py`：增加进程快照备用识别，以及隐藏窗口、无标题、小尺寸、无法核验进程、读取窗口位置失败和窗口已关闭的分类诊断。最小化时用 `GetWindowPlacement.rcNormalPosition` 判断原窗口尺寸。仍排除隐藏、无标题、小窗口和非钉钉进程；实际截图／收发仍要求先还原窗口。成功时不展示正常辅助窗口的过滤提示。
3. `modules/chat_gateway/desktop_gateway.py` 与 `src/lib/chatbots.ts`：只读 `--probe` 返回可选的 diagnostics 字段，接入前端。Rust 使用通用 JSON，无需修改 IPC 后端。
4. `modules/chat_gateway/test_desktop_detection.py`：15 项回归，覆盖进程查询失败时的备用识别、PID 与程序名核验、失败不能仅凭标题接管、原生 Windows 快照核验、空列表诊断、最小化、辅助窗口过滤与枚举错误。
5. `scripts/test-chat-desktop-setup-ui.mjs`：用隔离的组件页面和模拟 IPC 验证有连接的空表单、可见检测结果、校准锁定、最小化提示、重试清理、空列表原因与暂停恢复；覆盖 720px、系统浅色／深色 × 破甲开／关、切换与重新加载。

## 补丁制作环境验证（2026-11-03）

- 桌面 Python 测试：85 项通过，含 15 项窗口发现回归与原有后台发送保护测试。
- 修复后生产 `desktop_gateway.py --probe`：本机真实钉钉主窗口识别成功。
- 针对本机真实钉钉，模拟 `QueryFullProcessImageNameW` 返回失败：旧驱动返回空列表，R2 通过真实 Windows 进程快照识别主窗口。这里只模拟路径查询故障，不能证明用户此前空列表也由此引起。
- 界面回归脚本：四种外观组合全部通过，截图人工检查通过。使用模拟 IPC，没有连接真实聊天账号。
- `pnpm build`：通过；TypeScript 与外观检查通过。
- `pnpm check`：前端测试 307 / 308 通过；唯一未通过项为 Windows 原生安装器测试，因为本机没有 `makensis.exe`（NSIS 编译器）。`node scripts/test-release-config.mjs` 单独通过。
- 本机没有 Rust/Cargo，未运行 Rust 测试或重建 Tauri 安装包；未把隔离的浏览器组件验证记作修复后原生应用验收。
- 没有向真实钉钉发送消息，没有修改已安装应用、账号连接、路由或本机聊天草稿。本次交付为源码改动包，需合并并重新构建后使用。

复测命令（使用已准备好桌面依赖的 Python；Playwright 可由项目外独立安装）：

```powershell
python -m unittest discover -s modules/chat_gateway -p 'test_desktop*.py'
pnpm check
pnpm build
# 若 Playwright 没有安装在项目中，指定其 index.mjs 的绝对路径。
$env:LEVELUP_PLAYWRIGHT_MODULE = 'C:\path\to\playwright\index.mjs'
node scripts/test-chat-desktop-setup-ui.mjs
```

## 合并后操作

进入自动答复机器人 → 平台账号 → 检测钉钉窗口，直接查看结果卡片。
已有桌面连接时，点击“暂停连接并校准”恢复编辑现有账号，再检测和读取预览。
最小化时先还原钉钉再继续。核对聊天区域、路由和已有草稿后，由用户决定何时重新启用连接。

若展开时仍为空，记录结果卡片中的具体原因。也可在已准备好桌面依赖的 Python 环境下执行只读诊断（不截图、不读取聊天、不发送消息）：

```powershell
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
'{}' | python modules/chat_gateway/desktop_gateway.py --probe
```

R2 包含之前的修复，尚未合并旧包时直接使用 R2；已经合并旧包时应按文件比较合并，不能直接叠加同一基线的完整补丁。

## 主仓库合并验证（2026-11-04）

- 两个补丁包的 SHA256 清单均核验通过。R2 包含第一版改动，已在 `df094b4` 基线上通过 `git apply --check` 并应用，未叠加第一版完整补丁。
- 使用项目已有、具备桌面依赖的 Python 测试环境运行 `python -B -m unittest discover -s modules/chat_gateway`：95 项通过，包含 15 项窗口发现回归和原生进程快照测试。系统默认 Python 缺少 `uiautomation`，不作为完整测试环境。
- `pnpm check`：309 项前端回归通过，外观与发布配置检查通过；`pnpm build` 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：592 项通过、5 项忽略、0 项失败。
- `scripts/test-chat-desktop-setup-ui.mjs`：720px 下浅色／深色 × Armor Mode 开关四种组合通过，含成功结果、最小化提示、锁定说明、失败重试清理及空列表诊断。
- 隔离标识 `com.levelup.agent.dingtalkdetectionqa` 的 Tauri 调试构建通过，使用真实 `chat_desktop_probe` → Python → Windows 枚举验证四种外观下的结果卡片、diagnostics IPC 与重载。该验证仅枚举窗口，没有读取聊天或发送消息。
- 合并机器未运行钉钉，原生验收返回空窗口列表；真实钉钉主窗口及权限受限场景仍需在运行钉钉的机器上复验，不能将模拟回归写成真实收发验证。
