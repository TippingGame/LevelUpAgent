# Theme packages

LevelUpAgent supports installable, switchable, and removable `.levelup-theme` packages. A theme is presentation-only: it contains metadata and scoped CSS, and it is never executed as JavaScript.

This document is the package-format reference. For the complete development and host-adaptation specification, read [THEME_DEVELOPMENT.md](./THEME_DEVELOPMENT.md). Agents must also follow [THEME_AGENT_WORKFLOW.md](./THEME_AGENT_WORKFLOW.md).

## Package format

Theme packages are UTF-8 JSON files with this schema:

```json
{
  "schemaVersion": 1,
  "id": "example-theme",
  "name": "Example theme",
  "version": "1.0.0",
  "author": "Theme author",
  "description": "A short description",
  "layout": "standard",
  "homepage": "https://example.com",
  "license": "MIT",
  "css": "html[data-levelup-theme=\"example-theme\"] { --accent: #2878d0; }"
}
```

`layout`, `homepage`, and `license` are optional. `layout` defaults to `standard`; the built-in `qq2007` layout exposes the classic title bar, toolbar, three-column workspace, and status bar while the theme is active. The package ID may contain ASCII letters, numbers, dashes, and underscores. CSS must include the exact scope selector matching the ID.

Assets should be embedded as `data:` URLs. Remote CSS imports and remote `url(http...)` resources are rejected. The package is limited to 12 MiB and its CSS to 10 MiB.

## Lifecycle

Open **Model connections → Themes** to manage packages.

- Install validates the selected file and copies it atomically to the app data `themes` directory.
- Activate loads its CSS into a dedicated style element and persists the selected theme ID locally.
- Switching to the built-in default removes all third-party CSS immediately.
- Uninstall removes the copied package. Removing the active package first switches back to the default theme.

Invalid packages are ignored when installed themes are enumerated. Themes cannot call Tauri commands or read credentials, conversations, or local files, but CSS can change the presentation of application controls, so only install packages from authors you trust.
