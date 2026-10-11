# 音频工作台

创作空间 → **音频**。选择模型与“纯音乐／带歌词歌曲”，填写风格描述；歌曲模式另填歌词和演唱语言。结果自动保存在本机，可试听、收藏、归档、复用参数、导出 WAV，以及裁剪／淡入淡出另存新版本。种子等参数默认折叠。

默认使用 ACE-Step 1.5 Turbo。v1.3.75 的歌曲引擎接入见 [原始验收记录](AUDIO_ENGINES_INTEGRATION.md)；后续 YuE2 INT8 升级的当前状态和证据见 [升级记录](YUE2_261011_UPGRADE.md)。v1.3.73 / v1.3.74 只有 MusicGen Small。

| 模型 | 创作方式 | 时长 | 权重许可 |
| --- | --- | --- | --- |
| ACE-Step 1.5 Turbo | 纯音乐、按歌词演唱 | 目标 10–600 秒 | MIT；Qwen3 Apache-2.0 |
| YuE2 3B INT8 | 纯音乐、按歌词演唱、参考旋律改编 | 上限可设 8–600 秒；可能提前结束 | CC-BY-NC-4.0，非商业 |
| MusicGen Small | 纯音乐 | 4–30 秒 | CC-BY-NC-4.0，非商业 |

ACE-Step 当前不安装可选 5Hz LM，不提供自动写词／改写描述。YuE2 使用乐谱规划、语义生成、声学合成与分块 VAE 解码；达到时长或上下文上限会保存音频并显示截断提示。600 秒是可设上限，并非所有显卡都能生成完整 600 秒。歌词是生成条件，不保证逐字演唱，请试听。

YuE2 的“参考音频”默认折叠，可导入 WAV、MP3、FLAC、OGG、M4A、AAC（1–600 秒、≤256 MiB），转换为应用管理的 48 kHz 立体声 WAV，原文件保持不变。SheetSage2 提取旋律后，按新风格和歌词重新生成，不复制参考歌手声线。参考可随作品参数复用。

新版纯音乐自动执行生成、去人声、提取旋律、重生成和再次去人声，耗时更长；已有参考旋律时直接按参考生成并去人声。去人声仍可能残留哼唱或分离伪影。

## 环境与资源

- 资源支持 Windows x64，不依赖系统 Python、Node、WSL 或完整 CUDA SDK。各引擎独立安装，使用歌曲引擎不要求先安装 MusicGen。
- MusicGen：Python 3.10.11 / PyTorch 2.8 / CUDA 12.8。下载约 **4.88 GiB**、安装约 **9.26 GiB**，建议预留 **20 GiB**。
- ACE-Step：Python 3.12.10 / PyTorch 2.7.1 / CUDA 12.8。下载 **8.01 GiB**、安装 **11.64 GiB**，建议预留 **35 GiB**。
- YuE2 INT8：Python 3.13.12 / PyTorch、torchaudio 2.11.0 / CUDA 13.0。建议预留 **30 GiB**；准确下载量由“检查下载大小”读取当前资源清单。磁盘预留包含缓存和临时解压。
- MusicGen 短片段建议可用显存 ≥4 GiB、内存 ≥8 GiB，无 CUDA 时可用 CPU，速度较慢。ACE-Step 建议显存 ≥8 GiB、内存 ≥16 GiB。
- YuE2 INT8 需要 RTX 30 系及以上或同等 BF16 能力，以及兼容 CUDA 13.0 的 NVIDIA 驱动；短片段建议可用显存 ≥8 GiB、内存 ≥32 GiB，长歌曲建议 24 GiB 以上显存。短样例峰值不代表所有时长均可在同一硬件运行。
- 界面展示整机可用内存／显存，作品另记 PyTorch 实际分配显存峰值。一次只生成一个音频任务，最多排队 8 条；与 3D 或其他软件的 GPU 负载不共享调度。

## 下载与手动导入

