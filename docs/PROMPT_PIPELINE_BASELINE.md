# 提示词处理链路基线

本文记录 LevelUpAgent 在提示词优化改造前的真实实现，作为后续设计、开发和回归对照基线。

## 基线信息

| 项目 | 值 |
| --- | --- |
| 记录日期 | 2026-07-20 |
| 应用版本 | 1.0.6 |
| Git 分支 | `develop` |
| Git 提交 | `fd5b75d3abfbe9e7428b3c892d8a849e2823a320` |
| 调查范围 | 主对话输入、系统提示词、上下文治理、附件、Skills、MCP、Goal、工具循环、四协议适配、媒体提示词 |
| 基线结论 | 当前没有独立的用户提示词语义优化或重写阶段 |

## 核心结论

用户输入只在前端执行 `trim()`，之后作为 `user` 消息原样进入会话历史。当前所谓的提示词处理主要由以下机制组成：

1. 系统提示词拼装。
2. 会话历史裁剪与工具调用配对保护。
3. 附件解析和不可信上下文封装。
4. Instructions、Skills、Goal 和工具定义注入。
5. OpenAI Responses、OpenAI Chat、Anthropic、Gemini 四协议格式转换。
6. 工具结果回灌后的多轮循环。

系统目前不会先把用户输入转换成结构化任务，也不会自动补全目标、约束、交付物、验收标准或待确认问题。

## 端到端链路

```mermaid
flowchart LR
    A["用户输入"] --> B["trim 并创建 user 消息"]
    B --> C["完整会话历史经 Tauri IPC 提交"]
    C --> D["Rust 注入运行时上下文"]
    D --> E["历史裁剪和工具组完整性检查"]
    E --> F["拼装统一系统提示词"]
    F --> G["转换为 Provider 协议请求"]
    G --> H["模型返回文本或工具调用"]
    H --> I["工具执行或等待批准"]
    I --> J["结果作为 tool 消息加入历史"]
    J --> E
```

### 1. 用户输入

入口位于 `src/App.tsx:973`：

```ts
const value = draft.trim();
const user = message("user", value, { attachments: draftAttachments });
```

当前行为：

- 去除开头和结尾空白。
- 没有最大长度的前端提示或校验。
- 没有提示词重写、分类、澄清或任务规划阶段。
- 原始文本进入 SQLite 会话历史。
- 只有附件时允许用户文本为空。

### 2. IPC 请求

`src/lib/bridge.ts:222` 将消息转换为 Rust 所需结构：

```text
role
content
toolCalls
toolCallId
internal
attachments
```

消息 ID、创建时间、展示模型、耗时和 UI 错误状态不会发送给模型处理层。

### 3. Rust 运行时注入

流式入口位于 `src-tauri/src/lib.rs:1146`。每轮按以下顺序处理：

1. `attach_default_workspace`
2. `attach_images`
3. `attach_custom_instructions`
4. `attach_goal`
5. `attach_subagent_tools`
6. `attach_media_tools`
7. `attach_skills`
8. `attach_mcp_tools`

无项目会话会自动获得应用临时工作区，因此正常桌面调用通常都会有 workspace。

### 4. 上下文治理

核心实现在 `src-tauri/src/agent.rs:1073`。

| 项目 | 当前限制 |
| --- | ---: |
| 请求历史总字符 | 240,000 |
| 请求历史消息数 | 160 |
| 单条用户消息 | 64,000 字符 |
| 单条 Assistant 消息 | 32,000 字符 |
| 单条工具结果 | 12,000 字符 |
| 单个历史工具参数对象 | 8,000 字符 |

处理规则：

- 最后一个 `user` 消息所在单元强制保留。
- 其余历史从最近到最旧选择。
- 超长正文确定性保留约 75% 头部和 25% 尾部。
- 超长工具参数替换成预览和关键字段摘要。
- Assistant 工具调用与紧随其后的全部匹配工具结果组成不可拆分单元。
- 缺少结果、重复结果或孤立工具结果的单元整体排除。
- 省略和截断只发生在请求副本，SQLite 历史保持完整。
- 省略统计会进入系统提示词，要求模型不要假装读过缺失内容。

