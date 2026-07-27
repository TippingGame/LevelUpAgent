# Harness upstream notices

The harness primitives in `src-tauri/src/harness/` adapt small, provider-neutral ideas
from these projects. No upstream TUI, credential store, provider implementation,
or sandbox is copied into LevelUpAgent.

- [jcode](https://github.com/1jehuang/jcode): MIT License, Copyright (c) 2025 Jeremy Huang. Adapted concepts: interrupt signal race handling and tool-pair-safe compaction.
- [pi](https://github.com/earendil-works/pi): MIT License, Copyright (c) 2025 Mario Zechner. Adapted concepts: explicit turn/event boundaries and pre/post tool gates.
- [grok-build](https://github.com/xai-org/grok-build): Apache License 2.0, Copyright 2023-2026 SpaceXAI. Adapted concepts: separation of runtime, tools, workspace, and process boundaries.

If future changes copy a substantial upstream source fragment instead of
reimplementing the interface, keep the upstream copyright and license text
next to that file and add a prominent modification notice as required by the
applicable license.
