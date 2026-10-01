# 星图重构：创作项目与自动连接

2026-09-30。用户目标：安静的星空总览，卡片保存独立蓝图项目；进入项目精细创作；连接作品、AI 会话、本地工具和外部输入。参考 MONA 的克制画布与对象操作。每一步先更新本文档，再实现、验证、记录证据。不要把账号、密码写入文档、代码或测试。

## 产品契约

- 星图是项目总览；卡片是可再次打开的创作项目，保留素材、结果、布局与视口。可复用蓝图模板单独保存，不能与项目存档混淆。
- 编辑器默认每个节点只有一个输入连接点、一个输出连接点；用户也可把连接直接落在目标卡片。系统匹配实际端口，兼容旧的精确端口连线。
- 一次连接可传递多种适配的数据（例如画板的图像和蒙版）。多个上游可供同一节点使用；重复连线、环、类型错误、已占用的单值槽不静默覆盖。
- 连接不启动生成。选择后的连接应能查看具体映射和删除。运行读取真实映射，不能只有视觉上的线。
- 会话引用包含来源及显式选择的内容。本地工具复用应用的执行与权限边界；外部输入按明确的输入类型接入。
- 作品为画布主体，操作随选择出现；外层稳定、稀疏微光，不持续漂移。搜索和返回路径始终可用。

## 实施顺序与验收

### 1. 自动连接（已完成）

先实现纯逻辑连接解析器：根据源、目标和可选精确端口，决定一组类型安全的映射。优先同名端口，其次类型；文本优先主任务，已占用后使用多值上下文。画板的 mask 只进入 mask，不作为普通参考图。相同节点对已连过的映射跳过，允许补充未连接的映射。旧图和模板继续读取。

编辑器只呈现通用输入/输出点；内部精确端口保留为不可交互锚点。拖到卡片或通用点、反向从输入拖出、点击两点均使用同一解析器。多条映射在画布合并为一条可检查的连线；删除与重连对整组生效。源输出变化后重跑使用当前已保存的映射。

验收：文本到图片；图像到参考图；画板到图片同时匹配图像/蒙版；多个文本到写作；反向拖动；重复与环；删除/重连；折叠节点连接；旧图导入；撤销重做。逻辑测试、类型检查、浏览器真实拖拽验证。

### 2. 项目存档与星空总览（已完成）

定义项目与模板分离的数据模型；桌面 SQLite 持久化，浏览器独立回退；无损导入旧图。保存图、素材引用、结果、视口和总览位置。实现新建、打开、返回、重命名、复制、搜索与模板建项目。返回和重启保持状态；失败不能声称保存成功。

### 3. 创作对象与会话（已完成）

完善素材输入和作品预览；引入会话内容快照与来源导航。多输出选择、上下游变化提示、局部运行的输入可检查。

### 4. 本地工具、外部输入与项目连接（已完成，桌面 provider 仍需实测）

明确执行契约后接入现有工具运行边界、文件输入与 HTTP 输入；跨项目作品引用使用稳定 ID 与输出快照。验证真实运行、失败、取消、重开后的恢复。

#### 桌面只读工具验收步骤（2026-10-01）

在隔离的 Tauri QA 数据目录中添加 `read_file` 节点，将参数设置为 QA 工作区内的测试文件路径，点击“运行到这里”，并检查节点结果包含测试文件的原文。验收同时确认：

- 工具调用沿用现有 policy / approval / execute_tool 边界，只允许 `read_file` 等已列出的只读工具；
- 节点不会执行 shell、修改文件或扩大工作区范围；
- 参数、结果、节点状态和连线在保存、关闭、重启后仍可查看；
- 失败或权限拒绝时保留可诊断状态，不显示成功。

### 5. 完整验收（浏览器与隔离桌面生命周期完成）

