<div align="center">
  <p><strong>简体中文</strong> · <a href="README_EN.md">English</a></p>

  <a href="https://levelup.mom/">
    <img src="public/logo.png" width="112" height="112" alt="LevelUpAgent Logo" />
  </a>

  <h1>LevelUpAgent</h1>
  <p><strong>一个工作区，连接每一种模型。</strong></p>
  <p>本地优先的跨平台 AI Agent，为多模型工作流提供统一、克制且可审查的桌面体验。</p>

  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#核心能力">核心能力</a> ·
    <a href="#安全与隐私">安全与隐私</a> ·
    <a href="#文档">文档</a> ·
    <a href="https://levelup.mom/">LevelUpAPI</a>
  </p>

  <p>
    <img alt="Version" src="https://img.shields.io/badge/version-1.0.1-ff5a4f?style=flat-square" />
    <img alt="Status" src="https://img.shields.io/badge/status-stable-35a36f?style=flat-square" />
    <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-232f3e?style=flat-square" />
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-LGPL--3.0--only-2f80ed?style=flat-square" /></a>
  </p>
</div>

---

LevelUpAgent 把模型连接、项目上下文、工具审批、MCP、Skills、Git 审查和长任务执行放在同一个桌面工作台中。它优先适配 [LevelUpAPI](https://levelup.mom/)，也可连接标准 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 与 Gemini GenerateContent 服务。

> [!IMPORTANT]
> LevelUpAgent 1.0.0 是首个稳定版本。Windows 与 Linux 已有真实构建和冒烟验证；当前 tag 发布流程聚焦 Windows，并使用 Tauri 签名保护自动更新。涉及重要项目时仍建议先提交或备份改动。

## 为什么是 LevelUpAgent

| | 你获得的体验 |
| --- | --- |
| **一个入口** | 在同一项目中切换 OpenAI、Claude、Gemini、Grok 及兼容模型，不再维护多套增强工具。 |
| **默认可控** | 读取类工具可以自动执行；写文件、运行命令、调用 MCP 和应用子 Agent 补丁都需要明确批准。 |
| **本地优先** | 会话与运行记录保存在本地 SQLite；API Key 进入系统凭据库，不写入页面存储。 |
| **为 LevelUpAPI 而生** | 原生展示余额、用量、延迟与 request-id，并兼容多协议和备用连接故障转移。 |

## 快速开始

### 1. 安装

从仓库右侧的 **Releases** 下载与你的平台匹配的安装包：

| 平台 | 安装包 | 当前状态 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` / MSI | tag 工作流构建，Tauri 签名更新 |
| Linux x64 | AppImage / DEB / RPM | 已构建并冒烟验证；当前 tag 工作流不发布 |
| macOS Apple Silicon / Intel | DMG / App Bundle | 当前 tag 工作流不发布 |

当前 Windows 本地验收产物的 SHA-256 记录见 [校验清单](docs/SHA256SUMS_1.0.0.txt)。后续正式更新以 GitHub Releases 中带 `.sig` 与 `latest.json` 的 Tauri 签名产物为准。

### 2. 连接模型

1. 打开左下角 **模型连接**。
2. 添加 LevelUpAPI 或任意兼容 Provider 的地址、协议与模型；可信本机/局域网服务可显式允许无 API Key。
3. 模型 ID 可直接输入，也可点击 **检测** 从兼容的模型列表接口获取。
4. 可选：添加最多 7 个备用连接，并设置优先级。

Base URL 既可以是服务根地址，例如 `https://api.example.com`，也可以包含 `/v1`、`/v4` 等版本前缀。LevelUpAgent 会显示最终请求地址并避免重复拼接版本前缀。本地服务应使用其 OpenAI、Anthropic 或 Gemini 兼容接口，例如 Ollama 的 `http://127.0.0.1:11434/v1`，而不是原生 `/api/chat`。

### 3. 开始工作

选择项目目录，新建会话并描述目标。Agent 会先读取必要上下文，再按当前权限等级处理文件、命令与外部工具。你可以随时停止生成、切换模型，或在 Git 面板审查实际改动。

## 核心能力

### 多模型工作台

- LevelUpAPI / OpenAI-compatible / Anthropic-compatible / Gemini-compatible 连接
- 主连接优先、健康记录、指数冷却和最多 7 个备用连接的故障转移
- 四种协议的 SSE 流式输出、真实请求中断和 request-id 诊断
- 首页余额、30 天用量、延迟与 Token 统计
- Codex、Claude Code、Gemini CLI、OpenCode 和 cc-switch 配置扫描与安全导入

### 面向项目的 Agent

- 文件浏览、读取、搜索、写入、删除与命令执行
- 默认、规划、目标、问答四种工作模式
- 项目级会话、Markdown 响应与本地 SQLite 持久化
- 无项目会话自动使用 `%LOCALAPPDATA%\\com.levelup.agent\\workspace` 临时工作区，并保留适用的 Agent、MCP、Skill 和媒体能力；多个会话可独立并行运行与审批
- 图片、文本、代码、PDF、DOCX、XLSX、PPTX 托管上下文
- 可持久化 Instructions，并可安全同步到主流 CLI 指令文件
- Goal 持续执行、暂停/恢复、完成审计和阻塞审计

### 多媒体创作

- 自动发现并推荐当前连接中最新的生图、视频与 TTS 模型
- 独立“创作空间”，支持图片参考、多提示词并行生成、本地历史、预览与另存为
- 会话可直接调用 `generate_images`、`generate_videos`、`generate_speech`；连续生成调用并行执行，结果保持原顺序后交给模型统一汇总
- OpenAI-compatible 图片/语音/Sora 与 Gemini 原生图片/语音/Veo；视频任务持久化并自动轮询

### 可组合扩展

- stdio 与 Streamable HTTP MCP 客户端
- Codex、Claude、Agents、LevelUpAgent 与项目级 Skill 发现
- Skill 正文和引用按需读取，避免无关上下文膨胀
- 子 Agent 使用隔离 Git worktree；补丁完整可见，应用前再次批准

### 克制的桌面体验

- Tauri 2 + React，面向 Windows、macOS 与 Linux
- 与 LevelUpAPI 一致的暖色视觉系统、响应式布局与深色模式
- 完整中文 / English 界面，首次启动跟随系统语言
- 键盘焦点、Modal 焦点约束、Escape 关闭和减少动态效果支持

## 支持的协议

| 协议 | 请求端点 | LevelUpAPI 主要适配平台 | 适合场景 |
| --- | --- | --- | --- |
| OpenAI Responses | `/v1/responses` | OpenAI、Anthropic、Grok | Codex、GPT/Grok 推理与原生工具调用 |
| Chat Completions | `/v1/chat/completions` | OpenAI、Anthropic、Grok | 广泛的 OpenAI-compatible 模型 |
| Anthropic Messages | `/v1/messages` | Anthropic、OpenAI、Gemini、Antigravity、Grok | Claude Code 及跨平台 Messages 接入 |
| Gemini GenerateContent | `/v1beta/models/{model}:streamGenerateContent` | Gemini、Antigravity | Gemini 原生模型与工具调用 |

连接设置会用与 LevelUpAPI 一致的平台固有色展示这些主要适配关系。Grok/xAI 推荐使用 Responses，
同时也可通过 LevelUpAPI 使用 Chat Completions 或 Anthropic Messages。

自动化验证证据见 [LevelUpAPI 兼容性文档](docs/LEVELUPAPI_COMPATIBILITY.md)。

## 安全与隐私

- **密钥不进入前端存储**：API Key 保存在系统 Credential Manager、Keychain 或 Secret Service。
- **危险操作必须批准**：写入、删除、命令、MCP 与补丁应用不会静默执行。
- **工作区路径受限**：本地文件工具拒绝父目录、符号链接和路径前缀逃逸。
- **配置写回可恢复**：同步 CLI 前显示脱敏 diff，确认后原子写入并保留时间戳备份。
- **请求日志最小化**：不保存消息正文、附件内容、工具参数或 API Key。
- **Provider 边界透明**：只有你配置并选择的 Provider 会收到准备发送的消息和附件。

Shell 命令与本地 stdio MCP 进程仍拥有当前操作系统用户权限；LevelUpAgent 不将它们描述为系统级沙箱。完整威胁模型见 [安全审计](docs/SECURITY_AUDIT.md)。

## 从源码运行

需要 Node.js 22+、pnpm 11+、Rust 1.85+，以及对应平台的 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm tauri dev
```

只预览前端可运行 `pnpm dev`。Web 预览无法访问系统凭据库、目录选择器和本地工具。

### 验证与构建

```bash
pnpm check
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

验证当前代码与本机 LevelUpAPI 的四协议契约：

```bash
pnpm verify:levelupapi
```

## 项目结构

```text
LevelUpAgent/
├─ src/                  React 工作台与交互状态
├─ src-tauri/src/        Rust Agent 内核、协议适配与系统边界
├─ src-tauri/icons/      跨平台应用图标
├─ scripts/              构建、发布与兼容性验证
├─ docs/                 架构、安全、路线图与发布文档
└─ .github/workflows/    跨平台 CI 与签名发布流程
```

## 文档

- [架构与安全边界](docs/ARCHITECTURE.md)
- [安全审计](docs/SECURITY_AUDIT.md)
- [LevelUpAPI 兼容性证据](docs/LEVELUPAPI_COMPATIBILITY.md)
- [功能路线图](docs/ROADMAP.md)
- [替代能力审计](docs/REPLACEMENT_AUDIT.md)
- [签名发布与自动更新](docs/RELEASE.md)
- [参考项目研究](docs/REFERENCE_RESEARCH.md)

## 项目状态

`1.0.0` 是 LevelUpAgent 的首个稳定里程碑，整合四协议、多连接故障转移、本地工具、SQLite、Git 审查、MCP、Skills、Goal、隔离子 Agent、多项目多会话、三级权限、拖拽上下文和完整的 LevelUpAPI 平台适配提示。

Windows 自动更新依赖仓库所有者配置 Tauri updater 密钥并完成实体机验收。当前安装包未配置 Authenticode，可能触发 SmartScreen；其他平台的 tag 发布尚未启用。进度以 [路线图](docs/ROADMAP.md) 为准。

## 参与贡献

欢迎提交 Issue、文档改进和 Pull Request。提交代码前请至少运行 `pnpm check`、`pnpm build` 和 Rust 测试。涉及协议、凭据、文件系统、命令、MCP 或更新链路的改动，请同时说明安全边界变化与验证方式。

## 许可证

LevelUpAgent 以 [GNU Lesser General Public License v3.0 only](LICENSE) 发布。LGPL v3 引用的 GNU GPL v3 正文一并收录于 [LICENSE.GPL](LICENSE.GPL)。

Copyright © 2026 LevelUpAgent contributors.
