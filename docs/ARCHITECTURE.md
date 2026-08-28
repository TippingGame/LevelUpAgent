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
          |-- Git-independent per-operation workspace snapshots
          |-- local tools
          |     |-- list/read/search (encoding-aware text boundary)
          |     |-- edit file (exact replacement, format-preserving)
          |     |-- write file (new/full replacement, format-preserving)
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

## 连接、模型发现与模型路由

连接（Connection）是稳定的配置与凭据边界：`profile ID + Base URL + 独立 API Key + 默认文字模型 + 默认协议`。
模型路由（Model Route）是一次实际调用的地址：`profile ID + model ID + protocol`。因此同一连接可提供多个模型，
同一模型也可同时提供 Responses 与 Gemini GenerateContent 等不同路由，而不需要复制或替换 API Key。

模型发现属于控制面，不属于任何生成协议。Rust 会为每个可用连接并行检查标准 `/v1/models` 与 Gemini
`/v1beta/models`；Base URL 已带 `/v1` 或 `/v1beta` 时，两个目录按同级版本路径构造，避免折叠成同一 URL。
结果按大小写不敏感的模型 ID 合并，并保留 `supportedGenerationMethods`、输入/输出模态和全部已确认协议。
连接当前配置的协议仍是文字模型的默认路由；只有原生目录独占的模型才自动切换为 GenerateContent。
执行原生 Gemini 路由时同样会把以 `/v1` 结尾的 Base URL 切换到同级 `/v1beta`，避免发现地址与生成地址不一致。

OpenCode Go 在配置层表现为 `opencode_go` 自动路由，而不是新增一套 wire serializer。调用前会去掉
`opencode-go/` 或 `opencode/` 模型前缀，再按模型族落到现有适配器：Grok 4.5、`gpt-5.6-luna` 与
Muse Spark 使用 Responses；GLM、Kimi、DeepSeek、MiMo 与 HY 使用 Chat Completions；MiniMax 与 Qwen3
使用 Messages。未知模型保守回落到 Chat Completions。目录项同时保留自动路由和解析出的真实协议，
因此 UI 能显示技术接口，配置写回也能选择正确的 AI SDK provider。

思考强度是请求级字段，不写入连接配置。选择器先按模型 ID 解析已知能力，只显示该模型支持的档位；
切换模型后若原档位不兼容会自动回退到 `Auto`。`Auto` 会省略协议字段；其余受支持档位分别映射为
Chat 的 `reasoning_effort`、Responses 的 `reasoning.effort`、Messages 的 `thinking` 预算，以及
Gemini 的 `generationConfig.thinkingConfig.thinkingBudget`。未知兼容模型不会被乐观地注入可能导致
400 的档位；故障转移时也会按最终模型再次过滤。

`get_model_catalog` 使用 Rust 从系统凭据库分别加载每个连接的密钥，并把多协议模型展开为多条模型路由；
前端只收到连接 ID、显示名、模型元数据和协议，不收到密钥。主会话使用当前连接的默认路由；写作空间
单独保存所选文字路由；媒体目录跨全部可用连接聚合模型，并在已发现 Gemini 路由时为 Gemini 图片、
Imagen、Veo 与 Gemini TTS 优先选择原生协议。图片、视频和语音分别持久化所选连接与模型；OpenAI 图片、
Sora 和 OpenAI TTS 仍使用连接的标准路由。

## 写作与游戏叙事边界

写作项目与会话分离：桌面端以 `writing_projects` 表保存版本化 JSON，Web 预览使用独立的
localStorage 回退。项目包含文稿、任意类型设定、实体关系、剧情节点、变量、快照和补全设置；
单项目后端编码上限为 16 MiB，项目 ID、类型、标题和时间戳在写入前校验。导入数据经过逐层归一化，
无效 ID、时间戳、快照和字段会被修复或丢弃，不能直接成为数据库结构。