真实链路：会话设定 → 创作项目 → 本地工具/模型产物 → 人选择 → 两个下游项目复用 → 重启恢复 → 仅重做一部分。完成 pnpm check、生产构建、涉及的 Rust 测试与桌面生命周期验证。不得以单项测试通过代表整个愿景完成。

## 当前事实

### 2026-10-01 桌面完整链路验收记录

前端、Rust 自动检查、浏览器保存重开和隔离桌面生命周期均已完成。桌面验收以独立应用标识和数据库运行，未触碰用户日常项目与 provider 配置；实际 UI 覆盖了通用连接点、只读工具执行、保存关闭重开、跨项目引用和复制后的恢复。真实媒体模型请求仍因 QA 环境没有模型密钥而未验证，不能以本地工具成功替代媒体服务端生成验证。

- React Flow 12.11.2 已使用；项目改动仍保留在当前工作树，未覆盖用户已有修改。
- 星图项目使用独立项目记录：桌面走 SQLite IPC，浏览器走串行化 `localStorage` 回退，并迁移旧的单项目键。
- 持久化边仍是精确 typed ports；界面使用通用连接点并由解析器生成类型安全映射。
- 来源节点、候选媒体、项目引用和选择性重跑均有行为测试；浏览器不会伪造桌面工具或 provider 执行成功。

## 验证记录

2026-10-01：前端与桌面存储验证完成。

- `pnpm check`：216/216 通过，包含 28 项星图行为测试。
- `pnpm build`：TypeScript 检查与 Vite 生产构建通过。
- `cargo test --manifest-path src-tauri/Cargo.toml constellation_projects`：2/2 通过。
- 收尾复核：完整 `cargo test` 为 517 项通过、3 项忽略、0 项失败；`pnpm exec tsc --noEmit`、`cargo fmt --check` 通过。前端 216 项测试（包含星图 28 项）和生产构建再次通过。
- `git diff --check`：通过。
- 浏览器 `http://127.0.0.1:1420/`：实际点击星图标签，确认总览、创建项目、编辑标题与提示词、返回总览、重新打开项目；重新打开后仍显示保存的项目标题、节点和提示词内容。总览卡片使用真实节点拓扑预览，星空区域跨越完整编辑器高度。

上述浏览器验证使用浏览器 `localStorage` 回退适配器；没有伪造 Tauri 工具执行、模型生成或桌面权限结果。SQLite 的项目记录更新、重开、删除、创建时间保留、非法记录拒绝由 Rust 单元测试覆盖。

2026-10-01 桌面续验：使用 `artifacts/tauri.constellation-qa.json`（本地忽略的 QA 配置）构建隔离应用，标识 `com.levelup.agent.constellationqa20261001`，窗口 `LevelUpAgent Constellation QA`。用户安装版保持运行，未操作其项目或配置。

- 实际拖动提示词通用输出点到图像节点输入，画布生成连线并自动隐藏已连接的重复提示词输入。
- `read_file` 节点读取隔离 QA 工作区内的测试文件，真实结果为 `desktop-local-tool-evidence`，节点显示“已完成”。非法 JSON 参数显示“需要处理”与解析错误，修正后可重跑。
- 项目重命名为“桌面连线验收”，等待“已保存”，返回总览后卡片展示三节点拓扑。
- 用 Alt+F4 关闭 QA 进程后，从工作区可执行文件重启；重新进入星图并打开项目，确认标题、提示词、图像节点、连线、工具参数、完成状态和文本结果全部恢复。
- 本次最小回归：28/28 星图测试、`pnpm exec tsc --noEmit`、`git diff --check` 通过。
- QA 环境未配置模型密钥，未进行真实媒体模型请求；桌面本地执行与存储的成功不能替代媒体服务端生成验证。

跨项目续验：在第二份星图“下游作品 A”中打开作品引用选择器，选择“桌面连线验收 / 本地工具”的已完成文本输出，保存稳定项目/节点/端口快照；引用节点显示“已完成”，结果为 `desktop-local-tool-evidence`。这证明独立项目可以复用来源作品快照，且来源项目无需再次执行。

