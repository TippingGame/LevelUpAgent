# 摇光残影：独立聊天机器人

Implementation baseline: LevelUpAgent 1.3.82, `946af37f807d1fdb6d5f6ddfff627aa28b74ed1b`.
Research: `G:/Work/LevelUpAgent/research/chatbots-2026-10-18`.

## Chat selection and all-chat scope — build6, 2026-10-20

Application version remains **1.3.82**. The new scope panel separates private/group selection from group mention/all-text triggers. Registered/recent chats can be selected individually, selected together or paused together, with atomic batch saves. API/OneBot accounts may opt into all-chat fallback rules; exact rules, including paused exclusions, take precedence and invalidate pending work matched by the old fallback. Histories remain keyed by the actual chat/topic; relation memories require an exact rule. Legacy routes deserialize as exact. Knowledge visibility names distinguish the account and all-private/all-group scopes.

DingTalk desktop supports only registered full-title lists (at most 100 titles/account), with an explicit opt-in for group all-new-text. Its all-future-chat option is disabled and rejected by the backend/driver. The existing foreground, readable-editor and input-idle checks remain necessary; this build does not establish silent background personal-account access. Current evidence and packaging are recorded in [the build6 record](CHATBOTS_SCOPES_2026-10-20.md); historical validation below retains its original scope.

## Desktop DingTalk local delivery — 2026-10-20

新增无需开发者/组织 API 权限的 `dingtalk_desktop` 通道。Windows 本地 OCR/UIA、独立运行环境、可视校准、私聊/群 @ 路由、原子收件缓冲与发送保护已接入既有残影人格和知识库。版本保持 1.3.82；同版本测试安装包独立保存。[使用说明](DINGTALK_DESKTOP_2026-10-20.md)、[本地验收](CHATBOTS_DESKTOP_ACCEPTANCE_2026-10-20.md)。用户选择“暂时不方便，先完成实现”，因此真实钉钉动态收发待后续，不属于本地测试通过的结论。

## Local delivery complete — 2026-10-19

用户确认：“尚未开通，先完成本地实现与验收”。据此，本次交付范围为 M0–M4 本地实现、SDK 契约测试、模拟平台端到端和桌面生命周期验收；M3 微信按既有意见跳过。该本地范围已完成。真实平台应用开通、权限审批及实际登录收发转为后续联调，不再阻塞本次本地交付，也不视为已验证。

2026-10-19 复核了当前 26 个实现/文档文件与 v1.1 清单、归档 ZIP SHA256、归档内逐文件哈希及原生报告，全部一致；运行代码未再修改，因此沿用已通过的对应测试证据，未重复宣称新一轮平台验证。完整收尾记录见 [本地交付验收](CHATBOTS_LOCAL_ACCEPTANCE_2026-10-19.md)。

## Delivery milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 | Independent pet identities, explicit provider/persona, durable inbox/outbox, scoped knowledge, takeover UI | Implemented; Rust and isolated native end-to-end checks passed |
| M1 | Feishu official long connection, direct messages and group mentions | Local implementation and pinned SDK contract checks complete; real tenant validation deferred by user |
| M2 | DingTalk Stream and QQ official group/C2C adapters | Local implementation and pinned SDK contract checks complete; real app validation deferred by user |
| M3 | WeChat feasibility decision | Skipped by user preference: ordinary group takeover is not supported by the researched official assistant channel |
| M4 | Isolated external OneBot connector, lifecycle and end-to-end validation | Local implementation complete; native app + real gateway child + mock peer passed; logged-in service validation deferred by user |

## Acceptance boundaries

