# Provider waits and recovery

The 2026-10-16 incident involved repeated connection failures and a stalled
Responses stream. The first tool round took 15 minutes; the next provider
request was still pending when the log ended after 30 minutes. UI heartbeats
and file tools were healthy.

Generation adapters now bound individual transport waits:

| Phase | Limit | Behavior |
| --- | --- | --- |
| Connection | 30 seconds | Existing HTTP client connection timeout |
| Request upload / response headers | 90 seconds | Covers the entire `send()` future |
| Next complete SSE event | 300 seconds | Resets for each event, including reasoning and tool arguments |
| Complete JSON response body | 300 seconds | Bounds providers that ignore streaming and HTTP error bodies |

Active SSE generation has no total time limit. Stop and steer cancellation
remain available in every phase and during retry backoff. SSE comments alone
do not constitute a complete event and therefore cannot extend a stalled wait.

The 300-second SSE idle limit follows the documented Codex default:
<https://developers.openai.com/codex/config-reference/>.
The header/body limits and failed-attempt budget are LevelUpAgent policy,
not claims about Codex internals.

Each provider in a round retains the existing maximum of five retries. After
failed attempts have consumed a cumulative 300 seconds, no further retry is
started on that provider. This is a retry admission budget, not a hard deadline
for the whole round: an in-flight attempt may finish later, and healthy output
is never cut off by the budget. Existing configured failover candidates may
then be tried; otherwise the operation fails visibly. Completed tool calls
are not replayed by provider retries.

After 30 seconds without a phase result, the desktop conversation shows its
wait phase, elapsed seconds, and timeout, updated every 30 seconds. The status
is transient and is removed on progress, retry, completion, failure, or stop.
Reload removes any stale wait status. Opening an HTTP stream no longer claims
that a retry has recovered; recovery is reported on text output or successful
completion (including tool-only responses).

Logs now include wait-phase events, stream opening, first text timing for the
durable Harness, failed stream metrics, timeout phase, and exhausted retry
budget. Transport connection errors retain their underlying error chain.

Validation commands:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm check
pnpm build
node scripts/verify-provider-wait.mjs --prepare
pnpm tauri build --debug --no-bundle --config artifacts/provider-wait-review/tauri.json
# Set LEVELUP_PLAYWRIGHT_MODULE to an installed playwright/index.mjs if needed.
node scripts/verify-provider-wait.mjs
```

The desktop fixture uses its own application identifier and a loopback mock
provider. It checks real IPC, delayed headers, stalled streams, reconnect
status, stop, recovery, persisted history, reload, and 720px layout in system
light/dark with Armor Mode off/on. Results and screenshots are saved under
`artifacts/provider-wait-review/`.
