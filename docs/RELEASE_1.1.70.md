# LevelUpAgent 1.1.70 发布记录

日期：2026-10-09。当前状态：已发布到 GitHub，正式 Release 为 `v1.1.70`，已设为 Latest。

## 本版内容

- 修复创作空间图片编辑器的画布适配，打开图片时完整显示画布。
- 图片编辑器支持按住空格自由拖动画布，改善上下拖动受限的问题。
- 创作历史中每张图片显示真实像素宽高，在时间行右侧对齐。

## 发布前检查

- 应用、Tauri、Cargo 及锁文件版本统一为 `1.1.70`。
- `pnpm install --frozen-lockfile`、`pnpm build` 通过。
- `pnpm check`：296 项通过；外观守卫及发布配置检查通过。
- `cargo test`：536 项通过、4 项按条件忽略、0 失败。
- `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。
- 发布 tag：`v1.1.70`；Windows updater 沿用既有签名配置。

本机日志及资产验证证据：`G:\Work\LevelUpAgent\research\release-1.1.70-2026-10-08`。

## 验证边界

本次发布通过本地回归检查和 GitHub 原生 runner 构建验证。未执行 Windows 现有安装覆盖、旧版应用内更新或 Linux 实体机安装。
macOS 由原生 runner 验证 DMG 内及模拟复制安装后的应用签名。

Windows updater 签名不等同于 Authenticode。macOS 使用 ad-hoc 签名且未公证；Linux 包未做发行版签名。自动更新清单仅覆盖 Windows。

## 已发布结果

- 构建提交：`9fa7898024faef4ee8cf230977de644411e9915b`，tag：`v1.1.70`。
- 发布时间：北京时间 2026-10-09 00:32:57，正式发布且已设为 Latest，非预发布。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/37803173487) 全部通过。
- [四平台 Release 工作流](https://github.com/TippingGame/LevelUpAgent/actions/runs/37803201706) 全部通过。
- 正式 Release：[LevelUpAgent v1.1.70](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.1.70)。Windows x64 EXE/MSI、Apple Silicon/Intel DMG、Linux x64 AppImage/DEB/RPM、Windows 签名及更新清单共 10 个资产齐全。
- 10 个资产均完整下载，大小和 SHA-256 与 GitHub digest 一致；Windows EXE/MSI updater 签名及可信注释签名通过现有公钥验证。
- 公开 `latest.json` 返回 HTTP 200，版本为 `1.1.70`，URL 和签名均指向本次 Windows 资产；正式发布页返回 HTTP 200。
- Windows EXE 的 FileVersion/ProductVersion 均为 `1.1.70`；两个 macOS 包均在原生 runner 完成 DMG 内和模拟复制安装后应用签名验证。
- 本机安装包：`G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.70_Windows_x64-setup.exe`，保留旧版，新增 `SHA256_1.1.70.txt` 并更新总清单 `SHA256.txt`。
- EXE 大小：14,450,900 字节；SHA-256：`C47E64928036FA894AC9C9A3BE6FE4CC4D2357BF1055E5B5459E55A634FCE7AF`。
