# LevelUpAgent 1.1.69 发布记录

日期：2026-10-07。当前状态：已发布到 GitHub，正式 Release 为 `v1.1.69`，已设为 Latest。

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

## 已发布结果

- 构建提交：`807964d11ecc5e49156c0e949d4280a3a619bfac`，tag：`v1.1.69`。
- 发布时间：北京时间 2026-10-07 19:23:10，正式发布且已设为 Latest，非预发布。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/37600393933) 全部通过。
- [四平台 Release 工作流](https://github.com/TippingGame/LevelUpAgent/actions/runs/37600398546) 全部通过。
- 正式 Release：[LevelUpAgent v1.1.69](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.1.69)。Windows x64 EXE/MSI、Apple Silicon/Intel DMG、Linux x64 AppImage/DEB/RPM、Windows 签名及更新清单共 10 个资产齐全。
- 10 个资产均完整下载，大小和 SHA-256 与 GitHub digest 一致；Windows EXE/MSI updater 签名及可信注释签名通过现有公钥验证。
- 公开 `latest.json` 返回 HTTP 200，版本为 `1.1.69`，URL 和签名均指向本次 Windows 资产；正式发布页也返回 HTTP 200。
- Windows EXE 的 FileVersion/ProductVersion 均为 `1.1.69`；两个 macOS 包均在原生 runner 完成 DMG 内和模拟复制安装后应用签名验证。
- 本机安装包：`G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.69_Windows_x64-setup.exe`，已保留旧版，并新增 `SHA256_1.1.69.txt`、更新总清单 `SHA256.txt`。
- EXE 大小：14,461,461 字节；SHA-256：`2E1FA2DC4F75A7347B9F1F9CC0DE2133E2CDD7EFD5170189943536279E57BEF2`。
