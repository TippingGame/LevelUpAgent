<img src="public/logo.png" width="64" height="64" alt="LevelUpAgent" />

# LevelUpAgent

本地优先的桌面 Agent。连接自己的模型，在同一个工作区完成开发、研究与创作。

**简体中文** · [English](README_EN.md) · [文档](docs/README.md) · [LevelUpAPI](https://levelup.mom/)

## 工作台

| 入口 | 能力 |
| --- | --- |
| Agent | 流式会话、项目文件、命令、审批、Goal、Skills、MCP、浏览器验证与变更审阅 |
| 会话 | 全历史检索、快捷切换、独立草稿、运行中追加、分支、导入与导出 |
| 创作 | 图片、视频、语音、参考素材、蒙版编辑与本地历史 |
| 写作 | 文稿、设定集、参考库、目标执行、快照与剧情试玩 |
| 星图 | 类型化节点、并行分支、画板与可复用蓝图 |

![星图工作台](docs/images/constellation-workflow.png)

还包含主题与声明式布局、摇光残影桌面陪伴、连接迁移和 CLI 配置同步。
完整范围、限制及验证记录见 [功能总览](docs/FEATURES.md)。

## 开始使用

从仓库 **Releases** 安装对应平台的版本，添加模型连接，填写 Base URL、API Key 和模型，然后选择项目。

支持 OpenAI Responses、Chat Completions、Anthropic Messages、Gemini GenerateContent 和 OpenCode Go 自动路由。多个连接可配置故障转移；模型发现与思考档位以连接实际返回和模型能力为准。

聊天工作台按 `Ctrl/Cmd + K` 搜索会话和命令。Agent 执行任务，Plan 只做只读规划，Chat 不调用工具，Goal 持续推进并审计完成结果。[使用与恢复](docs/AGENT_WORKFLOWS.md)

## 权限与数据

API Key 保存在系统凭据库，会话和草稿保存在本机。配置的模型服务会收到发送的上下文；本地存储不代表离线推理。

新安装默认使用 `agent` 权限：工作区文件编辑和部分命令可以自动执行。`request` 对副作用逐项询问；`full` 允许自动执行及工作区外访问。已有权限选择保留。Shell 与 stdio MCP 使用当前系统账户权限。[安全边界](docs/SECURITY_AUDIT.md)

## 开发

需要 Node.js 22.18+、pnpm 11+、稳定版 Rust 及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
pnpm install
pnpm tauri dev
```

`pnpm dev` 只预览界面，不具备桌面凭据、文件工具或真实 Agent 执行能力。

```sh
pnpm check
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

[架构](docs/ARCHITECTURE.md) · [性能](docs/PERFORMANCE.md) · [Codex 工作流对照](docs/REPLACEMENT_AUDIT.md) · [路线图](docs/ROADMAP.md) · [发布](docs/RELEASE.md)

当前发布版本为 `1.0.60`。Windows 未配置 Authenticode，macOS 使用 ad-hoc 签名、尚未公证。跨平台发布与实体机验证边界见发布文档。

## 许可

[LGPL-3.0-only](LICENSE)。第三方归属见 [THIRD_PARTY_NOTICES](src-tauri/THIRD_PARTY_NOTICES.md)。
