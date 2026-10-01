# Version 1.1.65: local Windows test package

Date: 2026-10-01. Status: local testing, not published.

## Scope

- Include the completed constellation project overview and blueprint editor rebuild.
- Synchronize package.json, Cargo.toml, Cargo.lock and tauri.conf.json to 1.1.65.
- Build a Windows x64 NSIS installer with the normal com.levelup.agent identity.
- Place the installer in G:\Work\LevelUpAgent\安装包.
- Keep updater artifacts disabled for this ordinary local build.
- Do not push a tag, upload assets or publish a release.

## Cleanup plan

Remove obsolete LevelUpAgent installers and their detached signatures from the
known local installer/release directories, keeping the published 1.0.64 artifacts
for rollback. Remove completed installer fixtures, obsolete generated frontend
builds, the old dependency backup and the completed QA debug build. Preserve
source files, historical notes, test evidence, active dependencies, release
compilation caches and application data.

All deletion targets must resolve inside G:\Work\LevelUpAgent. Do not operate on
the installed application or its user data.

## Existing rebuild verification

The detailed evidence is in [CONSTELLATION_REBUILD.md](CONSTELLATION_REBUILD.md).

- Frontend checks: 216 passed, including 28 constellation behavior tests.
- Rust suite: 517 passed, 3 ignored, 0 failed.
- TypeScript, production frontend build, Rust formatting and diff checks passed.
- Browser project creation, editing, saving and reopening passed.
- An isolated real Tauri application verified automatic port routing, read_file
  execution, invalid JSON recovery, saved state after restart, and references
  shared by two independently persisted downstream projects.
- Read-only SQLite inspection confirmed source identities, saved outputs and
  viewports after restart.
- Real media-provider generation was not tested: the isolated QA profile had no
  model credentials.

## Local package verification plan

1. Run pnpm check after the version change, including native NSIS fixture tests.
2. Build with pnpm tauri build --bundles nsis using the normal configuration.
3. Check executable and installer versions, bundled resources and SHA-256.
4. Copy the installer to the requested directory and confirm the copied hash.
5. Remove newly completed installer fixtures and record cleanup totals.

Building and inspecting this package does not imply that it has been installed
over the user's existing application. Full upgrade and real model-generation
testing remain part of the later release validation.

## Results

Local package completed on 2026-10-01.

- pnpm check: 216 passed, 0 failed, including the native NSIS installer fixture.
- pnpm tauri build --bundles nsis: production frontend and optimized Rust build
  passed; one Windows x64 NSIS installer generated.
- Installer and packaged application ProductVersion/FileVersion: 1.1.65.
- Packaged application PE architecture: AMD64.
- Bandizip archive integrity test: All OK.
- All 50 bundled skill/theme resource files matched their source SHA-256 values.
- The unpacked executable matched the release executable except for Tauri's
  expected bundle-type marker: NSS inside the installer, UNK in the standalone
  release binary. An in-memory normalization confirmed no other differences.
- The installer copied to the requested directory matched the original hash.
- Authenticode status: NotSigned. No updater signatures were generated.
- No production installation, tag push or publication was performed.

Installer: G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.65_Windows_x64-setup.exe

Size: 14,053,593 bytes.

SHA-256: EAD46287AD307DB4A65942C9A16C780739030083DD1E3F82457296A27B2ECC21

Cleanup completed:

- Removed 101 obsolete installer/binary/signature files from the known local
  release directories; retained the published 1.0.64 artifacts for rollback.
- Removed 15 completed installer-fixture directories, three obsolete frontend
  build directories, two old installation-extraction directories, the dependency
  backup and the completed QA debug build.
- Debug cleanup alone reclaimed 80,138,608,640 bytes (about 74.6 GiB), measured
  from G: free space immediately before and after deletion, before packaging.
- Removed the temporary 1.1.65 package inspection directory after verification.
- Historical notes, metadata and diagnostic evidence were preserved.

The initial broad cleanup and a forced dependency-backup deletion were rejected
by automatic policy review. Narrower explicit-path operations without forced
recursive deletion completed the authorized cleanup.

