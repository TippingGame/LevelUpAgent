<div align="center">
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <a href="https://levelup.mom/"><img src="public/logo.png" width="96" height="96" alt="LevelUpAgent Logo" /></a>
  <h1>LevelUpAgent</h1>
  <p><strong>One workspace for every model—and every idea.</strong></p>
  <p>A local-first desktop AI workbench: use the Agent for complex tasks, the Creative Studio for media, and Constellation blueprints for repeatable workflows.</p>
  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#capability-map">Capability map</a> ·
    <a href="#security-and-privacy">Security</a> ·
    <a href="#documentation">Docs</a> ·
    <a href="https://levelup.mom/">LevelUpAPI</a>
  </p>
  <p>
    <img alt="Version" src="https://img.shields.io/badge/version-1.0.42-ff5a4f?style=flat-square" />
    <img alt="Status" src="https://img.shields.io/badge/status-preview-35a36f?style=flat-square" />
    <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-232f3e?style=flat-square" />
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-LGPL--3.0--only-2f80ed?style=flat-square" /></a>
  </p>
</div>

---

## See the product

### Agent workbench

Keep project files, references, commands, MCP, Skills, local turn-change review, optional Git review, and long-running goals in one traceable conversation. Every side-effecting action stays behind an explicit permission boundary.

### Creative Studio

Images, video, speech, and writing have independent parameters and history. Use references, parallel prompts, outpainting, local redraw, transparent PNG masks, and reusable results.

### Constellation blueprints

Connect the four standard abilities—writing, image, video, and speech—into a typed DAG. Box-select any group of nodes, save it as your own blueprint, and keep editing, arranging, or reconnecting the inserted instance.

![Constellation workflow with typed ports and blueprint library](docs/images/constellation-workflow.png)

![Creative Studio with image parameters, references, and local history](docs/images/creative-studio.png)

Read the [Creative Studio capability audit](docs/CREATIVE_STUDIO_AUDIT.md) for the Image Studio comparison and [Constellation documentation](docs/CONSTELLATION.md) for the graph contract and interactions.

## Quick start

### Install

Download the package for your platform from GitHub **Releases**. The current `1.0.42` Windows x64 installers are built by GitHub Actions and signed with the Tauri updater key; they are not Authenticode-signed, so SmartScreen may show an unknown-publisher warning.

| Platform | Package | Status |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` / MSI | Built and smoke-tested |
| Linux x64 | AppImage / DEB / RPM | Build from source |
| macOS Intel / Apple Silicon | DMG / App Bundle | Use the dedicated build script |

### Connect a model

1. Open **New model connection** in the lower-left corner.
2. Configure a Base URL, API key, default text model, and generation protocol. Trusted local or LAN services can explicitly allow a missing key.
3. Click **Detect** or enter a model ID. Standard `/v1/models` and Gemini `/v1beta/models` discovery are independent.
4. Add more connections and assign priorities; failed requests follow health and cooldown data through automatic failover.

LevelUpAgent supports LevelUpAPI plus OpenAI Responses, Chat Completions, Anthropic Messages, and Gemini GenerateContent-compatible services. API keys stay in the operating-system credential vault, never in web storage.

### Make your first work

1. Click **Open Creative Studio** and choose image, video, speech, or writing.
2. Enter a prompt and choose ratio, quality, format, and references.
3. For a repeatable flow, switch to **Constellation**: add abilities from the node library, connect ports by click or drag, run, and inspect results in the preview node.
4. Box-select a group and choose **Save as blueprint**. Insert it later from the blueprint library.

## Capability map

| Entry | Best for | Core capabilities |
| --- | --- | --- |
| Agent workbench | “Finish a task that needs files, tools, and judgment.” | Project context, approvals, MCP, Skills, Goals, turn-change review, optional Git review |
| Creative Studio | “Generate, edit, and manage media quickly.” | Image/video/speech, references, parallel prompts, history, preview |
| Constellation blueprints | “Connect steps and reuse them later.” | Typed ports, DAG execution, box select, batch move, auto-layout, import/export |
| Writing workspace | “Keep a book, screenplay, or narrative project moving.” | Codex, reference library, Goal mode, snapshots, Yarn export |

### Built-in Constellation nodes

- **Prompt** — write once and feed any creative ability.
- **Creative writing** — continue, rewrite, script, and prompt enhancement.
- **Image generation** — text-to-image, image-to-image, outpainting, and masked redraw.
- **Video / speech generation** — extend a text or image idea into motion and sound.
- **Canvas & mask** — annotate images, paint redraw regions, and emit a real PNG mask.
- **Preview / note** — inspect results and leave intent beside the flow.

Useful shortcuts: `Ctrl/Cmd + K` search and add a node, `Ctrl/Cmd + Enter` run, `Ctrl/Cmd + Z` undo, `Ctrl/Cmd + D` duplicate selection, `F` fit the canvas, and `Esc` stop a run.

## Security and privacy

- API keys use Windows Credential Manager, macOS Keychain, or Linux Secret Service.
- Writes, deletes, commands, MCP calls, and patch application never run silently; they require approval.
- File tools stay inside the workspace and reject traversal, unsafe symlinks, and path-prefix escapes.
- Request logs do not store message bodies, attachments, tool arguments, or API keys.
- Only providers you configure and select receive prepared messages and attachments.

Shell commands and local stdio MCP processes still run with the current OS user's permissions; LevelUpAgent does not present them as an OS sandbox. See the [security audit](docs/SECURITY_AUDIT.md) for the full boundary model.

## Run from source

Requirements: Node.js 22+, pnpm 11+, Rust 1.85+, and the platform-specific [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev
```

