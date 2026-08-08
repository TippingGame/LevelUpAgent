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

## Text encoding dependency

- [`encoding_rs` 0.8.35](https://github.com/hsivonen/encoding_rs):
  `(Apache-2.0 OR MIT) AND BSD-3-Clause`, Copyright © Mozilla contributors.
  LevelUpAgent uses its public codec tables and
  strict encode/decode APIs for GBK, GB18030, Big5, Shift-JIS, and Windows-1252
  workspace boundaries. No upstream detector or application code is copied; the
  detection policy and file-editing layer are a clean-room implementation in
  [`src/text_encoding.rs`](src/text_encoding.rs).
- [`chardetng` 1.0.0](https://github.com/hsivonen/chardetng): MIT OR Apache-2.0,
  Copyright © Mozilla contributors. LevelUpAgent uses the public
  `EncodingDetector` API as a secondary signal for no-BOM legacy text. No
  upstream source is copied; ambiguous short inputs are rejected and require an
  explicit encoding hint.