AI 写作使用写作空间独立选择的文字模型路由，并复用既有故障转移链路，但固定使用不暴露工具的 chat 模式。每次补全只
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
| `read_file` | 自动 | 自动识别 UTF-8/UTF-16/GBK/GB18030/Big5/Shift-JIS/Windows-1252；模型侧统一 LF；单文件最多 256 KiB |
| `search_files` | 自动 | 使用同一编码边界搜索；短旧编码可传 `encoding`；最多 100 条结果 |
| `write_file` | 询问 | 新文件默认为无 BOM UTF-8/LF；已有文本文件保留检测到的编码、BOM 和主导换行风格；写入最多 1 MiB |
| `edit_file` | 询问 | 精确 `old_string` → `new_string` 替换；默认只接受唯一匹配，保留编码、BOM 和主导换行风格；同目录原子替换 |
| `delete_file` | 询问 | 只删除工作区内非符号链接普通文件 |
| `run_command` | 询问 | 默认工作目录为工作区，120 秒超时；完全访问允许命令自行使用绝对路径 |
| `delegate_task` | 询问 | 干净仓库的隔离工作树，最多 8 个子回合，无 shell |
| `apply_subagent_patch` | 询问 | 第二次批准；相同 HEAD、干净主树、补丁无冲突 |
| `mcp_*` | 询问 | Agent 模式专用，120 秒超时，输出最多 120,000 字符；服务器描述和结果按外部不可信数据处理 |
| `skill_*` / `web_*` / `browser_*` / `*_process` | 按风险 | Skill 注册表（含未启用 Skill 的显式检查）、公共网页、隔离 Chromium/CDP 和有界后台进程；后台进程是主机管理的 QA 沙箱而非 VM；只读动作自动执行，其余遵循 Harness 权限 |
| `client_action` | 自动 | 只允许共享版本化清单中的可逆客户端导航动作；后端与 React 双重校验，不能携带凭据或执行持久化写入 |
| `read_skill` | 自动 | 仅启用 Skill，目录内 UTF-8 文件，输出最多 120,000 字符 |
| `get_goal` / `update_goal` | 自动 | 只读状态或本地状态迁移，不扩大工作区权限 |

规划模式只向模型公布标记为只读的工具（包括 Skill 目录、网页检索、浏览器快照和 MCP 状态）；问答模式不公布任何工具。
完全访问会自动放行本地文件的绝对路径、命令和已知外部工具，但系统凭据和未分类的凭据敏感工具仍要求明确批准。

所有新增客户端功能都必须按 [`CLIENT_CAPABILITIES.md`](CLIENT_CAPABILITIES.md) 选择专用工具、共享 `client_action` 或显式不开放给模型，并完成 Schema、策略、执行、结果、日志与测试契约。系统提示词要求模型在当前工具目录能够完成任务时优先使用 LevelUpAgent 原生能力。

## 文件编码与编辑边界

工作区工具把“模型传输文本”和“磁盘字节”分成两个明确阶段。读取时，带 BOM 的 UTF-8/UTF-16
按 BOM 解码；没有 BOM 时先严格尝试 UTF-8，再使用 `encoding_rs` 编解码和 Mozilla `chardetng` 辅助判断
常见中文/东亚 Windows 编码（GBK、GB18030、Big5、Shift-JIS，最后才是 Windows-1252）。读取结果只把换行规范化为 LF 提供给模型，避免模型因为
CRLF 复制差异而找不到编辑上下文。

已有文件的 `edit_file` 和 `write_file` 会使用原文件的编码与 BOM 重新编码，并恢复检测到的主导换行
风格；如果 `write_file` 的规范化内容没有变化则直接保持原始字节不写回，真正写入前还会复核整份原始字节没有被并发编辑。新文件默认使用 UTF-8（无 BOM、LF；显式选择 UTF-16 时写入对应 BOM）；零字节已有文件没有可保留的编码信号，显式选择 UTF-16 后同样补写对应 BOM。目标编码无法表示新字符时直接报错，二进制、UTF-32、
损坏或无法可靠解码的文件拒绝作为文本编辑，因此不会用 `?` 或替换字符静默破坏中文。疑似二进制的
文件也会被拒绝。`edit_file`
要求精确的非空 `old_string`，默认必须唯一匹配，并在写入前重新读取字节确认文件没有被编辑器或其他
Agent 改动；内容先写入同目录临时文件、刷盘后原子替换，并尽量保留原权限。

无 BOM 的短旧编码文件在信息论上可能无法唯一判断。`read_file`、`write_file` 和 `edit_file` 都接受
可选的 `encoding`（`utf-8`、`utf-16le`、`utf-16be`、`gbk`/`gb2312`、`gb18030`、`big5`、`shift-jis`、
`windows-1252`）作为严格覆盖；覆盖与 BOM 冲突时拒绝操作，也不能把含非 ASCII 字符且已经有效的 UTF-8 文本重新解释为旧代码页。
纯 ASCII 字节在所支持的旧代码页中含义一致，因此已知工程采用 GBK 等旧编码时允许提示其项目约定，确保首次新增中文仍按该编码落盘。
GBK/Big5 中混入日文假名、只有汉字的 Shift-JIS，以及缺少明显交错 NUL 特征的无 BOM UTF-16 都会保守地要求
显式编码，不会用统计猜测直接进入写路径。

