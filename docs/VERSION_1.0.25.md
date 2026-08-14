# LevelUpAgent 1.0.25 版本说明

## 桌面会话统一使用持久化 Harness

- 普通聊天、宠物聊天、主题生成和“摇光残影”孵化现在都通过持久化 Durable Harness 执行。
- 桌面端旧的 React 递归执行链路已移除；浏览器预览保留的本地 loop 不参与正式桌面运行。
- 历史消息继续保留，但恢复历史会话时创建新的 Harness operation 和 snapshot，不再复用已经失效的 operation UUID。

## 重启恢复与状态一致性

- Harness operation、current snapshot、审批请求、Goal token/turn 用量和孵化运行目录都持久化到本地数据库。
- 修复新会话在 `harness_start` 前落库的竞态，避免出现 `Harness operation has no current snapshot`。
- 重启应用后可以恢复待处理审批和 operation owner；多轮 input/output token 统计会累计而不是互相覆盖。
- 历史孵化会话从最新 Harness snapshot 恢复 canonical run directory，并继续执行来源证明和包内路径校验。

## 孵化安全边界

- `run_command` 只允许执行包内确定性脚本，并校验 source provenance、canonical run directory 和允许参数。
- 重复命令会触发熔断；只查询状态而不执行具体动作的调用会被拒绝。
- 原有最小权限审批边界保持不变，Shell 拼接、相对路径、伪造 metadata 和白名单外脚本仍不能绕过审批。

## 验证与发布

- TypeScript 检查、前端构建、Rust 格式检查、测试和 `clippy -D warnings` 均通过。
- Windows 正式安装包由 GitHub Actions 构建，包含 NSIS、MSI、对应 `.sig` 和 `latest.json`。

Tauri updater 签名用于验证更新包完整性与发布来源，不等同于 Windows Authenticode；安装包仍可能触发 SmartScreen 的未知发布者提示。
