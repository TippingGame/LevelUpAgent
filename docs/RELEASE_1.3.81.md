# v1.3.81：模型请求等待与自动重试修复

## 变化

- 修复连接异常和流响应中断时会话长时间停留在处理中的问题。响应头等待最多 90 秒，流连续 300 秒没有新事件即超时；正常持续返回事件的生成不按总时长截断。
- 非流式 JSON 响应体最多等待 300 秒，覆盖忽略流式参数的兼容服务和错误响应体。
- 每个供应商在一轮内失败请求累计耗时达到 300 秒后不再启动新重试，保留既有备用连接切换。此预算用于决定是否重试，不是整轮任务的硬截止时间。
- 等待超过 30 秒后显示阶段、耗时及限制；停止、恢复、完成或失败后移除等待状态。只收到响应头不再提前显示重连成功。
- 保留已完成的工具结果，补充流打开、首字时间、等待阶段、失败流统计及底层连接错误日志。
- 应用版本升级至 1.3.81；音频与 3D 资源版本不变，无需重复下载大型依赖。

## 验证

功能回归已覆盖四种协议的真实 HTTP 响应头、SSE 和 JSON 卡住场景，以及长时间持续输出、重试限制与取消。隔离 Windows 桌面实例验证了等待提示、停止、恢复、持久化与重载，覆盖系统浅深色 × Armor Mode 开关和 720 px 窗口。

本地发布门禁通过：冻结 lockfile 安装、`pnpm check`（307 项测试及外观／发布配置检查）、生产前端构建、Rust 格式检查、完整 Rust 测试（565 通过、5 忽略）与 Clippy 零警告。最后一处等价条件整理后另跑供应商相关测试（35 通过、1 忽略）。3D Python 测试 21 项（3 跳过），音频 Python 测试 9 项（2 跳过），其余全部通过。5 份独立资源清单和 48 个分卷已验证公开可用。

策略说明见 [模型请求可靠性](PROVIDER_RELIABILITY.md)。桌面证据在 `artifacts/provider-wait-review/`，本次发布门禁、工作流与资产验证证据归档到 `research/release-1.3.81-2026-10-16`。已于 2026-10-16 18:03:44（Asia/Shanghai）正式发布并设为 Latest。构建提交 `d8314487aa2248bd833f201ddc28ebcc33be2063`，三平台 CI run `38882047140` 与四平台 Release run `38882051277` 均成功。10 个资产完整下载并通过 GitHub SHA256 digest 校验；Windows EXE/MSI updater 签名及可信注释签名有效，公开发布页和 `latest.json` 均返回 HTTP 200、版本为 `1.3.81`。

## 平台与签名

Windows x64 提供 NSIS / MSI 及 Tauri updater 签名；macOS Apple Silicon / Intel 提供 ad-hoc 签名 DMG，未公证；Linux x64 提供 AppImage / DEB / RPM。主安装包不包含大型音频和 3D 模型及运行环境。

本次不覆盖用户正式安装，不执行旧版应用内更新；macOS / Linux 依赖原生 CI 构建与包验证，未新增实体机交互验收。


## 正式发布结果

- [GitHub v1.3.81](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.3.81)；[三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/38882047140)；[四平台打包](https://github.com/TippingGame/LevelUpAgent/actions/runs/38882051277)。
- 1.3.81 隔离 Windows 桌面回归通过：响应头等待、SSE 停滞、停止、恢复、持久化和重载，720 px 窗口、系统浅深色 × Armor Mode 开关，无页面脚本错误。
- 正式 Windows 安装器和主程序版本、归档完整性、x64 架构、CSP、生产 updater 配置和 71 个内置资源文件通过验证，未包含 QA 页面或标识。
- 5 份独立资源清单及 48 个分卷可公开读取，继续复用原资源版本；资源 Release 不占应用 Latest。
- 正式 EXE 已同步至 `G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.3.81_Windows_x64-setup.exe`，保留旧版，更新版本独立与汇总 SHA256 清单。
- EXE SHA256：`A7BB34C9E7B7061FAC18BA4C055214AFE71343C855C611892B22C0A3C7FA66B4`。

证据目录：`G:\Work\LevelUpAgent\research\release-1.3.81-2026-10-16`。未覆盖用户正式安装或执行旧版应用内更新，macOS / Linux 未新增实体机交互验收。