## Additional old release directory cleanup

The user requested cleanup of G:\Work\LevelUpAgent\releases and
G:\Work\LevelUpAgent\release-v1.0.57. Inspection found only the old 1.0.54/1.0.55
Linux/macOS packages and historical 1.0.57 validation files. Current build
configuration and scripts do not reference either directory.

Before deleting those directories, archive the small release notes, manifests,
validation scripts and log under artifacts/local-release-history. Delete the
obsolete binary packages and PDB. Preserve the 1.1.65 local installer and 1.0.64
rollback artifacts.

Additional cleanup completed: both old directories were removed. Eight small
historical files were archived under artifacts/local-release-history. Eleven
obsolete package/debug files were deleted, reclaiming 366,854,144 bytes (about
367 MB), measured from G: free space. The 1.1.65 installer hash remained unchanged
and the 1.0.64 rollback installer remained present.

## Old test package directory

The user requested removal of G:\Work\LevelUpAgent\测试包. Inspection found one
remaining standalone theme test artifact, levelupagent-qq-2007.levelup-theme
(1,893,818 bytes). Remove that artifact and its directory.

Test package directory cleanup completed: the directory and its old theme
artifact were removed. The current 1.1.65 Windows installer remains present in
G:\Work\LevelUpAgent\安装包.

## Refreshed local installer after gesture fixes

Built on 2026-10-01 at 14:26 Asia/Shanghai. This replaces the earlier same-name
installer; the original size and hash in Results above are historical.

- Included the prior Space/focus, node stripe, white overview, and node-size
  persistence corrections plus connection/marquee frame coalescing and endpoint
  stacking fixes. Gesture details and browser evidence are in CONSTELLATION_REBUILD.md.
- `pnpm check`: 217 passed, 0 failed. TypeScript and production Vite build passed.
- Production browser regression passed forward/reverse/rapid-release connections,
  duplicate rejection, cancellation, partial/additive selection, group dragging,
  reconnection, saved reopen, Space panning, and desktop/narrow screenshots.
- `pnpm tauri build --bundles nsis`: succeeded with the normal application identity.
- Installer, release executable, and unpacked executable versions: 1.1.65.
- Archive integrity: All OK. Packaged executable architecture: AMD64. Binary
  matches the release build except for Tauri's expected NSS/UNK bundle marker.
- All 50 bundled skill/theme files matched their source SHA-256 values.
- Copied installer hash matched the source. Authenticode: NotSigned.
- No desktop UI automation, upgrade installation, tag push, or release upload
  was performed for this follow-up. The previous Rust/desktop evidence was not rerun.

Current installer: G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.65_Windows_x64-setup.exe

Size: 14,063,966 bytes.

SHA-256: C68EFFDD4D5D5CFA24E8DB3D702ABD1BC66805559742118EA5B8EB55A7850913

Evidence: artifacts/constellation-gestures, including browser screenshots,
result.json, check.log, build.log, and package-result.json. The package directory
contains the matching SHA256.txt and updated Chinese testing instructions.

## Refreshed local installer after inspector divider fix

Built on 2026-10-01 at 17:30 Asia/Shanghai. This is the current same-name installer;
the size and SHA-256 values in earlier sections are historical.

- Aligned the inspector divider with its content edge, including hover/focus
  states, removing the apparent browser/diff background overhang. The 8px resize
  hit area is unchanged.
- After the fix, `pnpm check`: 217 passed. Browser rendering verified 12 viewport,
  pane-width and tab combinations, line wrapping, horizontal scrolling, split
  diff, pointer resizing and keyboard resizing.
- `pnpm tauri build --bundles nsis`: production frontend and optimized desktop
  build succeeded with the normal application identity and version 1.1.65.
- Installer integrity: All OK. Installer and packaged application versions:
  1.1.65. Packaged architecture: AMD64. All 50 skill/theme resources matched the
  sources. The application matched the release binary except for the expected
  NSS/UNK bundle marker.
