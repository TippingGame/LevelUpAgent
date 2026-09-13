# 创作空间的 MiniMax 与 Seedance 接入

创作空间从所选连接的模型列表识别媒体模型；分组需要开放对应模型。OpenAI 图片推荐优先使用 `gpt-image-2.5-sunburst`，不会把未返回的模型添加到连接目录。

MiniMax 图片推荐 `image-01`，没有时回退到 `image-01-live`；MiniMax 视频推荐 `MiniMax-H3`，没有时回退到 `MiniMax-H3-Max`；Seedance 视频推荐 `Seedance-2.5`，没有时回退到 `Seedance-2` / `Seedance-2.0`。同时连接多个平台时，各平台仍会标记自己的推荐。自动选择优先当前连接的可用推荐；手动选定的模型仍优先，临时不可用时的回退不会覆盖保存的手选。

模型连接中的“检测模型”会从返回目录自动选择默认文字模型，MiniMax 优先 `MiniMax-M3`，没有则按 `MiniMax-M2.7`、`MiniMax-M2.5` 等顺序回退。文字下拉框和自动推荐会排除 H3、Seedance、image-01 等媒体模型。纯 Seedance 或只开放媒体的连接会显示“无可用文字模型”，默认文字模型留空也能保存，媒体模型在创作空间选择。这些连接不会用于文字聊天或文字故障转移，也不会覆盖已有可用文字连接的默认选择。

| 模型 | 接口 | 时长 | 清晰度 |
| --- | --- | --- | --- |
| `image-01`、`image-01-live` | MiniMax `POST /v1/image_generation` | 同步图片 | 按图片模型支持的尺寸和比例选择 |
| `MiniMax-H3` | `POST /v2/video_generation`，`GET /v2/query/video_generation/{task_id}` | 4–15 秒 | 768p、2K |
| `MiniMax-H3-Max` | 同上 | 5–15 秒 | 480p、768p |
| `Seedance-2`、`Seedance-2.0` | `POST /v1/videos`，任务查询及 `/content` | 4–15 秒 | 480p、720p、1080p、4K |
| `Seedance-2.5` | 同上 | 4–30 秒 | 480p、720p |

MiniMax 和 Seedance 视频均支持文生视频、首帧及首尾帧。标准 H3 支持最多 9 张参考图，Seedance 2 支持 9 张，Seedance 2.5 支持 30 张；H3-Max 没有多图参考模式。首尾帧素材按首帧、尾帧顺序排列，画面比例跟随首帧。视频、音频参考尚未在这次创作空间界面中开放。

图片生成和视频的参考图片按当前列表显示为“图 1”“图 2”等，可用每行的前移、后移按钮调整顺序；移除后后续编号顺延。首尾帧模式中“图 1”为首帧、“图 2”为尾帧，交换顺序会交换对应角色。图片地址也支持排序，空白地址须补齐或移除后才能生成，不会跳过空栏而改变图号。生成请求使用当前顺序，并向模型说明图号对应输入图片的顺序；Gemini 还会在每张图片前附上对应图号。可在提示词中写“用图 1 的人物和图 2 的背景”；调整顺序后请同步检查提示词中的图号。

连接 LevelUpAPI 时，可直接选择、拖入或粘贴本地图片。生成前，应用使用该连接的 API Key 调用 `POST /v1/media/references`，将 `file` 作为 multipart 图片上传，再把返回的公开 HTTPS 地址填入视频请求。同一请求并行生成多个视频时只上传一次素材。上传失败会停止生成并显示原因，不会忽略图片后提交文生任务。LevelUpAPI 必须部署在上游可访问的 HTTPS 域名，并能持久保存临时素材；默认素材地址有效期为 2 小时，每 5 分钟清理；单用户临时素材默认最多 1 GiB、总目录最多 5 GiB，不保存生成的视频，无需另设对象存储。缓存满时先清理过期素材，仍不足会提示个人或全站容量已满及预计等待时间；可缩小图片、使用 HTTPS 图片地址，或由管理员调整 `MEDIA_REFERENCE_USER_MAX_MIB` / `MEDIA_REFERENCE_TOTAL_MAX_MIB`，不会为新上传删除尚未过期的素材。

直接连接 MiniMax 官方域名时，本地参考图使用原生 data URI。直接连接其他没有上传接口的中转服务，可在素材来源中选择公网 HTTPS 图片地址。MiniMax 原生协议是否由中转服务支持，仍取决于该服务；LevelUpAPI 的账号媒体协议设置负责转换为安域 `/v1/videos` 等上游协议。

MiniMax 图片使用原生的文生图或人物主体参考。界面不会为这些模型提供不支持的透明背景、输出格式或蒙版编辑选项。业务错误 `base_resp.status_code` 会作为失败展示；成功图片立即下载并保存到本地历史。

视频任务保留连接归属，查询完成后下载保存结果。MiniMax 视频 CDN 下载不携带 API Key。重启应用后，已有待完成任务仍可继续查询。

协议依据：[MiniMax 图片](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)、[MiniMax H3](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[安域视频接入文档](https://x.ailzd.com/video-docs)。测试使用本地模拟 HTTP 服务，不消耗真实生成额度。
