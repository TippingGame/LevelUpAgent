# 架构与安全边界

## 运行结构

```text
React workbench
  |-- threads / composer / approval state
  |-- writing projects / codex / narrative graph / playtest
  |-- provider settings (no plaintext key)
  `-- Tauri invoke boundary
          |
Rust host |-- OS credential vault
          |-- protocol adapters
          |     |-- OpenAI Responses
          |     |-- OpenAI Chat Completions
          |     |-- Anthropic Messages
          |     `-- Gemini GenerateContent
          |-- workspace guard
          |-- local tools
          |     |-- list/read/search
          |     |-- write file
          |     `-- run command
          |-- MCP manager (rmcp)
          |     |-- stdio child process
          |     |-- Streamable HTTP
          |     `-- dynamic tool registry
          |-- Skill registry
          |     |-- compatible directory discovery
          |     |-- frontmatter validation + enable preferences
          |     `-- root-constrained on-demand reads
          |-- sub-Agent manager
          |     |-- detached Git worktree
          |     |-- restricted file tools
          |     `-- reviewable patch + second approval
          `-- Goal state machine
                |-- usage accounting
                |-- pause/resume + hidden continuations
                `-- completion and blocked audits
```

## 通用消息模型

前端只保存 `user`、`assistant`、`tool` 三类消息。Assistant 消息可以携带通用 `ToolCall`：

```text
ToolCall { id, name, arguments }
```

Rust 适配器负责把通用历史转换为各协议格式，并把响应重新归一化。协议差异不会泄漏到会话
组件或本地工具层。

每次请求在 Rust 协议适配边界创建历史副本，SQLite 中的完整消息保持不变。副本最多包含 160 条
消息和 240,000 个文本字符；用户、Assistant、历史工具结果正文分别限制为 64,000、32,000、
12,000 字符，历史工具参数超过 8,000 字符时替换为确定性首尾预览与关键字段摘要。当前用户消息
强制保留；其余历史按最近优先选择。Assistant 工具调用和紧随的所有匹配结果属于同一不可拆分单元，
缺结果、重复结果或孤立结果的单元整体排除，防止生成四协议都无法接受的孤儿消息。省略消息数、
省略字符数、截断字符数和非法工具组数都会写入系统提示词，要求模型不能假装读过缺失内容，并在
需要时重新调用本地工具取证。图片二进制由附件独立的大小/数量限制约束，不计入文本字符预算。

## 写作与游戏叙事边界

写作项目与会话分离：桌面端以 `writing_projects` 表保存版本化 JSON，Web 预览使用独立的
localStorage 回退。项目包含文稿、任意类型设定、实体关系、剧情节点、变量、快照和补全设置；
单项目后端编码上限为 16 MiB，项目 ID、类型、标题和时间戳在写入前校验。导入数据经过逐层归一化，
无效 ID、时间戳、快照和字段会被修复或丢弃，不能直接成为数据库结构。

AI 写作复用当前文字 Provider 和既有故障转移链路，但固定使用不暴露工具的 chat 模式。每次补全只
发送当前操作构造的用户消息：项目前提与文风、当前/相邻文稿摘要、显式选择的设定、文稿或节点绑定、
光标附近名称/别名提及、实体关系以及世界观/规则按分数排序，并在用户设置的字符预算内逐块截断。
正文建议以预览态流式返回，接受后才写入项目，并在覆盖前创建快照；继续输入、切换目标或离开工作台
会取消仍在运行的补全。

剧情试玩不执行任意脚本。条件只接受布尔变量、`==`、`!=`、比较运算和 `&&`；效果只接受已声明变量的
`=`、`+=`、`-=` 和 `toggle`。无效表达式不会求值为可执行代码，类型不匹配或非有限数值不会写入状态。
完整性检查覆盖缺失开始节点、悬空目标、未知变量、死路和不可达节点。导出只经系统保存对话框写入
`.json`、`.md`、`.yarn` 或 `.txt`，目标父目录必须已存在。

## 审批模型

| 工具 | 默认策略 | 限制 |
| --- | --- | --- |
| `list_files` | 自动 | 忽略依赖、构建和 Git 目录，最多 400 项 |
| `read_file` | 自动 | UTF-8，单文件最多 256 KiB |
| `search_files` | 自动 | 最多 100 条结果 |
| `write_file` | 询问 | 只能写入已选择工作区 |
| `delete_file` | 询问 | 只删除工作区内非符号链接普通文件 |
| `run_command` | 询问 | 工作目录固定为工作区，120 秒超时 |
| `delegate_task` | 询问 | 干净仓库的隔离工作树，最多 8 个子回合，无 shell |
| `apply_subagent_patch` | 询问 | 第二次批准；相同 HEAD、干净主树、补丁无冲突 |
| `mcp_*` | 询问 | Agent 模式专用，120 秒超时，输出最多 120,000 字符 |
| `read_skill` | 自动 | 仅启用 Skill，目录内 UTF-8 文件，输出最多 120,000 字符 |
| `get_goal` / `update_goal` | 自动 | 只读状态或本地状态迁移，不扩大工作区权限 |