- Copied installer SHA-256 matched the source. Authenticode: NotSigned.
- No actual installation, new desktop UI verification or publication was run.

Installer: G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.65_Windows_x64-setup.exe

Size: 14,061,616 bytes.

SHA-256: 76FE281AA638B3FCEBCF5F47FA107C62834F1A27ACC204EC061FB79473B009A9

Previous installer and accompanying notes were backed up to
backups/installer-before-inspector-fix-20261001-172929.
Evidence: artifacts/inspector-package-20261001/package-result.json and archive logs.

## Refreshed local installer after composer and window layout fixes

Built on 2026-10-01 at 17:45 Asia/Shanghai. This supersedes the earlier same-name
installer; earlier hashes and sizes remain historical records.

- Replaced fixed composer wrap breakpoints with wrapping based on the controls'
  intrinsic widths. Armor controls remain on one row when they fit.
- Kept the inspector in the desktop grid below 1180px, reserving a 320px minimum
  conversation width and clamping both sidebars to available space. Window
  shrinking preserves the preferred inspector width for later expansion.
- Synchronized pointer/keyboard resizing bounds with the grid. The existing
  QQ 2007 layout keeps its separate width behavior; mobile overlays remain below
  the native desktop minimum window width.
- `pnpm check`: 217 passed. Browser regression covered 52 Chinese/English,
  armor on/off, 720–1600px viewport and wide-inspector combinations, plus both
  resize handles, keyboard bounds and panel close/reopen. Comparison screenshots
  reproduced both old defects and confirmed the corrected layout.
- Production frontend, optimized desktop build and NSIS packaging passed.
  Installer integrity: All OK. Versions: 1.1.65; application architecture: AMD64.
  All 50 bundled resources matched the sources. The packaged program matched
  the release binary apart from the expected NSS/UNK marker.
- Copied installer SHA-256 matched the source. Authenticode: NotSigned.
  No new native window-drag test, actual upgrade installation or publication
  was performed.

Installer: G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.65_Windows_x64-setup.exe

Size: 14,061,864 bytes.

SHA-256: E9D61D2995BDE1745B437D268D0DAC1476C58027E52ED520B7BF4095C8982BF8

Previous package: backups/installer-before-chat-layout-fix-20261001-174345.
Evidence: artifacts/chat-layout-20261001 (browser results, screenshots, archive
logs and package-result.json).

## Refreshed local installer after settings scrollbar fix

Built on 2026-10-01 at 18:27 Asia/Shanghai. This supersedes the earlier same-name
installer; earlier hashes and sizes are historical.

- Enabled the existing rounded WebKit scrollbar styling where supported, removed
  arrow buttons and kept transparent thumb padding. Standard/native scrollbar
  styling remains available for other engines and forced-color mode.
- Both connection-dialog tabs now scroll only their content body. The dialog
  clips its outer rounded outline while keeping its header, tabs and footer
  fixed. Removed the duplicate general-tab-only layout rules.
- `pnpm check`: 217 passed. Sixteen browser scenarios covered light/armor modes,
  both settings tabs, desktop/narrow sizes, wheel scrolling, actual thumb dragging
  and focusing form fields. All 52 previous chat-layout scenarios also passed.
- Production frontend, optimized desktop build and NSIS packaging passed.
  Installer integrity: All OK. Versions: 1.1.65; architecture: AMD64. All 50 bundled
  resources matched their sources. The program matched the release executable
  apart from the expected NSS/UNK marker; copied installer hashes matched.
- Authenticode: NotSigned. No new native desktop UI test, actual upgrade
  installation or publication was performed.

Installer: G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.65_Windows_x64-setup.exe

Size: 14,053,694 bytes.

SHA-256: BADF049D20F0E67B79577C0B5F59563515D15ECDED4CAB319AF1FE71F2348849

Previous package: backups/installer-before-scrollbar-fix-20261001-182550.
Evidence: artifacts/connection-scrollbar-20261001 (screenshots, browser results,
archive logs and package-result.json).

## Refreshed local installer after constellation conversation execution fix

