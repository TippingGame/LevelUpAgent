# Harness upstream notices

## Optional local music resources

Music runtimes and model weights are downloaded separately from application installers.
The resource archives retain upstream licenses, model cards and Python distribution notices.

- [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5): MIT; the packaged Qwen3-Embedding-0.6B text encoder uses Apache-2.0.
- [YuE2](https://github.com/multimodal-art-projection/YuE): Apache-2.0 code; YuE2-3B and YuE2-Vae weights use CC-BY-NC-4.0, for non-commercial use.
- [MusicGen Small](https://huggingface.co/facebook/musicgen-small): CC-BY-NC-4.0 weights, for non-commercial use.

Pinned revisions, resource layouts and retained notices are documented in
[`packaging/music-workbench/README.md`](../packaging/music-workbench/README.md).

## Harness primitives

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

## Optional chat gateway SDKs

The original modules/chat_gateway adapter installs these packages on demand in
an isolated Python environment. Their distributions retain upstream licenses:

- lark-oapi 1.7.5 — MIT, https://github.com/larksuite/oapi-sdk-python
- dingtalk-stream 0.24.3 — MIT, https://github.com/open-dingtalk/dingtalk-stream-sdk-python
- qq-botpy 1.2.1 — MIT, https://github.com/tencent-connect/botpy
- websockets 12.0 — BSD-3-Clause, https://github.com/python-websockets/websockets
- httpx 0.28.1 — BSD-3-Clause, https://github.com/encode/httpx

Direct requirements and the tested Windows/Python 3.10 transitive snapshot are
recorded in modules/chat_gateway. The source references and protocol notes are
in that directory's README. OneBot v11 is an external compatibility interface.
NapCat, AstrBot, MaiBot and WeChat account-hook implementations are not bundled.

The optional Windows DingTalk desktop adapter installs these packages in a
separate local Python runtime; upstream license files remain in the installed
distributions. It does not embed or modify the DingTalk client.

- rapidocr-onnxruntime 1.4.4 — Apache-2.0, https://github.com/RapidAI/RapidOCR
- Pillow 11.3.0 — MIT-CMU, https://github.com/python-pillow/Pillow
- uiautomation 2.0.29 — Apache-2.0, https://github.com/yinkaisheng/Python-UIAutomation-for-Windows

Transitive packages and OCR models are installed by their Python distributions.
See modules/chat_gateway/requirements-desktop-lock-windows-py310.txt for the
tested dependency closure; this lock is a Windows/Python 3.10 snapshot.
