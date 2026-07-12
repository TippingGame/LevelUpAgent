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
    <img alt="Version" src="https://img.shields.io/badge/version-1.0.0-ff5a4f?style=flat-square" />
    <img alt="Status" src="https://img.shields.io/badge/status-stable-35a36f?style=flat-square" />
    <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-232f3e?style=flat-square" />
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-LGPL--3.0--only-2f80ed?style=flat-square" /></a>
  </p>
</div>

---

LevelUpAgent brings model connections, project context, tool approvals, MCP, Skills, Git review, and long-running goals into one desktop workbench. It is designed around [LevelUpAPI](https://levelup.mom/) and also works with standard OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Gemini GenerateContent services.

> [!IMPORTANT]
> LevelUpAgent 1.0.0 is the first stable release. Windows and Linux builds have passed real build and smoke checks. The macOS release pipeline is ready, but signed distribution still requires notarization and physical-device validation. Committing or backing up important work is still recommended.

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
| Windows x64 | NSIS .exe / MSI | Built and verified |
| Linux x64 | AppImage / DEB / RPM | Built; AppImage and DEB smoke-tested |
| macOS Apple Silicon / Intel | DMG / App Bundle | Workflow ready; signing and hardware validation pending |

Checksums for the current local Windows validation artifacts are recorded in [the SHA-256 manifest](docs/SHA256SUMS_1.0.0.txt). Public distribution should use signed artifacts from GitHub Releases.

### 2. Connect a model

1. Open **Model connections** in the lower-left corner.
2. Add LevelUpAPI or another compatible provider URL, API key, protocol, and model.
3. Select **Test** to verify the model list, latency, and connection.
4. Optionally add up to seven fallback connections and set their priority.

A LevelUpAPI URL may be a service root such as <code>https://api.example.com</code>, or already include <code>/v1</code>. LevelUpAgent normalizes request paths and avoids duplicated version prefixes.

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
- Managed image, text, source code, PDF, DOCX, XLSX, and PPTX context
- Persistent Instructions with reviewable synchronization to popular CLI instruction files
- Long-running Goals with token budgets, pause/resume, completion audits, and blocked audits

### Composable extensions

- stdio and Streamable HTTP MCP clients
- Discovery for Codex, Claude, Agents, LevelUpAgent, and project-local Skills
- On-demand Skill body and reference loading to keep context focused
- Sub-agents in isolated Git worktrees, with complete patch review and a second approval before application

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
- [Roadmap](docs/ROADMAP.md)
- [Replacement audit](docs/REPLACEMENT_AUDIT.md)
- [Signed releases and updates](docs/RELEASE.md)
- [Reference project research](docs/REFERENCE_RESEARCH.md)

## Project status

Version 1.0.0 is LevelUpAgent's first stable milestone. It combines four protocols, connection failover, local tools, SQLite, Git review, MCP, Skills, Goals, isolated sub-agents, multi-project conversations, three permission levels, drag-and-drop context, and complete LevelUpAPI platform guidance.

Official Windows and macOS signing and automatic updates still depend on repository-owner credentials for Authenticode, Apple notarization, and Tauri updater signing. Follow the [roadmap](docs/ROADMAP.md) for platform validation progress.

## Contributing

Issues, documentation improvements, and pull requests are welcome. Before submitting code, run <code>pnpm check</code>, <code>pnpm build</code>, and the Rust test suite. Changes to protocols, credentials, file access, commands, MCP, or updates should document their security-boundary impact and validation.

## License

LevelUpAgent is licensed under the [GNU Lesser General Public License v3.0 only](LICENSE). The referenced GNU GPL v3 text is included in [LICENSE.GPL](LICENSE.GPL).

Copyright © 2026 LevelUpAgent contributors.