Use `pnpm dev` for a frontend-only preview. The web preview cannot access the credential vault, directory picker, or local tools.

### Chinese and legacy-encoded source files

Workspace `read_file` and `search_files` decode UTF-8, UTF-16, GBK (the GB2312/CP936 family), GB18030, Big5, Shift-JIS, and Windows-1252 text.
For existing files, the Agent should prefer the exact `edit_file` replacement tool: the host keeps the
source encoding, BOM, and dominant line-ending style, and refuses binary files or characters that the
original encoding cannot represent. New files default to UTF-8; pass an explicit `encoding` for short,
ambiguous legacy files, including mixed East-Asian code pages or BOM-less UTF-16 without a strong NUL
pattern. An ASCII-only file in a project known to use a legacy code page should also be hinted when first adding Chinese text;
those existing bytes are identical across the supported ASCII-compatible encodings. A hint still cannot reinterpret valid
non-ASCII UTF-8. The boundary follows the public design
of [Codex apply-patch](https://github.com/openai/codex/tree/main/codex-rs/apply-patch),
[Claude Text Editor](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/text-editor-tool),
Mozilla [`encoding_rs`](https://github.com/hsivonen/encoding_rs), and
[`chardetng`](https://github.com/hsivonen/chardetng); see the [research notes](docs/REFERENCE_RESEARCH.md)
and [`THIRD_PARTY_NOTICES.md`](src-tauri/THIRD_PARTY_NOTICES.md) for attribution.
With `agent` automatic permission, obvious file-rewriting shell commands (including nested-shell redirection,
PowerShell content-writer aliases, `git apply`, and formatter write-back) require approval first; explicitly approved commands still retain
the encoding behavior of the invoked tool.

### Validate and build

```bash
pnpm check
pnpm build
cargo fmt --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

Use `pnpm build:macos` for macOS packages. Signed public updates additionally require repository-owned Tauri updater keys and signing certificates.

## Documentation

- [Constellation graph contract and interactions](docs/CONSTELLATION.md)
- [Creative Studio capability audit](docs/CREATIVE_STUDIO_AUDIT.md)
- [Architecture and security boundaries](docs/ARCHITECTURE.md)
- [Skills, MCP, web, and browser tools](docs/SKILLS_AND_TOOLS.md)
- [Security audit](docs/SECURITY_AUDIT.md)
- [LevelUpAPI compatibility evidence](docs/LEVELUPAPI_COMPATIBILITY.md)
- [Roadmap](docs/ROADMAP.md)
- [Releases and automatic updates](docs/RELEASE.md)
- [Reference project research](docs/REFERENCE_RESEARCH.md)

## Current status

`1.0.42` is the current release milestone. The right sidebar now includes a browser workbench that shares the Agent's isolated Chromium session, so generated and tested pages, desktop/mobile viewports, console output, and browser-tool results remain visible and interactive. The left sidebar can be dragged directly into an icon rail, the right sidebar can expand to the left-sidebar boundary, and composer actions stay right-aligned and sendable in narrow layouts. Harness completion now coordinates with queued follow-up messages transactionally to prevent a completion/enqueue race from losing work. Windows installers use Tauri updater signatures but are not Authenticode-signed, so SmartScreen may show an unknown-publisher warning. When filing an issue, include reproduction steps, application logs, and platform details.

## License

LevelUpAgent is released under the [GNU Lesser General Public License v3.0 only](LICENSE). The referenced GPL v3 text is included in [LICENSE.GPL](LICENSE.GPL).

Copyright © 2026 LevelUpAgent contributors.
