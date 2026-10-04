# Spine 第二版实施日志

日期：2026-10-03。目标：天蓝色工作台，以及从拆层模型输出到可编辑 Spine 的下一段流程。逐阶段记录实施和验证，不将未执行的模型推理当作通过。

## 01 · 基线与范围

- 已读取仓库指令、第一版说明及 ComfyUI-See-through 的真实输出代码。
- 保留第一版未提交改动，以及另一个 3D 研究任务的 `docs/README.md`、`docs/MODEL3D*`、`modules/` 等现有工作。
- 色彩修改是 Spine 功能页的局部样式，不创建或改动可安装主题包。
- 本版目标：天蓝配色；See-through 图层清单导入和重组预览；保留画布坐标和绘制顺序；可修正的角色/父骨骼建议；本机 ComfyUI 作业提交、持久化与恢复查询；测试和操作说明。
- 继续使用 Spine 4.2 输出。多参考关键姿态、视频插帧和动作拟合不在本版冒充完成。

## 02 · 接口核实与设计

- `ComfyUI-See-through/nodes.py::SeeThrough_SavePSD.save` 输出 `{width,height,layers:[{name,filename,left,top,right,bottom,depth_median}]}`。清单按深度从后到前排列；PNG 是裁剪部件，宽高必须与边界匹配。
- 原节点只返回字符串文件路径，不给任务 history 写入可唯一定位的 UI 结果。不能通过 `seethrough_psd_info.log` 读取“最新结果”，否则并发任务会串图。
- 因此提供轻量、本项目实现的 ComfyUI 输出节点：接收 `SEETHROUGH_PARTS`，输出带作业 ID 的 PNG 和清单，并将清单放入该 prompt 的 history。模型推理仍由已安装的 See-through 节点负责。
- 工作台使用固定图节点，通过本机回环 HTTP 连接 ComfyUI；不接受任意服务端路径，不使用全局 interrupt。提交结果不明确时不自动重发，避免重复作业。
- 图层导入使用统一世界缩放、Y 轴翻转、裁剪偏移。先预览和选择，再创建新工程，不覆盖当前角色。

后续阶段完成时继续追加本文件。

## 03 · 天蓝配色与导入界面

- Spine 独立使用天空蓝强调色 `#0284c7`、浅蓝面板和深蓝画布；只修改 Spine 选择器及 Spine 页签，未改写作页配色。
- 新增「导入图层清单」：JSON + 裁剪 PNG，多层重组预览，透明检查，选择图层，修改角色/父骨骼建议，最后创建新工程。
- 画布统一缩放到最长边 480 个世界单位，原点为底部中心，Y 向上。原始裁剪图、边界、画布尺寸和导入来源随工程保存，ZIP 增加 sources/。
- 原有 V1 工程继续可读，新增数据为可选字段。界面与出口的自动化验证在后续阶段记录。

## 04 · 本机拆层作业

- 新增 Rust 命令 `spine_comfy_request`：仅回环 HTTP、无代理/重定向、45 秒请求超时、JSON 8 MiB / PNG 16 MiB 上限。推理在 ComfyUI 队列运行，不受查询超时影响。
- Rust 重建固定 7 节点流程，禁止调用方提交任意工作流；模型自动下载关闭，LaMa 隐式下载路径关闭。
- 前端保存「准备 → 提交 → 回执 → 完成」检查点。先落盘再提交，提交不明确进入待确认；读取队列和最近 100 条 history 找回回执，不自动重发。
- 模型列表来自本机 `/object_info`。支持从生图历史选择整张角色图，或上传本地图片；保留整图画布，仅缩小至最长边 2048。
- 面板打开时串行轮询，关闭/切换工作区停止轮询但本地任务继续；重新打开或重启后可继续查询。结果先进入图层审阅，再创建新骨骼工程。
- 当前尚未在真实 ComfyUI/GPU 上执行推理，接下来验证协议、状态恢复、界面和回归。

## 05 · 首轮验证与修正

