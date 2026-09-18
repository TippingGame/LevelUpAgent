# 性能记录

2026-09-18，Windows 11 x64，Intel i7-13700K、64 GB RAM，Node.js 24.14、Rust 1.94、Vite 7.3.6。
基线为 `75b9ff71b821716f13a604044f560e044d834439`（1.0.56）；结果来自当前未发布工作树。

## 实测变化

| 指标 | 审阅前 | 本轮结果 | 口径 |
| --- | ---: | ---: | --- |
| App 入口 JS | 1,062.01 kB | 379.92 kB | Vite 生产构建，减少约 64.2% |
| App 入口 JS gzip | 340.96 kB | 126.64 kB | 构建估算，减少约 62.9% |
| App 入口 CSS | 419.58 kB | 258.89 kB | 减少约 38.3% |
| 2,000 条消息后连续追加保存 20 次 | 1,997 ms | 811 ms | 同机一次数据库基准，约减少 59.4%；不是稳定延迟承诺 |
| 上述保存导致的 SQLite 变更行数 | 80,420 | 20 | 测试保持会话元数据不变；实际时间戳更新、Harness 账本另有写入 |
| 启动会话读取 | 最近 200 个会话及其正文 | 100 条摘要及所选正文 | 所选旧会话、审批恢复可以额外读取；目录可继续分页 |
| 240 条用户/助手消息首次挂载 | 全部 | 40 个会话块 | UI 验收为 20 条用户消息和 20 条助手消息；早期内容按需展开 |

入口包不是全部下载量。React 等共享代码、头像组件与当前对话需要的 Markdown 仍会加载。
生产预览中，包含 Markdown 的 240 消息场景首次加载约 796 kB JS、261 kB CSS（未压缩资源体积），未请求媒体、写作、星图及 React Flow 的工作区代码。
这些工作区第一次打开时才下载，之后保留组件状态与后台任务。代码拆分没有删除这些功能，也不代表安装包整体缩小同样比例。

## 为什么改善

- SQLite 保存保留未改变的消息，追加和编辑只修改有变化的行；重排、截断从第一个变化位置重建后缀，仍在同一事务内完成。
- 会话目录与正文分离，游标使用 `(updated_at, id)`，同一时间戳的记录不会在分页时丢失。
- 目录查询、正文加载、消息与草稿保存进入阻塞任务池；目录遍历和文件搜索不再占用异步执行线程。
- 草稿按会话合并 250 ms 内的编辑，持久化串行化；消息仍按 120 ms 合并。正常关闭等待两者完成。
- Markdown、媒体、写作、星图、Armor 和陪伴管理按需加载。共享创作导航样式独立，避免异步样式顺序造成首开错位。
- 长对话只初始挂载最近 40 个可见块；`read_file` 行区间帮助模型按需读取文件。

## 复现

构建和数据库基准不需要真实模型或 API Key：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm bench:persistence
```

基准位于 `src-tauri/src/database.rs::benchmark_long_conversation_persistence`，默认忽略，显式运行才执行。
它创建临时磁盘数据库，先写入 2,000 条约 2.3 kB 的消息，再分别追加保存 20 条，报告 `elapsed_ms` 与 `total_changes` 差值，最后校验 2,020 条消息仍完整并删除临时数据库。
旧版数据来自改造前运行相同 fixture；比较基线时，应在独立 checkout 中只移植这个 benchmark，再使用相同工具链和磁盘。不要在日常数据库上运行对比。

浏览器验证需要可解析的 Playwright 和本机 Edge。可用 `LEVELUP_PLAYWRIGHT_MODULE` 指定 Playwright 的 `index.mjs` 绝对路径。

```sh
pnpm preview --host 127.0.0.1 --port 1431
```

另一个 PowerShell 终端中：

```powershell
$env:LEVELUP_TEST_URL = 'http://127.0.0.1:1431'
node scripts/verify-workbench.mjs
```

脚本使用独立浏览器上下文，验证历史检索、草稿刷新恢复、键盘导航、240 条消息的渐进挂载、工作区延迟加载与状态保留，以及 1440/800/390 px 布局。截图与资源列表输出到 `artifacts/workbench-review/`。
`initialMs` 是本机生产预览单次导航到内容可见的观察值，受文件缓存、浏览器和后台任务影响，不是 Tauri 冷启动、P95 或与 Codex 的性能对照。

原生生命周期验证使用独立应用标识与本地模拟 Provider，端口 9443/1450 必须可用：

```sh
pnpm build
node scripts/prepare-desktop-review.mjs
pnpm tauri build --debug --no-bundle --config artifacts/tauri.review.json
node scripts/verify-desktop.mjs
```

准备脚本复制前端产物到 `artifacts/native-dist/`，生成只连接 `127.0.0.1:1450` 的无密钥配置。
验证脚本启动 QA 二进制，确认标识为 `com.levelup.agent.review20260918` 后才写入 205 条测试会话，验证 SQLite 草稿、SSE 工具循环、项目指令、行区间和关闭重启，然后关闭 QA 应用。
它不访问 `com.levelup.agent` 的生产数据库；测试数据保留在独立 QA 数据目录，截图与结果位于 `artifacts/desktop-review/`。
QA 构建会替换 `target/debug/levelup-agent.exe`，它不是分发产物；正常构建使用默认 Tauri 配置。

## 当前限制

活动会话正文仍整体加载、序列化和比较，保存不是 O(1)。查询正文使用 SQLite 字面匹配，没有 FTS 索引；大库搜索和数据库互斥锁仍可能成为瓶颈。SQLite `lower()` 仅提供内建的 ASCII 大小写折叠，中文按原文字面匹配。

渐进挂载不是完整虚拟列表，持续展开早期内容仍会增加 DOM 和内存。工作区访问后保持组件挂载，以保留后台任务，也会增加常驻内存。

`read_file` 的行范围减少返回上下文，但文件仍先按受限大小读入并解码；它不是磁盘随机行访问。主 Agent 工具循环仍串行，媒体和星图的独立任务可以并发。

没有测量长期内存曲线、低端机器、万级会话 P95、网络模型首 Token 延迟或 Codex 同机性能。真实模型速度、质量和配额取决于所选 Provider；本地优化不能保证这些上游指标。
