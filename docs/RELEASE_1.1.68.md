# LevelUpAgent 1.1.68 发布记录

日期：2026-10-07。当前状态：已发布到 GitHub，正式 Release 为 `v1.1.68`，已设为 Latest。

## 本版内容

- 创作空间和星图支持自定义图片模型名称的大小写不敏感匹配。
- 图片模型候选补充 `Image`、`Seedream` 和 `NovelAI` 名称，同时继续排除视频模型。
- 修复部分没有文件扩展名的 OpenAI 图片 URL 处理。
- 修复侧栏交互和常规设置在系统深色模式下的显示。

## 发布前检查

- 应用、Tauri、Cargo 及锁文件版本统一为 `1.1.68`。
- `pnpm install --frozen-lockfile`、`pnpm build` 通过。
- `pnpm check`：296 项通过；外观守卫 4 项通过，发布配置检查通过。
- `cargo test`：531 项通过、4 项按条件忽略、0 失败。
- `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。
- 发布 tag：`v1.1.68`；Windows updater 使用既有签名密钥和公开更新清单。

本机日志及资产验证证据：`G:\Work\LevelUpAgent\research\release-1.1.68-2026-10-07`。

## 验证边界

本次未调用真实上游生图服务，未执行 Windows 现有安装覆盖、旧版应用内更新或 Linux 实体机安装。
macOS 由原生 runner 验证 DMG 内及模拟复制安装后的应用签名。

Windows updater 使用原有 Tauri 签名配置，不等同于 Authenticode。macOS 使用 ad-hoc 签名且未公证；
Linux 包未做发行版签名。自动更新清单仅覆盖 Windows。

## 已发布结果

- 构建提交：`3774e14814ed619cad80efee99a7b5c3dfdb9ae1`，tag：`v1.1.68`。
- 发布时间：北京时间 2026-10-07 04:23:34，正式发布且已设为 Latest，非预发布。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/37521611398) 全部通过。
- [四平台 Release 工作流](https://github.com/TippingGame/LevelUpAgent/actions/runs/37521631101) 全部通过。Windows 首次已完成 Rust 编译，但下载 `nsis_tauri_utils-v0.5.3` 辅助 DLL 时 GitHub 返回 HTTP 500；仅重跑失败作业后成功，未更改构建提交或 tag。
- 正式 Release：[LevelUpAgent v1.1.68](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.1.68)。Windows x64 EXE/MSI、Apple Silicon/Intel DMG、Linux x64 AppImage/DEB/RPM、Windows 签名及更新清单共 10 个资产齐全。
- 发布页及公开 `latest.json` 均返回 HTTP 200；清单版本为 `1.1.68`，与发布前核验的清单逐字一致，URL 和签名均指向本次资产。
- 10 个资产均完整下载，大小和 SHA-256 与 GitHub digest 一致；Windows EXE/MSI updater 签名及可信注释签名通过现有公钥验证。
- Windows EXE 的 FileVersion/ProductVersion 均为 `1.1.68`；两个 macOS 包均在原生 runner 完成 DMG 内和模拟复制安装后应用签名验证。
- 本机安装包：`G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.68_Windows_x64-setup.exe`，已保留旧版，并新增 `SHA256_1.1.68.txt`、更新总清单 `SHA256.txt`。
- EXE 大小：14,224,812 字节；SHA-256：`BECEFE149F2F2EF24E46BBB24789FBDF7455BB0522E8232F619CBB4F854A143E`。
- Actions 日志、首轮 Windows 下载故障、资产哈希、签名及公开更新清单核验保存在上述本机证据目录。