跨项目持久化验收完成：运行 A 的引用节点后复制为独立的“下游作品 B”，保留同一个来源引用；关闭并重新启动隔离 QA 应用后，项目总览恢复“桌面连线验收”、A、B 三张卡片。实际分别打开 A、B，二者都恢复为“已完成”，显示相同来源项目/节点/端口和 `desktop-local-tool-evidence`，并等待状态变为“已保存”。

随后只读查询隔离 SQLite 数据库：项目库恰有三条记录，A、B 的项目 ID 不同；两个 `projectReference` 完全一致，均指向原项目的 `localTool` 节点 `text` 输出。来源节点、A 和 B 都是 `success`，两个快照值和路由输出均等于 `desktop-local-tool-evidence`；两个项目的视口也已保存。QA 主窗口已关闭，用户安装版未操作。

## 2026-10-01 implementation note: automatic routing contract

The first code slice will add a pure resolver beside the existing typed validator. It will accept a node pair plus optional exact handles and return candidate typed mappings without mutating graph state. Existing exact edges remain the persisted execution contract. The UI can create several exact edges from one gesture, while the resolver rejects duplicate mappings, cycles, incompatible types, and occupied single-value inputs. Universal handles will be introduced after the resolver tests pass; they will be presentation anchors only and will never be persisted as fake ports.

Evidence target for this slice: prompt→image, image→image reference, canvas→image plus canvas→mask, two text sources→writing prompt/context, reverse input-to-output gestures, duplicate and cycle rejection, and old graph normalization.

## 2026-10-01 implementation note: resolver purity and repeat gestures

The resolver must remain deterministic and side-effect free: cycle checks use graph topology directly and never construct random persisted edges. A repeated gesture from the same source card is a no-op when its compatible output is already mapped; the user can add a second text source to a writing card for context, but dragging the first source again must not duplicate its value into another input. The UI may replace a whole displayed connection group during reconnect, while persisted mappings remain exact typed ports.

验证：18 项星图测试、TypeScript 检查通过。下一步按源/目标节点对合并显示边，保留第一条真实边 ID 作为显示 ID；选择、删除、重连展开到整组真实边。重连验证先排除旧组，拖到卡片时使用页面命中结果补足 React Flow 的 handle 状态；取消或同方向端点不建线。仅有实际输入/输出的节点显示通用锚点，细分端口改为只读说明。选中连接显示真实映射。

## 2026-10-01 implementation note: project archive boundary

Constellation workspaces will be stored as independent project records, separate from reusable blueprints. The payload keeps the normalized graph plus a future overview position and viewport; node outputs, local references, and canvas data remain project data and are never written to a blueprint by accident. Desktop storage follows the existing SQLite command boundary with the same ID/title/size validation as writing projects; browser builds use a bounded localStorage fallback. The old single `levelup-agent.constellation.v1` value is imported once as a project and remains readable during migration. Autosave errors stay visible and do not claim success.

This slice adds the storage contract and migration helpers before wiring the outer star overview. Evidence target: create/update/list/delete round-trip on both storage adapters, old-key migration, bounded payload validation, and restart-safe graph metadata.

外层实施细节：独立的项目库拥有存储队列和加载错误状态；编辑器按项目 ID 挂载，返回前同步提交当前图与视口，切换项目清空执行缓存与撤销栈。默认进入稀疏星空，固定卡片位置可拖动调整，卡片支持标题、作品摘要、复制、搜索、从模板新建。导入永远创建新项目，避免覆盖同 ID 项目。删除需要界面确认且等待待保存队列。编辑器侧栏默认收起，缩放视口随项目保存；重开不再次自动 fitView。浏览器保存不截断旧项目。

本实现先交付单编辑器内的项目库总览：总览卡片使用项目记录的 `overviewPosition`，打开时加载该记录中的图，保存时回写同一 ID；旧单键记录若项目库为空则转换为第一条项目记录。项目记录故障保留当前内存图并显示错误，不能静默覆盖其它项目。

