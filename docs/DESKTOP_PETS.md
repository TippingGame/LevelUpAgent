# Starlight Echoes (摇光残影)

LevelUpAgent calls its animated companions Starlight Echoes. The feature includes a managed echo workspace and a separate transparent, always-on-top Tauri window. It reuses the application's existing providers, streaming agent loop, permissions, media tools, and Goal implementation; it does not add another provider protocol or companion API.

On Windows, transparent parts of the overlay pass mouse input through to the window underneath. The character and active prompt automatically become interactive when the pointer enters their tight bounds. The character supports click-drag movement across monitors, double-click opens its conversation, and right-click opens its Life workspace. A task reminder's **open** action focuses the main window directly on the Plan view.

## Autonomous life

Each echo owns a persistent life record rather than deriving its state only from the current Agent request. The record contains:

- energy, focus, curiosity, social bond, and mood needs;
- the current self-selected behavior, reason, message, direction, and next decision time;
- a generated daily schedule, five daily check-ins, tasks, reflections, and 30-day history summaries;
- manual study time, automatic study and knowledge targets, and earned bookmarks;
- source-backed knowledge with confidence and review history;
- autonomous questions with pending, asking, retrying, completed, or failed state and the answering Provider ID;
- a free desktop position, daily favorite-corner visits, dreams, discoveries, and inner traces;
- separate autonomy, independent-learning, movement, reminders, quiet-hours, patrol-speed, and login-startup settings.

The life tick is deterministic and bounded. Quiet hours take priority, then active study, check-ins, low energy, the current daily schedule, autonomous questions, knowledge review, rest, and self-directed walking. Needs continue to change between launches with a six-hour catch-up cap. Behavior, knowledge, schedules, learning questions, rewards, and user actions persist immediately; silent need drift checkpoints at most once per minute to avoid high-frequency disk writes.

Daily plans are generated locally from pending tasks, reviewed memories, stored knowledge, current needs, and configured goals. Due work is ranked by priority, due date, and creation time; future-due tasks are deferred. Regenerating a plan replaces only schedule blocks and preserves completed blocks, check-ins, reflections, reminders, chatter, and study-launch state. The echo can study, review knowledge, plan, walk horizontally within the active monitor work area, rest when tired, sleep during quiet hours, and celebrate completed tasks. User dragging always cancels autonomous movement immediately.

The life loop also produces sparse, durable inner traces without adding controls. On the first wake after quiet hours it may carry one existing knowledge item into a dream fragment. Once per day it may connect two non-discovery knowledge items, store the association as explicitly tentative `discovery` knowledge, and expose the trace in the Life view. Once per day it may choose a favorite desktop direction and walk there. A character click increases social bond and mood; journal entries are throttled to one per five minutes so affection cannot flood storage.

Task creation supports notes, due dates, three priority levels, and daily, weekday, or weekly recurrence. Recurring entries keep a stable series identity while creating one dated occurrence at most once per applicable day; completing an occurrence never overwrites earlier history. Deleting a recurring occurrence retires that series while preserving completed historical occurrences as ordinary records.

The three XiaoLu-inspired study periods are 09:00-12:00, 15:00-18:00, and 18:00-21:00. Ten minutes after a period begins, an unfinished launch appears as an interactive overlay prompt with **start now**, one **10-minute snooze**, and **skip this period**. Morning and afternoon supervision escalates by real elapsed time through playful, firm, angry, and final tiers at 0, 5, 15, and 30 minutes after the original reminder becomes due; the evening launch remains gentle. Starting a manual session completes the current launch. Check-ins can also be answered directly from the overlay, while health needs and quiet hours remain higher priority than supervision.

A Tauri-owned background loop advances life state even when the overlay is hidden, so hiding or reloading the pet webview cannot stop needs, plans, learning, or memories. When autonomy and independent learning are enabled, the echo is outside quiet hours, has at least 30 energy, and a configured text Agent is available, a new echo creates its first question after 45 seconds. Existing echoes with no open question may ask on the next 15-second life tick. It completes at most the configured daily knowledge goal (two by default), leaves at least 90 minutes between newly formed questions, and yields while foreground Agent or media activity is reported. Failed or malformed answers are never stored as knowledge: the question retries after 20 and 40 minutes, then remains visibly failed.

Autonomous movement has a separate switch and does not require independent learning. A ready, awake echo can make one ordinary patrol after a six-minute cooldown; the daily plan's 17:20 walk, the once-daily favorite-corner visit, post-settlement night walks, and study-supervision patrols can also trigger movement. The overlay must be visible, movement and autonomy must both be enabled, no foreground activity bubble may be active, and quiet hours, reminders, low energy, study, or other higher-priority behavior may delay a walk. Each ordinary walk moves horizontally across roughly 28% of the current monitor work area using the directional running animation. User dragging cancels it immediately.