- Each bot has its own stable ID, pet, provider, personality, routes, history and knowledge. Selecting another visible pet must not change message routing.
- Receive acknowledgements follow SQLite commit; one platform message has one inbox record. Send uncertainty is visible and never automatically retried.
- Pausing a bot or taking over a chat cancels queued work and checks again before sending. Already accepted platform sends cannot be recalled.
- External chat turns do not inherit owner memories, workspace access, shell, MCP tools or development-agent instructions.
- Gateway credentials use the OS credential store and process stdin. They are not stored in configuration JSON, command lines or logs.
- Actual platform validation requires the user's authorized bot applications and enabled permissions. Mocked verification is recorded separately from live-platform verification.
- Source references are used for protocol compatibility; GPL/AGPL and restricted third-party bot implementations are not copied into this LGPL application. NapCat is not bundled.

## Version ledger

| Date | Revision | Change | Evidence |
| --- | --- | --- | --- |
| 2026-10-18 | M0 working tree | Begin implementation against current 1.3.82 host | Research package and current clean Git baseline |
| 2026-10-18 | chatbots-v1 / M0 | Schema 21; stable pet/bot identity; account/chat/topic routing; inbox/outbox; dedicated tool-free bot_chat; ACL text retrieval; relation memory; daily budgets; control panel | 11 chatbot Rust tests; native dual-bot/account scenario |
| 2026-10-18 | chatbots-v1 / M1 | Feishu long connection using lark-oapi 1.7.5; message_id dedup; durable callback ACK; expiring token refresh | Actual pinned SDK dispatcher and mocked HTTP contracts |
| 2026-10-18 | chatbots-v1 / M2 | DingTalk Stream 0.24.3; QQ botpy 1.2.1 group/C2C; callback ACK and QQ resume rollback; single-attempt delivery | Python gateway suite: 9 tests |
| 2026-10-18 | chatbots-v1 / M3 | WeChat skipped under user instruction | No WeChat account option or login implementation shipped |
| 2026-10-18 | chatbots-v1 / M4 | Authenticated loopback OneBot v11; OS keyring; isolated processes; install/reconnect/exit; ordered unknown-delivery resolution | Windows native QA with a mock model and OneBot peer |
| 2026-10-18 | chatbots-v1.1 / recovery audit | Keep unresolved sends outside the latest-200 window; return saved account identity when connection prerequisites fail; disconnect before changing credentials; add account-failure and forced-process-exit coverage | 578 Rust tests passed / 5 ignored; 10 Python tests; native 13 model calls / 11 sends / 0 page errors |
| 2026-10-19 | chatbots-v1.1-local / acceptance | User explicitly chose local implementation and acceptance first; close local delivery, defer live-platform authentication; runtime code unchanged | 26-file and archive/report consistency audit; CHATBOTS_LOCAL_ACCEPTANCE_2026-10-19.md |

These are implementation-stage labels, not published releases or separate Git commits. The application version remains 1.3.82; the code is an uncommitted working-tree change over the baseline above. Gateway protocol and runtime directory are v1. Exact final source hashes are recorded in chatbots-v1-source-manifest.json in this directory.

## Verification and remaining acceptance

- Frontend: pnpm check passed (309 tests plus 4 appearance tests), production frontend build passed. No appearance-baseline expansion.
- Rust: full suite passed, 578 passed / 5 ignored / 0 failed, including 13 chatbot-specific tests. These cover routing, group/topic triggers, recovery, unresolved-delivery visibility, dedup tombstones, knowledge ACL, relation memory, limits and all four model protocols.
- Python: 10 gateway tests passed against the installed pinned SDKs; direct child stdio and authenticated mock OneBot transport, token expiry, expired reply windows, 429 limits and 503 uncertainty are exercised.
- Native app: separate com.levelup.agent.chatbotsqa identifier; two bots and accounts, same chat ID in different accounts, pet selection independence, cancellation, takeover, delivery uncertainty, restart, account removal, and child shutdown. Four system light/dark × Armor combinations at 720 px, all five panels.
- Evidence and reproducible commands: [validation record](CHATBOTS_VALIDATION_2026-10-18.md) and [usage guide](CHATBOTS.md).
- Deferred external acceptance (user decision, 2026-10-19): user-owned Feishu, DingTalk and QQ bot apps with platform permissions; an independently supplied logged-in OneBot service. These are follow-up items, not blockers for this local delivery. Mock/SDK checks do not establish platform approval, real delivery success or client login compatibility.
- Windows is the tested native target. macOS/Linux code paths exist but were not run in this implementation pass. No release packaging, tag, installer distribution or production account activation has been performed.