- TypeScript 检查中修正 JSX 闭合和 ES target 不支持 `replaceAll` 的问题，未改变项目编译目标。
- `pnpm check`：267 项通过；`pnpm build`：通过。
- `node --test scripts/test-spine-v2.mjs`：14 项通过，含几何、清单拒绝、提交检查点、回执丢失、落盘失败和恢复不重发。
- `python scripts/test_spine_comfy_bridge.py`：4 项通过，合成 RGBA 验证裁剪、排序、透明度、任务隔离。
- `cargo test --manifest-path src-tauri/Cargo.toml spine --lib`：3 项通过，包含 ZIP 原子替换、本机地址/固定图检查和实际回环 HTTP 提交/大小上限测试。
- 官方 Spine 4.2 验证：13 根骨骼、6 网格、4 动作，10,200 个坐标样本，最大误差 `0.00002625632697572655`。
- 隔离 Edge 启动后立即退出；改用已安装 Chrome 完成交互验证，未使用用户配置。V1 交互回归与 V2 图层/任务恢复交互均通过，页面错误 0。
- 人工检查截图发现 720px 图层弹窗中的选择文件按钮被输入框挤压，随后调整按钮行的宽度、换行与对齐规则，并安排复验。
- 增加「停止跟踪（不取消推理）」避免清空的服务端历史永久阻塞新任务；保留作业回执以便以后继续找回。

## 06 · 操作说明与交付范围

- 更新 `SPINE_STUDIO.md`：清单示例、坐标/大小约束、桌面 ComfyUI 操作、重启恢复、停止跟踪与实际取消的区别、原始图层输出、验收边界。
- 新增 `modules/spine_comfy_bridge/README.md`：节点安装、上游真实仓库地址和已核实提交、输出协议、故障处理和测试命令。
- 未安装模型、未下载大权重；尚未执行真实 ComfyUI GPU 推理、原生桌面界面验收或 Spine 编辑器导入回环。多图关键姿态、插帧、姿态拟合继续留待下一阶段。

## 07 · 最后边界检查

- 检查点写入失败时，未发出的任务明确记为失败，避免内存停留在「准备中」阻塞新任务；已发出的未知提交仍保留待确认。完成输出在落盘失败时仍保留内存清单。
- 新增两项对应状态测试；图层导入操作增加同步互斥，避免快速重复点击创建两份工程。
- 原始图层全部删除后，不再导出空的 sources 清单。文档总入口增加 Spine 使用和实施日志链接，保留其他研究任务条目。
- Rust 增加真实回环 HTTP 的 multipart 上传、history/queue 找回、图片拉取与跨任务拒绝测试。当前 Spine 相关 Rust 测试 4 项通过。

## 08 · 最终复验与产物

最终代码状态验证：

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 269 项通过，含新增 16 项 V2 合约/状态测试；TypeScript 与发布配置检查通过 |
| `pnpm build` | 通过，已生成本地 dist；未制作或发布安装包 |
| `cargo test --manifest-path src-tauri/Cargo.toml spine --lib` | 4 项通过（1 项 ZIP、3 项 ComfyUI 接口） |
| `python scripts/test_spine_comfy_bridge.py` | 4 项通过 |
| `scripts/test-spine-ui.mjs` | V1 示例、播放编辑、保存恢复、工程导入、PNG、撤销、ZIP、窄窗口回归通过 |
| `scripts/test-spine-v2-ui.mjs` | 最终复验通过，页面错误 0；天蓝配色、裁剪重组、循环拒绝、原始素材导出、任务重启恢复、跨任务输出隔离；推理使用模拟 IPC |
| `scripts/verify-spine-runtime.mjs` | 官方 4.2 兼容性通过，误差见阶段 05 |
| `git diff --check` | 通过（仅 Git 行尾转换提示） |

产物统一放在 `G:\Work\LevelUpAgent\research\spine-animation-2026-10-03\verification-v2\`：

- `pnpm-check.log`、`build.log`：最后一次完整检查输出。
- `ui/v2-ui-result.json`、`ui/sky-blue-studio.png`、`ui/layer-review*.png`：第二版交互结果、天蓝工作台和宽窄窗口审阅截图。
- `ui/comfy-recovered-mock.png`：模拟提交丢失后恢复的界面，文件名明确标为 mock。
- `ui/layers-spine.zip`、`ui/layers.json`、`ui/body.png` 等：可重复验证的合成图层和导出包，不是 AI 推理产物。
- `v1-regression/ui-result.json`、对应截图和 `orbit-spine.zip`：第一版功能回归证据。

截图已人工检查，720px 下导入按钮竖排问题已修复并复验。检查时本机默认 8188 端口没有监听服务，因此没有实际提交 GPU 推理。下一步是准备 ComfyUI 与权重、真实角色质量/显存验收，再推进多参考关键姿态及动作拟合。
