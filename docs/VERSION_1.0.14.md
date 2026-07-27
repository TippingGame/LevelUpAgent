# LevelUpAgent 1.0.14 版本说明

## 版本信息

| 项目 | 内容 |
| --- | --- |
| 应用版本 | `1.0.14` |
| Harness 交付批次 | `2026-07-26` |
| 数据库 schema | `13` |
| 适用范围 | Windows 桌面标准会话 |
| 构建状态 | 本地 MSI、NSIS 和 release exe 已生成 |
| 设计文档 | [`HARNESS_DESIGN.md`](./HARNESS_DESIGN.md) |

本版本把标准桌面会话的 Agent 编排从 React 递归流程迁移到 Rust Harness。React 负责提交用户意图、展示事件和收集批准；Rust 负责 Provider 调用、工具循环、权限裁决、持久化、恢复和终态。宠物孵化仍保留原有隔离链路，不在本次迁移范围内。

## 本次界面与校对体验改进

- 新增 Codex 风格的右侧变更校对区，以 side panel / diff viewer 展示本次对话产生的文件变更，并支持返回文件列表、查看单文件 Diff 和关闭侧栏。
- 右侧 Diff 面板增加可拖拽分隔条，可在桌面窗口中调整校对区域宽度；窄屏自动限制宽度，移动端隐藏拖拽操作。
- 代码和 Markdown 预览统一采用浅色、紧凑的 Codex 风格；代码块增加语言标识和复制按钮，Diff 增删行使用清晰的浅色差异背景。
- 内置 `public/fonts/Monaco.ttf`，避免系统没有 Monaco 时出现字体回退；右侧 Diff 与代码预览默认使用内置 Monaco。
- 设置页拆分为两个分类：第一项为“模型连接”，第二项为“通用设置”，打开设置时默认进入模型连接。
- 通用设置集中放置侧栏 Diff 字体和字号、主题管理，以及 MCP、Skills、Instructions、请求日志和桌宠入口。Diff 字体可选择内置 Monaco、系统等宽字体或 Consolas，字号范围为 10–24px，并自动保存到本地设置。

## 新增功能

### 1. Rust Agent Loop

- 新增 `harness_run`，由 Rust 持有标准会话的完整 Provider、工具、批准和继续循环。
- 同一个用户任务在整个执行过程中保持同一个 `operation_id`，不再由前端递归创建多段运行。
- Provider 完成、工具执行、等待批准、继续、失败、取消和完成均由 Rust runtime 决定。
- mode、permission、workspace 和工具策略在 Rust 侧重新校验，前端参数不能绕过最终权限裁决。

### 2. 事件驱动 UI

- Tauri `Channel<HarnessRuntimeEvent>` 向 React 投影 assistant、tool、approval、queue 和终态事件。
- UI 不再自行维护标准会话的 agent loop，只根据持久化事件更新消息和运行状态。
- 新增 `queue_injected` 和 `provider_turn_interrupted` 事件，用于展示运行中引导和 Provider turn 切换。
- 等待批准期间保留当前 operation 所有权，拒绝工具后不会卡在“正在思考”。

### 3. Draft、Operation、Snapshot 与事件持久化

- 发送前保存原始 Draft，并执行 workspace、Provider、model、credential 和 permission 预检。
- 预检通过后创建 operation、初始 snapshot 和首个事件。
- Harness 状态、事件 sequence、当前 snapshot 和更新时间持久化到 SQLite。
- Harness schema 使用附加表迁移，不重写现有 `threads` 和 `messages` 数据。

### 4. Approval 与一次性 Token

- `harness_approvals` 实际保存批准记录、参数摘要、token hash、有效期和消费时间。
- approval token 绑定 operation 和 tool call，只允许成功消费一次。
- `AwaitingApproval` 在应用重启后保持可恢复，不会被误标为普通中断。
- 批准、拒绝和取消使用不同状态，拒绝不会执行对应副作用工具。

### 5. Context Manager

- `agent.rs` 的 Provider 上下文构建接入共享 Harness Context Manager。
- 按 Token 预算选择消息原子单元，并保护 assistant tool call 与 tool result 的配对关系。
- 当前用户输入和必需上下文超出预算时显式失败，不静默破坏原始消息。
- 每次 Provider 调用写入 `harness_context_manifests`，记录预算、选择结果、snapshot 和算法版本。

### 6. Provider Attempt 观测

- 每次 Provider 请求写入独立的 `harness_provider_attempts` 记录。
- attempt 关联 operation、snapshot、context manifest、Provider profile 和 model。
- 记录 request ID、输入/输出 Token、错误和完成时间，不保存凭据或完整请求正文。
- failover 产生新的 attempt，便于区分主连接和备用连接的实际执行结果。

### 7. 运行中消息队列

- 新增持久化 `steer`、`follow_up` 和 `next_turn` 队列。
- 运行中输入保持可用，普通消息和显式命令可以加入当前 operation 的队列。
- 队列消息显示在输入框上方，支持“立即引导”和“移除”。
- “停止”与“立即引导”是两个独立操作，不再把发送入口替换成唯一的停止按钮。

### 8. Codex 风格 Steer

本版本采用“只切换当前 Provider turn，保留 Agent operation”的语义：

- Provider 输出阶段点击“立即引导”：取消当前 Provider turn，记录 `provider_turn_interrupted`，随后在同一个 operation 中注入引导消息并继续运行。
- 工具执行阶段点击“立即引导”：不取消正在执行的工具，等待工具结果提交后再注入引导消息。
- Steer 不调用整个 operation 的 cancellation token，不创建新会话，也不丢弃已经完成的工具结果。
- 引导消息通过 `queue_injected` 进入当前对话并显示为用户消息。

