# 交付路线图

## 0.1 基线

- [x] Tauri 2 + React 跨平台桌面骨架
- [x] LevelUpAPI / OpenAI / Anthropic / Gemini 四协议适配
- [x] 多连接创建、选择、检测和独立凭据
- [x] 系统凭据库
- [x] 项目会话与 Markdown
- [x] 读取、搜索、写入、命令工具
- [x] 写入与命令审批
- [x] 规划模式只读隔离
- [x] 工作区路径边界与工具轮次上限
- [x] 明暗主题、宽窄窗口视觉验证
- [x] 跨平台图标资产

## 0.2 日常可用

- [x] SSE 流式输出与中断
- [x] SQLite 会话、消息和工具事件存储
- [x] 连接复制、排序、健康状态与菜单快速切换
- [x] LevelUpAPI 用量、余额和请求 ID 诊断
- [x] request-id 消息关联
- [x] Git 状态与 diff 审查
- [x] Git 变更回滚（完整预览、一次性令牌、快照复核）
- [x] 文件附件和上下文选择（图片、UTF-8 文本/代码、PDF 与 Office）
- [x] Windows Tauri 签名更新运行时与发布凭据门禁

## 0.3 替代切换器

- [x] 导入 cc-switch 的 Codex、Claude、Gemini Provider
- [x] 读取 Codex、Claude、Gemini 现有配置
- [x] 读取 OpenCode 现有配置
- [x] 配置写回前的 diff、备份与恢复
- [x] MCP、Skill、Prompt/Instructions 统一控制面
- [x] 健康检查、优先级和自动故障转移
- [x] 本地请求日志与模型维度用量

## 0.4 Agent 内核

- [x] Goal 持续执行、暂停/恢复和完成审计
- [x] 子 Agent 与隔离工作树
- [x] MCP client 和动态工具注册
- [x] stdio / Streamable HTTP、凭据隔离与真实子进程集成测试
- [x] Skill 发现、校验与按需加载
- [x] Goal 状态与隐藏继续消息恢复
- [ ] SSH 远程工作区

## 1.0 验收线

- [ ] 不依赖 cc-switch 或 CodexPlusPlus 完成多模型日常开发
- [x] LevelUpAPI 四协议自动化兼容契约测试
- [x] Windows x64 MSI/NSIS 安装包与原生启动冒烟
- [x] Linux x64 DEB/RPM/AppImage，AppImage 启动与 DEB 安装冒烟
- [ ] macOS arm64/x64 安装包与实体机验证
- [ ] 使用所有者证书完成签名、自动更新和回滚实体机验收
- [x] 无障碍键盘路径与中英文完整本地化
- [x] 权限、路径、凭据和导出安全审计

## 0.6 已验证边界

- [x] 主连接始终先试，备用连接按优先级排序、去重并限制为 7 个
- [x] 仅对连接、鉴权、限流、模型缺失与服务端故障执行故障转移
- [x] 流式内容开始后禁止切换，取消请求禁止切换
- [x] Provider 失败指数冷却，成功后恢复并持久化滚动延迟
- [x] 外部配置预览令牌、脱敏 diff、同目录暂存、时间戳备份和回滚
- [x] 1440、800、640 宽度无横向溢出，浏览器控制台无告警

## 0.7 已验证边界

- [x] Instructions 持久化、四协议注入、四类 CLI 预览/备份/回滚
- [x] 图片魔数、大小、数量、总量和托管 ID 边界
- [x] Responses、Chat、Anthropic、Gemini 四种图片请求结构
- [x] 模型维度请求日志不保存正文、图片内容、工具参数或密钥
- [x] 窄屏入口可访问名称、Modal 焦点约束与 Escape

## 0.8 已验证边界

