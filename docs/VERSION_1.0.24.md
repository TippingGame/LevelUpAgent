# LevelUpAgent 1.0.24 版本说明

## Windows 一键孵化修复

- 修复正式 Windows 环境使用 `G:\...\prepare_pet_run.py` 与 `C:\...\pet-hatch\...` 路径时，前端 bootstrap metadata 只识别正斜杠，导致准备脚本被原生安全边界误拒绝的问题。
- `prepare_pet_run.py` 和 `pet_job_status.py` 现在都能从应用生成的带引号 Windows 命令中保留完整反斜杠路径，并将可信脚本路径和运行目录交给原生层复核。
- 新增与正式运行环境一致的 Windows prepare/status 命令回归测试，防止仅使用 `C:/...` 测试路径再次漏掉该问题。

## 安全边界保持不变

- 本次修复只补全 Windows 路径分隔符识别，不扩大 bootstrap 工具或脚本白名单。
- 原生层仍会校验固定 Python 调用、内置 hatch-pet 脚本的规范绝对路径、应用孵化工作目录和允许参数。
- 相对路径、白名单外脚本、Shell 拼接、伪造 metadata 和其他工具调用仍不会绕过正常审批。

## 验证

- 使用当前机器实际生成的 `levelup-pet-hatch.json` 路径完成请求级回归验证。
- TypeScript 检查、完整前端测试、生产构建和 Rust bootstrap 安全测试均通过。
- Windows x64 NSIS/MSI Release 安装包完成本地构建验证；正式更新资产由 GitHub Actions 使用 Tauri updater 私钥签名。

Tauri updater 签名用于验证更新包完整性与发布来源，不等同于 Windows Authenticode；安装包仍可能触发 SmartScreen 的未知发布者提示。
