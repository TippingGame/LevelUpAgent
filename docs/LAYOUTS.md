# Declarative layouts

LevelUpAgent renders its client structure from a validated `layout.json`. The built-in default layout is [default.layout.json](../layouts/default.layout.json). A schema version 2 theme may reference a separate companion layout file through `layoutFile`; if the field is absent or an installed custom layout becomes unreadable, the host uses the default layout.

The layout runtime is declarative. It supports component composition, visible application data, conditions, repeated data, local state, and registered host actions. It never evaluates JavaScript, arbitrary HTML, expressions, shell commands, or unregistered Tauri calls.

## Theme and layout files

Give every theme its own directory and keep both files inside it:

```text
example-theme/
├─ example.levelup-theme
└─ layout.json
```

The theme manifest names the companion file:

```json
{
  "schemaVersion": 2,
  "id": "example",
  "name": "Example",
  "version": "1.0.0",
  "author": "Author",
  "description": "Custom interface",
  "layoutFile": "layout.json",
  "css": "html[data-levelup-theme=\"example\"] { --accent: #2878d0; }"
}
```

Selecting `example.levelup-theme` installs the directory contents as `themes/example/`, where the managed theme is stored as `theme.levelup-theme` beside `layout.json`. `layoutFile` must be `layout.json` or a basename ending in `.layout.json`; absolute paths and directory traversal are rejected. The complete directory is replaced on update and removed on uninstall. Flat files directly under `themes/` are not scanned.

Schema version 1 themes remain compatible. `layout: "standard"` resolves to the default JSON layout, while `layout: "qq2007"` resolves to the bundled QQ2007 compatibility JSON layout.

## Layout format

```json
{
  "schemaVersion": 1,
  "id": "example-layout",
  "name": "Example layout",
  "window": { "decorations": true },
  "initialState": { "section": "main" },
  "root": {
    "type": "container",
    "id": "root",
    "className": ["example-layout"],
    "children": [
      { "type": "slot", "slot": "sidebar" },
      { "type": "slot", "slot": "workspace" },
      { "type": "slot", "slot": "inspector" }
    ]
  }
}
```

The root must be a container. The `workspace` slot is mandatory, cannot be conditional or repeated, and contains approval, stop, send, and other safety-critical controls. Slots cannot be duplicated. Layouts are limited to 512 KiB, 512 nodes, and 32 levels. When `window.decorations` is `false`, the layout must expose real minimize, maximize, and close actions or use the legacy QQ2007 title-bar slot.

## Declarative nodes

| Type | Required fields | Purpose |
| --- | --- | --- |
| `container` | `children` | Semantic or structural grouping |
| `slot` | `slot` | Mount a real LevelUpAgent feature area |
| `text` | `text` or `bind` | Localized text or a visible data value |
| `button` | `label`, `action` | Invoke a registered host or local-state action |
| `image` | `source`, `alt` | App-relative or embedded image |
| `icon` | `name` | Registered Lucide icon |
| `input` | `state`, `label` | Edit layout-local state |
| `repeat` | `source`, `item`, `children` | Render an exposed array |
| `spacer` | none | Flexible structural spacing |

Every node may use `id`, `className`, and `when`. Text may be a string or `{ "zh-CN": "…", "en-US": "…" }`. Strings support `{{path.to.value}}` interpolation.

Conditions support `path` with `equals`, `notEquals`, or `truthy`, plus nested `all`, `any`, and `not` operators. Buttons additionally support `activeWhen` and `disabledWhen`.

## Slots, data, and actions

General slots are `sidebar`, `workspace`, `mediaStudio`, and `inspector`. QQ2007 compatibility slots are also registered for legacy packages.

Layouts can read non-secret interface data for the app, current view, thread metadata, profile/model identity, connection state, agent mode, permission level, balance display, project/thread summaries, Git summary, goal status, and local layout state. They cannot read API keys, credentials, message bodies, arbitrary file contents, or provider request payloads.

Registered actions cover local state, creating or selecting threads, opening projects, switching chat/media views, toggling details, opening LevelUpAgent dialogs, changing locale, refreshing balance, visiting the official site, and real window minimize/maximize/close behavior. Unknown actions are rejected by the Rust installer.

The complete authoring reference and deterministic validator are bundled in the built-in `customize-levelup-layout` skill.

## Styling

Layout files assign safe class tokens. Visual rules stay in theme CSS and remain strictly scoped:

```css
html[data-levelup-theme="example"] .example-layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 300px;
}
```

The host provides only neutral structural utilities such as `layout-row`, `layout-column`, `layout-grid`, `layout-grow`, and `layout-spacer`.
