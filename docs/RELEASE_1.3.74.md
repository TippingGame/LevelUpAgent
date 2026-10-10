# LevelUpAgent 1.3.74 发布记录

日期：2026-10-11。状态：已发布到 GitHub，正式 Release 为 `v1.3.74`，已设为 Latest。

## 本版内容

- 会话图片不再受客户端单张／合计 64 MiB、粘贴数量和 `view_image` 8 MiB 限额拦截，不压缩或缩放原图。格式解析和文件访问检查保留，服务端限制与错误由上游返回。
- 大图请求使用常规五次重连策略；图片模型 Seedream 不再被错误纳入文本会话故障转移。
- 桌宠在隐藏、关闭主窗口／桌宠窗口及退出前保存最新原生位置，包含自主移动；重开时按显示器与工作区恢复。隐藏窗口不覆盖最后的可见位置。
- 中英文 README 重新设计，使用真实会话首页和创作空间首页两张新截图；六张创意图片通过现有生成管线产生并保留历史，截图已遮蔽账户余额。
- 主安装包继续复用音频和 3D 独立资源，不重复打包大型模型与依赖。

## 问题与验证

原始日志中的图片为 4,658,448 字节，上游约 127 秒后返回 HTTP 524；大图特殊策略只重连一次，随后错误切换到 Seedream，返回“图片 Responses 仅支持一个 image_generation 工具”。本版修复客户端拦截、重试差异与模型误选；不能消除上游网关自身的超时。

- 本地 `pnpm install --frozen-lockfile`、`pnpm check`（299 项及外观／发布配置检查）、`pnpm build` 通过。
- `cargo fmt --check`、`cargo test`（545 通过、5 忽略）及 `cargo clippy --all-targets -- -D warnings` 通过。
- 音频 Python 5 项通过；3D Python Windows 14 项通过、2 项按平台跳过。
- 大于旧限额的图片导入、四种协议原图编码、工具图像恢复与大图五次重连均有回归覆盖。原日志图片未提供，未将模拟上游验证当作原请求的实时复现。
- 六张创作示例均完成真实生成，保存参数、文件、SHA256 与追加历史记录；原有作品保留。
- 独立 Windows Tauri 验证隐藏、重复隐藏、关闭桌宠并重建、关闭主窗口再启动；最后一次原生坐标 `(650, 290)` 重启后精确恢复。负坐标显示器及小工作区由单元测试覆盖，本次未新增多显示器实体机验收。

## 平台与许可

Windows 未配置 Authenticode；macOS 使用 ad-hoc 签名，尚未公证；Linux 包未做发行版签名。
Windows updater 使用签名校验。macOS／Linux 仍以 Releases 手动下载安装。
本地音频目前仅支持 Windows x64，MusicGen Small 权重为 CC-BY-NC-4.0，仅限非商业用途。
3D 资源沿用 `linux-x64-cu118`，音频资源沿用 `windows-x64-cu128`，独立资源版本均为 `2026.10.1`。

证据目录：`G:\Work\LevelUpAgent\research\release-1.3.74-2026-10-11`。

## 发布结果

- 正式 Release：[LevelUpAgent v1.3.74](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.3.74)，Release ID `409193415`；北京时间 **2026-10-11 05:04:46** 发布并设为 Latest，非预发布。
- 构建提交：`4d7593e803a793757831903c68be265c0f818aba`，tag：`v1.3.74`。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/38083755127) 全部通过；Windows 首次因 Chocolatey 返回 504 缺少 NSIS，仅重跑失败作业后成功，未改动构建提交。
- [四平台 Release](https://github.com/TippingGame/LevelUpAgent/actions/runs/38084605371) 全部通过；两个 macOS runner 均执行 DMG 校验、包内签名和模拟复制安装后的签名验证。
- Windows EXE/MSI、Apple Silicon/Intel DMG、Linux AppImage/DEB/RPM、Windows 签名及更新清单共 10 个资产完整下载，大小与 SHA256 全部匹配 GitHub digest。
- Windows EXE/MSI updater 签名和可信注释签名有效；公开发布页与 `latest.json` 返回 HTTP 200，清单版本为 `1.3.74`，URL、签名与资产一致。
- Windows 安装包完整性、主程序 x64 架构、安装器／主程序版本、65 个内置资源、正式 CSP 与 updater 配置检查通过；没有演示标识或调试端口。
- 音频与 3D 共享资源清单匿名返回 200，全部分卷大小和 GitHub digest 匹配；继续保持 prerelease，不占应用 Latest。
- 正式 EXE 已同步到 `G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.3.74_Windows_x64-setup.exe`，保留旧版本并更新版本／总 SHA256 清单。大小 14,948,902 字节；SHA256：`CA7B61862761A3C2AFA851635A20D6503211319A0C8A35AFA3852729B9AB3B0A`。

本轮进行了独立 Windows Tauri 功能验收和正式安装包内容验证，未覆盖用户现有安装或执行旧版应用内更新。macOS 完成原生 runner 的签名与模拟安装验证；本轮未新增 macOS／Linux 实体机交互验收。应用 tag 与签名资产保留原构建提交，发布后仅同步文档记录。
