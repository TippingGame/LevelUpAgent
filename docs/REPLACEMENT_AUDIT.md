# 替代能力审计（0.12.0）

本审计区分“已经由 LevelUpAgent 原生承担”和“仍需保留其他工具”。结论以当前代码、自动化测试
和可构建安装包为准，不以路线图意图代替交付。

| 能力 | 0.12.0 状态 | 证据/边界 |
| --- | --- | --- |
| 多 Provider 与四协议 | 已完成 | Responses、Chat、Messages、Gemini 均支持工具调用和 SSE |
| LevelUpAPI 日常使用 | 已完成 | 模型列表、四线协议、`/health`、`/v1/usage`、request-id |
| CCSwitch 风格余额读取 | 原生替代 | 首页钱包/订阅/Key 额度兼容胶囊，自动/手动刷新，密钥不进入前端 |
| Provider 健康与接管 | 已完成 | SQLite 连接元数据/当前选择、优先级、指数冷却、持久统计、流式输出后禁止切换 |
| cc-switch 配置迁移 | 核心完成 | 可读 cc-switch/Codex/Claude/Gemini/OpenCode |
| 外部 CLI 配置写回 | 核心完成 | Codex/Claude/Gemini/OpenCode 有脱敏预览、备份、原子替换、回滚 |
| MCP 与 Skill | 已完成 | stdio/HTTP MCP、凭据隔离；多目录 Skill 发现与按需读取 |
| Agent 执行与长期 Goal | 已完成 | 工具审批、持久 Goal、预算、两阶段完成/阻塞审计；长历史按预算压缩且保持工具调用配对 |
| CodexPlusPlus 会话增强 | 原生替代 | LevelUpAgent 自己持有会话，不依赖 CDP 注入第三方 UI |
| 图片输入 | 已完成 | 托管存储、四协议编码、格式/大小/数量边界 |
| 文本/代码上下文附件 | 已完成 | 托管 UTF-8 文件、扩展/大小边界、四协议 user context |
| PDF/Office 文档提取 | 已完成 | 本地解析 PDF、DOCX、XLSX、PPTX；OOXML 防展开炸弹；确定性摘录 |
| Prompt/Instructions 控制面 | 已完成 | 内部注入及 Codex/Claude/Gemini/OpenCode 安全同步 |
| 子 Agent / 隔离工作树 | 已完成 | 受限子模型循环、detached worktree、完整补丁、二次批准与冲突拒绝 |
| 本地请求日志浏览器 | 已完成 | 模型筛选、成功率、延迟、Token、接管、request-id 与错误 |
| Git 变更审查与回滚 | 已完成 | 逐文件 diff、两阶段确认、快照复核、tracked restore 与 untracked delete |
| 本地安全边界 | 已审计 | 路径/symlink、凭据、MCP TLS、配置导出、附件、子 Agent 与 updater |
| 签名与自动更新 | 代码完成/凭据待验收 | updater 运行时、签名产物、CI 门禁已接入；缺所有者 URL/证书实体机验收 |
| 中英文完整本地化 | 已完成 | 系统语言检测、持久切换、全部静态 UI/ARIA/状态文案与 locale 时间 |
| Windows/Linux 可运行包 | 已完成 | Windows MSI/NSIS；Linux DEB/RPM/AppImage，含实际启动和 DEB 安装验收 |

因此，`0.12.0` 已可在日常多模型开发工作流中停止依赖 cc-switch/CodexPlusPlus。全量卸载的最终
1.0 验收仍需仓库所有者提供发布 URL、Windows/Apple 签名凭据，并在 macOS 实体机验证安装、
升级和回滚。
