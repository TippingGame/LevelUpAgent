# LevelUpAgent 1.0.17 版本说明

## 多连接模型路由

- 可同时保存多组 Base URL 与独立 API Key，密钥继续只存放在系统凭据库。
- 模型发现与生成协议解耦；每个连接独立检查标准 `/v1/models` 与 Gemini `/v1beta/models`，再合并模型能力和可用协议。
- 同一模型可保留多条“连接 + 模型 + 协议”路由，原生 Gemini 生成不会再受主会话默认 Responses 协议限制。

## 创作空间

- 图片、视频与语音目录跨全部可用连接聚合，并分别记住所选路由。
- Gemini 图片、Imagen、Veo 与 Gemini TTS 在可用时优先选择原生 GenerateContent 路由。
- 写作空间可独立选择任意连接的文字模型路由，不再强制跟随主会话模型。

## Gemini 当前模型

- 连接检测优先推荐 `gemini-3.6-flash`。
- `gemini-3.5-flash-lite` 与 `gemini-3.1-flash-lite` 作为低成本文字模型回退。
- Nano Banana 2 Lite（`gemini-3.1-flash-lite-image`）自动归入原生 Gemini 图片模型，并明确排在完整版 `gemini-3.1-flash-image` 之后。
- 文字模型选择与写作空间共用同一媒体模型过滤规则，图片模型不会被误选为默认文字模型。

## 兼容性

- Base URL 以 `/v1` 结尾时，Gemini 模型发现和生成会切换到同级 `/v1beta`，避免请求落到错误的 `/v1/models/{model}` 路径。
- OpenAI-compatible 图片、Sora 与 TTS 路由保持不变。
- 数据库 schema 未升级，现有会话、写作项目和媒体历史无需迁移。