在“环境与下载”选择模型，点击“下载并安装”；首次完成后即可离线生成。下载显示字节数、速度、预计剩余时间和校验／解压阶段，支持断点续传与 SHA256 校验。完成校验和解压后才标记就绪，取消会保留已下载分卷。

手动导入：从 [共享资源 Release](https://github.com/TippingGame/LevelUpAgent/releases/tag/music-workbench-resources) 下载对应 JSON 清单和**全部同前缀 `.zip.part` 分卷**，放在同一文件夹。在“环境与下载”选择同一模型，点击“导入离线资源”并选择这个文件夹。无需提前解压，不能只选择原始权重文件夹。

| 模型 | 当前离线清单 |
| --- | --- |
| MusicGen | `music-workbench-2026.10.1-windows-x64-cu128.json` |
| ACE-Step | `music-workbench-2026.10.11-acestep-windows-x64-cu128.json` |
| YuE2 INT8 | `music-workbench-2026.10.11-yue2-int8-windows-x64-cu130.json` |

默认数据位置为 `app_data_dir()/music-workbench/`，“环境与下载”显示本机实际路径：

```text
music-workbench/
  resources/2026.10.1/{runtime,musicgen-small}/
  resources/2026.10.11-acestep/{runtime,acestep-models}/
  resources/2026.10.11-yue2-int8/{runtime,yue2-models}/
  references/<id>.wav       导入后的参考音频
  references/<id>.json      原文件名与时长
  downloads/               下载缓存；已安装组件自动清理缓存
  library.sqlite3          任务与作品元数据
  outputs/<id>/            WAV、请求、日志与生成记录
  service.log              控制进程诊断
```

v1.3.75 的 `2026.10.11-yue2` 是原版 BF16 资源，不能直接供新的 Comfy INT8 加载器使用；此次需要同时升级应用和独立资源。官方原版模型 revision 未变，变化是量化格式与工作流。已发布旧资源、旧安装目录及已有作品保留，绝不以新权重覆盖旧文件。

安装时暂停新增生成任务；已有作品仍可试听、导出，刷新也保留作品列表。运行中的任务须完成或取消后再安装。重新导入可修复缺失或截断的模型。原始整合包里的匹配权重可由构建脚本核验复用，与终端用户导入的分卷格式不同。

## 集成与发布

Rust 经 stdin/stdout 管理 Python 控制进程，不启动 HTTP 服务、不开放端口、不放宽 CSP。三个引擎共用串行队列，每条任务运行在自己的 Python worker；取消与关闭终止推理进程树，任务结束释放模型。异常退出遗留任务在重启后标记 interrupted，不自动重跑。缺失模型或推理失败不会切换引擎。

前端惰性加载，切换创作页后队列继续、播放暂停，参数作为本机草稿保留。音频播放仅通过限定到 outputs 的 Tauri asset 协议。参考请求只传管理 ID，不接受生成参数中的任意文件路径。原始 LevelUpMusic、参考整合包和已有数据不迁移；云端语音仍在图片／视频／语音页。当前不公开 Agent 工具。

主安装包只枚举 10 个小型音频 Python／JSON 控制文件，不含模型、解释器、CUDA、ComfyUI Web 前端、测试或缓存。Comfy 核心及完整对应 GPL 源码随独立运行环境分发。资源版本独立于应用版本，固定在 `resources.json` 和 `song-resources.json`；共享资源 Release 为 prerelease，不占应用 Latest，不覆盖旧资产。

资源准备与发布见 [构建说明](../packaging/music-workbench/README.md)。验证使用 `pnpm check`、`pnpm build`、`python -B -m unittest discover -s modules/music_workbench/tests -v` 和 `cargo test --manifest-path src-tauri/Cargo.toml --lib music_`。真实推理通过 `scripts/verify-song-engine.py`；原生界面脚本为 `scripts/test-music-workbench-ui.mjs --native`，必须连接隔离 QA identifier，不能使用正式用户目录。
