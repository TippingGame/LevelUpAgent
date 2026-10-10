# LevelUpAgent 1.3.73 发布记录

日期：2026-10-10。状态：准备发布；构建、签名及公开下载结果在实际验收后补录。

## 本版内容

- 创作空间新增本地音频工作台，保留“描述 → 生成 → 试听 → 保存”的简约流程。
- MusicGen Small 生成 4–30 秒纯音乐，支持作品收藏、归档、复用参数、WAV 导出、裁剪与淡入淡出另存。
- 显示可用显存、内存、磁盘空间与资源不足提示；生成结束释放模型，任务按队列依次运行。
- Python、PyTorch / CUDA 和模型不进入主安装包，首次按需下载；展示进度、速度、预计剩余时间，支持续传、SHA256 校验、取消和离线导入。
- 音频资源版本 `2026.10.1`，固定在 `music-workbench-resources` Release。约 4.88 GiB 下载、9.26 GiB 安装，安装时预留约 20 GiB 空间。
- 3D 资源继续复用既有 `model-workbench-resources` Release；两种共享资源均作为 prerelease 分发，不占用应用 Latest。

## 功能验收

真实 Windows Tauri 与独立 Python / CUDA 已完成生成、实际播放、收藏、裁剪、导出、取消与重启验收。
RTX 3080 Ti 上生成 3.94 秒 WAV，推理约 4.66 秒，PyTorch 分配显存峰值 2.317 GiB；不代表长音频或整卡占用。
界面验证覆盖系统深浅色 × Armor Mode 开关、弹窗、创作空间导航和 720px 窄窗口。

详细记录：[音频工作台集成验收](AUDIO_WORKBENCH_VALIDATION.md)。
发布证据目录：`G:\Work\LevelUpAgent\research\release-1.3.73-2026-10-10`。

## 发布检查与结果

- 应用、Tauri、Cargo 与锁文件统一为 `1.3.73`。
- 本地 `pnpm install --frozen-lockfile`、`pnpm check`（299 项及外观／发布配置检查）、`pnpm build` 通过。
- `cargo fmt --check`、`cargo test`（543 通过、5 按条件忽略）、`cargo clippy --all-targets -- -D warnings` 通过；Clippy 修正后音频 Rust 常规测试 5 项再次通过。
- 音频 Python 测试 5 项全部通过；3D Python 测试 Windows 14 项通过、2 项按平台跳过。
- CI、Release、音频资源工作流通过 actionlint 检查。
- 音频资源 `2026.10.1` 已公开，6 个分卷和清单大小／GitHub digest 一致，匿名清单返回 HTTP 200。
- 3D 资源公开清单返回 HTTP 200，14 个分卷大小／digest 与清单匹配；两种资源保持 prerelease，不占应用 Latest。

接下来按 [发布手册](RELEASE_GUIDE.md) 验收三平台 CI、四平台打包、10 项资产和 Windows updater 签名，并验证公共 `latest.json`。

## 使用与验证边界

当前本地音频仅支持 Windows x64，MusicGen Small 权重为 **CC-BY-NC-4.0，仅限非商业用途**。
它生成短纯音乐，不支持按歌词演唱。首次获取资源后可离线生成。
原始 LevelUpMusic 原型及旧作品库保留，正式应用使用独立作品库。

Windows 未配置 Authenticode；macOS 使用 ad-hoc 签名，尚未公证；Linux 包未做发行版签名。
原生功能验收使用隔离应用数据，用户现有安装与作品不受影响；实体机安装／更新验收范围在发布结果中如实记录。
