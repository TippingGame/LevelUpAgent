# Harness 最终消息重复：诊断与修复

## 结论

2026-09-29 排查确认，重复来自前端过早结束 Harness 运行：`harness_run` 命令返回时，独立 Channel 中的大型 `assistant_completed` 事件可能尚未送达。模型只生成一次，流式占位消息和稍后到达的正式回复却分别进入了会话。

排查读取了用户提供的会话 JSON、运行日志和 SQLite 事件记录，数据库连接使用 `mode=ro`。没有修改生产会话、请求记录或原始导出文件，也没有读取 API 密钥。

## 证据链

本次事故时间均为 UTC+08:00：

| 时间 | 记录 |
|---|---|
| 2026-09-29 02:50:43.871 | 创建流式占位消息 |
| 02:50:43.884 | 第一次、也是唯一一次供应商请求开始 |
| 02:52:10.765 | 请求成功；343 个正文 delta，共 2027 字符 |
| 02:52:10.766 | 数据库保存唯一的 `assistant_completed`，随后保存 `operation_completed` |
| 02:52:10.768 | 前端记录运行结束时间，占位消息保留下来但没有 requestId |
| 02:52:10.785 | 最终回复被创建为第二条消息，正文完全相同，并带 requestId |

正式回复事件的 payload 为 10,624 UTF-8 字节，加事件封装后为 10,749 字节。仓库使用的 Tauri 2.11.5 在 Channel JSON 消息达到 8192 字节时走异步 fetch；较小的命令返回值可以先到达 JavaScript。

Tauri 的 Channel 对通道内的事件按索引排序，但不保证另一条 IPC 命令返回值晚于 Channel 的异步 payload。原来的 `bridge.harnessRun()` 直接返回 `invoke()`，把“命令执行结束”误当成“前端已消费所有事件”。

`App.runHarnessAgent()` 收到命令结果后调用 `settleStreamingAssistant(true)`：保存正文、清空占位身份。迟到的 `assistant_completed` 随后调用 `ensureStreamingAssistant()`，新建另一个 ID 并追加同一正文。原记录中 17 毫秒的时间差与这条路径一致，回归测试也直接执行该 App 函数复现了两条消息。

只读检索还发现两处相同特征的历史记录，各自只有一次 provider attempt 和一次正式回复事件：

| 日期 | 事件总字节数 | 正文字数 |
|---|---:|---:|
| 2026-09-25 | 8293 | 2535 |
| 2026-09-26 | 11142 | 4 |
| 2026-09-29（本次） | 10749 | 2027 |

这说明正文很短也可能触发：附带的 provider reasoning 数据同样计入消息体积。这里仅核对其大小和是否保留，不解读或输出其内容。

## 影响边界

- 本次没有第二次模型请求、重试、工具执行或重复的后端 `assistant_completed`。
- 两条记录已经写入 `messages` 表；导出只是原样序列化。JSON 同时含 `messages` 和 `transcript` 是正常格式，不能据此判断重复。
- 之后一轮的日志显示历史消息数为 10，重复记录进入了后续上下文。这可能增加输入用量；不能从日志推算具体计费金额。
- 问题属于所有桌面 Harness 会话共用的传输收尾路径，不是某个模型专属。

## 修复

1. 后端在本次调用的全部事件之后，在同一个 Channel 发送瞬态 `run_finished` 标记。该标记不写入持久事件表，也不改变操作状态。
2. 正常结果、等待确认结果和运行时错误使用统一的结果封装。取消和失败也必须先排空已发送的事件，再向调用方返回原错误。
3. `runHarnessStream()` 同时等待命令结果和通道末尾标记。标记到达意味着前面的最终正文、用量、工具和确认事件都已经按顺序处理。
4. 命令结束后若 10 秒内仍无法排空通道，显式报错并关闭消费者，防止永久等待或迟到事件继续改写会话。这不是每次固定等待 10 秒，正常收尾立即完成。
5. 消费者抛出的异常不会卡住 Channel 的索引递增；错误在排空后报告。IPC 本身拒绝时直接关闭消费者。

没有按正文做全局去重，正常多轮相同文本仍保留各自身份。没有自动迁移或删除已有的三组历史记录。

## 验证方式

- `scripts/test-harness-stream.mjs` 使用真实 Tauri JavaScript Channel 和从 App/bridge 提取并编译的当前运行函数，模拟大事件晚到、小终止事件先到以及命令先返回。
- 旧代码在该测试中得到 2 条 assistant，预期为 1；修复后保留原 ID、创建时间、请求 ID、附带数据，token 只累加一次。
- 覆盖两种到达顺序、取消、失败、等待确认、合法相同正文的多轮回复、IPC 拒绝、消费异常、丢失结束标记和其他 operation 的事件。
- Rust 测试核对所有运行出口的封装与 Channel 结束标记。
- 独立桌面验证脚本使用 `com.levelup.agent.harnessdeliveryqa` 数据目录、本地模拟供应商和隐藏测试窗口，在真实异步 fetch 上人为延迟 250 毫秒；检查单条持久消息、请求数、附带数据、token、导出和重启恢复。

运行：

```powershell
pnpm check
cargo test --manifest-path src-tauri/Cargo.toml harness_ -- --nocapture
pnpm build
node scripts/verify-harness-delivery.mjs --prepare
pnpm tauri build --debug --no-bundle --config artifacts/harness-delivery-review/tauri.json
# LEVELUP_PLAYWRIGHT_MODULE 指向已安装 Playwright 的 index.mjs（如不在 node_modules 中）。
node scripts/verify-harness-delivery.mjs
```

桌面验证的具体结果保存到 `artifacts/harness-delivery-review/result.json`。源码修复需要前后端一起构建；只替换前端资源不能升级这项 IPC 协议改动。

## 本次验证结果

- `pnpm check`：类型检查及 199 项前端测试全部通过，其中新增 10 项通道收尾回归测试。
- Rust `harness_`：7 项相关测试全部通过。
- `cargo fmt --check`、`git diff --check`、生产前端构建和隔离桌面 debug 构建通过。
- 原生长正文事件 31,787 字节，晚于命令结果 252 毫秒到达，只保存 1 条回复。
- 原生短正文加附带数据事件 12,384 字节，晚于命令结果 254 毫秒到达，只保存 1 条回复。
- 两次用户发送对应两次本地模拟请求；总输入 46 tokens、输出 14 tokens，导出各含 1 条对应回复；关闭测试进程并重新启动后再次核对通过，无前端异常。
- 桌面验证使用独立应用标识和数据目录；已安装的正式版本没有替换，生产库中的旧重复记录仍保留。