## 2026-10-01 implementation note: archive lifecycle hardening

Hydration must finish before any autosave can run. A serialized storage boundary prevents older snapshots winning races and preserves viewport and overview metadata. Switching, returning, importing, and creating flush the current project before clearing runtime/history. The old single-key migration uses a once-only marker, imports only after a successful library read, and never resurrects projects after deletion. Failed reads disable writes; failed saves preserve the in-memory graph with retry. The outer overview gains real pointer positioning, rename/copy/delete, search and template creation, with stable positions and actual graph previews.

Evidence target: fresh startup cannot overwrite stored work; rapid edits save in order; project position and viewport survive autosave/reopening; import always creates a new ID; deletion followed by restart stays deleted.

### Archive corrections after live inspection

The browser exposed a real grid bug: the overview occupied only the editor's 64px header row. It must span both rows. Empty projects must normalize successfully. Extract the overview into its own component, use absolute saved coordinates in a scrollable plane with an explicit drag grip and keyboard arrows, and render actual graph topology or a saved image. Rename/delete use application dialogs. Stable default positions follow creation order, independent of save/search order. Serialize all record mutations against the latest record, guard transitions synchronously, flush on app-mode changes, and warn on unload only while unsaved. Storage adapters must agree on timestamps, Unicode title limits and original creation time.

### 2026-10-01 continuation: stable coordinates and sources

归档验证已实际通过：22 项前端星图测试、TypeScript 检查，以及 2 项 Rust 数据库测试（105 条记录、更新保留创建时间、重新打开、删除和非法数据拒绝）。接下来先固化每条旧记录的总览坐标；新建、导入和复制分配不重叠的空位；窄窗口采用可横向滚动的画布。打开项目先等待写入队列并读取最新记录，保存时在队列中合并最新元数据。

创作对象实施契约：会话节点显式选取消息并保存来源/正文快照；外部输入支持文本、导入文件和 HTTP 文本；项目作品引用固定项目、节点、端口和快照，更新来源需要用户操作。多结果生成保留所有候选，选定后才向下游输出。语义修改与输入连线变化使下游结果标为过期；局部运行复用未变化的上游，输入面板展示真正参与运行的值。本地工具通过现有 harness policy、approval 和 execute_tool 调用，绝不直接绕过到 shell，也不自动把权限设为 full。浏览器不模拟桌面执行成功。

### 2026-10-01 implementation note: traceable sources and selective reruns

This slice makes the new source nodes executable without broadening host authority. Conversation nodes keep only explicitly selected non-internal messages and attachment metadata; project references keep a stable project/node/port identity plus the currently selected value snapshot. External input exposes text, imported files, and bounded URL retrieval. Local-tool nodes call the existing policy checker and executor only for the host's read-only tools; any operation that requires approval is surfaced as such instead of pretending to run.

### Completion contract: candidates, refresh, and execution evidence

TypeScript now passes. Complete the candidate chooser with saved previews, pending/failed states and explicit selection; stale candidates remain inspectable but cannot satisfy changed inputs. Refresh must not revive stale output or overwrite a newer generation/selection. A failed candidate refresh must not discard other results. Project references refresh their original project/node/port explicitly, preserving the snapshot when the source disappears. Changing a typed file path clears the old imported attachment. Execution uses only completed cached values and exposes the connected input values and source status. Add behavioural tests for these state transitions before full checks and UI verification. The native tool path remains workspace-scoped and read-only; desktop/provider verification must be reported separately from browser testing.

Generated media keeps all returned candidates and makes the selected candidate the value routed downstream. Semantic node changes and connection changes mark dependents stale while retaining their inspectable old result. A targeted run reuses successful unchanged ancestors and executes stale or missing values. Evidence target: typed project references, explicit snapshot selection, read-only tool policy rejection, candidate selection staling descendants, full type checking, the constellation tests, browser interaction, and persisted reopen.