实现细节：`message_char_cost` 当前会把附件 Base64 计入字符成本，但架构文档写的是图片二进制不计入文本字符预算。并且当前用户单元会先被强制选中，可能使实际请求超过 240,000 字符名义上限。这是代码与文档之间需要后续统一的边界。

### 5. 系统提示词

基础提示词定义在 `src-tauri/src/agent.rs:15`：

```text
You are LevelUpAgent, a precise local development agent. Work only inside the selected workspace. Inspect before editing, keep changes focused, explain consequential decisions, and never claim a tool action succeeded until its result is returned. Use tools whenever local evidence is needed.
```

`system_prompt_with_omission` 在 `src-tauri/src/agent.rs:1324` 按以下顺序继续拼接：

1. 基础提示词。
2. 选中的 workspace 路径。
3. 全局 `User-defined Instructions`。
4. 附件和提取文档的不可信数据声明。
5. 上下文省略与截断声明。
6. 已启用 Skill 的名称、ID 和描述。
7. Goal 目标、状态、轮数、Token 使用量和审计要求。

当前没有显式的指令优先级说明，也没有独立的模式提示词、权限提示词或结构化任务合同。

### 6. 运行模式

| 模式 | 模型可见能力 | 额外系统提示词 |
| --- | --- | --- |
| `chat` | 不提供工具 | 无模式专用说明 |
| `plan` | `list_files`、`read_file`、`search_files` 和只读动态工具 | 无模式专用说明 |
| `agent` | 本地文件、命令、媒体、子 Agent、Skills、MCP | 无模式专用说明 |
| `goal` | Agent 工具、Goal 工具和自动续跑 | 注入 Goal 状态与审计要求 |

四种模式共用同一个基础系统提示词。`chat` 模式没有工具，但系统提示词仍要求在需要本地证据时使用工具；`plan` 模式的只读边界主要由工具过滤保证，而不是由模式提示词解释。

权限等级 `request`、`agent`、`full` 只存在于前端审批逻辑，没有进入 `AgentTurnRequest`，模型不知道当前实际审批策略。

### 7. Instructions

全局 Instructions 最多 32,000 字符，保存在 SQLite `app_settings` 中。Rust 在每轮请求前读取并覆盖 IPC 中的同名字段，因此前端不能为单轮请求临时注入隐藏 Instructions。

Instructions 作为同一条系统提示词的一部分，位于基础身份和 workspace 之后。当前没有：

- 项目级 Instructions 分层。
- 指令来源和优先级标注。
- 冲突检测。
- 针对模式的启用范围。

项目中的 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 当前只用于外部 CLI 写回，不会在 LevelUpAgent 运行时自动发现并注入。

### 8. Skills 和 MCP

Skills：

- 最多扫描 300 个 Skill。
- 每轮最多向系统提示词列出 64 个已启用且有效的 Skill 摘要。
- 每个描述最多注入 500 字符。
- Skill 正文不自动注入，由模型调用 `read_skill` 按需读取。
- 是否需要读取 Skill 由模型根据摘要自行判断，没有宿主侧强制路由。

MCP：

- 只在 `agent` 和 `goal` 模式连接和注入。
- 每个服务最多暴露 128 个工具。
- `available_tools` 总量以 256 为软上限。
- 单个 schema 最大 48 KiB，描述最大 2,000 字符。
- 工具 schema、系统提示词和附件开销没有进入统一 Token 预算。

### 9. 附件

附件处理入口位于 `src-tauri/src/attachment.rs:233`。

当前用户轮次：

- 每条消息最多 12 个附件。
- 最多 8 张图片、8 份文档。
- 文本或文档每文件最多注入 48,000 字符。
- 所有文本和文档合计最多注入 120,000 字符。
- 图片重新读取、校验并编码为 Base64。
- 文本、PDF 和 Office 文档在本地提取后封装成 `<managed_context_file>`。

历史用户轮次：

- 不再发送完整附件内容。
- 只发送 `historical_reference_omitted` 元数据标记。
- 同一用户轮次的工具循环仍会继续展开当前附件。

系统提示词明确声明附件内容是不可信数据，但通过 `read_file`、`run_command` 或 MCP 获得的工具结果没有同等级的统一提示注入防护说明。

### 10. 四协议映射

