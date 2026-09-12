# 模型头像生成提示词

本批 11 张头像已由用户生成并接入。原图保存在 `assets/avatar-sources`，使用 Lanczos 重采样导出为 `public/avatars` 下的 256×256 PNG。以下提示词保留用于后续更新。

把生成结果放到 `G:\Work\LevelUpAgent\LevelUpAgent\public\avatars`。不要只放进 `dist/avatars`，该目录会在构建时重建。开发模式刷新即可加载；发布前运行 `pnpm build`。建议最终图片为 256×256 PNG。

现有 `openai.png`、`anthropic.png`、`gemini.png`、`grok.png`、`antigravity.png` 保持不变。新增模型按家族共用头像，无需为每个版本单独生成。图片缺失时显示应用图标。

## 使用方式

每次生成一张：上传一张现有头像作为画风参考，再上传对应平台的官方 Logo 作为标识参考。把下面的通用提示词与该模型的专属提示词拼接使用。Logo 附图比只描述品牌名更可靠，尤其是 GLM、MiniMax、混元和 OpenCode。

## 通用提示词

参考 public/avatars/openai.png 和 anthropic.png 的画风，绘制一张精致日系动漫少女头像。角色为成年年轻女性，头肩近景，居中构图，脸部占画面主要区域，头顶完整，留少量边距。细腻清晰线稿，柔和赛璐璐上色，有光泽的头发，明亮眼睛，温柔自信的微笑，浅色未来感立领服装，背景为干净浅色圆形光环。同系列美术风格，但角色长相、发型与配色各不相同；缩小到 36×36 像素仍能辨识。把提供的官方 Logo 参考图变成一枚清晰的发饰或胸针，保留其标志性轮廓、比例和品牌主色，不把品牌名称铺满背景。只画一位角色，不拼图，不加水印、标题、边框或额外文字。方形构图，生成 1024×1024 PNG，最终导出 256×256 PNG。

## 文件名与模型映射

| 文件名 | 对应模型 |
| --- | --- |
| `deepseek.png` | DeepSeek V4 / V3 / R1 |
| `qwen.png` | Qwen3.8 / Qwen3 / QwQ |
| `glm.png` | GLM-5.3 / GLM-5 / GLM-4 |
| `kimi.png` | Kimi K3 / K2、Moonshot |
| `minimax.png` | MiniMax M3 / M2.7 / M2.5 |
| `mistral.png` | Mistral、Mixtral、Codestral、Devstral、Ministral、Magistral |
| `llama.png` | Llama 4 / Llama 3 |
| `mimo.png` | MiMo V2.5 / V2.5 Pro |
| `hunyuan.png` | HY3、Hunyuan |
| `muse.png` | Muse Spark |
| `opencode.png` | 无法识别具体模型家族的 OpenCode Go 模型 |

同一家族经 OpenCode 等聚合平台调用时仍使用模型头像；旧消息也会按模型名重新识别。Antigravity 仍可用于没有可识别模型名、但保留了该平台身份的消息。

## 各模型专属提示词

### DeepSeek — `deepseek.png`

深海蓝长发，蓝宝石色眼睛，蓝白配色，浅蓝圆环背景。侧发夹采用 DeepSeek 蓝色鲸鱼 Logo 的轮廓，保留鲸鱼身形与上扬尾鳍，标识简洁清楚。

### Qwen / 通义千问 — `qwen.png`

深紫色侧编发，淡紫眼睛，紫罗兰与白色服装，淡紫圆环背景。发夹采用 Qwen / 通义千问官方紫色交织几何花结标志，保留其多瓣、交错、旋转对称的轮廓；以你提供的官方 Logo 参考图为准。

### GLM / 智谱 — `glm.png`

银蓝色利落短发，钴蓝色眼睛，深蓝与白色服装，冰蓝圆环背景。佩戴智谱 GLM 官方 Logo 胸针，准确沿用你提供的智谱 Logo 参考图中的几何轮廓和蓝色；若参考图只有字标，可把简短 GLM 字标做成小胸牌，不自行编造图标。

### Kimi / Moonshot — `kimi.png`

黑色长发带靛蓝光泽，紫蓝眼睛，黑白与浅紫配色，月白圆环背景。发饰采用 Kimi 官方 K 形标志，保留参考 Logo 的黑白对比、笔画结构和轮廓；可加极小的新月装饰，但 K 标志必须是主体。

### MiniMax — `minimax.png`

栗棕高马尾，琥珀色眼睛，珊瑚红与白色服装，浅粉圆环背景。佩戴 MiniMax 官方图形 Logo 发饰，保留参考图的品牌色与标志性笔画、几何结构；不要用随意的双竖线替代真实 Logo。

### Mistral — `mistral.png`

铜橙色短发，榛色眼睛，橙黄渐层配色，暖杏色圆环背景。发饰采用 Mistral AI 标志性的像素阶梯 M 标志，清楚保留橙黄红色像素方块与黑色局部轮廓，像一枚精致像素徽章。

### Llama / Meta — `llama.png`

灰棕色柔软波浪发，天空蓝眼睛，蓝白配色，浅蓝圆环背景。发饰采用 Meta 官方蓝色无限环 Logo，保留标志性的连续双环曲线；衣领可带一个小羊驼剪影装饰来强调 Llama 模型身份，主体 Logo 仍为 Meta 无限环。

### MiMo / 小米 — `mimo.png`

暖深棕短发与轻薄刘海，蜂蜜色眼睛，橘白配色，奶油橙圆环背景。发饰采用 Xiaomi 小米的橙色圆角方形 Logo，保留白色 mi 标志性笔画，做成小巧珐琅徽章；代表 Xiaomi MiMo。

### Hunyuan / 腾讯混元 — `hunyuan.png`

青黑色长发扎低侧马尾，青绿色眼睛，蓝青与白色服装，淡青圆环背景。发饰或胸针采用腾讯混元 Hunyuan 的官方图形 Logo，严格跟随提供的参考图保留图形、比例和蓝色层次，不用通用轨道图标代替；对应 hy3 与 hunyuan 模型。

### Muse / Meta — `muse.png`

珍珠金柔长发，淡蓝眼睛，天蓝与香槟白配色，浅金蓝圆环背景。发饰采用 Meta 官方蓝色无限环 Logo；在发饰旁加一枚很小的星光装饰，表现 Muse Spark 的火花意象，与 Llama 少女保持不同发型、眼神和配色。

### OpenCode Go — `opencode.png`

石墨灰短发，局部银白挑染，灰蓝眼睛，黑白与浅银配色，浅灰圆环背景。发饰采用 OpenCode 官方黑白几何标志，依据提供的 Logo 参考准确保留轮廓和负空间，做成极简金属徽章；不要用随意的代码尖括号代替真实标志。
