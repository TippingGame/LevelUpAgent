<div align="center">
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>

  <a href="https://levelup.mom/">
    <img src="public/logo.png" width="112" height="112" alt="LevelUpAgent Logo" />
  </a>

  <h1>LevelUpAgent</h1>
  <p><strong>One workspace. Every model.</strong></p>
  <p>A local-first, cross-platform AI agent with a calm, unified, and reviewable desktop experience.</p>

  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#highlights">Highlights</a> ·
    <a href="#security-and-privacy">Security</a> ·
    <a href="#documentation">Docs</a> ·
    <a href="https://levelup.mom/">LevelUpAPI</a>
  </p>

  <p>
<img alt="Version" src="https://img.shields.io/badge/version-1.0.8-ff5a4f?style=flat-square" />
    <img alt="Status" src="https://img.shields.io/badge/status-stable-35a36f?style=flat-square" />
    <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-232f3e?style=flat-square" />
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-LGPL--3.0--only-2f80ed?style=flat-square" /></a>
  </p>
</div>

---

LevelUpAgent brings model connections, project context, tool approvals, MCP, Skills, Git review, and long-running goals into one desktop workbench. It is designed around [LevelUpAPI](https://levelup.mom/) and also works with standard OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Gemini GenerateContent services.

> [!IMPORTANT]
> LevelUpAgent 1.0.0 is the first stable release. Windows and Linux builds have passed real build and smoke checks. The current tag workflow focuses on Windows and protects automatic updates with Tauri signatures. Committing or backing up important work is still recommended.

## Why LevelUpAgent

| | What you get |
| --- | --- |
| **One home** | Switch between OpenAI, Claude, Gemini, Grok, and compatible models without maintaining several enhancement tools. |
| **Control by default** | Reads may run automatically; file writes, commands, MCP calls, and sub-agent patches require explicit approval. |
| **Local first** | Conversations and run metadata stay in local SQLite. API keys are stored in the operating system credential vault. |
| **Built for LevelUpAPI** | Native balance, usage, latency, request-id diagnostics, protocol selection, and connection failover. |

## Quick start

### 1. Install

Download the package for your platform from **Releases** in the repository sidebar:

| Platform | Package | Status |
| --- | --- | --- |
| Windows x64 | NSIS .exe / MSI | Built by the tag workflow with Tauri-signed updates |
| Linux x64 | AppImage / DEB / RPM | Built and smoke-tested; not published by the current tag workflow |
| macOS Apple Silicon / Intel | DMG / App Bundle | Not published by the current tag workflow |

Checksums for the current local Windows validation artifacts are recorded in [the SHA-256 manifest](docs/SHA256SUMS_1.0.0.txt). Future public updates should use Tauri-signed GitHub Release artifacts with `.sig` files and `latest.json`.

### 2. Connect a model

1. Open **Model connections** in the lower-left corner.
2. Add LevelUpAPI or another compatible provider URL, protocol, and model. Trusted local or LAN services can explicitly allow a missing API key.
3. Enter a model ID directly, or select **Test** to retrieve it from a compatible model-list endpoint.
4. Optionally add up to seven fallback connections and set their priority.

A Base URL may be a service root such as <code>https://api.example.com</code>, or already include a version prefix such as <code>/v1</code> or <code>/v4</code>. LevelUpAgent previews the resolved request URL and avoids duplicated version prefixes. Local servers must expose an OpenAI-, Anthropic-, or Gemini-compatible endpoint—for example Ollama at <code>http://127.0.0.1:11434/v1</code>, not its native <code>/api/chat</code> endpoint.

### 3. Start working

Choose a project directory, create a conversation, and describe the outcome you want. The agent reads the required context first, then handles files, commands, and external tools according to the selected permission level. You can stop generation, switch models, or inspect actual changes in the Git panel at any time.

## Highlights

### Multi-model workbench

- LevelUpAPI, OpenAI-compatible, Anthropic-compatible, and Gemini-compatible connections
- Primary-first routing, health history, exponential cooldown, and up to seven fallback connections
- Streaming and cancellation across four provider protocols
- Balance, 30-day usage, latency, tokens, and request-id diagnostics
- Safe discovery and import from Codex, Claude Code, Gemini CLI, OpenCode, and cc-switch

### A project-native agent

- Browse, read, search, write, and delete files, plus approved command execution
- Default, Plan, Goal, and Ask modes
- Project conversations, Markdown output, token accounting, and local SQLite persistence
- Conversations without a selected project automatically use the `%LOCALAPPDATA%\\com.levelup.agent\\workspace` temporary workspace while retaining applicable Agent, MCP, Skill, and media capabilities; multiple conversations run and await approval independently
- Managed image, text, source code, PDF, DOCX, XLSX, and PPTX context
- Persistent Instructions with reviewable synchronization to popular CLI instruction files
- Long-running Goals with pause/resume, completion audits, and blocked audits

### Multimodal creation

- Automatically discovers and recommends the newest available image, video, and TTS model on configured connections
- A standalone Media Studio with image references, parallel prompts, local history, previews, and Save As export
- Conversations can call `generate_images`, `generate_videos`, and `generate_speech`; consecutive generation calls run concurrently, preserve result order, and return to the model for one summary
- OpenAI-compatible image, speech, and Sora flows plus native Gemini image, speech, and Veo flows, with persistent video jobs and automatic polling

### Starlight Echoes

- A separate transparent, always-on-top echo window with built-in Yui; names and avatars come directly from Codex-compatible pet packages
- A frame-timed state machine plays all nine atlas actions; drag the character anywhere and resize each echo independently
- Persistent per-echo XP and levels driven by real model input and output tokens
- Separate game-style bubbles for concurrent conversations, approvals, and background media generation
- Double-click opens an echo-specific temporary conversation that stays out of the normal conversation database; every echo has isolated, reviewable long-term memory
- Import, switch, and remove multiple echoes, with automatic discovery from `${CODEX_HOME}/pets`
- `hatch-pet` and `imagegen` ship inside the app and enable automatically; with Python and a model connection available, one click starts a Goal and imports the validated result

### Composable extensions

- stdio and Streamable HTTP MCP clients
- Discovery for Codex, Claude, Agents, LevelUpAgent, and project-local Skills
- On-demand Skill body and reference loading to keep context focused
- Sub-agents in isolated Git worktrees, with complete patch review and a second approval before application
- Install, switch, and uninstall third-party `.levelup-theme` packages

### A calm desktop experience

- Tauri 2 and React for Windows, macOS, and Linux
- A warm visual system shared with LevelUpAPI, responsive layouts, and dark mode
- Complete Chinese and English interfaces with first-run system-language selection
- Keyboard focus, trapped modal focus, Escape behavior, and reduced-motion support

## Supported protocols

| Protocol | Endpoint | Primary LevelUpAPI platforms | Best suited for |
| --- | --- | --- | --- |
| OpenAI Responses | <code>/v1/responses</code> | OpenAI, Anthropic, Grok | Codex, GPT/Grok reasoning, and native tool calls |
| Chat Completions | <code>/v1/chat/completions</code> | OpenAI, Anthropic, Grok | Broad OpenAI-compatible model support |
| Anthropic Messages | <code>/v1/messages</code> | Anthropic, OpenAI, Gemini, Antigravity, Grok | Claude Code and cross-platform Messages clients |
| Gemini GenerateContent | <code>/v1beta/models/{model}:streamGenerateContent</code> | Gemini, Antigravity | Native Gemini models and tools |

Connection settings visualize these primary compatibility relationships with the same platform colors as LevelUpAPI.
Responses is recommended for Grok/xAI, while Chat Completions and Anthropic Messages are also available through LevelUpAPI.

See [LevelUpAPI compatibility](docs/LEVELUPAPI_COMPATIBILITY.md) for automated contract evidence.

## Security and privacy

- **No keys in frontend storage:** API keys live in Windows Credential Manager, macOS Keychain, or Linux Secret Service.
- **Approval for consequential actions:** writes, deletes, commands, MCP calls, and patch application never run silently.
- **Workspace path boundaries:** file tools reject parent traversal, unsafe symlinks, and path-prefix escapes.
- **Recoverable configuration writes:** external CLI changes show a redacted diff, use atomic replacement, and retain timestamped backups.
- **Minimal request logs:** message bodies, attachments, tool arguments, and API keys are not recorded.
- **Transparent provider boundary:** only providers you configure and select receive prepared messages and attachments.

Shell commands and local stdio MCP processes still run with the current operating system user's permissions. LevelUpAgent does not present them as an OS sandbox. Read the [security audit](docs/SECURITY_AUDIT.md) for the full threat model.

## Run from source

Requirements: Node.js 22+, pnpm 11+, Rust 1.85+, and the platform-specific [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

    pnpm install
    pnpm tauri dev

Run <code>pnpm dev</code> for a frontend-only preview. Browser preview cannot access the credential vault, directory picker, or local tools.

### Validate and build

    pnpm check
    pnpm build
    cargo test --manifest-path src-tauri/Cargo.toml
    pnpm tauri build

Validate all four protocol contracts against a local LevelUpAPI checkout:

    pnpm verify:levelupapi

## Repository layout

    LevelUpAgent/
    ├─ src/                  React workbench and interaction state
    ├─ src-tauri/src/        Rust agent core, protocol adapters, and system boundaries
    ├─ src-tauri/icons/      Cross-platform application icons
    ├─ scripts/              Build, release, and compatibility checks
    ├─ docs/                 Architecture, security, roadmap, and release docs
    └─ .github/workflows/    Cross-platform CI and signed-release workflow

## Documentation

- [Architecture and security boundaries](docs/ARCHITECTURE.md)
- [Security audit](docs/SECURITY_AUDIT.md)
- [LevelUpAPI compatibility evidence](docs/LEVELUPAPI_COMPATIBILITY.md)
- [Starlight Echo packages, XP, memory, and hatching](docs/DESKTOP_PETS.md)
- [Roadmap](docs/ROADMAP.md)
- [Replacement audit](docs/REPLACEMENT_AUDIT.md)
- [Signed releases and updates](docs/RELEASE.md)
- [Reference project research](docs/REFERENCE_RESEARCH.md)
- [Third-party theme packages](docs/THEMES.md)
- [Theme development, build, and adaptation specification](docs/THEME_DEVELOPMENT.md)
- [Theme adaptation workflow for agents](docs/THEME_AGENT_WORKFLOW.md)

## Project status

Version 1.0.0 is LevelUpAgent's first stable milestone. It combines four protocols, connection failover, local tools, SQLite, Git review, MCP, Skills, Goals, isolated sub-agents, multi-project conversations, three permission levels, drag-and-drop context, and complete LevelUpAPI platform guidance.

Windows automatic updates depend on repository-owner Tauri updater keys and physical-device validation. The current installers do not use Authenticode and may trigger SmartScreen; tag publishing for other platforms is not enabled. Follow the [roadmap](docs/ROADMAP.md) for progress.

## Contributing

Issues, documentation improvements, and pull requests are welcome. Before submitting code, run <code>pnpm check</code>, <code>pnpm build</code>, and the Rust test suite. Changes to protocols, credentials, file access, commands, MCP, or updates should document their security-boundary impact and validation.

## License

LevelUpAgent is licensed under the [GNU Lesser General Public License v3.0 only](LICENSE). The referenced GNU GPL v3 text is included in [LICENSE.GPL](LICENSE.GPL).

Copyright © 2026 LevelUpAgent contributors.
