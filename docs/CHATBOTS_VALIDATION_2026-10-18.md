# 自动机器人 chatbots-v1 验证记录

2026-10-19 补充：用户确认先完成本地实现与验收；真实平台联调转为后续事项。本记录保留 2026-10-18 的实际测试结果，当前文件和归档一致性已另行复核，见 [本地交付验收](CHATBOTS_LOCAL_ACCEPTANCE_2026-10-19.md)。

验证日期：2026-10-18（Asia/Shanghai）。主工程基线 1.3.82 / 946af37f807d1fdb6d5f6ddfff627aa28b74ed1b；未发布工作树，数据库 schema 21、网关协议 v1。

## 自动化结果

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| pnpm check | 通过：309 项测试、4 项外观测试、TypeScript 和发布配置检查 | 全前端回归；外观基线未增加 |
| pnpm build | 通过 | 生产前端编译；不是发布安装包 |
| cargo test --manifest-path src-tauri/Cargo.toml | 578 passed / 5 ignored / 0 failed | Rust 全量回归，含 13 项 chatbot 测试 |
| python -m unittest -v test_gateway | 10 passed | 实际固定版本 SDK 导入/分发契约、模拟 HTTP、真实 stdio 子进程 |
| Tauri debug --no-bundle | 通过 | 使用专用 QA identifier 构建 |
| node scripts/verify-chatbots.mjs | 通过：13 次模拟模型请求、11 次模拟平台发送、0 个页面错误 | 原生 Tauri、SQLite、OS 凭据、Python 网关与模拟 OneBot peer |
| git diff --check | 通过 | 已跟踪文件无空白差错 |

原生最新报告时间：2026-10-18T13:59:15.666Z（北京时间 21:59:15）。原始报告在 artifacts/chatbots-review/report.json。v1 原生报告与源码保存在研究目录旧覆盖包内；v1.1 是本次恢复审阅的新增快照。

## 原生验收覆盖

- 同时运行两个机器人、两个平台账号；同一 chat ID 在不同账号内隔离；路由冲突拒绝。
- 重放同一平台 message_id 只生成一次；人格、知识 ACL 与人物关系记忆隔离；模型请求不包含工具。
- 切换可见桌宠后原聊天仍由绑定机器人回复；通过界面实际保存身份。
- 慢生成时暂停可取消；人工接管不回复；发送中断进入 delivery_unknown，同会话后续消息等待主人核对。
- 主人确认送达后继续；重启不会重复回复；关闭应用后网关子进程停止。
- 测试账号断开、移除并执行 OS 凭据删除路径；生产应用数据未参与。
- 720 px 窗口下覆盖身份、账号、路由、知识、消息五个页签；系统浅/深色 × Armor 关闭/开启四组合；检查 hover/focus、实际 Armor 切换、重载、错误提示和横向溢出。
- 路由冲突错误会自动出现在可见区域，无需向上寻找；截图已复核。
- 单个账号被协议服务拒绝期间，另一个账号继续答复；恢复允许连接后自动重连并成功回复。
- 发送命令已到 peer 但尚未确认，同时另一个账号模型请求正在生成时，强制终止主进程。网关 EOF 退出，重启后分别为 delivery_unknown / interrupted；没有重发或重新生成。
- 缺少平台凭据时仍返回已保存的账号 ID，并显示 credential_required，可继续编辑；停止旧网关后才更新系统密钥。
- Rust 追加验证 220 条新记录不能挤掉未确认发送，解决后会话恢复；精确群话题、@ 触发、媒体不支持及官方通道全量群监听限制。
- Python 追加验证实际 token 过期刷新、钉钉回复窗口过期时不发网络请求、429 明确失败、503 送达不确定、QQ C2C 分发。

本轮第一次原生启动等待 WebView 页面超时；进程已确认终止后增加启动诊断，再执行成功。后续包含强制终止与多次重启的完整运行通过，未将失败运行写成成功证据。

## 可重复执行

在主工程目录执行：

~~~powershell
pnpm check
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/verify-chatbots.mjs --prepare
pnpm tauri build --debug --no-bundle --config artifacts/chatbots-review/tauri.json
$env:LEVELUP_PLAYWRIGHT_MODULE='绝对路径/playwright/index.mjs'
$env:LEVELUP_QA_PYTHON='已安装网关 SDK 的 Python 绝对路径'
node scripts/verify-chatbots.mjs
~~~

网关测试需在 modules/chat_gateway 目录用安装 requirements.txt 的 Python 执行 python -m unittest -v test_gateway。

QA identifier 固定为 com.levelup.agent.chatbotsqa；脚本先校验 identifier 再改动数据。模型服务和 OneBot peer 仅监听本机随机端口。截图和报告在 artifacts/chatbots-review（Git 忽略）。QA 可执行文件不应分发为正式应用。

## 已知边界与待联调

没有用户飞书租户、钉钉组织或 QQ 官方应用凭据，因此没有验证真实平台审批、权限发布或实际消息往返。SDK 契约测试不能替代真实平台联调。OneBot 使用可控协议模拟服务，没有验证某个第三方 QQ 客户端的登录与账号恢复。

macOS/Linux 未实机验证。微信按用户意见跳过。仅支持文本，QQ 频道、图片/语音/文件理解不在本版范围；任意普通账号/群全量接管不作承诺。

交付代码是本地工作树，未创建新 commit/tag，未上传或发布安装包。固定 SDK 版本与文件 SHA256 见 chatbots-v1-source-manifest.json；研究目录保存对应源码快照，以便以后逐版比较。
