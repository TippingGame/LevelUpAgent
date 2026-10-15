# v1.3.79：Windows 原生 3D 与平台资源选择

## 变化

- Windows 3D 工作台使用原生便携 Python、PyTorch/CUDA 11.8、预编译扩展与 Blender，无需 WSL、系统 Python、CUDA Toolkit 或编译器；系统需 NVIDIA 驱动。
- 按操作系统和架构自动选择依赖及模型：Windows x64 为 `2026.10.15 / windows-x64-cu118`，Linux x64 保持 `2026.10.1 / linux-x64-cu118`。macOS 与其他未支持架构在下载前提示。
- Windows 安装器由 Rust 引导，支持在线续传、离线 ZIP 分卷导入、完整 SHA256 校验、取消与资源锁。旧 Linux TAR 资源和历史作品保留。
- Windows 工作进程使用 Job Object、父进程句柄及心跳，取消、关闭或异常退出均清理子进程；重启保留已完成的阶段。
- 继续使用 TripoSG、SD2.1 + MV-Adapter 与 Blender 3.6.23，未更换模型权重。应用升级到 1.3.79。

## 资源与验收

Windows 独立资源含 10 个分卷与 1 份清单，下载 14,143,575,278 bytes（约 13.17 GiB）、安装 18,714,139,632 bytes（约 17.43 GiB），主安装包不包含大型环境与权重。上传时校验分卷及完整归档、核对 GitHub digest，清单最后上传；共享资源 Release 保持 prerelease，不占应用 Latest。

RTX 3080 Ti 12 GiB 上，隔离的正式 Tauri 页面在仅有 Windows 系统 PATH 的环境中，完成离线安装及三阶段生成：标准 50 步灰模 430.00 秒、2K 贴图 71.24 秒、蒙皮导出 6.39 秒。30,000 面、19 根骨骼、Idle/Walk/Wave 三个动作；GLB/FBX/Blend 重载确认纹理、骨骼与动画顶点位移。系统深浅色 × Armor 开关及 720px 窗口通过；取消、正常退出、强制结束和重启通过。验收证据：`artifacts/model-workbench/windows-native/acceptance`。

预编译 CUDA 扩展目标 `8.6+PTX`，只实测 RTX 3080 Ti，不表示所有 NVIDIA 架构均已验证。当前生产路径不启用 CV-CUDA UV padding 或 Poisson blending；本轮未新增 Unity/Unreal 导入及其他 GPU 的美术质量验收。

本地锁定依赖安装、303 项前端测试及外观检查、生产构建、Rust 格式检查、555 项 Rust 测试与全目标 Clippy 通过（5 项 opt-in 测试忽略）。3D Python 20 项测试、3 项 Linux 专属跳过；音频 Python 9 项测试、2 项便携解码器测试跳过。1.3.79 隔离原生客户端确认 Windows 平台、组件复用、旧作品读取、四种外观与 720px 环境对话框。

已于 2026-10-15 16:21:14（Asia/Shanghai）正式发布并设为 Latest。构建提交 `a836cd392adb574cbcdcd17302c14ef2fe3e06bf`，三平台 CI run `38696906888` 与四平台 Release run `38696910394` 均成功。10 个资产完整下载并通过 GitHub SHA256 digest 校验；Windows EXE/MSI updater 签名及可信注释签名有效，公开发布页和 `latest.json` 均返回 HTTP 200、版本为 `1.3.79`。发布证据：`research/release-1.3.79-2026-10-15`。

正式 Windows 安装包完成归档完整性、版本、x64 架构、CSP、updater 配置和 71 个资源文件验证，不含 QA 标识和调试端口。Windows 3D 的 10 个新分卷与 JSON 清单可匿名读取，原 15 个 Linux 资源资产 ID、大小和哈希保持；原生客户端读取公开 Windows 清单成功。资源 Release 保持 prerelease、不占应用 Latest。

安装包已保存到 `G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.3.79_Windows_x64-setup.exe`，保留旧版本并更新 SHA256 清单。SHA256：`ADEF6F69FFDAE3CB0E8B8F5A5478E153EE1CD81FD7441C5B1655E6B8914FEA83`。本次未覆盖用户正式安装，未执行旧版应用内更新，macOS/Linux 未新增实体机交互验收。
