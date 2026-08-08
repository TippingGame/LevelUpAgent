# 安全审计（0.12.0）

审计范围覆盖本地权限、路径、凭据、外部配置导出、更新、MCP、附件和子 Agent 补丁。威胁模型假定
模型输出、MCP 返回、Skill/附件内容和 Provider 响应均不可信；已签名的应用前端和当前操作系统账户
属于信任边界。

## 已验证控制

- 工作区工具拒绝绝对路径、`..`、Windows prefix 和 canonicalize 后的目录逃逸；读写会拒绝指向工作区
  外部的符号链接，删除仅允许普通文件。
- 工作区文本工具单次写入限制为 1 MiB；读取/编辑会识别 UTF-8、UTF-16、GBK、GB18030、Big5、Shift-JIS
  和 Windows-1252，已有文件保留编码、BOM 与主导换行，无法表示的新字符和疑似二进制文件直接拒绝。
  无 BOM 的短旧编码允许通过受限 `encoding` 枚举显式指定，且与 BOM 冲突、或试图把有效 UTF-8 重新解释为
  旧代码页时拒绝；纯 ASCII 文件可用提示记录字节兼容的旧代码页项目约定，避免首次新增中文时改用 UTF-8；混合中日文导致脚本信号冲突时不会采用统计猜测进入写路径。
  `edit_file` 只接受精确且默认唯一的替换，`write_file`/`edit_file` 写入前均复核原始字节，并通过同目录临时文件原子替换；Agent 自动权限会把 shell 重定向、嵌套 shell、文本写入 cmdlet/别名、`git apply` 和明显的格式化写回命令转为需批准，显式批准后命令仍按用户权限运行，120 秒超时后杀死直接子进程。
- API Key 与 MCP secret 存入系统凭据库，并使用互斥的 `provider:` / `mcp:` 账户命名空间；旧版裸
  Provider ID 凭据首次读取时透明迁移。Provider 请求日志不保存正文、附件、工具参数或密钥。
- Provider 名称、URL、协议、模型、优先级和当前选择持久化到 SQLite；旧 WebView localStorage 仅在
  SQLite 写入成功后清除，序列化结构不包含 API Key。
- Provider Base URL 拒绝 URL userinfo、query、fragment 和非 HTTP(S) scheme，避免把秘密混入可持久化
  URL 或错误日志。
- 远程 MCP 携带 secret header 时必须使用 HTTPS；plain HTTP 仅允许 loopback 开发地址；URL userinfo
  一律拒绝。
- 外部 CLI 写回先返回脱敏 diff，一次性确认令牌精确绑定 target 与完整 Provider 快照，10 分钟过期；
  staged file 同目录落盘、flush 后原子替换，并保留可回滚备份。
- Unix 上 SQLite、WAL/SHM、托管附件和包含导出密钥的临时配置显式收紧为用户私有权限；Windows 继承
  应用数据目录或目标配置目录的用户 ACL。
- Git 回滚仅在仓库根执行，拒绝路径逃逸、symlink、目录、rename 和 submodule；完整预览绑定一次性
  token，应用前再次比较 HEAD、status 与原始 binary diff/hash。未跟踪文件删除和 tracked HEAD restore 均有真实
  临时仓库测试。
- 子 Agent 只接收隔离 worktree 内的受限文件工具；补丁限制大小、清理临时 worktree，并在应用前复核
  仓库根、干净状态、相同 HEAD 和 patch 可应用性。应用仍需第二次用户批准。
- Provider 请求历史在 Rust 内复制后按 240,000 字符/160 消息治理；超大正文、工具结果和工具参数使用
  确定性可见摘要，工具调用与匹配结果成组保留。SQLite 完整历史不被压缩，省略统计进入系统提示词，
  缺失或孤立工具结果不会被发送为协议非法上下文。
- updater 只在 release 编译开关存在时注册；发布 endpoint 必须是无 URL credentials/fragment 的 HTTPS
  URL，Tauri updater 私钥、公钥和密码缺一即失败。

## 明确保留的风险

- 用户批准的 shell 命令和 stdio MCP 进程拥有当前用户权限；LevelUpAgent 不把它们描述为 OS sandbox。
- 同步到 Codex/Claude/Gemini/OpenCode 的 API Key 必须按这些 CLI 的格式写入配置文件。预览不泄密，
  但最终文件是显式导出，保护强度取决于目标目录 ACL。
- 配置的 Provider 会收到用户选择发送的消息和附件；LevelUpAgent 不会把数据发送到未配置的第三方。
- SSH 远程工作区尚未实现，因此没有宣称远程主机隔离或远程凭据安全。
- 正式 updater 仍需仓库所有者密钥和 Windows 实体机验收；当前安装包没有 Authenticode，Tauri 更新
  签名只保证更新完整性与发布密钥连续性，不提供 Windows 系统级发布者身份。

## 回归证据

Windows 本机通过 Rust 编码专项（UTF-8 BOM/CRLF、GBK、UTF-16、重复匹配保护）与完整 Rust tests、`cargo clippy -D warnings`、`cargo fmt --check`、`pnpm check`、
生产构建、真实 Provider SQLite 迁移与 UI 宽窄屏复核。Ubuntu 26.04 WSL2 通过 80 个测试，实际验证 `0700` 目录、`0600`
文件及符号链接逃逸拒绝；AppImage 启动与 DEB 安装后启动也已通过。
