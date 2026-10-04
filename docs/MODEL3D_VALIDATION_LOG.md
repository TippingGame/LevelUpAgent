# 生模型模块验证日志

## 2026-10-03 / V01：确定验证边界

用户继续验证“现有生图 → 容许误差的多视图 → 高斯 → Unity 网格”，要求评估安装体积、可拆卸方式，并在每一步留下文档。

- 当前基线：`6a8c77ec5778c60e4673be647da8121294d81e10`，LevelUpAgent `1.1.65`。
- 本轮开始时已有研究文档改动，以及其他工作产生的 `src/lib/spine*.ts` 未跟踪文件；本轮保留这些文件，不将其作为本轮成果。
- 当前阶段以源码／权重元数据核算、可拆卸后端边界和可重复的本地验证入口为目标。先取得可靠的体积数据和环境检查结果，再决定正式 UI 与大模型环境交付。
- 所有体积区分“主安装包增量”“可选下载量”“安装后磁盘占用”“运行时显存”；未知部分明确标为估算。
- 图片无需绝对一致；验证 LGM 等具有三维先验和扰动训练的重建方法。严重拓扑矛盾由主图优先、视图筛选或重生成处理。

后续步骤完成后继续追加记录，失败与未验证事项同样记录。

## 2026-10-03 / V02：体积和主机环境取证

- 本地既有 `LevelUpAgent_1.1.65_x64-setup.exe`：14,065,983 bytes，即 14.07 MB / 13.41 MiB。不是本轮重打包结果。
- Hugging Face 模型元数据：修正旋转后的 LGM FP16 权重 830,126,160 bytes；ImageDream 的 image encoder、text encoder、UNet、VAE 合计 3,993,187,342 bytes；五个主权重共 **4,823,313,502 bytes（4,823.31 MB / 4,599.87 MiB）**。没有把 LGM FP32、旧版 FP16 等替代 checkpoint 重复计入。
- 已锁定权重 revision、每文件字节数和 LFS SHA-256，写入 `modules/model3d/lgm-lab.manifest.json`。上游原始元数据在外层 `research/gaussian-splatting-study/package-sizing/`。
- Windows Python 3.10.11；当前 Python 没有 torch、diffusers、transformers。GPU 是 RTX 3080 Ti 12GB，检查时空闲约 8.6GiB，会随其他应用变化。
- WSL Ubuntu 能看到同一 NVIDIA GPU，但系统 Python 是 3.14.4，未发现 nvcc；不能直接当作匹配 LGM 历史依赖的环境。需独立 Python 3.10 环境和可编译 CUDA 扩展的运行时。
- PyTorch CUDA Windows wheel 的一处 CDN HEAD 请求返回 403；依赖包体积暂不按该 URL 宣称已测得。

后续补证：改用官方 `download.pytorch.org` 直连 URL，HEAD 返回 200，`Content-Length=2,722,716,227`。加主权重后的已知下载项为 **7,546,029,729 bytes**；这不是 NSIS 压缩增量或安装后的目录大小。原始响应记录在 `package-sizing/torch-cu118-win-direct.json`。

## 2026-10-03 / V03：可拆卸模块验证工具

新增标准库脚本 `scripts/model3d_lab.py` 与实验性模块清单，提供：

1. `doctor`：检查独立模块目录、运行时、Python 包可见性、NVIDIA GPU 和权重尺寸；可加 SHA-256 验证。不会下载依赖或启动推理，文件齐全也仍要求真实推理冒烟测试。
2. `size`：按唯一选中 checkpoint 计算主权重总字节数，并列出未计入项。
3. `plan`：生成“预处理 → ImageDream → LGM → mesh → 验收”计划，明确 `planned_not_executed`；不是推理执行器。
4. `blueprint`：生成当前星图可解析的“本地工具 → 报告”诊断图，复用现有 localTool，不修改星图类型或抢占正在开发的 UI。
5. `verify-glb`：检查 GLB 容器及 POSITION 存储范围、是否有网格／UV 等基础信息；不代替完整 glTF、拓扑或 Unity 验收。

工具／manifest 位于源码 `scripts/` 与 `modules/`；当前 Tauri resource 配置不包含它们，因此本轮没有将 GPU 或 Python 依赖装入主安装包。

## 2026-10-03 / V04：已执行验证

- `python scripts/test_model3d_lab.py`：13 项通过，包括路径越界、权重占位／篡改、缺失环境、虚假成功、非网格 GLB、截断文件与顶点越界。
- `node --test scripts/test-model3d-integration.mjs`：1 项通过；用真实 `normalizeConstellationGraph` 导入生成的图，保留两个节点和一条有效连线，并通过实际 PowerShell 命令取得 JSON 诊断报告。包含空格和单引号路径。
- 本机 doctor 返回 `blocked`，明确缺少独立运行时和模型文件，没有标记生成成功。报告位于 `artifacts/model3d-validation/doctor.json`。
- 对上游现成的 `MV-Adapter/assets/demo/ig2mv/cartoon_style_table.glb` 执行结构检查通过：11,497,212 bytes、319,323 个 POSITION（按 primitive 累加）、没有 UV 和材质；该文件只是验证读取器的已有参考资产，**不是本轮生成成果**。
- 未执行 GPU 生成、Unity 导入、模型质量评分、正式安装包构建或真实桌面 UI 点击导入。蓝图验证范围是现有图解析器和命令调用链。

## 2026-10-03 / V05：收敛模块方案与复核交付

- 已完成 [模块验证方案](MODEL3D_MODULE_VALIDATION.md)：主客户端／本地可选包／云端模式的体积边界，安装、旁路升级、停用、卸载与作品保留的生命周期设计，以及可直接运行的验证命令。
- 主客户端 2–8MB 增量、本地下载 8–12GB／安装占用 12–20GB 是当前预算范围；五个主权重和一个 Torch wheel 的 7,546.03MB 是已取得的文件字节数。二者未混为实测 NSIS 结果。
- 已生成 `artifacts/model3d-validation/` 下的 doctor、size、plan、诊断星图和参考 GLB 检查报告。
- JSON／Python 语法、本轮 Markdown 本地链接及 `git diff --check` 通过。星图集成测试在完善临时目录清理边界后复跑通过；13 项 Python 测试此前已通过，业务代码未变，无需据此重复整套产品构建。
- 验证代码、测试和 manifest 合计 37,460 bytes（不含文档／报告）；它们当前不在 Tauri bundle resource 清单里，不会把几 GB 依赖带入应用更新。
- 工作期间另有 Spine 相关文件及 `src-tauri/src/lib.rs` 改动出现，属于其他并行工作；本轮未修改、测试或归功于这些改动。
- 下一关仍是隔离环境中的真实 ImageDream→LGM→GLB 生成及 Unity 导入。当前验证接口不会将“有文件”“Python 包可见”或“诊断脚本执行成功”当作该关已经通过。