协议请求体位于 `src-tauri/src/agent.rs:758`。

| 协议 | 系统提示词字段 | 历史字段 | 工具字段 |
| --- | --- | --- | --- |
| OpenAI Responses | `instructions` | `input` | Responses function tools |
| OpenAI Chat | 首条 `system` message | `messages` | Chat function tools |
| Anthropic Messages | `system` | `messages` | Anthropic tools |
| Gemini GenerateContent | `systemInstruction` | `contents` | `functionDeclarations` |

四个适配器都调用同一个上下文治理和系统提示词函数，协议差异只存在于序列化层。

### 11. 工具循环

模型返回工具调用后，前端按权限执行或请求用户批准，然后把结果作为 `tool` 消息加入历史并再次请求模型。

| 模式 | 最大连续轮数 |
| --- | ---: |
| 普通模式 | 12 |
| Goal | 48 |

Goal 在模型没有发出工具调用但目标仍处于 `active` 或 `auditing` 时，会添加隐藏的内部 `user` 续跑消息。`internal` 字段只控制 UI 隐藏和持久化，协议适配器仍将其作为普通 `user` 消息发送。

工具执行错误的 `isError` 目前只用于前端显示，没有进入 Rust `AgentMessage`。模型只能根据工具结果文本判断调用是否失败。

### 12. Provider 故障转移

主连接失败时，同一个逻辑请求会复制给备用 Provider，再按目标 Provider 的协议重新序列化。已经开始流式输出后不会切换 Provider，以避免将两个模型的内容拼接在一起。

故障转移不执行额外提示词改写。

## 独立媒体提示词路径

Media Studio 和 Agent 的媒体工具最终进入 `src-tauri/src/media.rs`，这条路径与主对话模型提示词不同。

当前行为：

- 所有媒体提示词先执行 `trim()`。
- 最大长度为 32,000 字符。
- 图片提示词会由 `effective_image_prompt` 追加尺寸、比例、铺满画布和禁止留白的硬约束。
- Gemini 图片同时使用原生 `aspectRatio` 和 `imageSize` 配置。
- 视频提示词主要原样提交，并通过 Provider 参数传递比例和时长。
- 语音提示词主要作为待朗读文本提交，另有可选 delivery instructions。
- 没有通用的媒体提示词语义增强器。

## 已有优势

1. 四协议共享统一消息模型和提示词来源。
2. 长历史治理确定且不会修改持久化原文。
3. 工具调用和结果成组保留，避免非法协议历史。
4. 当前附件重新校验，历史附件不会每轮重复膨胀。
5. 附件有明确的不可信数据声明。
6. Skill 正文按需加载，避免无关上下文常驻。
7. Goal 有完成审计和阻塞审计，而不是只依赖模型口头声明。
8. Provider 日志不保存提示词正文、图片内容、工具参数或密钥。

## 已知缺口

### P0：缺少提示词编译层

系统没有从用户原文派生结构化任务表示。模糊目标、多目标、隐含约束、缺少验收标准等问题完全交给主模型即时处理，无法观察或复用处理结果。

### P0：模式策略没有进入提示词

模式差异主要由工具暴露控制。基础提示词没有明确告知模型当前是问答、规划还是执行模式，也没有说明当前审批权限。

### P0：工具结果的提示注入边界不足

附件被声明为不可信，但文件读取、命令输出、网页或 MCP 结果没有统一的来源标签和不可执行指令策略。

### P1：缺少项目级指令发现与优先级

运行时不自动加载项目 `AGENTS.md` 等指令文件，也没有产品规则、用户规则、项目规则、Skill 和 Goal 之间的冲突处理模型。

### P1：上下文预算不是模型感知的 Token 预算

固定字符预算不能准确适配中文、代码、不同模型 tokenizer、工具 schema、系统提示词和多模态开销。

### P1：工具目录没有按任务筛选

Agent 和 Goal 可能把大量本地、媒体、Skill 和 MCP 工具同时发送给模型，增加 Token 消耗和误调用概率。

### P1：缺少最终提示词可观测性

请求日志只保存 Provider、模型、延迟、Token、request ID 和错误，不保存也不提供脱敏后的提示词组成预览。

### P1：缺少语义评测

