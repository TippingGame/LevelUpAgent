# LevelUpAgent · ComfyUI Spine output adapter

这是本项目编写的输出节点，只负责将 See-through 拆层结果转换为可唯一定位的 PNG + JSON，不包含模型、权重或第三方推理代码。

## 安装

1. 在本机准备 ComfyUI 和 [ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through)。本次按本地研究仓库提交 `98d754bf04f668647919ab750eccb0e0640faa81` 核实接口。需要带 `auto_download` 开关的 `SeeThrough_LoadLayerDiffModel` 和 `SeeThrough_LoadDepthModel` 节点版本。
2. 将本目录完整复制到 `<ComfyUI>/custom_nodes/levelup_spine_bridge/`，确保 `__init__.py` 位于该目录根部。
3. 按 See-through 的说明准备 LayerDiff、Depth 模型与依赖。此适配器仅使用其环境中已有的 Pillow，模型输入使用 numpy 数组。
4. 重启 ComfyUI，在工作台「本地 AI 拆层」输入 `http://127.0.0.1:8188`，点击「检查连接与模型」。服务需在同一台电脑，无反向代理子路径或登录页。

UI 使用固定流程：LoadImage → LayerDiff → Layers → Depth → PostProcess → LevelUpSpineExport。自动下载关闭，LaMa 关闭。默认 768 / NF4 / group offload 是试跑起点，并非 12 GB 显存的推理成功承诺。

## 输出协议

输入 `parts: SEETHROUGH_PARTS`，`job_id: 32 位小写十六进制串`。图层以深度降序稳定排列，PNG 保留透明度与裁剪尺寸，JSON 保留完整画布和每层边界。

- `output/levelup_spine_<job_id>_000.png` 等裁剪部件。
- `output/levelup_spine_<job_id>_layers.json`：离线导入清单。
- `history[prompt_id].outputs["7"].levelup_spine[0]`：同一份清单，由 UI 读取；不使用共享的“最新文件”指针。

每个 PNG 和清单先写临时文件，再原子替换。失败时可能留下该作业的部分 PNG，但不会回传成功清单；后续不同作业使用不同 ID，不会互相取错图片。ComfyUI 的 output 文件需自行保留，删除后历史回执仍可存在，但无法再拉取对应图片。

## 测试

在 LevelUpAgent 根目录、有 Pillow/numpy 的 Python 环境中：

```powershell
python scripts/test_spine_comfy_bridge.py
```

测试使用合成透明图层，验证排序、偏移、透明度、任务隔离和错误拒绝，不执行模型推理。完整使用与当前验收状态见 `docs/SPINE_STUDIO.md` 和 `docs/SPINE_V2_IMPLEMENTATION_LOG.md`。
