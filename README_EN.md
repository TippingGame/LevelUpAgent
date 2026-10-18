<div align="center">

<img src="public/logo.png" width="88" height="88" alt="LevelUpAgent" />

# LevelUpAgent

### Turn an idea into something real.

A desktop agent for code and creative work. Connect your own models and go from the first thought to the finished project.

[![Release](https://img.shields.io/github/v/release/TippingGame/LevelUpAgent?style=flat-square&color=f26564)](https://github.com/TippingGame/LevelUpAgent/releases/latest) [![Platforms](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4f78c4?style=flat-square)](https://github.com/TippingGame/LevelUpAgent/releases/latest) [![License](https://img.shields.io/badge/license-LGPL--3.0-5f9c86?style=flat-square)](LICENSE)

**[Download](https://github.com/TippingGame/LevelUpAgent/releases/latest)** · **[Documentation](docs/README.md)** · [Issues & ideas](https://github.com/TippingGame/LevelUpAgent/issues)

[简体中文](README.md) · **English**

</div>

![LevelUpAgent conversation home with projects, model controls, execution modes, and task details](docs/images/conversation-home.png)

## One workspace, from thinking to shipping

Let your agent explore a project, edit code, run commands, and verify pages. Plan before executing, or give a longer task to Goal. Files, tool calls, and changes remain available for review.

| What you want to make | What you can use |
| --- | --- |
| **Code & research** | Streaming chat · Project files · Terminal · Browser QA · Change review |
| **Images & sound** | Image generation · Reference edits · Inpainting · Video · Speech · Instrumentals & lyric-conditioned songs |
| **Stories & worlds** | Writing studio · Lore & references · Story playtesting · Spine · 3D |
| **Your own workflow** | Skills · MCP · Constellation workflows · Themes & layouts · Desktop companions |

## Give your ideas room to grow

Describe a scene, add references, and start creating. Prompts, settings, and generation history stay on your machine, ready for the next iteration.

![LevelUpAgent Creative Studio home with six genuinely generated artworks](docs/images/creative-studio.png)

<div align="center"><sub>Cloud Post Office · Undersea Library · Moon Café · Pocket Forest · Desert Spring · Interstellar Garden<br />Captured in a separate 1.3.74 demo workspace. Account balance is redacted.</sub></div>

## Start in three steps

1. **Install** — Get the build for your system from [Releases](https://github.com/TippingGame/LevelUpAgent/releases/latest).
2. **Connect** — Enter your Base URL, API key, and model. Supports Responses, Chat Completions, Anthropic, Gemini, and OpenCode Go.
3. **Create** — Choose a project and start a conversation, or open Creative Studio. Press `Ctrl / Cmd + K` to search conversations and commands.

Conversations and drafts are stored locally; API keys stay in the OS credential vault. Submitted context goes to your selected model provider. The default Agent permission allows workspace edits and some commands automatically; you can choose per-action approval. [Permissions & data →](docs/SECURITY_AUDIT.md)

<details>
<summary><strong>Develop locally</strong></summary>

Requires Node.js 22.18+, pnpm 11+, stable Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm dev` previews the frontend only. Before contributing, run `pnpm check`, `pnpm build`, and `cargo test --manifest-path src-tauri/Cargo.toml`. See [architecture](docs/ARCHITECTURE.md) and the [publishing guide](docs/RELEASE_GUIDE.md).

</details>

<sub>Local music supports Windows x64. ACE-Step 1.5 uses MIT / Qwen3 Apache-2.0; YuE2 INT8 supports reference melodies. YuE2 and MusicGen weights use CC-BY-NC-4.0 for non-commercial use. Large audio and 3D resources download on demand. [Capabilities & requirements](docs/FEATURES.md) · [1.3.82 release notes & platform signing](docs/RELEASE_1.3.82.md)</sub>

---

[LGPL-3.0-only](LICENSE) · [Third-party notices](src-tauri/THIRD_PARTY_NOTICES.md) · [LevelUpAPI](https://levelup.mom/)
