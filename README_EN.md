<img src="public/logo.png" width="64" height="64" alt="LevelUpAgent" />

# LevelUpAgent

A local-first desktop agent. Connect your models and work on code, research, and creative projects in one workspace.

[简体中文](README.md) · **English** · [Documentation](docs/README.md) · [LevelUpAPI](https://levelup.mom/)

## Workspaces

| Workspace | Capabilities |
| --- | --- |
| Agent | Streaming conversations, files, commands, approvals, Goals, Skills, MCP, browser QA, and change review |
| Conversations | History search, quick switching, independent drafts, queued follow-ups, forks, import, and export |
| Creative Studio | Images, video, speech, references, mask editing, and local history |
| Writing | Manuscripts, codex entries, references, goals, snapshots, and narrative playtesting |
| Constellation | Typed nodes, parallel branches, a canvas, and reusable blueprints |

![Constellation workspace](docs/images/constellation-workflow.png)

Themes, declarative layouts, Starlight Echoes desktop companions, connection migration, and CLI configuration sync are also included. See the [feature inventory](docs/FEATURES.md) for scope and limitations.

## Get Started

Install a build from this repository's **Releases**, add a connection with its Base URL, API key, and model, then select your project.

Supported protocols include OpenAI Responses, Chat Completions, Anthropic Messages, Gemini GenerateContent, and OpenCode Go automatic routing. Connections support failover; discovery and reasoning controls follow actual provider and model capabilities.

Press `Ctrl/Cmd + K` in chat to search conversations and commands. Agent executes tasks, Plan exposes read-only tools, Chat uses no tools, and Goal continues work through a completion audit. [Workflows and recovery](docs/AGENT_WORKFLOWS.md)

## Permissions And Data

API keys stay in the OS credential vault. Conversations and drafts are stored locally. Configured model providers receive submitted context; local storage does not imply offline inference.

New installations default to `agent` permission, allowing workspace edits and some commands automatically. `request` asks before side effects; `full` allows automatic execution and access outside the workspace. Existing choices are preserved. Shell and stdio MCP run with your OS account's privileges. [Security boundaries](docs/SECURITY_AUDIT.md)

## Development

Requires Node.js 22.18+, pnpm 11+, stable Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

`pnpm dev` previews the UI without desktop credentials, file tools, or real Agent execution.

```sh
pnpm check
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

[Architecture](docs/ARCHITECTURE.md) · [Performance](docs/PERFORMANCE.md) · [Codex workflow comparison](docs/REPLACEMENT_AUDIT.md) · [Roadmap](docs/ROADMAP.md) · [Releases](docs/RELEASE.md)

The current release is `1.0.58`. Windows builds lack Authenticode signatures; macOS builds use ad-hoc signing and are not notarized. Platform verification limits are documented in the release guide.

## License

[LGPL-3.0-only](LICENSE). See [third-party notices](src-tauri/THIRD_PARTY_NOTICES.md).
