# 生模型模块：可拆卸设计、体积核算与验证入口

日期：2026-10-03。阶段：验证，**尚未跑通生成或发布安装器**。每一步结果见 [验证日志](MODEL3D_VALIDATION_LOG.md)，路线调研见 [高斯生模型方案](GAUSSIAN_3D_WORKFLOW_RESEARCH.md)。

## 1. 是否值得植入

值得。LevelUpAgent 已有生图、参考素材、星图 DAG、本地命令、远端媒体任务和持久历史，适合承担“生模型”的编排入口。需要新增的是独立推理后端、三维资产和质量验收；GPU 推理不适合与聊天主进程、主安装器绑在一起。

本轮选择：**轻量主客户端＋按需安装的本地推理模块＋可选云端 adapter**。第一步验证 ImageDream→LGM→GLB 的高斯链路，同时保留直接网格路线作为对照。

图片可以有误差：LGM 配置包含 grid distortion 与 camera jitter 训练增强，模型用三维先验处理一定程度的输入不一致。验收目标是保留主体设计、形成自洽的三维资产。后端仍需筛选严重矛盾的视图；不把“所有图片严格正确”设成人工前置门槛。

## 2. 安装包究竟会增加多少

统一用十进制 MB／GB；`1 MB=1,000,000 bytes`，MiB／GiB 另标。下载量、安装占用和显存互不等同。

### 2.1 已取得的字节数

通过 Hugging Face API 读取模型文件元数据与 SHA-256，并对官方 PyTorch wheel 做 HTTP HEAD。**只获取元数据，没有下载这些大文件。**

| 内容 | 字节数 | MB | 说明 |
| --- | ---: | ---: | --- |
| 当前本地 LevelUpAgent 1.1.65 NSIS 安装包 | 14,065,983 | 14.07 | 既有文件，非本轮构建 |
| LGM `model_fp16_fixrot.safetensors` | 830,126,160 | 830.13 | 只选择修正版 FP16，不重复下载其他 checkpoint |
| ImageDream image encoder | 1,261,595,704 | 1,261.60 | 上游当前文件 |
| ImageDream text encoder | 680,820,392 | 680.82 | 同上 |
| ImageDream UNet | 1,883,435,904 | 1,883.44 | 同上 |
| ImageDream VAE | 167,335,342 | 167.34 | 同上 |
| **五个主权重小计** | **4,823,313,502** | **4,823.31** | 约 4.49 GiB |
| Windows Python 3.10 的 torch 2.1.0＋CUDA 11.8 wheel | 2,722,716,227 | 2,722.72 | HEAD 200、Content-Length；这是压缩 wheel，不是安装后的目录大小 |
| **以上下载项合计** | **7,546,029,729** | **7,546.03** | 未包括其他依赖、辅助权重、配置文件 |

主权重 manifest：[lgm-lab.manifest.json](../modules/model3d/lgm-lab.manifest.json)。原始证据：[package-sizing](../../research/gaussian-splatting-study/package-sizing/)。

官方源：

