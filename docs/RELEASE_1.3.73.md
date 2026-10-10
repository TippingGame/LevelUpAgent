# LevelUpAgent 1.3.73 发布记录

日期：2026-10-10。状态：已发布到 GitHub，正式 Release 为 `v1.3.73`，已设为 Latest。

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

- 构建提交：`d3ab6a0ce8fba45e1115d303d9893e763482ecda`，tag：`v1.3.73`。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/38010254505) 全部成功；Windows Rust 543 项通过，macOS／Linux 各 544 项通过，各平台 5 项按条件忽略。
- 音频 Python 5 项在三个原生 runner 全部通过；3D Python 16 项在 macOS／Linux 全部通过，Windows 14 项通过、2 项按平台跳过。
- 音频全部 6 个分卷首尾 64 KiB 共 12 次匿名 Range 请求均返回 HTTP 206，范围与本地字节一致。

- [四平台 Release](https://github.com/TippingGame/LevelUpAgent/actions/runs/38010355807) 全部成功；两个 macOS 包均通过原生 runner 的 DMG 校验、包内签名与模拟复制安装后的签名验证。
- Windows EXE 完整性检查通过。安装器及主程序 FileVersion／ProductVersion 均为 `1.3.73`，主程序架构 x64；65 个内置资源忽略文本换行差异后与源码一致，正式 CSP、updater 公钥和地址正确，没有 QA 标识。

## 发布结果

- 正式 Release：[LevelUpAgent v1.3.73](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.3.73)，Release ID `408463553`。
- 发布时间：北京时间 **2026-10-10 09:04:34**，已设为 Latest，非预发布。
- Windows EXE/MSI、Apple Silicon/Intel DMG、Linux AppImage/DEB/RPM、Windows 签名及更新清单共 10 个资产齐全；全部完整下载，大小与 SHA256 均匹配 GitHub digest。
- Windows EXE/MSI updater 签名和可信注释签名通过现有公钥验证，`latest.json` 的 URL 和签名匹配本次资产。
- 匿名公共 `latest.json` 与正式发布页均返回 HTTP 200；清单版本为 `1.3.73`，内容与验签时的清单逐字节一致。
- 音频资源于北京时间 08:41:23 先行公开为 prerelease；3D 资源继续复用。两个资源 Release 均不占应用 Latest。
- Windows EXE 已同步到 `G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.3.73_Windows_x64-setup.exe`；保留旧版，新增 `SHA256_1.3.73.txt` 并更新总清单与测试说明。
- EXE 大小：14,895,729 字节；SHA256：`A59FD597B3FF89C42832FE51192860C089D3F4470592CC381D3AE445215F6147`。

本地完整文件下载曾停滞，采用分段下载后完成；每个合并文件都通过完整 SHA256 校验，未改动远端资产。
发布记录、音频验收记录及仓库内外两份手册在发布后同步；应用 tag 与签名资产保持原构建提交。

## 使用与验证边界

当前本地音频仅支持 Windows x64，MusicGen Small 权重为 **CC-BY-NC-4.0，仅限非商业用途**。
它生成短纯音乐，不支持按歌词演唱。首次获取资源后可离线生成。
原始 LevelUpMusic 原型及旧作品库保留，正式应用使用独立作品库。

Windows 未配置 Authenticode；macOS 使用 ad-hoc 签名，尚未公证；Linux 包未做发行版签名。
原生音频功能验收使用隔离应用数据；本轮检查正式 Windows 包但未覆盖用户现有安装，也未从旧版执行应用内更新。
macOS 完成原生 runner 的签名与模拟复制安装验证；本轮未新增 macOS／Linux 实体机交互验收。
