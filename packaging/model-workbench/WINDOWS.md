# Windows 原生 3D 资源

固定资源：`2026.10.15 / windows-x64-cu118`，与 Linux `2026.10.1` 独立。没有更换 TripoSG、SD2.1 或 MV-Adapter 权重。

## 构建来源

先在同级研究项目 `LevelUpGaussian` 的 `.runtime/windows-cu118` 隔离环境验证。构建脚本和详细记录见该项目 `docs/WINDOWS_NATIVE.md`、`scripts/prepare_windows_cuda.py`、`prepare_windows_sources.py`、`build_windows_extensions.py`、`prepare_windows_portable.py`。原 vendor、模型权重和 WSL 环境保留。

- Python 3.10.11、Torch 2.5.1+cu118、torchvision 0.20.1；精确版本在资源的 `runtime/requirements.lock.txt`。
- MSVC 14.37 + NVIDIA CUDA 11.8 官方 redistributable 编译 diso 0.1.4 / nvdiffrast 0.3.3。构建工具及头文件不随最终资源分发。
- 当前扩展目标 `8.6+PTX`，RTX 3080 Ti 实测；没有把其他 NVIDIA 架构声明为已验证。
- 便携 Python 的 `_pth` 隔离系统注册表、用户 site-packages 和 PYTHONPATH；MSVC 运行库 DLL 一并携带。
- nvdiffrast 加载预编译 `.pyd`，生产运行禁止隐式 JIT；MV-Adapter 的 Triton 为可选导入，实际使用 torch-native。生产路线关闭 CV-CUDA UV padding / Poisson blending。
- Windows Blender 3.6.23 官方 ZIP SHA256：`e3296eba7eab32c2e5182459ec7614af32224eee2bd32c9d0a08ffd751c54f3b`。
- 每个组件携带 provenance、许可证和上游来源。Blender 对应源代码地址包含在 provenance 内。禁止混入旧 LGM、RMBG 权重或非商业高斯光栅化器。

## 本地打包与使用

```powershell
python scripts/package-model-workbench-windows.py --staging ../LevelUpGaussian/.runtime/windows-cu118/staging --output artifacts/model-workbench/windows-native/release
```

输出必须为空目录。四组件 ZIP 分卷每片小于 2 GB，包含逐片及完整 ZIP 的 SHA256、安装字节数。约 13.2 GiB 下载，17.4 GiB 安装；磁盘还需容纳缓存和临时归档，以客户端实际清单计算为准。

在原生版客户端进入「创作空间 → 3D → 环境与下载」，勾选组件，离线导入上述文件夹。不要手工拼接、解压或重命名分卷。原 Linux 包无法在 Windows 原生运行，仍保留供 Linux 使用。用户只需系统 NVIDIA 驱动，无需 WSL / 系统 Python / CUDA Toolkit / Visual Studio。

## 主应用验收

- `pnpm check`：301 项现有前端测试及外观检查通过；`pnpm build` 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml model_ --lib`：23 项相关测试通过，含原生无 Python 引导、旧作品读取、资源清单/ZIP/哈希校验、断点续传、排他锁和取消。
- Python 工作台测试 16 项，Windows 下跳过 3 项 Linux 专属测试。
- 另外三个真实 Windows 进程测试通过：取消、launcher 被终止、桌面父进程退出，均清理 worker 和孙进程。
- 独立正式构建标识 `com.levelup.agent.modelnative20261015`，使用正式打包页面与 CSP。PATH 仅 Windows/System32；移除 Python/CUDA/编译器环境变量。
- 离线包已通过原生安装器安装到 `artifacts/model-workbench/windows-native/Windows 离线验证`，与构建目录分离，包含中文和空格。
- 实际桌面验证脚本 `scripts/verify-model-native.mjs`；输出 `artifacts/model-workbench/windows-native/acceptance`。包括浅深色 × 装甲开关、720px、真实三阶段生成、纹理载入、动作播放、导出和重载。完整结果以验收 JSON 为准。
- 最终桌面实测通过：灰模 430.00 秒、贴图 71.24 秒、绑定 6.39 秒（界面操作墙钟时间）。实际 GLB/FBX/Blend 重载均读到纹理及三个动作，动画顶点发生位移。
- `scripts/verify-model-native-lifecycle.mjs` 验证实际取消、正常退出、强制结束桌面后的子进程清理及重启，原完成的三个阶段均保留。汇总见 `acceptance/summary.json`，截图及完整记录保留在同目录。

研究环境先行结果：50 步灰模约 372 秒；2K 贴图约 78 秒；19 骨和三个基础动作约 5 秒；GLB/FBX/Blend 实际重载通过。只有单张角色输入，骨骼变形和贴图质量仍需美术检查，本轮未重新执行 Unity/Unreal 导入。

## 上传与平台选择

```powershell
node scripts/upload-model-workbench.mjs artifacts/model-workbench/windows-native/release windows
```

上传脚本的第二个参数为 `windows` 或 `linux`；未填写保持原 Linux 发布流程。先校验全部分卷和完整归档，逐卷核对 GitHub digest，最后上传清单。同名不同内容拒绝覆盖。Windows 与 Linux 资源共同存放在 `model-workbench-resources` prerelease，不影响应用 Latest。

1.3.79 客户端按实际操作系统与架构自动选取依赖和模型。Windows x64 读取 `resources-windows.json`，Linux x64 读取 `resources.json`，不支持的平台在下载前报错。旧 Linux 资源保留，离线包也必须与当前平台匹配。公开发布验证见 `docs/RELEASE_1.3.79.md`。
