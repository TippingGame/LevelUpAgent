# 音频工作台

创作空间 → **音频**。选择模型与“纯音乐／带歌词歌曲”，填写风格描述；歌曲模式另填歌词和演唱语言。生成结果自动保存在本机，可试听、收藏、归档、复用参数、导出 WAV，以及裁剪／淡入淡出另存新版本。种子等参数默认折叠。

> ACE-Step 1.5 / YuE2 已完成接入与本机验收，计划随 v1.3.75 发布。已发布的 v1.3.73 / v1.3.74 仍只有 MusicGen Small。资源及应用发布状态见 [接入记录](AUDIO_ENGINES_INTEGRATION.md)。

| 模型 | 创作方式 | 时长 | 权重许可 |
| --- | --- | --- | --- |
| ACE-Step 1.5 Turbo | 纯音乐、按歌词演唱 | 目标 10–600 秒 | MIT；Qwen3 文本编码器 Apache-2.0 |
| YuE2 3B | 纯音乐、按歌词演唱 | 最大 8–360 秒；可能提前结束 | CC-BY-NC-4.0，非商业 |
| MusicGen Small | 纯音乐 | 4–30 秒 | CC-BY-NC-4.0，非商业 |

ACE-Step 使用原生 DiT Turbo 推理，当前不安装可选 5Hz LM，不提供自动写词／改写描述。YuE2 使用完整乐谱规划、语义生成、NAR 合成与分块 VAE 解码；超过最大 token 数时会保存已有音频，并在作品上提示“结尾或歌词可能未完成”。输入歌词是生成条件，不保证逐字演唱；试听后再决定导出。

首个正式引擎是 **MusicGen Small**，固定 revision `4c8334b02c6ec4e8664a91979669a501ec497792`。它生成短纯音乐，不按歌词演唱。权重许可 **CC-BY-NC-4.0，仅限非商业用途**。界面保留授权说明。这里的“音频”是本地音乐工作台；原来的云端语音入口仍在图片／视频／语音页面。

## 环境与资源

- 首次在“环境与下载”中下载并安装，也可选择离线资源目录。目录必须包含对应版本清单与完整分卷。
- 当前资源支持 Windows x64。不依赖系统 Python、Node、WSL 或完整 CUDA SDK。MusicGen 使用 Python 3.10.11 / PyTorch 2.8；歌曲引擎使用 Python 3.12.10，ACE-Step 配 PyTorch 2.7.1、YuE2 配 PyTorch 2.10，均为 CUDA 12.8。各引擎独立安装，使用歌曲引擎不要求先安装 MusicGen。
- MusicGen 下载约 **4.88 GiB**，安装约 **9.26 GiB**，安装预留 **20 GiB**。ACE-Step 下载 **8.01 GiB**、安装 **11.64 GiB**；YuE2 下载 **8.69 GiB**、安装 **11.64 GiB**。各引擎分别读取版本清单展示实际下载量；界面建议分别预留 ACE-Step **35 GiB**、YuE2 **45 GiB**，包含缓存和临时解压。
- NVIDIA GPU 建议至少 4 GiB 可用显存、8 GiB 可用内存；较长片段可能需要更多。显卡需要兼容 CUDA 12.8 的驱动。CUDA 不可用时使用 CPU，速度较慢。界面展示整机当前可用内存／显存，成功作品另行记录 PyTorch 实际分配显存峰值。
- 上述 CPU 后备仅用于 MusicGen。歌曲引擎当前需要 NVIDIA CUDA；ACE-Step 短片段建议可用显存 ≥ 8 GiB、内存 ≥ 16 GiB；YuE2 建议可用显存 ≥ 8 GiB、内存 ≥ 32 GiB，并要求 BF16 支持。YuE2 长歌曲建议 24 GiB 以上显存。短样例峰值不能推导为所有时长都能在同一显存容量上运行。
- 一次只运行一条音频生成任务，最多 8 条待处理任务；与 3D 或其他软件的 GPU 负载不共享调度，应留意资源提示。

默认数据目录为 Tauri 的 `app_data_dir()/music-workbench/`：

