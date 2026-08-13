# LevelUpAgent 1.0.23 版本说明

## 摇光残影一键孵化

- 修复应用自动执行孵化准备与状态检查时漏传 bootstrap 语义，导致 Harness 将内置步骤误判为普通命令并要求审批的问题。
- 为应用自有孵化步骤增加统一、命名参数化的请求入口，技能清单、必要参考文档、准备脚本和状态脚本使用同一条受控链路。
- 保留 `1.0.22` 的自主求知能力：摇光残影仍可根据主人近期输入、当天计划和行为状态自主形成问题并向 Agent 求解，无需开始共学。

## 安全边界

- bootstrap 仅允许读取内置 hatch-pet 技能清单及三份必要参考文档。
- 命令执行仅允许固定 Python 调用内置 `prepare_pet_run.py` 和 `pet_job_status.py`，同时校验绝对脚本路径、应用孵化工作目录与允许参数。
- 相对路径、白名单外脚本、Shell 拼接、伪造 metadata 和其他工具调用不会绕过正常审批。

## 验证

- 新增前端 bootstrap 请求语义与可信 metadata 回归测试。
- TypeScript 检查、前端生产构建、Rust 格式检查、测试与 Clippy 均通过。
- Windows x64 NSIS/MSI Release 安装包已完成本地构建验证；正式更新资产由 GitHub Actions 使用 Tauri updater 私钥签名。

Tauri updater 签名用于验证更新包完整性与发布来源，不等同于 Windows Authenticode；安装包仍可能触发 SmartScreen 的未知发布者提示。