## Knowledge and memory

Conversation memory and the knowledge library have different contracts:

- durable memory stores conservative facts about the user, such as explicit remember requests, identity, stable preferences, and goals;
- knowledge stores a title, summary, human-readable source, source kind, optional source reference, tags, confidence, and review history;
- substantive echo replies are saved as deduplicated conversation knowledge and linked to the originating request or operation ID;
- high-confidence durable memories are reviewed into knowledge once, using a stable source reference;
- autonomous discoveries are marked tentative and deduplicated by local date;
- greetings, secrets, credentials, paths, malformed Agent answers, and unsupported claims are not learned automatically.

The echo prompt includes current needs, behavior, today's schedule, pending tasks, recent knowledge, and reviewed memories. It is explicitly forbidden from claiming unrecorded actions, sensations, or network access. Independent learning is a real background `chat` request to the active LevelUpAgent Agent with normal Provider failover, but no Harness thread, tools, MCP, file access, workspace, shell, or browser. The Agent must return a bounded JSON knowledge record; the runtime validates it, records the actual Provider and request reference, and only then commits it. General autonomous web crawling remains intentionally disabled, so a model must disclose uncertainty about changing facts instead of pretending it verified them online.

## XiaoLu companion rhythm

The XiaoLu research checkout is pinned at `G:/Work/LevelUpAgent/.research/XiaoLu`, commit `73b361ecd3ced7e24835802cc30250afe381187c`. The detailed feature mapping is in [XIAOLU_MIGRATION.md](XIAOLU_MIGRATION.md).

The migrated rhythm includes manual study timing, automatic goals, five check-ins, task-driven plans, daily settlement, history, bookmarks, login startup, and bounded patrols. The echo is intentionally silent: OS offline speech and its settings were removed. LevelUpAgent keeps its existing Tauri lifecycle and multi-model Agent architecture; XiaoLu's Electron shell, tray, installer, character audio, private character assets, and application-specific coupling are not copied. Unknown fields from pre-release state or archives are discarded when loaded and are not written into subsequent state or exports.

## Pet package contract

Each pet is a directory containing exactly the metadata file and the referenced spritesheet:

```text
pet-id/
├─ pet.json
└─ spritesheet.webp
```

`pet.json` uses the Codex-compatible fields:

```json
{
  "id": "yui",
  "displayName": "Yui",
  "description": "A short stable identity description.",
  "spritesheetPath": "spritesheet.webp",
  "personality": "Optional companion-specific prompt text."
}
```

- `id` is 1-80 ASCII letters, digits, dashes, or underscores.
- `displayName` is 1-80 characters and is the source for all pet names in the UI.
- `description` is limited to 500 characters.
- `personality` is optional and limited to 4,000 characters.
- `spritesheetPath` must be a package-local WebP or PNG filename.
- The sheet must be `1536x1872`, arranged as 8 columns by 9 rows of `192x208` cells.
- Symlinks, path traversal, empty files, and sheets larger than 24 MiB are rejected.

The built-in `yui` package is embedded in the application and repaired from the bundled copy if its managed files become unreadable. It cannot be removed or replaced. Custom packages are copied atomically into the application data directory and can be updated by importing the same ID again.

## Animation rows

The shared renderer uses the Codex row contract. A JavaScript frame state machine selects each cell from an absolute animation phase so delayed webview frames do not accumulate timer drift. CSS `steps()` is not used because reaction rows retain state-specific hold times.

| Row | State | Frames |
| --- | --- | ---: |
| 0 | `idle` | 6 |
| 1 | `running-right` | 8 |
| 2 | `running-left` | 8 |
| 3 | `waving` | 4 |
| 4 | `jumping` | 5 |
| 5 | `failed` | 8 |
| 6 | `waiting` | 6 |
| 7 | `running` | 6 |
| 8 | `review` | 6 |

Frame durations follow the bundled `hatch-pet/references/animation-rows.md` contract: idle uses `280/110/110/140/140/320 ms`; directional running uses eight even `90 ms` frames for the XiaoLu-compatible `720 ms` gait; the remaining rows use their documented state-specific timings. Drag direction selects `running-left` or `running-right`; greetings, drops or level-ups, errors, approvals, generation, active work, and rest map to `waving`, `jumping`, `failed`, `waiting`, `running`, `review`, and `idle` respectively. One-shot reactions return to the current work state after one complete cycle.

