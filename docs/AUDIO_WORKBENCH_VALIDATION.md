# 音频工作台集成验收

日期：2026-10-10。Windows x64，RTX 3080 Ti 12 GiB，系统内存约 64 GiB。

## 已验证

- `pnpm check`：TypeScript、4 项外观静态检查、299 项既有前端回归与发布配置检查通过，外观基线未扩增。
- `pnpm build`：生产前端构建通过，音频工作台为独立惰性加载模块。
- `python -B -m unittest discover -s modules/music_workbench/tests -v`：5 项通过。验证真实 WAV／裁剪／原始文件保留、收藏和归档持久化、缺模型不生成假音频、非法输入、队列取消、中断恢复、stdio 错误恢复及 EOF 退出。
- `cargo test --lib music_`：5 项常规测试通过。验证固定清单身份与大小限制、Windows 路径别名／穿越拒绝、分阶段解压不产生假就绪、HTTP Range 续传、服务器忽略 Range 时重新下载、错误范围／错误 SHA256 拒绝。
- actionlint：新的独立音频资源工作流通过。
- 浏览器与真实 Tauri 均验证浅色／深色 × Armor Mode 关／开，弹窗、焦点、hover、720／1100／1440 布局、所有创作页之间往返切换、刷新保留音频页及参数。截图与结果在 `artifacts/music-workbench/ui/`。

## 真实资源与模型

资源包来自已验证的 Python 3.10.11／MusicGen venv 与固定模型 snapshot。重新整理为可搬迁 Python 目录，运行时不依赖构建机器的 Python 注册表、venv 或 PYTHONPATH。分卷下载总量 5,241,344,415 bytes，解压 9,938,897,098 bytes，6 个分卷；主程序只增加明确枚举的小型控制脚本与清单。

`music_portable_install_generate_cancel_and_eof` 实际运行通过（不是默认跳过测试的推断）：

- 全新目录 `artifacts/music-workbench/acceptance-4/`，使用实际 Rust 离线安装器校验、解压并启用两个资源组件。
- 经实际 Rust JSON-lines 服务桥接，使用独立 Python 完成 CUDA 推理，3.94 秒／32 kHz／单声道 PCM16 WAV。
- worker 载入至保存 4.66 秒，PyTorch 峰值分配显存 2.317 GiB；该数值不代表整卡显存占用，也不保证长音频的峰值。
- 原音频 SHA256 `d4f6b32c800ed77ecbb43aae3b6e71d7f2ec1d0a4ffaba8c2d268f8c6f08097b`。
- 裁剪另存 2 秒，取消正在运行的 30 秒任务，再关闭控制管道时清理另一条运行任务；重启后无 queued／running 残留，原作品保留。
- 详细证据 `artifacts/music-workbench/acceptance-4/acceptance.json`，WAV 在同目录的 `outputs/`。

真实 Tauri 隔离应用 `com.levelup.agent.musicqa20261010` 同样完成资源安装、UI 点击生成、asset 协议实际播放（播放器时间前进）、收藏、裁剪和原生 IPC 导出 WAV。原生成 3.94 秒，worker 5.77 秒，峰值 2.317 GiB。导出文件：`artifacts/music-workbench/ui/desktop-export.wav`；界面无 JS 错误。直接取消与关闭真实原生窗口均停止音频 Python 子进程，重新打开后状态为 cancelled 且作品保留，记录于 `lifecycle-before.json`／`lifecycle-after.json`。

## GitHub 资源上传

2026-10-10 01:03（UTC+8）核对 `TippingGame/LevelUpAgent` 的共享 Release `music-workbench-resources`（ID `408105987`）：6 个分卷与版本清单全部为 `uploaded`，GitHub 返回的大小和 SHA256 与本地清单一致。下载总量 5,241,344,415 bytes，清单 2,550 bytes。记录在 `artifacts/music-workbench/release-verification.json`。

上传时 Release 保留 draft + prerelease。按用户的 v1.3.73 发布要求，2026-10-10 08:41（UTC+8）已公开为
[独立音频资源 Release](https://github.com/TippingGame/LevelUpAgent/releases/tag/music-workbench-resources)，保持 prerelease 且不占用应用 Latest。
公开清单匿名下载返回 HTTP 200，内容与本地清单逐字节一致；6 个分卷的大小和 GitHub SHA256 均再次核验通过。
全部 6 个分卷分别读取首尾 64 KiB，12 次匿名 Range 请求均返回 HTTP 206，Content-Range 与本地字节一致；
首次链路探测遇到连接超时，重试后完成。未为此重复下载全部 4.88 GiB。
发布链路证据在 `G:\Work\LevelUpAgent\research\release-1.3.73-2026-10-10`。

最终重新执行 `pnpm check`、`pnpm build`、Rust 音频常规测试和 Python 测试均通过；`git diff --check` 无空白错误。Tauri 音频资源表仅包含 6 个控制文件，合计 21,916 bytes；大型资源与验收产物均在 Git 忽略目录，未加入主安装包。

## 修复与边界

真实安装暴露了开发目录被 Vite 文件监听覆盖时的 Windows 目录启用问题。安装路径现先 canonicalize，释放压缩文件句柄后启用，短暂文件占用有有限重试；Vite 排除大型 `artifacts` 目录。正式应用数据目录安装与开发目录的最终完整验收均通过。

没有测试 macOS／Linux 资源、CPU 长片段性能、音乐主观质量或跨设备种子的逐字节可复现性。工作台明确标识 Windows x64 支持范围与 MusicGen 非商业许可。未改动原型 `LevelUpMusic` 或其旧作品库，也没有把 ACE-Step／YuE2 调研候选当作已完成能力。
