# LevelUpAgent 1.1.68 发布记录

日期：2026-10-07。目标状态：通过 GitHub Actions 完成跨平台构建并正式发布为 `v1.1.68`。

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

## 发布结果

构建提交、Actions 运行记录、Release 资产、`latest.json` 和 SHA-256 校验值在发布完成后补充记录。