```text
music-workbench/
  resources/2026.10.1/runtime/       可搬迁 Python + 推理依赖
  resources/2026.10.1/musicgen-small/ 固定模型与 tokenizer
  resources/2026.10.11-acestep/runtime/          ACE-Step 独立 Python
  resources/2026.10.11-acestep/acestep-models/   Turbo + 文本编码器 + VAE
  resources/2026.10.11-yue2/runtime/             YuE2 独立 Python
  resources/2026.10.11-yue2/yue2-models/          YuE2-3B + YuE2-Vae
  downloads/                       未完成下载；成功组件自动清理缓存
  library.sqlite3                  任务与作品元数据
  outputs/<id>/                    WAV、请求、日志与生成记录
  service.log                      控制进程诊断
```

下载支持 HTTP Range 续传，校验分卷和合并 ZIP 的 SHA256，解压限制路径、文件类型和总大小；完成后才写安装标记。取消不清空已下载分卷。网络错误、资源尚未发布、磁盘不足和校验失败会显示真实错误，不把下载进度当作就绪状态。

安装过程中暂停新增生成任务；已有作品仍可试听与导出，刷新页面也会保留作品列表。运行中的任务需要完成或取消后才能开始安装。重新导入可修复缺失或被截断的模型文件。

手动导入时，在“环境与下载”选择同一模型，然后选择包含清单与**全部分卷**的文件夹，不要提前解压或只选择权重目录。清单名分别为：

- `music-workbench-2026.10.1-windows-x64-cu128.json`
- `music-workbench-2026.10.11-acestep-windows-x64-cu128.json`
- `music-workbench-2026.10.11-yue2-windows-x64-cu128.json`

所有分卷与清单放在同级目录即可；导入后由应用保存到上述数据目录。“环境与下载”会显示这台机器的实际路径。用户提供的原始 YuE2 模型目录可由资源构建脚本核验、复用，无须再次下载相同权重；它与面向终端用户的离线分卷包是不同格式。

## 集成边界

宿主经 Tauri IPC 调用 Rust 桥接；Rust 管理 Python 控制进程的 stdin/stdout，**不启动 HTTP 服务、不开放端口、无需会话 token 或放宽 CSP**。控制进程沿用 LevelUpMusic 的 SQLite 队列、独立推理 worker 和 WAV 编辑实现。每次推理退出释放模型，取消会终止 worker 进程树；正常关闭宿主会先关闭控制管道并等待清理。中断遗留任务在下次启动标为 interrupted，不自动重新生成。

前端惰性加载，切换创作页后队列继续，播放暂停，侧栏任务计数继续更新。描述与参数存为本机草稿，刷新可恢复。音频仅经限定到 outputs 的 Tauri asset 协议播放，导出仅接受合法作品 ID 与 WAV 路径。

原始 `../LevelUpMusic` 原型及已有数据不修改、不迁移；正式工作台使用宿主自己的作品库。当前不公开 Agent 工具。三个引擎进入同一串行队列，每条任务由对应运行环境中的独立 worker 执行。模型缺失或生成失败不会自动切换引擎。

## 发布

主应用的 Tauri 资源表只枚举九个小型 Python／JSON 文件，不含权重、解释器、CUDA、测试或缓存。资源版本独立于应用版本，MusicGen 固定在 `modules/music_workbench/resources.json`，歌曲引擎固定在 `song-resources.json`，从同一仓库的 `music-workbench-resources` Release 下载。资源发布不占用应用 Latest，既有 `2026.10.1` 资源不重打包、不覆盖。

资源准备、分卷、不可变校验及上传方式见 [资源构建说明](../packaging/music-workbench/README.md)。

## 验证命令

```powershell
pnpm check
pnpm build
python -B -m unittest discover -s modules/music_workbench/tests -v
cargo test --manifest-path src-tauri/Cargo.toml --lib music_
node scripts/test-music-workbench-ui.mjs
```

真实资源验收（会在指定新目录安装所选引擎的资源，生成短片段，再验证裁剪、取消、管道关闭与重启）：

```powershell
$env:MUSIC_TEST_ASSETS = '绝对路径\release'
$env:MUSIC_TEST_ROOT = '绝对路径\全新验收目录'
$env:MUSIC_TEST_ENGINE = 'yue2' # 或 acestep、musicgen；省略时为 musicgen
cargo test --manifest-path src-tauri/Cargo.toml --lib music_portable_install_generate_cancel_and_eof -- --ignored --nocapture
```

界面脚本默认使用已安装的 Playwright 和 Edge，连接本地 Vite。`--native` 连接 9451 端口的隔离 Tauri QA 应用，先验证应用 identifier，再执行原生下载桥接、生成、播放、剪辑与 WAV 导出。测试不应该连接用户的正式应用数据目录。