### 9. Session Tree 与 Fork

- 新增 `harness_session_nodes` 和 session head 持久化结构，保存 parent、branch 和 position。
- 支持从当前会话节点创建分支并继续运行。
- Fork 复制历史时为每条消息生成新的消息 ID，修复 `UNIQUE constraint failed: messages.id`。
- 分支使用独立 thread/message 记录，避免两个分支因复用消息主键而保存失败。

### 10. 重启恢复与 Unknown 对账

- 启动时扫描未完成 Harness operation。
- `AwaitingApproval` 保留原状态并恢复批准入口。
- 中断时仍处于执行中的副作用工具标记为 `unknown`，不会自动重放。
- UI 提供“已执行”“未执行”“取消”三种人工对账结果，并将决策写回执行账本。

## 数据与接口

本版本新增或启用以下持久化表：

- `harness_drafts`
- `harness_operations`
- `harness_snapshots`
- `harness_events`
- `harness_context_manifests`
- `harness_provider_attempts`
- `harness_tool_executions`
- `harness_approvals`
- `harness_compactions`
- `harness_session_nodes`
- `harness_session_heads`
- `harness_queues`

主要 Tauri 接口包括：`harness_preflight`、`harness_start`、`harness_run`、`harness_check_tool`、`harness_resolve_approval`、`harness_list_recovery`、`harness_resolve_unknown`、`harness_enqueue`、`harness_steer`、`harness_cancel_queue` 和 `harness_fork_session`。

## 本次修复

- 修复拒绝文件创建后 operation 所有权被提前释放，界面永久停留在“正在思考”的问题。
- 修复运行期间前端只有停止按钮、无法继续输入的问题。
- 修复运行中消息加入队列后没有可见提示的问题。
- 修复 Fork 会话复用原消息 ID 导致 SQLite 唯一约束失败的问题。
- 修正早期“停止当前 operation 后重新发起任务”的 Steer 实现，改为保留同一个 operation 的 Provider-turn steer。
- 正式构建统一使用项目发布配置中的 `npm run build`，不使用临时回退配置。

## 兼容性与边界

- 现有 thread 和 message 数据继续使用原表；Harness 通过 additive migration 增加 schema 13 表。
- 标准桌面 chat/plan/agent/goal 发送链路使用 Harness；宠物孵化暂时保留旧的专用状态机。
- 当前 Context Manager 已完成预算选择、工具组保护和 manifest 记录；完整 project instruction 分层、统一 tool result trust envelope、可撤销 Memory 和增强型 compaction 仍属于后续版本。
- 本地安装包没有 Windows Authenticode 发布者签名，首次安装可能出现 SmartScreen 提示。
- 本实现参考了 [jcode](https://github.com/1jehuang/jcode)、[grok-build](https://github.com/xai-org/grok-build) 和 [pi](https://github.com/earendil-works/pi) 的设计边界；许可证和适配范围记录在 [`THIRD_PARTY_NOTICES.md`](../src-tauri/THIRD_PARTY_NOTICES.md)。

## 验证结果

截至 `2026-07-26`：

| 验证项 | 结果 |
| --- | --- |
| `npm run build` | 通过，TypeScript 与 Vite production build 完成 |
| `cargo fmt --check` | 通过 |
| `cargo check` | 通过 |
| `cargo clippy --all-targets -- -D warnings` | 通过 |
| `cargo test` | 165 个测试执行，164 通过，1 个条件忽略 |
| `npm run tauri build` | 通过，生成 release exe、MSI 和 NSIS |
| `git diff --check` | 通过 |
| `npm run check` | 未全通过：Node 20.19 直接导入两个 `.ts` 测试模块时报 `ERR_UNKNOWN_FILE_EXTENSION`；其余已运行的测试 12 个通过 |

构建产物：

- `src-tauri/target/release/levelup-agent.exe`
- `src-tauri/target/release/bundle/msi/LevelUpAgent_1.0.14_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/LevelUpAgent_1.0.14_x64-setup.exe`

对应 SHA-256：

```text
aa3becdd03d92dd956b8945373531937fef03aed97349200336354e6f441e8fe  levelup-agent.exe
740b934664a0630b68056d7c53a7dc0d74d2ffca2c3ec04743bf3760e367e389  LevelUpAgent_1.0.14_x64_en-US.msi
83ba86c3d91e8b44c8b0a21cc67528bdfdc6ed7610f5c8b62acf675d14d14820  LevelUpAgent_1.0.14_x64-setup.exe
```

## 人工验收重点

1. 正常文本任务能够由同一个 operation 完成多轮 Provider/tool loop。
2. 写工具批准后执行；拒绝后任务可以继续，不会卡在“正在思考”。
3. Provider 输出阶段点击“立即引导”，当前输出停止但 operation 不结束，引导消息随后进入当前对话。
4. 工具执行阶段点击“立即引导”，工具先完成，引导消息随后进入下一次 Provider 上下文。
5. “停止”按钮会真正取消 operation，行为与“立即引导”不同。
6. 创建会话分支后能够保存和继续，不出现 `messages.id` 唯一约束错误。
7. 在等待批准时重启应用，批准入口能够恢复。
8. 模拟副作用工具中断后，恢复界面要求人工选择结果，应用不会自动重放工具。
