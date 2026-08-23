# LevelUpAgent Client Capability Contract

LevelUpAgent treats model-callable client features as first-party capabilities. The provider system prompt gives these capabilities priority over asking the user to click through the UI, opening another application, or approximating a native feature with shell commands. The current tool catalog and tool results remain authoritative: the model must not invent a capability or bypass Harness approval.

## Contract v1

Every new user-facing feature must explicitly choose one of these surfaces:

1. A dedicated Agent tool for data access, durable mutations, external I/O, or parameterized work.
2. A registered `client_action` for reversible UI navigation with no secret or durable-data arguments.
3. An explicit `not model-callable` decision documented with the feature because automation would be unsafe or meaningless.

A model-callable capability is complete only when all of the following exist:

| Requirement | Contract |
| --- | --- |
| Identity | Stable `snake_case` tool name and a versioned capability/family ID. Renames require a compatibility alias or a version transition. |
| Availability | Explicit Agent modes, workspace requirement, platform requirement, and dependency checks. Unavailable capabilities are omitted from the provider catalog. |
| Input | JSON Schema with an object root, bounded strings/arrays/numbers, required fields, and `additionalProperties: false` where practical. Never accept raw credentials. |
| Policy | An explicit `ToolRisk` classification and Harness decision. Unknown tools fail into the credential-sensitive boundary. |
| Execution | One host-owned dispatch route. The executor validates arguments again and does not trust provider-side schema enforcement. |
| Result | A bounded structured result or a clearly delimited untrusted-data result. Success is reported only after the operation finishes or is durably queued. |
| Client UX | A localized tool label/icon and visible approval/result state when the call appears in a conversation. |
| Observability | Start/completion/failure logging with operation ID, call ID, tool name, duration, and redacted errors. |
| Verification | Catalog test, provider serialization/tool-call round-trip test, executor integration test, policy test, and negative argument/security test. |
| Documentation | User-facing behavior and limitations in the relevant feature document, plus this contract when the protocol changes. |

## Reversible client actions

The shared registry is [`capabilities/client-actions.json`](../capabilities/client-actions.json). Rust validates it, builds the `client_action` tool Schema, enforces the allowlist, and emits a versioned event. React imports the same registry and rejects unknown actions before changing UI state.

`client_action` is limited to reversible navigation: switching workspaces, opening or closing the details panel, and opening or closing application dialogs. File changes, settings writes, provider calls, process control, browser control, purchases, credentials, and destructive actions require dedicated tools with their own policy classification.

## Browser capability conformance

The `browser_*` family is a dedicated capability because it owns an isolated Chromium process and accepts parameterized actions. A conforming browser implementation must provide:

- an ephemeral profile and loopback-only CDP endpoint;
- bounded URL schemes, workspace-scoped `file:` URLs, and an optional domain allowlist;
- start/list/navigate/wait/viewport/snapshot/click/type/assert/console/screenshot/close operations;
- explicit untrusted boundaries for page and console text;
- screenshot size limits and cleanup of both the process and temporary profile;
- a provider round-trip test proving `browser_start` is sent in the tool catalog and parsed from a model response;
- a real Chromium test covering input, click, assertion, snapshot, console capture, screenshot, and close.

## Manual acceptance cases

Client control prompt:

```text
请直接使用 LevelUpAgent 的原生客户端能力打开 Skills 管理界面，不要告诉我应该点击哪里。
```

Pass criteria: the conversation shows a `client_action` call with `dialog.skills`, and the Skills dialog opens without manual navigation.

Browser prompt, run from this repository in Agent mode:

```text
请只使用 LevelUpAgent 原生工具完成一次内置浏览器验收：用 start_process 启动 `pnpm exec vite --host 127.0.0.1 --port 1430`，再用 browser_start 打开 http://127.0.0.1:1430（allowedDomains 只允许 127.0.0.1），依次执行 browser_snapshot、把视口设为 390x844、browser_assert 验证 document.title === 'LevelUpAgent'、browser_screenshot，最后无论成功失败都执行 browser_close 和 stop_process。逐项报告真实工具结果，不要用系统浏览器或只描述步骤。
```

Pass criteria: the model emits the named tools rather than shell-based browser automation; the snapshot contains `LevelUpAgent`; the assertion passes; the screenshot path exists; the browser session and dev server are both closed.
