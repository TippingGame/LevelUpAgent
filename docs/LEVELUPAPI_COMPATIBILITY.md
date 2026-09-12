# LevelUpAPI 四协议与 OpenCode Go 自动路由兼容性证据

审计日期：2026-07-12。适配目标为 `G:\Work\levelup2api\LevelUpAPI`，审计提交
`c3b6cf6d6f21`（LevelUpAPI `1.1.217`），测试期间保持只读且工作树干净。

## 路由映射

| LevelUpAgent 协议 | 请求 | LevelUpAPI 网关路由 |
| --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses 自动平台路由 |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Chat Completions 自动平台路由 |
| Anthropic Messages | `POST /v1/messages` | Messages 网关 |
| Gemini GenerateContent | `POST /v1beta/models/{model}:generateContent` | Gemini 原生兼容层 |
| OpenCode Go（自动） | 按模型选择上述 Responses / Chat / Messages | OpenCode 分组或官方 Go 上游 |

Rust 契约测试 `levelup_api_four_protocol_request_contracts` 使用真实 HTTP socket 捕获四种 adapter
发出的路径、Bearer/API Key 头和 JSON body，并用各协议响应结构完成解析。LevelUpAPI 侧的
`internal/handler` 与 `internal/server/routes` unit suites 验证上述网关处理器和路由注册。

2026-08-21 增量契约把 OpenCode Go 作为配置层路由器接入：`grok-4.5`、`gpt-5.6-luna` 与
`muse-spark-1.2-contributor` 发送到 `/v1/responses`，GLM/Kimi/DeepSeek/MiMo/HY 发送到 `/v1/chat/completions`，
MiniMax/Qwen3 发送到 `/v1/messages`。`opencode_go_auto_route_and_reasoning_request_contracts`
使用真实本地 socket 同时校验三条路径、规范化后的模型 ID、认证头、响应解析和模型级思考强度过滤；
`reasoning_effort_serializes_only_supported_model_levels` 与
`reasoning_effort_capabilities_are_model_specific` 覆盖模型切换回退及四种 wire adapter，未公布可调
档位的 OpenCode Go 模型不会继承另一协议族的档位。

一条命令可重复运行双方证据：

```powershell
pnpm verify:levelupapi
```

本次结果：LevelUpAPI handler 与 routes 通过，LevelUpAgent 四协议 HTTP 契约通过。另行运行的
LevelUpAPI 全量 `internal/server` 契约有三个既有失败：usage stats stub 返回 `not implemented`，以及
后台 settings 快照未同步新增字段/默认值。这些失败不在 LevelUpAgent 仓库中修改，也不涉及四条模型
网关路由。

## 运行时边界

- Base URL 只接受不含 URL 凭据、query 或 fragment 的 HTTP(S) 地址。
- Gemini 模型名只接受 ASCII 字母数字、`-`、`_`、`.`，防止路径注入。
- Responses、Chat、Messages 使用 Bearer；Messages 同时发送 `x-api-key` 和固定
  `anthropic-version`；Gemini 同时发送 `x-goog-api-key` 和 Bearer，兼容 LevelUpAPI 鉴权层。
- `/health` 从 service root 读取，`/v1/usage?days=30` 和模型请求保留 request-id 诊断。

## 2026-09-12 平台与模型更新

MiniMax 平台支持 Responses、Chat Completions、Anthropic Messages。Composite 是 LevelUpAPI 的
分组路由，支持这三种入口以及 Gemini GenerateContent；具体模型必须有对应的分组路由与可用账号。
协议标签使用 LevelUpAPI `frontend/src/utils/platformColors.ts` 的配色，覆盖浅色、系统深色和 Armor Mode。

模型发现仍仅从返回列表中选择，不构造不存在的模型，也不改写已保存连接的模型。

| 模型族 | 优先模型 | 核对来源 |
| --- | --- | --- |
| OpenAI | `gpt-6-astra` | 用户指定；[模型页](https://developers.openai.com/api/docs/models/gpt-6-astra) |
| GLM | `glm-5.3-flash` | 用户指定 |
| Gemini | `gemini-3.8-flash` | 用户指定 |
| DeepSeek | `deepseek-v4-pro` | 用户指定；[模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) |
| MiniMax | `MiniMax-M3` | [模型调用](https://platform.minimax.io/docs/guides/text-generation) |
| Kimi | `kimi-k3` | [Kimi API 平台](https://platform.moonshot.ai) |
| Qwen | `qwen3.8-max` | [阿里云模型列表](https://help.aliyun.com/zh/model-studio/models) |
| Claude | `claude-fable-5-1` | [Fable 模型页](https://www.anthropic.com/claude/fable) |
| Mistral | `mistral-medium-3-5` | [模型页](https://docs.mistral.ai/models/mistral-medium-3-5-26-04) |
| Grok | `grok-4.6`（保留） | [模型列表](https://docs.x.ai/developers/models) |
| Llama | Llama 4 Maverick（保留） | [Meta 官方模型库](https://github.com/meta-llama/llama-models) |
| OpenCode Go | `gpt-5.6-luna`（保留） | 沿用既有 Go 专属模型目录 |

思考选择按具体模型与协议决定，Composite 不另造一套统一档位：

- DeepSeek V4 与 `deepseek-flash`：自动、关闭、低、高、最大。Chat / Messages 的关闭使用
  `thinking.type=disabled`，开启使用 `enabled` 并分别传 `reasoning_effort` / `output_config.effort`；
  Responses 使用 `reasoning.effort=none/low/high/max`。
- MiniMax M3：自动、关闭、自适应。Chat / Messages 使用 `thinking.type=disabled/adaptive`；
  Responses 使用 `reasoning.effort=none/high`。官网明确非 none 档位仅开启自适应思考，不调节深度。
  自动不传控制参数：官网 Chat 默认开启，Messages / Responses 默认关闭。M2.x 不支持关闭，保留自动。
- GPT-6 Astra：自动、低、中、高、超高、最大，不发送不支持的 none/minimal。发现 Astra 时从 Chat
  默认切换 Responses，以支持工具调用；无状态 Responses 请求获取并回传加密推理项。
- OpenCode Go 未公布可调控制的其他模型仍保持自动，不假设直连厂商的参数均被 Go 网关接受。

官方契约：[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)、
[DeepSeek Responses](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)、
[MiniMax Chat](https://platform.minimax.io/docs/api-reference/text-chat-openai)、
[MiniMax Messages](https://platform.minimax.io/docs/api-reference/text-chat-anthropic)、
[MiniMax Responses](https://platform.minimax.io/docs/api-reference/responses-create)、
[MiniMax 多轮工具调用](https://platform.minimax.io/docs/guides/text-m3-function-call)。

Chat 保存并回放 `reasoning_content` / `reasoning_details`，Responses 保存并回放原生 reasoning item，
同时保留工具调用与结果的关联。原生推理数据不混入可见正文。测试覆盖流式分片、非流式解析、
工具续接以及未调用工具的历史 assistant 回合。DeepSeek 与 MiniMax 官方域名会使用各自原生路径，
LevelUpAPI / Composite 仍使用配置的网关路径。

本次验证为本地 HTTP 契约与前端测试、构建及界面检查；没有使用付费厂商 Key 做线上推理验证。
