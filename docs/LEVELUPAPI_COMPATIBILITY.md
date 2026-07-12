# LevelUpAPI 四协议兼容性证据

审计日期：2026-07-12。适配目标为 `G:\Work\levelup2api\LevelUpAPI`，审计提交
`c3b6cf6d6f21`（LevelUpAPI `1.1.217`），测试期间保持只读且工作树干净。

## 路由映射

| LevelUpAgent 协议 | 请求 | LevelUpAPI 网关路由 |
| --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses 自动平台路由 |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Chat Completions 自动平台路由 |
| Anthropic Messages | `POST /v1/messages` | Messages 网关 |
| Gemini GenerateContent | `POST /v1beta/models/{model}:generateContent` | Gemini 原生兼容层 |

Rust 契约测试 `levelup_api_four_protocol_request_contracts` 使用真实 HTTP socket 捕获四种 adapter
发出的路径、Bearer/API Key 头和 JSON body，并用各协议响应结构完成解析。LevelUpAPI 侧的
`internal/handler` 与 `internal/server/routes` unit suites 验证上述网关处理器和路由注册。

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
