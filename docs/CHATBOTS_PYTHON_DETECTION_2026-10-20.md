# 机器人复用已有 Python · 2026-10-20 build3

应用版本保持 **1.3.82**，构建标记 **dingtalk-desktop-test-20261020-build3**。本次解决首次准备机器人环境时总是要求手选 Python 的问题。build1、build2 安装包和源码归档保持原样。

## 使用变化

进入 **摇光残影 → 自动机器人 → 平台账号**，页面自动显示已有 Python 的版本、位数和路径。点击“使用已有 Python 配置依赖”即可，不需要重新下载安装 Python。首次联网安装的是机器人 SDK / OCR 等依赖，它们进入应用数据目录的独立 venv，不装进系统 Python。

依赖环境已就绪后按钮变为“校验已有环境”。如果实际导入检查通过，直接复用，不重新创建 venv 或运行 pip。无法自动识别自定义安装位置时，可以重新检测，或展开手动选择已有的 `python.exe`，支持中文和空格路径。误选不存在或不兼容的解释器时，先报错，不删除现有环境的就绪标记。

- 官方 API 通道：Python 3.10+，包含 venv / ensurepip。
- 钉钉桌面 OCR 通道：Windows CPython 3.10–3.12，x64，包含 venv / ensurepip。Python 3.13+、32 位和 ARM64 解释器不能用于这组固定依赖；可以另装兼容版本，与原版本共存。
- 扫描顺序：应用已有环境 → Windows PEP 514 用户/系统注册表（64/32 位视图）→ 常用安装目录 → py launcher → PATH。每个候选真实启动探测，不能只根据目录名判断版本。Windows Store 的 PATH 别名不直接启动，避免误打开商店；新 launcher 的自动安装关闭。
- 未识别不代表必须重装；不在注册表、常用目录和 PATH 的便携安装可手选。检测不会遍历用户磁盘。

## 实现和复现

检测与校验：`src-tauri/src/chatbots/python.rs`；安装与复用：`gateway.rs`；命令：`chat_detect_python`、允许省略路径的 `chat_install_runtime`；官方 API 和桌面通道共用 `src/components/ChatRuntimeSetup.tsx`。

原生测试仍使用专用 `com.levelup.agent.chatbotsqa`。`scripts/verify-chatbots.mjs --fresh-python` 在核实隔离目录后临时移开旧测试 venv，移除子进程 PATH 中的 Python，验证真实系统发现与自动配置。结束后恢复旧测试环境，不使用生产配置。`LEVELUP_QA_MANUAL_PYTHON` 可指定含中文/空格的测试解释器。

本次不改变钉钉消息读取或发送驱动。用户已推迟真实钉钉联调；自动检测 Python 通过不能视为真实聊天自动收发通过。[客户端步骤和边界](DINGTALK_DESKTOP_2026-10-20.md)，[上一构建验收](CHATBOTS_DESKTOP_ACCEPTANCE_2026-10-20.md)。

## 本地验证结果

| 检查 | 结果 |
| --- | --- |
| Rust 全库测试 | 583 passed，5 ignored；新增 3 项 Python 版本、架构、venv 和路径校验测试 |
| `pnpm check` | TypeScript、309 项前端测试和 4 项外观测试通过 |
| 前端与 NSIS 生产构建 | 通过，版本仍为 1.3.82 |
| 原生隔离 QA | 37 场景，0 page errors；13 次本地模拟模型请求、11 次模拟发送 |
| 无旧 venv、PATH 无 Python | 实际自动发现 `Python310/python.exe`，3.10.11 / 64 位；官方 SDK 与桌面 OCR 环境均省略路径完成配置 |
| 中文及空格路径 | 实际启动 `已有 Python with spaces/Scripts/python.exe`，手选兼容性检查通过 |
| 错误路径 | 安装命令报错；原就绪标记修改时间保持不变 |
| 复用环境 | 后端再次配置及界面“校验已有环境”后，`pyvenv.cfg` 修改时间保持不变；健康分支直接返回，不调用 pip |
| 四套外观 | 720px 下系统 light/dark × Armor off/on，自动检测结果、手选展开及 hover/focus 可见，无横向溢出 |
| 安装包资源核对 | 6 个网关资源与源码逐字节一致；EXE 仅有预期 Tauri bundle 标记差异；解包后桌面依赖检查通过；不含测试驱动 |

QA 完成时间：`2026-10-20T09:12:28.552Z`。报告 `artifacts/chatbots-review/report.json`，独立检测证据 `build3-python-detection.json`，日志 `build3-*.log`，四套界面总览 `build3-desktop-contact.png`。Python 消息驱动本轮无修改；43 项消息驱动测试沿用 build2 通过记录，另有本轮实际导入及原生进程验证。

## 交付和归档

安装包：`G:/Work/LevelUpAgent/安装包/钉钉桌面测试版_20261020_build3/LevelUpAgent_1.3.82_Windows_x64_dingtalk-desktop-test-setup.exe`，15,331,972 字节。

SHA256：`49c2aaff344d2084c7932ad08073f713bec30cbebaa429db37ad5396d91564d2`。

源码、逐文件哈希、构建与测试证据保存在 `research/chatbots-2026-10-18/implementations/dingtalk-desktop-2026-10-20-build3/`。研究目录 `CHANGELOG.md` 和 `VERSION_LEDGER.md` 追加本构建记录。未安装到生产用户环境，未触发真实钉钉消息发送。
