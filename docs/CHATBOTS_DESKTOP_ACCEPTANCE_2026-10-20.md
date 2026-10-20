# 钉钉桌面本地验收记录 · 2026-10-20

本文保留 build2 的验收证据。后续 build3 的自动识别 Python 变更及独立安装包见 [复用已有 Python](CHATBOTS_PYTHON_DETECTION_2026-10-20.md)。下文报告文件对应 build2 归档；工作目录同名报告随复跑更新。

版本：**1.3.82**，保留用户要求的版本号。当前构建：**dingtalk-desktop-test-20261020-build2**。范围：免开发者权限的 Windows 钉钉桌面通道，本地实现与测试安装包。用户明确暂不打开钉钉，因此真实平台测试不计为通过。

## 已执行

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| `pnpm check` | 309 项前端测试 + 4 项 appearance 测试通过；TS 类型检查通过 | UI 行为另作原生验证 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 580 passed，5 ignored，0 failed | 含桌面账号、路由及延后发送规则 |
| Python 网关全部测试 | 43 passed | 33 项桌面测试 + 10 项既有网关测试 |
| Windows 桌面依赖导入/枚举 | 通过，检测到 0 个钉钉窗口 | 实际调用 Windows API，无模拟窗口冒充钉钉 |
| 真实用户截图 OCR | 识别一个可见文字气泡；图像/表情文字未进入消息 | 静态图，无法证明输入框可读写 |
| 原生 Tauri QA | 30 个记录场景完成，0 page errors；13 次本地模拟模型请求、11 次模拟平台发送 | 模型与平台服务为本地测试进程 |
| 桌面账号无需密钥 | 通过，独立运行环境就绪后进入 waiting，无 credential_required | 未使用开发者或组织 API 权限 |
| 缺少钉钉窗口 | 通过，账号显示等待和具体原因，不发消息 | 不伪报 online |
| 私聊/群 @ 路由 | 本地校验通过；拒绝群全部文本及重复标题路由 | 真实事件待测 |
| 空聊天首条消息、临时空 OCR、人工操作 | 单元测试通过；输入前繁忙保留同一回复，输入后不确定状态不重试 | 真实桌面时序待测 |
| 输入框诊断与文字写入 | 单元测试覆盖 ValuePattern / LegacyIAccessible、部分写入、字面 Unicode 和只读诊断 | 测试编辑器为模拟对象，真实钉钉 UIA 兼容性未验证 |
| 实际子进程协议 | 私聊/群 @、提交 ACK 丢失重投、延后发送、跨重启发送保护及阻塞驱动 EOF 退出通过 | 子进程使用测试驱动，不能视为钉钉动态收发通过 |
| 暂停、断开、崩溃恢复 | 本地模拟与状态机测试通过 | 不能撤回已经点击发送的内容 |
| 外观 | 720px 下 light/dark × Armor off/on 截图；无横向溢出 | 含桌面新增设置区 |
| 生产构建 | 使用 `pnpm tauri build --bundles nsis --no-sign --ci` | NSIS x64 测试包，未签名，不发布更新 |

原生完整报告：`artifacts/chatbots-review/report.json`，最终 QA 时间 `2026-10-20T08:03:52.826Z`。截图为同目录 `*-desktop.png`，四套外观总览为 `desktop-final-contact.png`。测试使用 `com.levelup.agent.chatbotsqa`，不读写生产用户配置。

原生复跑曾受残留测试账号及桌宠自主学习请求影响；脚本已清理隔离账号、在复跑时重置模型请求统计，并仅在隔离 QA 配置中关闭与机器人测试无关的自主学习。平台选择器有明确 aria-label；桌面截图在进程重启后重新设置 720px viewport，并断言实际 innerWidth。最终复跑完成。只读输入框诊断有单元测试；没有真实钉钉窗口，原生 QA 未验证真实编辑器诊断结果。

测试命令、构建日志、安装包核验脚本及逐文件哈希随 build2 源码快照保存。测试驱动 `scripts/chatbots-mock-desktop.py` 不随安装包分发。