### Historical completion audit (chatbots-v1.1, 2026-10-18)

At this audit, the code/documentation work and runtime evidence were complete locally; live-platform acceptance was missing. A read-only inspection of the configured production database found no chat_accounts table and no bot accounts. No credential values were read or printed. The user subsequently answered on 2026-10-19 and explicitly chose local implementation and acceptance first; the current delivery decision is recorded above.

| Required stage | Current authoritative evidence | Remaining acceptance |
| --- | --- | --- |
| Research and per-version source records | research/chatbots-2026-10-18 manifests, fixed repositories/worktrees, original source overlay and v1.1 overlay | None for this research snapshot |
| M0 identity/routing | Database constraints, 13 chatbot Rust tests, native two-account/two-bot run and UI save | Verified locally |
| M0 reliable recovery | Queue/order/budget tests; 220-new-message visibility regression; actual process termination while generating/sending; orphan gateway EOF exit | Verified with controlled platform peer |
| M0 knowledge isolation | SQL ACL and relation-memory tests; tool-free model request assertions; deletion cancellation | Verified locally |
| M1 Feishu | Pinned SDK dispatch and HTTP contracts; group/topic trigger tests | Real tenant direct/group/@/all-authorized-text round trips and reconnection |
| M2 DingTalk/QQ | SDK ACK and resume tests; C2C dispatch; expiry, 429 and 503 send outcomes | Real organization/app credentials, permission scopes and platform message delivery |
| M3 WeChat | Explicitly omitted under user instruction | Skipped |
| M4 external protocol | Authenticated OneBot stdio child; independent-account failure/recovery; native shutdown and forced-exit tests | User-supplied logged-in connector and exact client/version login-restoration checks; real official-channel coexistence |

No live-platform gate is inferred complete from mock traffic. The research design's optional future UI/agent capabilities remain separately listed below. Actual platform round-trip acceptance remains unverified and is deferred under the user's 2026-10-19 instruction.

## Scope chosen for this implementation

The earlier research design includes future options. This version implements exact direct/group/topic routes plus opt-in account/type all-chat fallbacks for API/OneBot channels, group mention or all-text triggers where supported, owner-managed scoped memories, lexical text retrieval and tool-free model responses. It does not implement keyword rules, burst merging, vector embeddings, public web search, media understanding, autonomous knowledge promotion, chat edit/delete synchronization, floating-pet conversation indicators or exported bot bundles. No LangBot/AstrBot daemon is required.

## DingTalk desktop extension — 2026-10-20

The user requested a first local implementation without developer permissions and explicitly deferred opening DingTalk. The new `dingtalk_desktop` adapter uses the already signed-in Windows client, local OCR and UI Automation. It reuses per-pet identities, model profiles, personas, knowledge, route ownership and pause controls. One desktop controller can bind distinct full-title private chats and mention-only groups; all replies use the same signed-in DingTalk account.

Application version remains **1.3.82**. Implementation snapshots use dated build labels and per-file hashes rather than changing the application version. The 2026-10-18/19 evidence above is historical; current desktop evidence and installer details are in `CHATBOTS_DESKTOP_ACCEPTANCE_2026-10-20.md`.

The second desktop build adds stable empty-chat baselines, safe pre-input delivery deferral without regenerating replies, LegacyIAccessible editor support, read-only editor diagnostics, click-target ownership checks and subprocess protocol recovery tests. Uncertain input/send attempts still never retry automatically. The production package contains no mock-driver switch.

Live DingTalk private replies, group mentions and input compatibility remain **unverified**, deferred at the user's request. Local implementation and packaging are delivered independently of this later client test; mocks and screenshot OCR do not establish real compatibility. See `DINGTALK_DESKTOP_2026-10-20.md` for setup and limitations.