- [LGM 模型文件元数据](https://huggingface.co/api/models/ashawkey/LGM?blobs=true)
- [ImageDream 模型文件元数据](https://huggingface.co/api/models/ashawkey/imagedream-ipmv-diffusers?blobs=true)
- [PyTorch CUDA 11.8 wheel 索引](https://download.pytorch.org/whl/cu118/torch/)

加载模型时 `torch_dtype=float16` 不代表网络传输自动减半；下载量必须按所选文件计算。以后如果重新发布半精度或裁剪后的权重包，可以进一步减少下载，但要重新验证质量和分发条款，不能提前算作节省。

### 2.2 规划预算，不是实测安装体积

| 交付方式 | 主安装包预计增量 | 可选下载／磁盘 | 判断 |
| --- | --- | --- | --- |
| 本轮验证工具 | **0 MB GPU 依赖进入 bundle** | 少量脚本、manifest、报告在源码工作区 | 当前没有修改 Tauri 打包资源；未重打包 |
| 正式云端生成入口 | 约 **2–8 MB** 客户端预算 | 不下载本地推理权重；生成结果另计 | 预算覆盖任务 UI、adapter、基础 GLB 预览；最终须打包对比 |
| 正式可拆卸本地模块 | 主客户端仍按约 **2–8 MB** 预算 | LGM 组合暂按 **8–12 GB 下载、12–20 GB 安装占用**；准备 **25–35 GB** 空间供下载／解压／更新 | 范围为工程估算，已知 7.55GB 下载项提供依据；推理缓存及用户资产另计 |
| 全部塞进主安装包 | 会进入**数 GB 级** | 无法把上述文件大小直接等同 NSIS 压缩结果 | 不推荐；所有用户和每次更新都承担大依赖 |

本地预算假定交付经过验证的预编译扩展／运行环境。若让用户现场安装完整 CUDA Toolkit 和 Visual Studio 编译工具，额外占用可能显著增大，不包含在上表中。真正发行包应预构建扩展并核对再分发要求。

不把当前 PyTorch 版本当最终最佳版本；这是 LGM README 使用过的组合，用于给出有依据的尺寸基线。后续锁定新的可用环境时必须重新核算。

## 3. 可拆卸模块的边界

主客户端应保留：

- “生模型”入口、星图节点、任务状态和错误处理。
- 本地／云端统一任务契约和连接选择。
- 模型作品记录、GLB／高斯预览和导出入口。
- 模块发现、兼容性、版本、安装状态和占用统计。

可选模块包含：

- 独立 Python 运行环境、PyTorch／CUDA runtime、已编译扩展。
- 按锁定版本使用的 LGM／ImageDream adapter 与模型权重。
- 分割、网格提取／贴图等实际必需的辅助依赖。

Blender／FBX 转换、Unity 导入工具、COLMAP／Brush 实拍重建另设可选组件。**合成视图→LGM 不需要为了“高斯”三个字把 FFmpeg、COLMAP 和 OOOSplat 整套引擎都打包。**

建议目录：

```text
<用户指定模块盘>/LevelUpAgentModules/
  lgm-lab/0.1.0/
    module.json
    runtime/                # 每个后端的隔离环境
    source/LGM/
    weights/lgm/
    weights/imagedream/
    weights/auxiliary/
    cache/                  # 可清理缓存
    verification.json       # 实际冒烟验证记录，不能由文件存在自动推断

<工作区>/model3d/<jobId>/    # 用户输入、中间结果、模型和报告，与模块目录分离
```

后续共享权重缓存可以减少多个 backend 的重复占用，但需要引用计数。本轮先按单模块独立文件布局验证，避免“卸载一个模块破坏另一个模块”。

### 生命周期设计（尚未实现安装器）

1. **安装**：展示准确下载量和磁盘要求 → 分段下载到暂存目录 → 校验 hash → 解压／环境检查 → 真实推理冒烟 → 原子登记可用版本。失败不能出现半安装的 ready 状态。
2. **升级**：新版本旁路安装并验证；旧任务继续绑定旧版本；确认没有运行任务后回收旧版。
3. **停用／切换**：仅停用路由，不删除文件；在本地与云端之间切换不影响已有作品。
4. **卸载**：检查运行任务与共享引用 → 仅删除已核验的模块目录 → 保留工作区作品和来源。缓存／旧版本／输出分别展示，不用一个“清空”混在一起。
5. **失败恢复**：保留主图和已完成阶段；GPU OOM 最多有限降档，不能无限重试生图和重复收费。

模块协议用结构化参数和资产引用，不接受下载来的 manifest 任意指定 shell 命令。按平台发布不同运行包；Windows Python 和 WSL Linux Python 不混装。

## 4. 本轮已经可以运行的验证入口

源码入口：[scripts/model3d_lab.py](../scripts/model3d_lab.py)。它仅依赖 Python 标准库，不需要安装 torch。

在项目根目录执行：

```powershell
python scripts/model3d_lab.py doctor --report artifacts/model3d-validation/doctor.json
python scripts/model3d_lab.py size --report artifacts/model3d-validation/size.json
python scripts/model3d_lab.py plan --report artifacts/model3d-validation/plan.json
python scripts/model3d_lab.py blueprint --report artifacts/model3d-validation/model3d-validation.levelup-constellation.json
```

检查外置模块时指定实际根目录：

```powershell
python scripts/model3d_lab.py doctor --root 'D:/LevelUpAgentModules/lgm-lab/0.1.0' --verify-hashes --strict
```

`doctor` 默认返回码 0 表示诊断命令完成；JSON 中 `status=blocked` 表示模块存在缺失。用于自动门禁时加 `--strict`，缺失或仍需推理验证返回 2。不可将星图节点执行成功误当作 backend 已准备好。

`plan --image '<PNG/JPEG>'` 可以附上一个真实输入路径，但只记录计划，不上传、不生图、不推理、不写假模型。manifest 还不是依赖安装锁文件：辅助权重与全部传递依赖须在首次真实 POC 后补齐。

`verify-glb --file '<model.glb>'` 检查容器、网格顶点存储范围和基础元数据，报告明确保留 `unityImportVerified=false`。非网格高斯容器不能通过普通游戏网格检查；压缩／稀疏 POSITION 数据可能需要完整 glTF 验证器。

### 在现有星图中验证

将生成的 [诊断星图](../artifacts/model3d-validation/model3d-validation.levelup-constellation.json) 通过星图的 JSON 导入入口导入。它只有“3D 模块环境检查 → 环境报告”两个节点。

- 这是真正按当前星图 schema 生成的图，不是假定已存在的 `model3d` 节点。
- 生成文件包含当前机器 Python／脚本的绝对路径；移动项目或换电脑后重新运行 `blueprint`。
- 当前测试已覆盖实际 graph normalizer 和 PowerShell 命令调用，但未声称在桌面 UI 中点击导入与运行过。
- 原生业务端的长任务 service 和 GPU runner 尚未实施，不把长时间训练交给 localTool 的同步命令。当前后端 `run_command` 有 120 秒超时，进一步说明需要异步 job service。

## 5. 当前主机的真实状态

- RTX 3080 Ti 12GB；检查时空闲约 8.6GiB。官方“LGM 约 10GB”不能保证现在整链容得下；应在真实 POC 中分开多视图、重建和网格转换进程，测每阶段峰值。
- Windows 已有 Python 3.10.11，但 torch／diffusers／transformers 未安装。
- WSL Ubuntu 可用且识别 NVIDIA GPU，系统 Python 3.14.4 不匹配计划中的 3.10，未发现 nvcc。WSL 还输出了 localhost 代理映射和一个旧 PATH 翻译警告；后续安装前需验证实际联网／工具链，而不是默认环境已就绪。
- 外层 research 的 LGM 源码已克隆；诊断默认检查**独立模块根目录**，所以里面的源码也会显示 missing。它没有自动把 research checkout 复制进模块目录。

实际诊断：[doctor.json](../artifacts/model3d-validation/doctor.json)。基础网格读取验证使用的是上游现成 GLB，并非本轮生成物：[reference-glb-check.json](../artifacts/model3d-validation/reference-glb-check.json)。

## 6. 下一步门槛与决策

下一步应完成一次真实生成实验，然后再写正式用户界面：

1. 在独立 Linux/WSL 或 Windows 环境固定 Python、Torch/CUDA、xformers、光栅器和 nvdiffrast 等版本；优先选能复现的环境，不改变 Agent 的通用 Python。
2. 完成辅助依赖清单与离线加载路径。官方 LGM `infer.py` 使用远端 model id 加载 ImageDream，不能只把权重放到目录就宣称支持离线；adapter 要显式使用本地模型目录，并避免 LPIPS／rembg 等首次运行暗中下载。
3. 下载并校验选中的约 4.82GB 主权重及锁定依赖；GPU 推理的实际许可仍按研究评估范围执行。
4. 用一个简单不对称道具图实际跑 ImageDream→LGM→GLB；保存四视图、相机条件、PLY、GLB 和阶段日志。分阶段释放 GPU，网格转换单独测量。
5. 在 Unity 实际导入，检查轮廓、UV／材质、尺度和碰撞。之后与 TripoSR／云端 TRELLIS.2 对照，决定是否让高斯路线成为默认。
6. 只有上述链路取得真实结果，才实现安装器、正式异步 job service 和可发布的“生模型”节点。

本轮新增工具已经能检测缺失、形成可复现运行计划并验证基础输出结构。**尚未有可用的完整生模型模块，安装／卸载 UI、后台 GPU 执行器和 Unity 质量验证也没有被伪装成已完成。**