补存 Python 日志时曾有 ACK 测试超时。诊断复现了 Windows 下读取句柄干扰子进程的原子替换（WinError 5），当前环境即使允许 READ / WRITE / DELETE 共享也仍拒绝替换。测试改为由专用模拟子进程在真实 fsync + replace 成功后报告状态快照，运行期间不再打开该状态文件；关闭子进程后直接读盘确认 ACK 已持久化。等待函数也会直接报告子进程退出。此处只修改测试及测试驱动，不修改已打包的运行代码。失败日志及复现日志保留为 `python-recheck-failed.log`、`python-shared-reader-failed.log`、`protocol-reader-contention.log`；最终整组结果见 `python-final-tests.log`。

可复现命令（项目根目录，使用已安装依赖的隔离 Python）：

```powershell
& .\artifacts\chatbots-review\venv\Scripts\python.exe -m unittest discover -s modules/chat_gateway -p 'test_*.py' -v
pnpm check
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm build
pnpm tauri build --bundles nsis --no-sign --ci
& .\artifacts\chatbots-review\venv\Scripts\python.exe artifacts/chatbots-review/verify_desktop_installer.py
```

原生 QA 的专用配置和运行步骤见 `scripts/verify-chatbots.mjs`；仅可使用其隔离标识与测试服务。

## 未完成的真实客户端验收

- 钉钉 9.0.1-Release.260920012_Native 真实私聊动态读取与自动回复。
- 群内 @ 显示名、昵称、引用、换行以及实际消息方向的识别。
- UIA 输入框定位、读草稿、文字写入和点击发送。
- 多个置顶聊天轮询、窗口缩放与系统缩放的真实兼容性。
- 离线发送与服务器回执。界面“本地已发出”仅指可见发出气泡，不代表对方已收到。

这些项等待用户方便打开钉钉后完成，不能以本地模拟测试替代。运行步骤及功能限制见 `DINGTALK_DESKTOP_2026-10-20.md`。

## 安装包核对

当前测试包：`G:/Work/LevelUpAgent/安装包/钉钉桌面测试版_20261020_build2/LevelUpAgent_1.3.82_Windows_x64_dingtalk-desktop-test-setup.exe`，15,359,960 字节。SHA256：`0f4e500cec713aed53ce8e695a50444a5e09344a2b42c5dd8544bfa97118d7c3`。

7-Zip 成功解包；6 个网关资源与源码逐字节一致；打包后的 EXE 仅有 Tauri 预期的 bundle type 标记 UNK→NSS 差异，其他字节一致；FileVersion / ProductVersion 均为 1.3.82。解包后的桌面 gateway `--check` 导入通过，未包含桌面测试或模拟驱动。核验结果：`artifacts/chatbots-review/installer-verification.json`。未在生产用户环境执行安装或发送聊天消息。

## 历史构建保留

build1 包仍在 `G:/Work/LevelUpAgent/安装包/钉钉桌面测试版_20261020/`，15,204,064 字节，SHA256 `67d93f701742851834bbb9bb65a1654f3b9af2632349c0830ca9c20e829b2153`。原始源码归档仍为 `research/chatbots-2026-10-18/implementations/dingtalk-desktop-2026-10-20/`，ZIP SHA256 `3f2d64649f10f339885cdaae6ec26aca6a1fd9c4f35319424e387aae8740da2c`。此前结果为 Python 31 项、Rust 579 passed / 5 ignored，原生 QA 时间 `2026-10-20T07:06:29.740Z`；对应报告与截图另存 `artifacts/chatbots-review/build1-evidence`。

build2 另存 `research/chatbots-2026-10-18/implementations/dingtalk-desktop-2026-10-20-build2/`，清单记录应用版本、构建标记、前一构建、安装包和源码 ZIP 的 SHA256，以及每个文件的哈希；研究目录的 CHANGELOG 和 VERSION_LEDGER 分别追加记录。
