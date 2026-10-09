# LevelUpAgent 1.2.72 发布记录

日期：2026-10-09。状态：已发布到 GitHub，正式 Release 为 `v1.2.72`，已设为 Latest。

## 本版内容

- 修复 3D 贴图生成成功后桌面预览仍显示白模：补齐内嵌贴图读取所需的 CSP blob 权限，已有生成结果可直接显示。
- 3D 工作台复用 Spine 的纯色背景抠图，提供容差调整、透明预览、应用与还原。原图及已完成的形状/贴图保留，后续生成使用已应用参考图。
- 白底预处理只移除边缘连通的近白背景，保护主体内部浅色脸部和头发高光；贴图阶段不再沿用旧任务中受损的参考图。
- 修复 Windows 应用目录重定向下 Rust 与 WSL 读取不同作品目录的问题。
- 媒体生成等待上限延长到 10 分钟。
- 模型、Python / PyTorch / CUDA 和 Blender 继续复用通用资源 `2026.10.1`，无需随本版重新下载。

## 功能验证

- 带内嵌 PNG 的 GLB 浏览器回归复现旧策略的白模，并确认正式 CSP 可载入贴图。
- 参考图抠底、应用、还原通过系统浅/深色 × 装甲开/关和 720px 窗口检查。隔离 Windows WebView2 验证真实导入、保存、页面重载与还原，原图保留。
- RTX 3080 Ti / WSL2 对照使用相同网格、描述、种子 42、30 步和 2K 贴图，仅修复参考图。正式启动器贴图约 62.6 秒，PyTorch 显存保留峰值 2,354 MiB，网格位置最大偏差为 0。
- 美术质量仍需检查：该修复改善参考图损坏导致的乱纹，不保证消除所有接缝或原网格缺陷。

功能验收证据：`artifacts/model-workbench/texture-quality/`；发布证据：
`G:\Work\LevelUpAgent\research\release-1.2.72-2026-10-09`。

## 发布检查与结果

- 应用、Tauri、Cargo 及锁文件统一为 `1.2.72`。
- 本地 `pnpm install --frozen-lockfile`、`pnpm check`（299 项及外观/发布配置检查）、`pnpm build` 通过。
- `cargo fmt --check`、`cargo test`（538 通过、4 按条件忽略）、`cargo clippy --all-targets -- -D warnings` 通过。
- Python 16 项测试在 Windows 14 通过、2 按平台跳过；WSL 16 项全部通过，覆盖真实进程组取消和目录链接恢复。
- CI / Release 工作流通过 actionlint 检查。通用资源清单公开下载返回 200，14 个分片的大小与 GitHub digest 匹配，资源 Release 保持 prerelease、不占用 Latest。

- 构建提交：`3ff34012f3cbaac79f8cee57b34fc911aeda4a5a`，tag：`v1.2.72`。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/37934222275) 与 [四平台 Release](https://github.com/TippingGame/LevelUpAgent/actions/runs/37934223456) 全部成功。Windows Rust 测试 538 通过、Linux 539 通过；各平台按条件忽略 4 项。
- 两个 macOS 包均在原生 runner 完成 DMG 内及模拟复制安装后的签名验证。
- Windows EXE 解包核对 59 个资源文件，忽略文本换行差异后与源码一致；正式 CSP、updater 公钥和地址均存在，无 QA 页面或隔离应用标识。安装器和主程序的 FileVersion / ProductVersion 均为 `1.2.72`。

## 发布结果

- 正式 Release：[LevelUpAgent v1.2.72](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.2.72)，Release ID `407921564`。
- 发布时间：北京时间 2026-10-09 21:34:32，已设为 Latest，非预发布。
- Windows EXE/MSI、Apple Silicon/Intel DMG、Linux AppImage/DEB/RPM、Windows 签名及更新清单共 10 个资产齐全；全部完整下载，大小与 SHA-256 均与 GitHub digest 一致。
- Windows EXE/MSI updater 签名和可信注释签名通过现有公钥验证；`latest.json` 的下载 URL 和签名匹配本次资产。
- 未登录的公开 `latest.json` 与正式发布页均返回 HTTP 200；清单版本为 `1.2.72`，字节与已验签资产内的清单一致。
- 通用 3D 资源 `2026.10.1` 保持公开 prerelease，14 个分片的大小和 digest 与清单匹配；本次未重新打包或上传资源。
- Windows 安装包已同步至 `G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.2.72_Windows_x64-setup.exe`，保留旧版，新增 `SHA256_1.2.72.txt` 并更新总清单。
- EXE 大小：14,751,424 字节；SHA-256：`34149D774384A27F5E4794557A4E7940F6A576DCB00716B9EB2DE26EBEBC0B2A`。

下载过程中遇到本地连接缓慢，改用断点续传与分段下载；合并后的 AppImage 已通过完整 SHA-256 校验。未改动远端资产。

## 验证边界

Windows 原生功能验证使用隔离应用标识，未覆盖用户现有安装，也未执行从旧版本的应用内更新。
macOS 使用 ad-hoc 签名且未公证；Windows 未配置 Authenticode；Linux 包未做发行版签名。
本版仍使用已发布的通用 3D 资源，不重复打包或上传大依赖。
