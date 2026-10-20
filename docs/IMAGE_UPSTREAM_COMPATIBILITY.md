# 创作空间图片请求与第三方上游兼容性核查

## 范围与结论

核查链路：MediaStudio → Rust media adapter → LevelUpAPI OpenAI Images API Key 路线 → 第三方图片上游。协议依据为用户提供的 image2pro 同步图片与编辑文档；在线页面未取得可读取的内容。未读取生产密钥，未调用收费生图接口，未确认生产账户的实际模型映射。

普通文生图和 multipart 图生图的基本格式正确。客户端原来会附加与用户描述冲突的视觉指令；字段别名则取决于上游协议，不能根据模型名一概改写。已修正本地客户端和中转源码，未部署到生产环境。

## 已修正

1. 开启 Armor Mode 的图片提示词原来会附加“单一主体”、固定背景、景深、成品美术风格等要求。现已完全移除创作空间的 Armor 注入：无论开关状态如何，图片、视频、语音、写作、星图生成节点及主题背景图都不附加破甲提示词。一键破甲仅影响会话，控制台已删除。
2. 选择尺寸时原来强制铺满画布、禁止留白和边框。现只补充输出尺寸要求，并保留用户指定的构图、留白和边框。
3. LevelUpAgent 完整保留原有 Images 参数发送逻辑，包括 gpt-image-2 与 gpt-image-2.5 的 size / quality。客户端没有新增 image2pro 识别、分支或字段转换；所有第三方协议适配只放在 LevelUpAPI。
4. 经过 LevelUpAPI 时由中转在选择最终上游之后，将比例 size 转成 aspect_ratio，将 1K/2K/4K quality 转成 resolution，且只匹配 image2pro 的精确域名。其他 API Key 上游和 OAuth 图片链路不变。JSON / multipart 均覆盖，已明确提供的 `aspect_ratio` / `ratio` 与 `resolution` / `image_size` 优先；像素尺寸和 `high` / `medium` 保持原语义。
5. 补齐界面已有的 4:3 / 3:4 在原生 Gemini 比例参数和尺寸提示中的映射。

## 格式与透传核查

| 项目 | 核查结果 |
| --- | --- |
| 文生图 | POST `/v1/images/generations`，JSON 含 model / prompt / n |
| 图生图 | 有参考图时 POST `/v1/images/edits`，通用路线使用 multipart |
| 图片内容 | 按参考图顺序发送实际文件字节，字段为重复的 `image`；非本地路径字符串 |
| 蒙版 | 独立 `mask` 文件部分，客户端限定 PNG |
| multipart Content-Type | 由 reqwest 生成 boundary；中转重建 multipart 时同步更新 Content-Type |
| 输出数量 | 界面多张输出拆成多个 `n=1` 请求，因此不违反上游单请求 n≤4 |
| 结果读取 | 同时支持 `data[].url` 和 `data[].b64_json`，也支持无扩展名图片 URL |
| 中转 API Key 路线 | 通用上游仅映射 model；image2pro 在最终上游边界转换比例/分辨率别名；保留 prompt、参考图顺序和文件字节 |

## 仍需区分的限制

- 按所贴文档，`quality` / `background` / `output_format` 不保证生效。客户端仍为支持这些字段的其他 Images 服务保留它们；选 high 不等于上游必然提高质量，也不等于更强的指令遵循。
- 客户端目前发送 `response_format=b64_json`。所贴文档建议省略或 url，且说明不会强制转码；客户端按实际响应解析两种形式，所以收到 url 不会直接当失败。
- 客户端通用参考图上限为 8 张 / 64 MiB，蒙版另有上限；第三方文档为输入图与蒙版合计 24 MB。大文件请求可能被上游拒绝，此限制尚未做按供应商区分，不能宣称所有边界都完全兼容。
- LevelUpAPI 通用 OpenAI JSON edits 解析器目前要求 `images[].image_url`，不直接接受第三方示例的 `input_image` 字符串。创作空间通用图生图使用 multipart，不经过这个不兼容分支；其他客户端照抄第三方 JSON 示例访问 LevelUpAPI 可能收到 400。
- 此结论针对 API Key 图片转发路线。OAuth 转译路线、原生 Gemini/Grok 路线及生产模型映射不能据此一概推断。
- 请求格式正确不能证明输出一定精准。当前没有同提示词、同模型、同参考图的真实上游 A/B 结果，不能将剩余偏差断言为上游降级、换模型或单纯模型能力问题。

## 验证

- Rust 媒体测试：47 项通过，包括 gpt-image-2 / gpt-image-2.5 的原始 JSON / multipart 参数、中文提示词、参考图顺序、蒙版、URL/base64 返回值。
- 前端完整检查：307 项测试通过，包含会话破甲保留、所有非会话 surface 隔离与控制台删除；TypeScript、外观检查和生产前端构建通过。
- 隔离 Tauri 桌面验证通过：系统明暗与破甲开关四种组合、创作皮肤、图片预览、720px 布局、工作台切换和重载。两个 GPT 图片模型共 8 次本地模拟生成的提示词逐字保留，未请求收费上游。记录位于 artifacts/armor-conversation-review/report.json，复现脚本为 scripts/verify-armor-conversation.mjs。
- LevelUpAPI Go 测试：`TestOpenAIImagesAPIKeyPreservesCreativeStudioContract` 覆盖两个模型、通用/image2pro 两种上游、旧字段/显式别名、JSON/multipart；另外验证明确别名优先、相似域名不触发转换、其他上游请求字节不变。

提示词清理位于客户端的 Armor 模块、创作组件及媒体适配器；字段转换仅位于 LevelUpAPI 的 backend/internal/service/openai_images_image2pro.go 和 API Key 请求构造入口。创作空间皮肤保留，控制台及生成指令注入已移除。自定义 image2pro 代理域名不会自动匹配。该适配需要部署新的 LevelUpAPI 才会生效。
