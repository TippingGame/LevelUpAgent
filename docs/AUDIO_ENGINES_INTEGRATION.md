# ACE-Step 1.5 与 YuE2 接入记录

开始日期：2026-10-11。目标为正式音频工作台同时接入 ACE-Step 1.5 和 YuE2，支持纯音乐与按歌词演唱，保留 MusicGen 和已有作品。
两个引擎已完成真实推理与原生桌面验收；独立资源上传核验仍在进行。按用户确认，应用版本更新为 1.3.75，正在准备发布。

## 完成门槛

- 前端提供纯音乐／歌曲、引擎、歌词与语言；根据引擎解释目标时长或最大时长，高级项折叠。
- 两个真实 worker 接入同一串行队列，支持进度、错误、取消、退出清理和重启恢复；不自动改用其他模型。
- 每个引擎使用独立可搬迁 Python 与固定模型资源；按需下载和离线导入复用分卷、SHA256、空间与进度管理；大资源不进主包。
- 实机生成两个引擎的可播放音频并验证歌词条件、超过 30 秒的生成、峰值显存、取消和退出；YuE2 截断如实记录与显示。
- 保留试听、WAV 导出、收藏、归档、参数复用与非破坏裁剪；旧数据和 MusicGen 资源兼容。
- 静态检查、前后端测试、生产构建、四种外观与真实 Tauri 操作通过，文档记录实际能力和限制。

## 来源与资源

- 宿主起点：`38a4c46`（1.3.74），工作区开始时干净。
- ACE-Step 参考：`research/ACE-Step-1.5`，提交 `ca1e85fe9430179831e6bc6be790c332190a3866`；优先验证 2B Turbo 的本地 Python 推理接口。
- YuE2 参考：用户提供的整合包内官方 `YuE`，提交 `88da114a67df892af0329472073b96a5ef700b93`；不复制无独立许可的第三方 WebUI。
- YuE2 原有 Python 3.12.13 / torch 2.10.0+cu128 / transformers 4.57.6 环境已通过导入和 CUDA 探测；这不等于模型推理通过。
- 验证硬件：RTX 3080 Ti 12 GiB。生成采用单任务、阶段卸载和分块解码，记录真实占用；不使用 Ampere 不支持的原生 FP8。

## 已有真实证据

- 两个 worker 已进入正式 stdio 桥接与同一串行队列；UI 包含模型、纯音乐／带歌词、歌词／语言及按引擎变化的时长。保留旧作品结构和 MusicGen 资源路径。
- YuE2 独立 Python 3.12.10 / torch 2.10.0+cu128，无 MusicGen：45 秒中文歌词样例成功，48 kHz 立体声 PCM16；worker 96.16 秒、PyTorch 峰值分配显存 7.247 GiB。达到语义 token 上限，截断提示正确保留。证据：`artifacts/music-workbench/multi-engine/yue2-portable-1/acceptance.json`。
- ACE-Step 独立 Python 3.12.10 / torch 2.7.1+cu128，无 MusicGen：45.000 秒中文歌词样例成功，48 kHz 立体声 PCM16；worker 15.78 秒、峰值 4.557 GiB。使用原生 2B Turbo、官方 VAE、Qwen3 文本编码器，无可选 5Hz LM。证据：`artifacts/music-workbench/multi-engine/acestep-portable-1/acceptance.json`。
- ACE-Step 180 秒请求输出完整 180.000 秒音频；worker 23.50 秒、峰值 4.800 GiB。YuE2 最大 180 秒请求自然结束于 61.559 秒，worker 171.59 秒、峰值 7.450 GiB，乐谱与语义均未截断。分别见 `multi-engine/acestep-portable-180/acceptance.json`、`yue2-portable-180/acceptance.json`。YuE2 此项不等于验证了实际 180 秒音频。
- 两个独立环境均通过剪辑另存 2 秒、收藏、取消、EOF 关闭与重启恢复。上述显存是 PyTorch 峰值分配，不等于整卡占用或所有时长的保证。
- YuE2 完整分卷已通过真实 Tauri 的 Rust 离线导入。界面生成 11.999 秒歌词片段、实际播放进度前进、收藏、裁剪和导出通过，四种外观／720 px／往返导航／刷新通过，无 JS 错误。证据：`multi-engine/native-ui-yue2/native-result.json`。
- YuE2 原生纯音乐样例 9.999 秒、耗时 114.77 秒；关闭真实主窗口终止另一条运行任务，重启后为 cancelled，已完成作品保留。证据：`multi-engine/lifecycle/yue2-before-exit.json` 和 `yue2-after-restart.json`。乐谱规划使短纯音乐仍有明显耗时。
- ACE-Step 完整分卷同样通过实际 Rust 离线导入；原生 UI 生成 12.000 秒中文歌词音频，播放时间实际前进，收藏、裁剪、导出和四种外观／720 px／导航／刷新通过，无 JS 错误。见 `multi-engine/native-ui-acestep/native-result.json`。另有 10.000 秒纯音乐、关闭运行任务与重启恢复记录于 `multi-engine/lifecycle/acestep-before-exit.json`、`acestep-after-restart.json`。
- 安装另一个引擎时，宿主缓存作品列表；真实安装中刷新页面后作品仍在，可获取音频与导出，取消安装后两个歌曲模型恢复就绪。证据：`multi-engine/lifecycle/install-cache.json`。运行中的生成任务会阻止安装启动。
- 最终 `pnpm check` 299 项前端测试、外观检查与发布配置通过；前端生产构建通过。全量 Rust 测试 547 项通过、5 项显式忽略；音频专项 7 项通过、1 项 opt-in 测试忽略，真实资源已由上述原生验收覆盖。`cargo fmt --check`、全目标 Clippy `-D warnings`、资源工作流 actionlint 通过。
- Python 3.12 的 6 项桥接测试通过；检查中修复了 SQLite 事务 context 不自动关闭连接的问题，现在每次数据库操作显式释放句柄，避免 Windows 文件占用。

未做主观试听评分或逐字歌词准确率评估，也未验证 ACE-Step 600 秒、YuE2 实际 360 秒的最高时长。在其他显卡或长片段上的资源占用不由短样例推导。

YuE2 的 NAR 阶段通过官方 `yue2.nar.synthesize` 指定 `query_chunk_size=512`，限制 Windows SDPA 工作区；未复制参考包里修改过的 pipeline 或第三方 WebUI。模型源代码始终从固定 Git 提交导出。ACE-Step checkpoint 侧 Python 文件按官方同步规则在打包前固化，推理不需要改动资源。

## 仍在进行

两个独立资源版本的 GitHub 上传及匿名下载核验尚在进行，清单最后上传。ACE-Step 共 10 个分卷、8,605,753,923 下载 bytes、12,495,192,040 安装 bytes；YuE2 共 11 个分卷、9,332,598,511 下载 bytes、12,503,247,378 安装 bytes。

应用 1.3.75 正在准备发布，结果记录于 [发布记录](RELEASE_1.3.75.md)。原型数据库与用户提供的整合包保持原样。已公开的 MusicGen 资源不覆盖，应用主包仅包含 9 个小型音频控制文件，共约 35 KiB。
