# Starlight Echoes (摇光残影)

LevelUpAgent calls its animated companions Starlight Echoes. The feature includes a managed echo workspace and a separate transparent, always-on-top Tauri window. It reuses the application's existing providers, streaming agent loop, permissions, media tools, and Goal implementation; it does not add another provider protocol or companion API.

On Windows, transparent parts of the overlay pass mouse input through to the window underneath. The character and drag handle automatically become interactive when the pointer enters their bounds. The character itself supports click-drag movement across monitors while preserving click and double-click actions.

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

The shared renderer uses the Codex row contract. A JavaScript frame state machine selects each cell and schedules its exact duration; CSS `steps()` is not used because the final frame of every row has a distinct hold time.

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

Frame durations follow the bundled `hatch-pet/references/animation-rows.md` contract: idle uses `280/110/110/140/140/320 ms`; directional running uses seven `120 ms` frames plus a `220 ms` hold; the remaining rows use their documented state-specific timings. Drag direction selects `running-left` or `running-right`; greetings, drops or level-ups, errors, approvals, generation, active work, and rest map to `waving`, `jumping`, `failed`, `waiting`, `running`, `review`, and `idle` respectively. One-shot reactions return to the current work state after one complete cycle.

The same package image supplies the large character, roster avatar, conversation avatar, and desktop overlay. No separate name or avatar registry exists.

## XP and activity

The pet selected when an Agent run begins receives that run's model usage, even if the user switches pets before the request finishes. Every successful provider response is recorded under its request ID (or operation ID fallback), so tool loops, concurrent conversations, and approval continuations are counted without duplicate rewards.

```text
total XP = floor((input tokens + output tokens) / 100)
XP required for level N = 100 + 35 × (N - 1)
```

Per-echo totals, request IDs, active selection, overlay visibility, scale, and memories are stored in `pet-state.json` under the application data directory. Scale is independently adjustable from 55% to 145%. Removing and later re-importing a custom package with the same ID preserves its XP, size, and memories.

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
