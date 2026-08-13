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

## XiaoLu

The Starlight Echo life, study-rhythm, reminder, patrol, and journal
features were informed by the open-source XiaoLu project:

- Project: https://github.com/UniqueYu8988/XiaoLu
- Reviewed revision: `73b361ecd3ced7e24835802cc30250afe381187c`
- License: MIT
- Copyright (c) 2026 UniqueYu8988

LevelUpAgent reimplements and extends those behaviors in its Tauri and Rust
architecture. XiaoLu's Electron shell, installer, character art, fonts, icons,
recorded voice clips, and manual imagery are not bundled here.

MIT License

Copyright (c) 2026 UniqueYu8988

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

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