- [x] UTF-8 文本/代码附件扩展白名单、1 MiB 单文件和 4 MiB 请求总量
- [x] 上下文文件作为不可信 user context 注入四协议
- [x] 连接复制不会复制 API Key，优先级自动后移
- [x] 快速切换按优先级排序，640px 菜单不越界并支持 Escape

## 0.9 已验证边界

- [x] PDF、DOCX、XLSX、PPTX 本地提取与真实最小文件回归测试
- [x] OOXML 路径、重复项、展开大小、条目数量和冲突包类型边界
- [x] 当前轮次每文件 48,000 字符、每请求 120,000 字符的确定性首尾摘录
- [x] 历史图片与文档只发送保留标记，工具循环仍保留当前用户轮次上下文
- [x] 四协议统一使用不可信 managed context，并明确暴露提取与截断元数据

## 0.10 已验证边界

- [x] 子 Agent 只在干净 Git 仓库根目录创建 detached 隔离工作树
- [x] 子 Agent 仅可浏览、读取、搜索、写入和删除隔离区普通文件，不获得 shell/MCP/Goal/再委派能力
- [x] 真实 HTTP 模型两轮工具循环与 Git 新增/修改文件补丁集成测试
- [x] 临时工作树在补丁生成后清理，主工作树保持不变
- [x] 完整补丁可在对话中展开审查，应用需要第二次批准
- [x] 应用前复核仓库根、干净状态与相同 HEAD；补丁冲突时拒绝写入

## 0.11 已验证边界

- [x] 中文/English 全部前端静态字符串、可访问名称、状态和提示文案
- [x] 系统语言首次选择、顶栏即时切换、持久化与 locale-aware 时间格式
- [x] Tauri updater 签名验证、显式安装重启和本地未配置状态
- [x] Windows tag 发布生成 release-only updater 配置，缺私钥、公钥、密码或 endpoint 即失败
- [ ] 完成 Windows updater 实体机验收
- [ ] 后续按需恢复 Authenticode、macOS notarization 与多平台 tag 发布

## 0.12 已验证边界

- [x] Git tracked/untracked 逐文件回滚，应用前绑定并复核 status、binary diff/hash
- [x] 外部配置确认令牌绑定完整 Provider 快照，拒绝 preview/apply 间替换 URL 或模型
- [x] Provider URL 禁止嵌入凭据/query/fragment；远程 MCP secret header 强制 HTTPS
- [x] Unix 敏感文件私有权限、写入上限、超时子进程终止和符号链接逃逸回归测试
- [x] LevelUpAPI handler/routes 与 LevelUpAgent 四协议真实 HTTP 请求契约的一键验证
- [x] Ubuntu 26.04 WSL2 上 80 个测试、AppImage 启动和 DEB 实际安装/卸载验收
- [x] Provider 列表与当前选择从 localStorage 迁移到 SQLite，API Key 仍只进系统凭据库
- [x] 四协议统一的 240k/160 条长历史治理、当前用户保留和完整工具调用/结果配对
- [x] 超大用户/Assistant/工具正文与工具参数确定性摘要，省略元数据进入系统提示词且不改写 SQLite 历史
- [x] LevelUpAPI 同源视觉系统、应用图标与 CCSwitch 风格实时余额胶囊

## 0.13 创作空间

- [x] 小说、剧本和游戏剧情项目独立于会话持久化，桌面使用 SQLite，Web 预览使用本地回退
- [x] 正文流式 AI 补全、停笔自动触发、选区改写类操作、接受/拒绝/重试与版本快照
- [x] 人物、地点、阵营、物品、世界观、剧情、规则、任务和自定义设定的关系网络与相关度召回
- [x] 场景、对白、选择、条件、结局节点，以及剧情变量、条件/效果解释器、完整性检查和试玩
- [x] JSON/Markdown/Yarn 导入导出、异常项目防御性修复、16 MiB 后端边界和受限文件扩展名
- [x] 1280、768、390 宽度真实浏览器验收；窄屏创作切换、导航抽屉和上下文入口均可达
