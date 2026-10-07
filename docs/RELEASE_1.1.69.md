# LevelUpAgent 1.1.69 发布记录

日期：2026-10-07。当前状态：本地检查通过，待四平台构建及 Draft 资产核验完成后正式发布。

## 本版内容

- 移除模型生成请求的 90/240/360/1860 秒客户端硬超时，等待上游返回或用户取消；保留连接超时、有限重试和停止/steer 取消。
- 保留上游 HTTP 状态及错误详情，方便定位 403、404 和服务端错误。
- 大网页不再因旧 4 MiB 限制直接失败，返回可读取内容并标明截断。
- 使用 HTML5 解析器提取正文，正确处理脚本、属性和 HTML 实体。
- 搜索域名限制同时应用于查询和结果校验。
- 最新图片批次超过四张时完整传入视觉请求，并补充六图批次回归测试。

## 发布前检查

- 应用、Tauri、Cargo 及锁文件版本统一为 `1.1.69`。
- `pnpm install --frozen-lockfile`、`pnpm build` 通过。
- `pnpm check`：296 项通过；外观守卫及发布配置检查通过。
- `cargo test`：536 项通过、4 项按条件忽略、0 失败。
- `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。
- 发布 tag：`v1.1.69`；Windows updater 使用既有签名密钥和公开更新清单。

本机日志及资产验证证据：`G:\Work\LevelUpAgent\research\release-1.1.69-2026-10-07`。

## 验证边界

本次通过本地回归测试和 GitHub 原生 runner 构建验证；不以此声称真实上游站点的 403/404 已消失。
未执行 Windows 现有安装覆盖、旧版应用内更新或 Linux 实体机安装。
macOS 由原生 runner 验证 DMG 内及模拟复制安装后的应用签名。

Windows updater 使用原有 Tauri 签名配置，不等同于 Authenticode。macOS 使用 ad-hoc 签名且未公证；
Linux 包未做发行版签名。自动更新清单仅覆盖 Windows。