Directional rendering uses `requestAnimationFrame` and computes the current cell from the absolute animation phase. Every state begins at column 0, then advances through numeric columns left-to-right before looping. If the webview or native window movement delays a paint, the renderer skips to the correct phase instead of accumulating timer drift. The hatching skill mirrors directional frames individually instead of mirroring the full strip, which preserves the gait phase order. The built-in Yui atlas passes the packaged validator with no errors or warnings; all sixteen directional cells share a top alpha bound of 5 px and a foot baseline of 202 px. The previous visible hitch came from a `220 ms` final-frame hold in a `1060 ms` loop; directional playback now uses eight even `90 ms` phases.

The same package image supplies the large character, roster avatar, conversation avatar, and desktop overlay. No separate name or avatar registry exists.

## XP and activity

The pet selected when an Agent run begins receives that run's model usage, even if the user switches pets before the request finishes. Every successful provider response is recorded under its request ID (or operation ID fallback), so tool loops, concurrent conversations, and approval continuations are counted without duplicate rewards.

```text
total XP = floor((input tokens + output tokens) / 100)
XP required for level N = 100 + 35 × (N - 1)
```

Per-echo totals, request IDs, active selection, overlay visibility, scale, and memories are stored in `pet-state.json` under the application data directory. Scale is independently adjustable from 55% to 145%. Removing and later re-importing a custom package with the same ID preserves its XP, size, and memories.

## Complete backup and restore

The workspace header exports the active echo to one `.levelup-echo` ZIP archive. It contains exactly:

```text
backup.json
pet.json
spritesheet.bin
```

`backup.json` includes XP/token progress, durable memories, scale, complete life state, needs, behavior, settings, plans, check-ins, tasks, study sessions, knowledge, autonomous questions and answer provenance, inner traces, rewards, history source records, positions, and timestamps. `pet.json` and `spritesheet.bin` preserve the package identity and visuals. Export uses staged atomic replacement so an existing good backup remains recoverable if a new write fails.

Restore rejects extra files, duplicate or unsafe paths, oversized entries, invalid manifests, mismatched IDs, and spritesheets that are not exactly `1536x1872`. Validation completes before package or state data is committed. Restoring a backup also selects that echo and reapplies its login-startup preference. The archive is intentionally local and contains personal memories and learning history; users should store it with the same care as other private backups.

The main window publishes only bounded activity summaries to the pet window: task ID, title, state, and a short generic detail. Message bodies, tool arguments, file paths, credentials, and request payloads are not sent to the overlay. Multiple running conversations, pending approvals, and background media jobs render as separate game-style status bubbles.

## Temporary conversation and memory

Double-clicking the desktop character focuses the main window and opens one in-memory conversation per pet. These pet threads:

- use the active LevelUpAgent model connection and streaming implementation;
- run in `chat` mode without local tools;
- do not enter the normal conversation database or project list;
- disappear when the application process exits.

The hidden conversation context is rebuilt from `pet.json` and only the selected echo's reviewed durable memories. Memories are keyed by package ID, so switching or opening a different echo cannot leak another echo's context. The local learner is deliberately conservative: it stores explicit "remember" statements and a small set of stable identity, preference, and goal patterns; it rejects likely credentials, URLs, paths, and secrets. Memories are visible and removable from the echo workspace. This follows the persona/conversation separation used by companion systems such as AstrBot while keeping LevelUpAgent's normal session layer authoritative.

## Hatching and auto-import

The application package contains and automatically enables:

- `resources/skills/hatch-pet`
- `resources/skills/imagegen`

Users do not choose or configure Skill paths. At startup, LevelUpAgent resolves the packaged resource directory, creates the private hatch workspace and output directory, and records those paths for the Goal. The only runtime prerequisites reported to the user are:

- Python 3
- a usable LevelUpAgent model connection

**Hatch and auto-import** creates a dedicated Goal conversation with optional managed image references. The Goal is instructed to follow the packaged hatch-pet atlas, grounding, provenance, validation, preview, repair, and packaging requirements while using LevelUpAgent's `generate_images` tool as the visual layer.

When the Goal reaches a terminal completed state, LevelUpAgent scans packages modified since the run started and imports valid results automatically. On startup or when the pet page opens, previously unimported packages under `${CODEX_HOME}/pets` are also discovered without overwriting installed packages.

## Storage

On Windows, the default locations are:

```text
%APPDATA%/com.levelup.agent/pets/<pet-id>/
%APPDATA%/com.levelup.agent/pet-state.json
%APPDATA%/com.levelup.agent/pet-hatch/
%USERPROFILE%/.codex/pets/<pet-id>/
```

Platform equivalents use Tauri's application data and home-directory APIs.

## Validation

Run the normal host checks after changing the pet contract, renderer, or window lifecycle:

```bash
pnpm check
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
```

Desktop changes must also verify both real windows, overlay show/hide, double-click conversation opening, minimum `720x560` main-window layout, and main-window close cleanup.
