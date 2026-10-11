# LevelUpAgent 1.3.75 发布记录

日期：2026-10-11。状态：已发布到 GitHub，正式 Release 为 `v1.3.75`，已设为 Latest。

## 本版内容

- 创作空间音频工作台新增 ACE-Step 1.5 Turbo 和 YuE2，支持纯音乐与按歌词演唱；保留 MusicGen Small、已有作品、试听、收藏、归档、参数复用、裁剪与 WAV 导出。
- 默认使用 ACE-Step；歌曲模式提供歌词与语言。ACE-Step 目标时长 10–600 秒，YuE2 最大时长 8–360 秒，MusicGen 保留 4–30 秒。YuE2 达到上限时如实提示结尾或歌词可能未完成。
- 模型与运行环境按引擎独立下载或离线导入，显示显存／内存、磁盘需求，以及下载、校验、解压进度。大型资源不进入主安装包。
- 安装期间保留已有作品列表和试听／导出，刷新页面也可恢复；取消与窗口退出释放推理进程，重启保留作品。重新导入可修复缺失或被截断的模型文件。
- 修复 Python 3.12 下 SQLite 连接未及时关闭的问题，避免 Windows 文件占用。

## 验证

RTX 3080 Ti 12 GiB、约 64 GiB RAM，两个引擎均在各自可搬迁 Python 环境中实际运行，无需先安装 MusicGen。

| 引擎与请求 | 实际输出 | Worker 耗时 | PyTorch 峰值分配显存 |
| --- | --- | --- | --- |
| ACE-Step 中文歌词，45 秒 | 45.000 秒 | 15.78 秒 | 4.557 GiB |
| ACE-Step 中文歌词，180 秒 | 180.000 秒 | 23.50 秒 | 4.800 GiB |
| YuE2 中文歌词，最大 45 秒 | 约 45 秒，提示截断 | 96.16 秒 | 7.247 GiB |
| YuE2 中文歌词，最大 180 秒 | 61.559 秒，自然结束 | 171.59 秒 | 7.450 GiB |

- 两个引擎均通过真实 Tauri 离线安装、UI 生成歌曲、asset 协议播放、收藏、裁剪、导出及原生纯音乐生成；关闭运行任务并重启后，取消状态及旧作品保留。
- 浅色／深色 × Armor Mode 关／开，弹窗、焦点、hover、禁用态、720／1100／1440 布局、导航往返与刷新通过，无 JS 错误，外观基线未扩增。
- 本地前端 299 项与外观／发布配置检查、Rust 547 项（5 项显式忽略）、全目标 Clippy、格式检查、生产构建和 actionlint 通过。音频 Python 6 项分别在 Python 3.10 与 3.12 通过。
- 详细记录：[双引擎接入验收](AUDIO_ENGINES_INTEGRATION.md)。本机证据在 `artifacts/music-workbench/multi-engine/`。

## 独立资源与边界

| 引擎 | 资源版本 | 分卷 | 下载 | 安装 |
| --- | --- | --- | --- | --- |
| ACE-Step | `2026.10.11-acestep` | 10 | 8.01 GiB | 11.64 GiB |
| YuE2 | `2026.10.11-yue2` | 11 | 8.69 GiB | 11.64 GiB |
| MusicGen | `2026.10.1`，继续复用 | 6 | 4.88 GiB | 9.26 GiB |

均使用同一 `music-workbench-resources` 预发布资源页，不占应用 Latest；先核验公开资源，再发布应用。主包仅加入 9 个约 35 KiB 的音频控制文件。

本地音频当前支持 Windows x64；ACE-Step 与 YuE2 需要兼容 CUDA 12.8 的 NVIDIA GPU，YuE2 另要求 BF16 支持。ACE-Step 使用 MIT／Qwen3 Apache-2.0；YuE2 和 MusicGen 权重为 CC-BY-NC-4.0，非商业用途。

上述显存不是整卡占用，不保证所有时长与显卡均可运行；未验证 ACE-Step 600 秒、YuE2 实际 360 秒，也未做主观评分或逐字歌词准确率评估。输入歌词是生成条件，可能改唱或漏唱。ACE-Step 当前不包含可选 5Hz LM；转谱、翻唱和乐谱编辑不属于本次发布。

Windows updater 使用签名校验，未配置 Authenticode；macOS 使用 ad-hoc 签名，尚未公证；Linux 包未做发行版签名。没有覆盖用户现有安装或作品库。

应用发布证据目录：`G:\Work\LevelUpAgent\research\release-1.3.75-2026-10-11`。

## 发布结果

- 正式 Release：[LevelUpAgent v1.3.75](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.3.75)，Release ID `409438669`；北京时间 **2026-10-11 14:23:57** 发布并设为 Latest，非预发布。
- 构建提交：`3cb7110985c683f8e3b0def76340d0b73084583c`，tag：`v1.3.75`。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/38114725194) 和 [四平台 Release](https://github.com/TippingGame/LevelUpAgent/actions/runs/38114726825) 全部成功。两个 macOS runner 均执行 DMG 校验、包内签名及模拟复制安装后的签名验证。
- 10 个应用资产完整下载，大小与 SHA256 全部匹配 GitHub digest；Windows EXE/MSI updater 签名及可信注释签名有效。公开发布页和 `latest.json` 均返回 HTTP 200，版本、URL、签名与已验证资产一致。
- Windows EXE 完整性、主程序 x64 架构、安装器／主程序版本 1.3.75、68 个内置资源、正式 CSP 和 updater 配置通过；没有 QA 标识或调试端口。
- 音频三个引擎共 27 个分卷及 3 份清单通过大小、GitHub SHA256 digest 和匿名下载校验。清单 HTTP 200，全部分卷首尾 64 KiB 的 Range 请求 HTTP 206 且字节相同；资源清单均在对应分卷核验后上传。
- 正式版本代码的隔离 Tauri 应用实际读取三个引擎的公开清单，浅色／深色 × Armor Mode 关／开四种外观的下载大小显示通过。3D 固定资源继续复用且公开校验通过；音频和 3D 资源均保持 prerelease、不占应用 Latest。
- MusicGen 旧资源回归生成 3.94 秒音频，worker 耗时 6.92 秒，PyTorch 峰值分配显存 2.317 GiB；既有 4 条任务和 WAV 哈希保持。证据：`legacy-musicgen-verification.json`。
- 正式 EXE 已同步到 `G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.3.75_Windows_x64-setup.exe`，保留旧版并更新版本／总 SHA256 清单；14,946,009 字节，SHA256：`184AEE1F269E4D5A57EBBEF6DF44025F9E7BD824B60C156F226140ACE1F8549D`。

本轮完成隔离 Windows 原生功能验收与正式安装包内容验证，未覆盖用户现有安装或执行旧版应用内更新；macOS／Linux 未新增实体机交互验收。应用 tag 与签名资产保留原构建提交，发布后仅同步文档记录。
