# LevelUpAgent 1.1.66 发布记录

日期：2026-10-05。当前状态：已发布到 GitHub，正式 Release 为 `v1.1.66`，已设为 Latest。

## 本版内容

- 修复流式请求在 `stream disconnected before completion`、`Upstream request failed`、EOF、上游 5xx、过载和临时限流等情况下没有自动重连的问题。
- 区分可重连、切换备用 Provider 和不可重试的错误；已产生部分文本时重试会清理未完成输出，避免内容拼接。
- 修复摇光残影桌宠孵化流程把无图片生成和像素检查能力的隔离子代理暴露给主流程的问题。
- 修复主题生成流程的同类问题：主题和桌宠均在主会话继续生成，不再要求隔离子代理或干净 Git 工作区；Full 权限下保留宿主图片生成/检查能力，受限主题生成仍只开放直接写入主题包。
- 改进 Spine 工作台蒙皮方向、末端骨骼变形、呼吸/弹性/波动预设和助手交互。

## 发布前检查

- 应用、Tauri、Cargo 和锁文件版本统一为 `1.1.66`。
- `pnpm install --frozen-lockfile`、`pnpm build` 通过。
- `pnpm check`：296 项通过，0 失败。
- `cargo test`：529 项通过，4 项按条件忽略，0 失败。
- `cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings` 通过。
- `git diff --check` 通过。
- 已增加断流重连、孵化和主题生成工具目录/策略回归测试。
- 隔离 Tauri 原生回归通过：Full 权限的主题/孵化工具目录均不包含隔离子代理；模型强行调用两个子代理工具时均被阻止，无审批弹窗，主会话随后正常完成。
- 原生主题生命周期通过：生成、验证、安装、启用、关闭重启、恢复、切回默认主题和卸载。孵化工具目录确认保留 `generate_images` 与 `view_image`。

本机检查日志：`G:\Work\LevelUpAgent\research\release-1.1.66-2026-10-05`。

## 验证边界

原生 Tauri smoke 使用独立应用标识和本地 mock provider，验证工具目录、权限和主题生命周期，不调用真实图片服务，也不改动生产应用数据。没有在本次发布前重新生成完整的摇光残影素材；真实图片生成结果仍取决于配置的图片 Provider。

本次未在用户现有应用上执行覆盖安装或从旧版本完成应用内更新；Linux 实体机安装未验证。macOS 在原生 runner 验证了 DMG 内和模拟复制安装后的应用签名。

Windows updater 使用原有 Tauri 签名配置；它不等同于 Authenticode。macOS 使用 ad-hoc 签名且未公证；Linux 包未做发行版签名。更新清单仅覆盖 Windows。

## 打包与发布步骤

1. 提交发布准备变更并推送 `main`。
2. 创建并推送 `v1.1.66`，由 Release 工作流生成 Draft。
3. 核对 Windows EXE/MSI 及签名、两个 macOS DMG、Linux AppImage/DEB/RPM 和 `latest.json`。
4. 核对资产、签名和更新清单后公开发布并设为 Latest。
5. 验证公开 `latest.json`，并同步正式 Windows EXE 到本机安装包目录。

## 已发布结果

- 构建提交：`dc4b3065e72cac9e55674cf5f0c9566b980109a4`，tag：`v1.1.66`。发布于北京时间 2026-10-05 19:21:15，已设为 Latest，非预发布。
- [发布前 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/37297299227) 的 Windows、macOS、Linux 三个 job 全部通过。
- [Release 工作流](https://github.com/TippingGame/LevelUpAgent/actions/runs/37297320357) 成功，四个平台资产均已上传。Apple Silicon 首次在 `hdiutil verify` 遇到 `Resource temporarily unavailable`；仅重跑失败作业后通过，未更改构建提交或 tag。
- 正式 Release：[github.com/TippingGame/LevelUpAgent/releases/tag/v1.1.66](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.1.66)。
- 公开 Release 页面和更新清单均返回 HTTP 200；更新清单版本为 `1.1.66`，与已校验的 Draft 清单逐字一致。
- 10 个发布资产均已完整下载，本地大小和 SHA-256 与 GitHub digest 一致；Windows EXE/MSI 的 Tauri updater 签名均通过公钥验证，清单中的 URL 和签名与安装包一致。
- Windows EXE 的归档完整性检查通过，ProductVersion/FileVersion 均为 `1.1.66`。两种 macOS DMG 均完成 runner 上的签名及模拟安装复制校验。
- 正式 Windows EXE 已同步到 `G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.66_Windows_x64-setup.exe`，保留旧版本；已新增 `SHA256_1.1.66.txt` 并更新总清单 `SHA256.txt`。
- EXE 大小：14,224,017 字节；SHA-256：`3274BF5B8EF7556257CC88E27C14D3943E6AF91D0B7F113DBC7A752DEC4FA9CD`。
- 资产、签名、原生 smoke、Actions 日志与公开更新清单的验证证据保存在 `G:\Work\LevelUpAgent\research\release-1.1.66-2026-10-05`。