规划模式只向模型公布前三个只读工具。问答模式不公布任何工具。

## 工作区边界

所有文件路径必须是相对路径，拒绝绝对路径、父目录组件和 Windows 路径前缀。已有路径经过
canonicalize 后必须以工作区 canonical path 开头；新文件则验证最近的已存在父目录。

该边界防止模型通过 `../` 或符号链接逃出用户选定项目。命令执行仍具备完整 shell 能力，
因此必须由用户逐轮批准；后续版本会加入持久化规则和 sandbox profile。

## 密钥边界

Provider 元数据保存在 WebView 的 localStorage，但 API Key 通过 Rust `keyring` crate 写入：

- Windows Credential Manager
- macOS Keychain
- Linux Secret Service

模型请求完全在 Rust 进程中组装。前端只能查询某连接“是否已有密钥”，无法读取密钥明文。
错误输出不会包含请求头。

MCP 服务器的公开配置保存在 SQLite。敏感环境变量和 HTTP 请求头作为每服务器独立 JSON
凭据写入同一系统凭据库；IPC 列表只返回敏感键名。编辑时留空会保留原值，移除键名才会
删除对应凭据。MCP 工具 schema 在 Rust 中转换并限制为每服务器 128 个、全回合 256 个。

## 数据边界

`0.12.0` 使用应用数据目录中的 SQLite 保存 Thread、Message、Provider 元数据与当前选择、MCP Server、Goal、Provider 健康状态、Instructions 与请求元数据，启用 WAL、外键和事务。旧版 WebView Provider localStorage 在首次成功写入 SQLite 后清除；API Key 不进入 SQLite。
旧版 WebView 会话会在数据库为空时导入一次，随后清除旧数据。Schema v2 还保存每轮网关
`request-id`，Schema v3 增加 MCP 配置，Schema v4 增加 Skill 启用偏好；用于关联 LevelUpAPI
请求日志。Schema v5 增加 Goal 和隐藏内部消息，Schema v6 增加 Provider 连续失败、冷却期限、
请求/接管计数与滚动延迟。Schema v7 增加 Instructions，Schema v8 增加附件元数据，Schema v9
增加不含正文的 Provider 请求日志；当前 Schema v12 增加独立的写作项目表与更新时间索引。
Skill 正文与图片二进制不进入数据库。持久化遵循以下原则：

- Thread 与 Message 分表并有稳定 ID；工具调用作为 Message 的结构化字段保存。
- 工具输入和输出可单独设置保留期限。
- 删除任务必须删除关联工具结果。
- 导出默认移除密钥、环境变量和已识别凭据。

## 配置迁移边界

扫描器只读取 `~/.codex`、`~/.claude`、`~/.gemini`、`~/.config/opencode/opencode.json`
和 `~/.cc-switch/cc-switch.db`。
前端只收到连接名称、端点、模型、协议和“是否存在密钥”；API Key 不进入 IPC 扫描结果。
用户确认单项导入后，Rust 重新扫描该候选并直接把密钥写入系统凭据库。导入不会修改原应用
配置。写回 Codex、Claude Code、Gemini CLI 或 OpenCode 是独立的显式操作：Rust 生成不含密钥的字段级
diff 和 10 分钟确认令牌；确认后在目标目录暂存并刷盘，把原文件改名为带时间戳和随机 ID 的
备份，再激活新文件。回滚 ID 只接受受限 ASCII，目标路径由后端固定推导，前端不能指定任意路径。

## Provider 高可用

每轮请求先尝试用户当前选择的连接。最多 7 个已启用备用连接按数字优先级升序排列并按 ID
去重；处于冷却期的备用连接被跳过，主连接即使此前失败也始终先试。连接/超时、401/403、404、
408/409、429、5xx、无效响应和无效 Base URL 可以触发切换；400、422、用户取消和已经产生
流式输出的请求不会切换。连续失败冷却从 30 秒指数增长到最多 15 分钟，成功后清零。

主页余额胶囊调用与设置页诊断相同的 Rust 命令；API Key 只由凭据库加载并在 Rust 中发送到当前
Provider 的 `/v1/usage?days=30`。前端只接收结构化响应，依次解析 `balance`、`remaining` 与
`quota.remaining`，切换 Provider 时取消旧结果归属，每 60 秒刷新且允许用户手动刷新。

## Instructions 与多模态边界

全局 Instructions 最多 32,000 字符，存入 `app_settings` 并由 Rust 在每轮调用前覆盖 IPC 中同名
字段，前端不能为单次请求注入未保存的隐藏指令。同步外部 CLI 仍使用 10 分钟确认令牌、同目录
暂存、备份和受限回滚 ID。

