# LevelUpAgent 1.1.70 发布记录

日期：2026-10-08。当前状态：准备发布，正式发布结果将在完成核验后补充。

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