PowerShell、Python 和本地命令输出统一请求 UTF-8；如果命令仍返回旧代码页，主机沿用同一编码探测
边界解码。Git 快照和 diff 保留命令返回的原始字节，只在展示边界按当前文件编码解码；隔离子 Agent
补丁也以原始 `Vec<u8>` 暂存并直接交给 `git apply`，不会先经过替换字符。文件附件、Skill 和布局 JSON
仍遵循各自的 UTF-8 契约，不与工作区代码文件的兼容范围混用。`agent` 权限下，shell 重定向、嵌套 shell、
`Set-Content`/`Out-File` 及其常见写入别名、`git apply`、格式化器等明显可能改写文件的命令会转为需要批准，避免绕过上述
编码边界；显式批准或 `full` 权限仍由用户承担命令本身的编码责任。

## 工作区边界

所有文件路径必须是相对路径，拒绝绝对路径、父目录组件和 Windows 路径前缀。已有路径经过
canonicalize 后必须以工作区 canonical path 开头；新文件则验证最近的已存在父目录。

该边界防止模型通过 `../` 或符号链接逃出用户选定项目。命令执行仍具备完整 shell 能力，
因此必须由用户逐轮批准；后续版本会加入持久化规则和 sandbox profile。

## 本轮变更与 Git 边界

会话消息里的“本轮变更”不依赖 Git。每个有工作区的 operation 在开始和结束时调用
`get_workspace_snapshot`，由 Rust 的 `workspace` 模块扫描选定目录中的普通文件，排除 `.git`、
依赖和常见构建目录，按文件字节生成指纹，并在预算内保留可解码正文。前端对两个快照做确定性
before/after 对比，因此新增、修改和删除在普通文件夹、没有 Git 的机器上也能显示；正文无法解码、
过大或超出扫描上限的文件仍会列出，但只提示“无可显示 diff”。
对比和 diff 预算集中在 `src/lib/workspaceChanges.ts`，不与聊天组件或 Git API 互相耦合。

Git 仍是独立的可选能力：右侧项目状态、仓库 diff、带确认令牌的回滚，以及 detached worktree
子 Agent 需要 Git 的提交/索引语义。它们不会阻塞聊天、文件工具或本轮变更审查。

## 密钥边界

Provider 元数据与当前连接保存在 SQLite；Web 预览才使用 localStorage 回退。API Key 通过 Rust `keyring` crate 写入：

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
内部继续消息。Goal 没有固定回合上限，会持续到进入终态、用户暂停/取消或发生终止错误；非 Goal
Durable Harness 仍保留 64 回合保护上限。

`update_goal(complete)` 在 Active 状态只能进入 Auditing。模型必须在新回合重新核对目标需求与
权威当前状态，才能再次提交证据完成。阻塞报告按完全相同的证据累计，第三次才转为 Blocked；
用户恢复会清除阻塞计数。Goal 工具不绕过既有写文件、命令或 MCP 审批。

## 子 Agent 隔离边界

父 Agent 只能在用户选择了干净 Git 仓库根目录后请求 `delegate_task`。用户批准后，Rust 在应用数据
目录创建基于当前 HEAD 的 detached worktree。子 Agent 复用当前 Provider 与故障转移策略，但模式
固定为 `subagent`：只公布浏览、读取、搜索、写入和删除普通文件工具，不公布 shell、MCP、Skill、
Goal 或委派工具。文件操作仍受隔离工作树 canonical path 约束。

子 Agent 结束后，Rust 以 `git add -N` 加 `git diff --binary` 捕获新增、修改和删除文件，原始补丁超过
120,000 字节会拒绝并要求缩小任务。临时 worktree 随后立即移除；主工作树尚未改变。完整补丁作为
可展开工具结果交给用户和父 Agent 审查。只有单独的 `apply_subagent_patch` 调用再次获得用户批准，
并确认仓库根、干净状态及 HEAD 与委派时一致后，才使用 `git apply --binary` 写入未暂存变更；任何
冲突均保持待审补丁并拒绝部分应用。待审补丁只在内存保留一小时，最多 32 份。