用户通过系统文件选择器、会话输入框 Ctrl+V 或窗口拖放导入附件。Rust 校验普通文件：图片支持 PNG/JPEG/WebP/GIF 魔数、20 MiB
单图、每消息 8 张和每请求 32 MiB；文本上下文只接受扩展白名单内的 UTF-8 文本、配置、日志与
代码文件，限制为每文件 1 MiB、每请求 4 MiB；PDF 与 OOXML 文档支持 PDF/DOCX/XLSX/PPTX，限制
为每文件 20 MiB、每消息 8 份和每请求 48 MiB。OOXML 拒绝路径逃逸、重复路径、冲突包类型、超过
4,096 个条目、单项展开超过 32 MiB 或总展开超过 96 MiB 的包。

所有附件以随机 32 位十六进制 ID 复制到应用数据目录，消息只保存 ID、名称、MIME、大小和种类。
请求前重新读取当前轮次并复验；图片 Base64、文本正文和文档提取结果只存在于当前 Rust 请求对象，
Serde 明确跳过持久化和 IPC。当前用户轮次每文件最多注入 48,000 字符、全部附件最多 120,000 字符，
超限时确定性保留 75% 头部和 25% 尾部，并附来源字节数、提取字符数、实际注入量和截断状态。
历史附件不再展开，只注入包含名称、类型和大小的保留标记；同一用户轮次的工具循环仍会继续展开
附件。所有托管内容均以 user context 注入，系统提示词要求把文件内指令视为不可信数据。

## 请求日志边界

`provider_requests` 记录 thread ID、Provider ID、模型、协议、开始时间、延迟、状态、Token、
request-id、接管序号和最多 1,000 字符错误。它不记录消息正文、图片数据、工具参数、请求头或
API Key。连接尝试、配置错误、失败、取消和成功均留下独立记录，便于解释故障转移路径。

## 签名更新边界

本地构建默认不注册 updater 插件并关闭 updater artifacts，因此不会因缺少发布公钥而崩溃，也不会
把未签名包冒充正式更新。正式 tag workflow 设置编译期开关并使用
release-only Tauri overlay 注入 HTTPS endpoint、updater 公钥和 `createUpdaterArtifacts`；私钥只从
GitHub Secret 进入构建进程。当前 tag workflow 只构建 Windows，缺少 updater 公钥、endpoint、
加密私钥或密码时在打包前失败。运行时只通过 Tauri updater 验证签名、下载并被用户显式点击后
重启，不实现任意 URL 下载或跳过签名校验。此签名不等同于 Windows Authenticode；安装包仍可能
触发 SmartScreen。

## Skill 边界

扫描器识别 LevelUpAgent、Codex、Claude、Agents 与当前工作区的兼容 Skill 目录，不跟随目录
链接，最多返回 300 个 `SKILL.md`。发现阶段只解析受限 frontmatter；无效 Skill 不能启用。
Agent 和 Plan 每回合最多注入 64 个启用 Skill 的截断元数据，正文只在模型调用只读工具时加载。
被引用文件必须是 Skill 根目录内的现有 UTF-8 普通文件，拒绝绝对路径、`..` 和符号链接逃逸。

## Goal 状态机

Goal 与普通会话分离持久化，状态为 Active、Paused、Auditing、Completed、Blocked 或 Cancelled。
每次模型响应由 Rust 记录输入/输出 Token 与回合数。前端只在 Active 或 Auditing 状态生成隐藏的
内部继续消息，并有单次 48 回合上限；达到上限后暂停，用户核对结果后可以继续。

`update_goal(complete)` 在 Active 状态只能进入 Auditing。模型必须在新回合重新核对目标需求与
权威当前状态，才能再次提交证据完成。阻塞报告按完全相同的证据累计，第三次才转为 Blocked；
用户恢复会清除阻塞计数。Goal 工具不绕过既有写文件、命令或 MCP 审批。

## 子 Agent 隔离边界

父 Agent 只能在用户选择了干净 Git 仓库根目录后请求 `delegate_task`。用户批准后，Rust 在应用数据
目录创建基于当前 HEAD 的 detached worktree。子 Agent 复用当前 Provider 与故障转移策略，但模式
固定为 `subagent`：只公布浏览、读取、搜索、写入和删除普通文件工具，不公布 shell、MCP、Skill、
Goal 或委派工具。文件操作仍受隔离工作树 canonical path 约束。

子 Agent 结束后，Rust 以 `git add -N` 加 `git diff --binary` 捕获新增、修改和删除文件，补丁超过
120,000 字符会拒绝并要求缩小任务。临时 worktree 随后立即移除；主工作树尚未改变。完整补丁作为
可展开工具结果交给用户和父 Agent 审查。只有单独的 `apply_subagent_patch` 调用再次获得用户批准，
并确认仓库根、干净状态及 HEAD 与委派时一致后，才使用 `git apply --binary` 写入未暂存变更；任何
冲突均保持待审补丁并拒绝部分应用。待审补丁只在内存保留一小时，最多 32 份。