## 2026-10-01 interaction polish: implementation and acceptance plan

- Repair Space panning after toolbar and node controls retain focus. Preserve spaces in editable fields, transfer focus when returning to the canvas, and clear held-key state on window blur or hidden visibility. Verify repeated gestures, held Space from an input, and release outside the canvas.
- Keep node content and grouped edge identities stable during position-only changes. Render card contents only when their inputs change, preserve downstream preview updates, and defer autosave until a drag/connection gesture ends. Verify final positions, undo/redo, connected previews, and saved reopening with fast pointer movement.
- Clip only the colored decorative layer to the card's inner rounded outline, keeping handles and their hit areas outside the card available.
- Use a white overview with readable controls, topology previews, errors, and sparse star details. Preserve saved card positions and project operations. Inspect desktop and narrow-window screenshots.
- Run the frontend checks and production build, exercise the real interactions in an isolated browser and desktop application, then refresh the local Windows 1.1.65 installer and its checksum. No release or installation over the user's running app.

Live inspection also found persisted nodes with a zero fixed height: `finite(value, undefined)` uses the default numeric fallback, and saved measured heights freeze otherwise content-sized cards. Remove persisted fixed heights during serialization and normalization so React Flow measures visible contents after reopening/collapsing. Add a round-trip regression covering old zero and positive heights; verify fit-view and connection anchors in the browser.

## 2026-10-01 connection and marquee follow-up

- Cache connection validation for each source/target/handle tuple during a gesture. Invalidate on graph changes, connection boundaries, and reconnect boundaries; the commit still runs the full resolver against the current graph.
- Coalesce XYFlow connection store notifications to the latest pointer position once per animation frame. Preserve XYFlow hit testing, final connection resolution, and cancellation. Cancel queued work and restore the store actions when returning to the overview or unmounting. The integration targets pinned @xyflow/react 12.11.2.
- Paint the marquee from pointer refs once per frame. Use React Flow's intersection API at release, preserving partial selection, additive selection, and automatic viewport panning at the boundary. Clear the gesture on cancellation or lost capture. Selecting a group no longer updates every node and connected edge for every raw pointer event.
- Place the node layer above both committed and preview edges, and handles above the colored stripe. Keep the enlarged hit regions and native edge reconnection anchors.

Verification on the production Vite build with isolated headless Microsoft Edge:

- `pnpm check`: 217 passed, zero failed, including native NSIS fixture checks. TypeScript and `git diff --check` passed.
- `scripts/verify-constellation-gestures.mjs`: forward and reverse connections, immediate release, duplicate rejection, empty-canvas cancellation, partial/additive marquee selection, group dragging, reconnecting an existing edge, saved reopening, and Space panning after node focus all passed. No browser page errors.
- Three separate bursts each dispatched 1,080 pointer/mouse events over 45 animation frames. Connection paths had 45 attribute updates before and after reopening; the marquee had 90 style-attribute updates (width and height, not 90 frames). Frame intervals were approximately 4.2 ms median and at most 4.6 ms in this headless run. These measurements demonstrate update coalescing in this environment, not an end-user desktop FPS guarantee.
- Screenshots inspected at 1600x1000 and 900x700; the enlarged endpoint detail shows the white ring and solid handle covering the edge. Evidence: `artifacts/constellation-gestures/`.
- This revision did not repeat native desktop UI automation or perform an upgrade installation. The earlier isolated desktop and Rust results above remain historical evidence for the rebuild, not a new native acceptance run for these gesture changes.

Browser command: set `LEVELUP_PLAYWRIGHT_MODULE` to an available Playwright module and `LEVELUP_TEST_URL` to the production preview URL, then run `node scripts/verify-constellation-gestures.mjs`. The script uses the installed Edge browser and a disposable browser context; it does not touch the installed application's data.