现有测试覆盖协议结构、附件编码、上下文裁剪、Instructions、Skills 和 Goal 字段，但没有评估模型是否正确理解模式、目标、约束和验收标准。

### P2：截断对用户不可见

超过 64,000 字符的用户消息会在请求副本中删除中间内容，但 UI 不提示用户本轮实际发送了哪些部分。

### P2：内部续跑消息与用户消息同级

Goal 隐藏续跑提示以 `user` 角色发送，没有单独的来源或应用控制层。

### P2：工具错误缺少结构化标记

工具失败状态没有进入四协议消息，只依赖错误文本表达。

## 后续优化建议的数据结构

建议保留用户原文，不做不可见的覆盖式重写，并在模型调用前生成可审计的编译结果：

```text
CompiledTurn
  raw_user_input
  task_contract
    objective
    constraints
    deliverables
    acceptance_criteria
    ambiguities
  execution_policy
    mode
    permission_level
    workspace
    allowed_actions
  instruction_layers
    product
    user
    project
    skills
    goal
  trust_boundaries
  context_manifest
  selected_tools
  rendered_protocol_request
```

这样可以在不篡改用户表达的前提下，稳定补充任务结构、模式策略和上下文说明，并支持调试、回归和协议一致性测试。

## 优化后对照清单

后续每次提示词改造可以基于本表更新结果：

| 对照项 | 当前基线 | 优化后记录 |
| --- | --- | --- |
| 用户原文是否保留 | 是，持久化原文完整 | 待填写 |
| 是否有结构化任务合同 | 否 | 待填写 |
| 是否有模式专用提示词 | Goal 部分有，其余无 | 待填写 |
| 模型是否知道权限等级 | 否 | 待填写 |
| 是否自动加载项目指令 | 否 | 待填写 |
| 是否有指令优先级 | 否 | 待填写 |
| 是否按任务筛选工具 | 否 | 待填写 |
| 是否使用模型感知 Token 预算 | 否 | 待填写 |
| 系统和工具 schema 是否计入预算 | 否 | 待填写 |
| 工具结果是否统一标记不可信 | 否 | 待填写 |
| 工具错误是否结构化 | 否 | 待填写 |
| 是否可预览最终编译提示词 | 否 | 待填写 |
| 是否有语义提示词评测集 | 否 | 待填写 |
| 四协议是否共享同一逻辑表示 | 是 | 待填写 |
| 长历史是否保持工具组完整 | 是 | 待填写 |
| SQLite 原始历史是否保持完整 | 是 | 待填写 |

## 关键代码索引

| 位置 | 作用 |
| --- | --- |
| `src/App.tsx:768` | Agent 多轮执行循环 |
| `src/App.tsx:973` | 用户发送入口 |
| `src/App.tsx:193` | 前端工具审批策略 |
| `src/lib/bridge.ts:222` | 流式 Agent IPC 请求 |
| `src-tauri/src/lib.rs:1146` | Rust 流式命令入口和上下文注入 |
| `src-tauri/src/agent.rs:15` | 基础系统提示词 |
| `src-tauri/src/agent.rs:758` | 四协议请求体构造 |
| `src-tauri/src/agent.rs:1073` | 上下文选择和裁剪 |
| `src-tauri/src/agent.rs:1324` | 系统提示词拼装 |
| `src-tauri/src/agent.rs:1398` | 通用消息到四协议消息映射 |
| `src-tauri/src/agent.rs:1646` | 内置工具定义 |
| `src-tauri/src/agent.rs:1693` | 按模式过滤工具 |
| `src-tauri/src/attachment.rs:233` | 当前和历史附件解析 |
| `src-tauri/src/skill.rs:28` | Skill 发现 |
| `src-tauri/src/mcp.rs:70` | MCP 工具发现和暴露 |
| `src-tauri/src/media.rs:1798` | 图片有效提示词增强 |
| `docs/ARCHITECTURE.md:42` | 通用消息和上下文架构说明 |

## 验证状态

- 本次调查未修改运行代码。
- 调查时 Git 工作区为干净状态。
- 已静态检查现有 Rust 单元测试覆盖范围。
- 当前执行环境没有 `cargo`，未实际运行 Rust 测试。