Built on 2026-10-01 at 22:45 Asia/Shanghai. This supersedes the earlier same-name
installer; earlier hashes and sizes are historical.

- Constellation selects an entire existing conversation or creates one on first
  run, with project groups and search. Message selection and context-source
  controls were removed in the preceding refactor.
- Execution now uses the existing Agent flow with tools, current model and
  permissions, and the selected conversation's full history and workspace.
  Threads outside the loaded sidebar page are fetched from persistence; missing
  threads are reported instead of silently replaced.
- Bind new threads before execution so approval and failure remain accessible.
  Prevent concurrent submissions to one thread and reject incomplete, failed,
  cancelled, approval-pending, old, and error results as downstream input.
- Preserve bindings in project saves and remove them from reusable blueprints.
- `pnpm check`: 230 passed, including new conversation and real App stream
  executor tests using simulated transports. Production frontend and optimized
  Windows/NSIS builds passed.
- Production Edge verification passed at 1440x920, 900x700, and 720x560, including
  project grouping, same-name projects, search, selection, and reset to automatic
  conversation creation. No browser errors were recorded.
- Installer integrity: All OK. Installer/application versions: 1.1.65;
  application architecture: AMD64. All 50 bundled resources matched their source
  hashes. The program matched the release build except for Tauri's expected
  NSS/UNK marker, and the copied installer hash matched.
- No actual upgrade installation or live-model file-write test was performed.

Installer: G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.65_Windows_x64-setup.exe

Size: 14,064,541 bytes.

SHA-256: A347B508FE1F320C427BB7BCA1B5BA7D64B2E79DFC7B9187B82C0F74EA120191

Previous package: backups/installer-before-conversation-fix-20261001-224900.
Evidence: artifacts/constellation-conversation-20261001 (picker screenshots,
browser results, verification script and package-result.json).

## Refreshed local installer after constellation node controls and templates fix

Built on 2026-10-01 at 23:26 Asia/Shanghai. This supersedes the earlier same-name
installer; earlier hashes and sizes are historical.

- Aligned conversation action buttons in a shared flex row. The reusable-template
  save button now has its own row below a consistently sized help paragraph.
- Grouped built-in and custom templates and distinguished old duplicate names.
  Saving an unchanged built-in name creates a named copy; further collisions get
  a numeric suffix. Updating a custom template retains its ID.
- Changed the built-in connectivity example to `echo "tool ready"`, which works
  without Python and avoids the `python -c` approval restriction. Existing node
  configurations remain intact; selecting the built-in reloads the new example.
- Unwrapped native command reports before routing stdout or extracting JSON
  fields. Failed commands and malformed reports cannot become successful output.
  Approval-required commands now direct users to conversation execution.
- Added `docs/CONSTELLATION_TOOL_TEMPLATES.md` with setup, variables, text/JSON
  examples, persistence, and update behavior.
- `pnpm check`: 233 passed. New tests execute the actual node and command functions
  with simulated native responses for JSON, stderr, failure, and approval cases.
- Production Edge checks passed at 1600x1200, 900x800, and 720x650: aligned actions,
  separate save row, no control overflow, duplicate selection, copy naming,
  update without duplication, reload, and preservation of old templates.
  No browser errors. Example commands ran successfully in Windows PowerShell.
- Production frontend, optimized Windows executable, and NSIS build passed.
  Archive integrity: All OK. Installer/application versions: 1.1.65; architecture:
  AMD64. All 50 bundled resources matched their sources. The program matched the
  release executable apart from Tauri's expected NSS/UNK marker.
- Copied installer SHA-256 matched. No actual upgrade installation or new native
  desktop UI test was performed.

Installer: G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.65_Windows_x64-setup.exe

Size: 14,065,897 bytes.

SHA-256: 54BD40E2C1BEDC1A593276E51DFDA3C934A8C1D3D37871B6BA2503CEE64ED664

Previous package: backups/installer-before-node-controls-fix-20261001-233028.
Evidence: artifacts/constellation-node-controls-20261001 (screenshots, browser
results, verification scripts, extracted package and package-result.json).
