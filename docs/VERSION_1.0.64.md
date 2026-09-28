# LevelUpAgent v1.0.64

## 修复 Windows 旧版本卸载失败

- 修复 1.0.63 修改发布者名称后，从旧版升级时选择“先卸载再安装”出现 `Unable to uninstall!` 的问题。
- 从旧版实际卸载记录定位安装目录，兼容 `levelup` 和 `TippingGame` 发布者以及自定义安装路径。
- 修复带中文、空格的路径和安装记录版本滞后情况下的目录识别；拒绝用空目录参数调用卸载程序。
- 静默安装和应用内更新沿用原安装目录；正常升级保留会话和设置，卸载时仍可由用户选择是否删除应用数据。
- 保留 1.0.63 的重复回复修复；不自动清理历史重复消息。

## 验证与发布

- 新增原生 NSIS 回归测试，复现旧错误码并验证升级目录解析、旧版卸载及测试数据保留。
- 技术说明见 [Windows 安装器兼容性](WINDOWS_INSTALLER_COMPATIBILITY.md)。
- Windows x64 提供 NSIS、MSI 和既有密钥签名的自动更新产物；macOS 提供 Apple Silicon / Intel DMG；Linux 提供 AppImage、DEB、RPM。
- Windows 未配置 Authenticode；macOS 使用 ad-hoc 签名，尚未公证。
- 以新版本 1.0.64 发布，保留已经公开的 1.0.63 安装包和签名。

## English

Fixes `Unable to uninstall!` when upgrading older Windows NSIS installations after
the publisher rename in 1.0.63. The installer now resolves the existing directory
from its registered uninstaller, preserves custom locations, and rejects empty or
malformed uninstall paths. Normal upgrades preserve application data. Includes the
duplicate-reply fix from 1.0.63; existing duplicate history is not removed.
