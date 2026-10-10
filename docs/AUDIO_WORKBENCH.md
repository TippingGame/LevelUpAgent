# 音频工作台

创作空间 → **音频**。填写音乐描述、选择 4–30 秒时长，点击生成；作品自动保存在本机，可试听、收藏、归档、复用参数、导出 WAV，以及裁剪／淡入淡出另存新版本。默认保留简约流程，不展示原型里的调研模型、程序节拍、歌词服务或多轨编辑。

首个正式引擎是 **MusicGen Small**，固定 revision `4c8334b02c6ec4e8664a91979669a501ec497792`。它生成短纯音乐，不按歌词演唱。权重许可 **CC-BY-NC-4.0，仅限非商业用途**。界面保留授权说明。这里的“音频”是本地音乐工作台；原来的云端语音入口仍在图片／视频／语音页面。

## 环境与资源

- 首次在“环境与下载”中下载并安装，也可选择离线资源目录。目录必须包含对应版本清单与完整分卷。
- 当前资源支持 Windows x64，独立 Python 3.10.11、PyTorch 2.8.0 CUDA 12.8、Transformers 4.57.6。不依赖系统 Python、Node、WSL 或完整 CUDA SDK。
- 下载约 **4.88 GiB**，安装约 **9.26 GiB**；安装需预留约 **20 GiB**，包含分卷缓存、临时 ZIP 和解压目录。界面可读取 Release 清单显示准确下载量，安装前检查实际空闲磁盘。
- NVIDIA GPU 建议至少 4 GiB 可用显存、8 GiB 可用内存；较长片段可能需要更多。显卡需要兼容 CUDA 12.8 的驱动。CUDA 不可用时使用 CPU，速度较慢。界面展示整机当前可用内存／显存，成功作品另行记录 PyTorch 实际分配显存峰值。
- 一次只运行一条音频生成任务，最多 8 条待处理任务；与 3D 或其他软件的 GPU 负载不共享调度，应留意资源提示。

默认数据目录为 Tauri 的 `app_data_dir()/music-workbench/`：

```text
music-workbench/
  resources/2026.10.1/runtime/       可搬迁 Python + 推理依赖
  resources/2026.10.1/musicgen-small/ 固定模型与 tokenizer
  downloads/                       未完成下载；成功组件自动清理缓存
  library.sqlite3                  任务与作品元数据
  outputs/<id>/                    WAV、请求、日志与生成记录
  service.log                      控制进程诊断
```

下载支持 HTTP Range 续传，校验分卷和合并 ZIP 的 SHA256，解压限制路径、文件类型和总大小；完成后才写安装标记。取消不清空已下载分卷。网络错误、资源尚未发布、磁盘不足和校验失败会显示真实错误，不把下载进度当作就绪状态。

## 集成边界

宿主经 Tauri IPC 调用 Rust 桥接；Rust 管理 Python 控制进程的 stdin/stdout，**不启动 HTTP 服务、不开放端口、无需会话 token 或放宽 CSP**。控制进程沿用 LevelUpMusic 的 SQLite 队列、独立推理 worker 和 WAV 编辑实现。每次推理退出释放模型，取消会终止 worker 进程树；正常关闭宿主会先关闭控制管道并等待清理。中断遗留任务在下次启动标为 interrupted，不自动重新生成。

前端惰性加载，切换创作页后队列继续，播放暂停，侧栏任务计数继续更新。描述与参数存为本机草稿，刷新可恢复。音频仅经限定到 outputs 的 Tauri asset 协议播放，导出仅接受合法作品 ID 与 WAV 路径。

原始 `../LevelUpMusic` 原型及已有数据不修改、不迁移；正式工作台使用宿主自己的作品库。当前不公开 Agent 工具或 ACE-Step／YuE2 接口。

## 发布

主应用的 Tauri 资源表只枚举六个小型 Python／JSON 文件，不含权重、解释器、CUDA、测试或缓存。资源版本独立于应用版本，固定在 `modules/music_workbench/resources.json`，从同一仓库的 `music-workbench-resources` Release 下载。资源发布不占用应用 Latest，不重新打包到应用安装器。

资源准备、分卷、不可变校验及上传方式见 [资源构建说明](../packaging/music-workbench/README.md)。

## 验证命令

```powershell
pnpm check
pnpm build
python -B -m unittest discover -s modules/music_workbench/tests -v
cargo test --manifest-path src-tauri/Cargo.toml --lib music_
node scripts/test-music-workbench-ui.mjs
```

真实资源验收（会在指定新目录安装约 9.26 GiB 资源，生成短片段，再验证裁剪、取消、管道关闭与重启）：

```powershell
$env:MUSIC_TEST_ASSETS = '绝对路径\release'
$env:MUSIC_TEST_ROOT = '绝对路径\全新验收目录'
cargo test --manifest-path src-tauri/Cargo.toml --lib music_portable_install_generate_cancel_and_eof -- --ignored --nocapture
```

界面脚本默认使用已安装的 Playwright 和 Edge，连接本地 Vite。`--native` 连接 9451 端口的隔离 Tauri QA 应用，先验证应用 identifier，再执行原生下载桥接、生成、播放、剪辑与 WAV 导出。测试不应该连接用户的正式应用数据目录。
