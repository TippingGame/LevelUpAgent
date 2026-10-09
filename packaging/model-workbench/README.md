# 3D 资源构建

此目录维护通用资源的构建输入。主 Tauri 资源表只列举 `modules/model_workbench` 的七个 Python 源文件和 `resources.json` 兼容清单，不包含此处构建环境、权重或 CUDA。资源独立版本为 `2026.10.1`，统一发布到固定 `model-workbench-resources` Release；应用版本升级不重打包资源。

在 Linux x64 / WSL Ubuntu 中构建。运行环境固定 Python 3.10、Torch 2.5.1+cu118、torchvision 0.20.1、CUDA 11.8、diffusers 0.32.2。先用 `conda-explicit.txt` 创建独立环境，再安装 Torch 与 `requirements.txt`，最后构建 diso 0.1.4 和 nvdiffrast 0.3.3。需要 CUDA 编译工具及 GCC 11，编译扩展时设置 `CUDA_HOME` 和适合目标 GPU 的 `TORCH_CUDA_ARCH_LIST`。

```bash
micromamba create -y -p /absolute/build/python --file packaging/model-workbench/conda-explicit.txt
/absolute/build/python/bin/python -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu118
/absolute/build/python/bin/python -m pip install -r packaging/model-workbench/requirements.txt
/absolute/build/python/bin/python -m pip install --no-build-isolation diso==0.1.4
/absolute/build/python/bin/python -m pip install --no-build-isolation /absolute/source/nvdiffrast
/absolute/build/python/bin/python -m pip check
/absolute/build/python/bin/python -m pip freeze > requirements.lock.txt
/absolute/build/python/bin/conda-pack -p /absolute/build/python -o python-relocatable.tar.gz
```

源码版本：TripoSG `fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c`，MV-Adapter `4277e0018232bac82bb2c103caf0893cedb711be`，nvdiffrast `729261dc64c4241ea36efda84fbf532cc8b425b8`。保留各源码仓库许可证。执行 `python packaging/model-workbench/patch_mvadapter.py <MV-Adapter目录>` 应用参考注意力缓存的 CPU 卸载兼容修复；脚本检查补丁位置并可重复运行。复制副本后应用，不修改研究项目。

TripoSG 权重和 SD2.1 / Adapter 下载的固定地址见 `triposg-sources.json`、`sd21-sources.json`；CUDA Redistributable 的固定大小 / 哈希见 `cuda-sources.json`。`sdxl-sources.json` 仅记录历史对比，不属于当前发布资源。TripoSG 清单已移除 RMBG。对于历史清单中缺少 SHA 的小配置文件，获取后计算哈希，最终 Release 归档和每个分片必须有真实 SHA-256，不使用占位哈希。

`scripts/download-model-asset.py` 提供可恢复的并行范围下载，`transfer(entry, connections, direct_cdn)` 接受 `path/sourceUrl/bytes/sha256`。下载成功才把临时文件改名为正式文件。只用于资源准备；桌面安装器自身的下载逻辑位于 `launcher.py`。

Blender 使用 **3.6.23 Linux x64**，归档 SHA-256：`0e9a18af4d0060b825e9617e24a775f759e0f9f67271c062f3d53a539030af00`。本次从 Blender 的 Berkeley 镜像下载并核对对应 SHA256 清单，保留 Blender 原始 `COPYING`、许可证和源代码获取说明。对应源代码为 `https://projects.blender.org/blender/blender/src/tag/v3.6.23` / `https://download.blender.org/source/blender-3.6.23.tar.xz`。

将 `python-relocatable.tar.gz` 解压到 staging/runtime/python，但不要在 staging 运行 conda-unpack；安装器会在用户最终路径执行它。将 CUDA 和两个源码目录放在 staging/runtime；把形状、贴图、Blender 放在独立目录，每个组件附 `provenance.json`。完整目录布局和打包 / 发布命令见 [MODEL_WORKBENCH.md](../../docs/MODEL_WORKBENCH.md)。

`runtime/python` 必须完整保留 conda-pack 的文件，不能按目录名删除其中的 `downloads` 或 `__pycache__`：这些文件可能在 conda-unpack 的迁移清单里。仅修改某个组件时，可对尚未发布的资源集传入 `--component runtime` 重建该组件，清单会在分片完成后原子更新。已公开的资源不可原地修改：先增加 `modules/model_workbench/resources.json` 的独立资源版本，再在同一 Release 添加新资产，保留旧版本。上传脚本跳过已存在且哈希一致的文件，拒绝同名不同内容。

打包器把组件内部的目录别名记录在受归档哈希保护的 `.directory-links.json` 中。安装器先安全提取普通文件，再验证目标仍位于同一组件内才恢复目录链接；这样保留 GCC sysroot 布局，并避免把整个 Python 库重复打包。禁止指向组件外部的目录链接。发布验收要从空的 `cache/torch` 开始，确保 nvdiffrast 首次编译和链接真正成功。

当前本机资源中的 diso 来自 `8.6+PTX` 编译环境，完整 GPU 验收设备为 RTX 3080 Ti。不能据此宣称覆盖所有 NVIDIA 型号；面向较老架构发布时，需要按目标设置（例如 `7.5;8.0;8.6;8.9+PTX`）重编扩展并验收。RTX 50 系列应准备更新的 CUDA / PyTorch 资源目标，不能假定此 cu118 目标适用。

发布前至少验证一次：离线资源包完整安装 → TripoSG 灰模 → SD2.1 贴图 → 可调整骨架与基础动画 → GLB/FBX/Blender 导出。检查结果与资源版本一起记录；安装包成功构建不能替代 GPU 推理验收。
