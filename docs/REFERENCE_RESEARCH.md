# 参考项目研究

研究快照日期：2026-07-11。参考仓库保存在工作区外层 `.research/`，不参与构建和发布。

## 研究范围

| 项目 | 快照提交 | 主要用途 | 许可证边界 |
| --- | --- | --- | --- |
| fanfan-de/anybox | `261b73f` | 桌面 Agent 工作台与会话体验 | MIT |
| claude-code-best/claude-code | `75e2b3b` | Agent 循环、Goal、工具与工作流 | 仅供学习研究，未提供可复用项目许可证 |
| farion1231/cc-switch | `f39d463` | 多供应商配置、备份、代理与用量 | MIT |
| BigPizzaV3/CodexPlusPlus | `b9393b1` | Codex 中转注入、配置同步与诊断 | AGPL-3.0-only |
| LevelUpAPI | 本地 `main` | 实际网关协议、鉴权和模型能力 | 本地项目约束 |

LevelUpAgent 采用 clean-room 实现：参考产品边界、公开协议和交互模式，不复制受限项目源码，
也不链接 CodexPlusPlus 的 AGPL 代码。

## Anybox

Anybox 把桌面壳、Agent 服务和共享契约拆成独立包：Electron 主进程托管 Bun/Hono Agent，
渲染层只消费强类型 API/IPC。其值得保留的核心不是 Electron 本身，而是以下边界：

- 会话是长期实体，流事件、权限请求和工具结果都有稳定身份。
- 工作区状态与对话状态分离，文件、终端、diff 和预览是同级工作面板。
- 权限请求由专门控制器管理，不在消息组件里直接执行副作用。
- MCP、Skill、连接器和插件有各自契约，核心会话不依赖具体扩展。
- 托管 Agent 有明确启动、健康检查、日志和关闭生命周期。

LevelUpAgent 的对应决策：共享通用消息/工具模型；把系统能力留在 Rust；审批状态由会话层管理；
未来扩展通过稳定能力接口进入，而不是让插件直接操作窗口状态。

## Claude Code Best

该项目展示了成熟编码 Agent 的状态机形态：工具调用不是一次请求的附属文本，而是可恢复的
执行记录；Goal、workflow engine、MCP client 和 builtin tools 都围绕这一记录推进。

关键结论：

- Agent 循环必须有轮次上限、取消点和终止原因。
- 工具描述需要小而稳定，参数 schema 是模型与本地能力之间的真实 ABI。
- Goal 与普通会话不同：Goal 需要跨轮预算、完成审计和阻塞审计。
- 只看最终回复无法调试 Agent，必须保留请求 ID、用量、工具输入和结果。
- 工作流编排应建立在同一个消息事件模型上，不能另起一套旁路状态。

LevelUpAgent `0.12.0` 已实现统一工具 ABI、SSE 中断、MCP client、Skill 按需加载、持久 Goal、
预算与完成审计、Provider 故障转移、安全配置写回、Instructions、图片输入和请求日志，以及完整工具结果回灌。由于该参考项目没有
提供可复用许可证，本仓库不复制其实现。

## cc-switch

cc-switch 的价值集中在“AI 工具控制面”，而非 Agent 执行本身：

- 多供应商配置、模型拉取、连通性检测和快速切换。
- Claude/Codex/Gemini/OpenCode 等配置文件适配。
- MCP、Skill、Prompt 的统一管理与同步。
- 配置备份、导入导出、代理、故障转移和用量统计。
- Tauri 2 的跨平台安装、托盘、单实例和更新能力。

LevelUpAgent 不再把其他 Agent 当唯一执行端，因此优先实现自己的模型连接和 Agent 内核。
配置导入/导出仍会保留，用于平滑迁移现有 `~/.codex`、Claude 和 Gemini 配置，而不是长期
依赖切换器。

## CodexPlusPlus

CodexPlusPlus 通过外部 CDP 和本地代理增强 Codex，解决 API 模式下插件、会话删除、导出、
Provider 同步和上下文窗口配置等问题。它证明了用户确实需要：

- Responses 协议中转和自定义模型目录。
- 供应商切换后会话仍可见。
- 可解释的诊断、日志与安全回滚。
- Windows 静默启动和 macOS 双架构安装。

但 CDP 注入和修改其他应用运行时天然受上游 DOM/版本影响。LevelUpAgent 选择直接成为 Agent：
会话、工具、模型和插件都由自身控制，不解锁或注入第三方客户端。迁移阶段只读取已有配置，
任何写回都需要显式预览、备份和确认。

## LevelUpAPI

LevelUpAPI 是 Go/Gin 网关，提供账号调度、API Key、计费、并发控制和粘性会话。对桌面 Agent
最重要的公开面为：

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- `GET /v1beta/models`
- `POST /v1beta/models/{model}:streamGenerateContent`

因此 LevelUpAgent 将 LevelUpAPI 视为首选网关而不是特殊私有协议：用户只需服务地址和 API
Key；模型请求继续走标准线协议。管理后台的账号、支付、调度和计费职责不复制到桌面端。

## 产品结论

LevelUpAgent 的目标形态由三层组成：

1. Agent 工作台：项目、会话、工具轨迹、diff、终端和审批。
2. Agent 内核：统一消息、协议适配、工具循环、Goal、MCP 和 Skill。
3. 模型控制面：LevelUpAPI 优先，多连接、健康检查、故障转移、用量和迁移。

这三层合并后，cc-switch 和 CodexPlusPlus 的“中转配置”职责被原生连接管理取代，Anybox 和
Claude Code 类产品的“Agent 执行”职责由本地内核承担，LevelUpAPI 继续专注服务端调度。
