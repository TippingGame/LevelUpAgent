# LevelUpAgent layout.json reference

## Package contract

Use a schema version 2 theme package. Embed the parsed contents of `layout.json` in the package:

```json
{
  "schemaVersion": 2,
  "id": "example-theme",
  "name": "Example",
  "version": "1.0.0",
  "author": "Author",
  "description": "Example custom layout",
  "layout": {
    "schemaVersion": 1,
    "id": "example-layout",
    "name": "Example layout",
    "root": { "type": "container", "children": [{ "type": "slot", "slot": "workspace" }] }
  },
  "css": "html[data-levelup-theme=\"example-theme\"] { --accent: #2878d0; }"
}
```

Installing the theme stores the complete package under `themes/{id}/theme.levelup-theme`; updates replace that directory and uninstall removes it. Omitting `layout` selects the built-in default layout. Legacy schema version 1 package fields and older schema version 2 `layoutFile` companion packages remain supported.

## Layout envelope

```json
{
  "schemaVersion": 1,
  "id": "example-layout",
  "name": "Example layout",
  "window": { "decorations": true },
  "initialState": { "section": "activity", "search": "" },
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

The root must be a `container`. Every layout must contain `workspace` exactly once, outside repeats and conditional ancestors. A file is limited to 512 KiB, 512 nodes, and 32 nesting levels. If `window.decorations` is false, include buttons for `window.minimize`, `window.toggleMaximize`, and `window.close`, or use `qq2007Titlebar`.

## Nodes

All nodes accept `id`, `className` as an array of safe class tokens, and `when`.

- `container`: requires `children`; optionally accepts an ARIA `role`.
- `slot`: requires `slot`.
- `text`: requires either localized `text` or a `bind` data path.
- `button`: requires localized `label` and an `action`; optionally accepts `icon`, `activeWhen`, `disabledWhen`, and `children`.
- `image`: requires `source` and localized `alt`. Sources must be app-relative or embedded `data:image/` URLs.
- `icon`: requires a registered `name`; optionally accepts localized `label`.
- `input`: requires a local `state` key and localized `label`; optionally accepts `placeholder`.
- `repeat`: requires an array `source`, local `item` name, and `children`; optionally accepts `empty` children.
- `spacer`: flexible structural spacing.

Localized text is either a string or `{ "zh-CN": "…", "en-US": "…" }`. Text and action strings can interpolate safe paths with `{{thread.title}}`.

## Conditions

```json
{ "path": "view.current", "equals": "chat" }
{ "path": "thread.running", "truthy": true }
{ "path": "state.section", "notEquals": "activity" }
{ "all": [{ "path": "view.current", "equals": "chat" }, { "path": "view.detailsOpen" }] }
{ "any": [{ "path": "thread.running" }, { "path": "thread.pendingApproval" }] }
{ "not": { "path": "profile.connected" } }
```

## Slots

- `sidebar`: built-in project and conversation navigation.
- `workspace`: conversation, approvals, composer, and agent controls. Required.
- `mediaStudio`: media creation interface.
- `inspector`: workspace, Git, permission, and goal details.
- `qq2007Titlebar`, `qq2007Toolbar`, `qq2007RightPanel`, `qq2007Statusbar`: legacy compatibility components.

Each slot may appear at most once. Slot content retains its real application behavior.

## Exposed data

- `app.name`, `app.version`, `app.locale`
- `view.current`, `view.detailsOpen`
- `thread.id`, `thread.title`, `thread.workspace`, `thread.messageCount`, `thread.running`, `thread.pendingApproval`
- `profile.id`, `profile.name`, `profile.model`, `profile.connected`
- `agent.mode`, `agent.permission`
- `balance.label`, `balance.loading`, `balance.error`
- `workspace.temporary`, `workspace.path`
- `projects[]`: `id`, `name`, `workspace`, `threadCount`
- `threads[]`: `id`, `title`, `workspace`, `active`, `running`, `pendingApproval`
- `git.branch`, `git.changedFiles`
- `goal.status`
- `state.KEY`: layout-local state
- `index` and the declared item name inside a `repeat`

No API keys, provider secrets, message bodies, file contents, or arbitrary local paths are exposed.

## Actions

- `state.set`: args `{ "target": "section", "value": "details" }`
- `state.toggle`: args `{ "target": "expanded" }`
- `thread.new`: optional `workspace`
- `thread.activate`: `threadId`
- `project.open`
- `view.chat`, `view.media`
- `panel.toggle`
- `dialog.settings`, `dialog.themes`, `dialog.extensions`, `dialog.skills`, `dialog.logs`
- `app.website`, `app.locale.toggle`
- `balance.refresh`
- `window.minimize`, `window.toggleMaximize`, `window.close`

Action arguments may interpolate data, for example `{ "threadId": "{{item.id}}" }` inside a repeat.

## Icons and structural utilities

Registered icons: `activity`, `bot`, `check`, `chevron-down`, `chevron-right`, `alert`, `cpu`, `external`, `folder`, `folder-open`, `media`, `language`, `message`, `panel-close`, `panel-open`, `plus`, `search`, `settings`, `shield`, `sparkles`, `close`.

Host structural classes: `layout-row`, `layout-column`, `layout-stack`, `layout-grid`, `layout-grow`, and `layout-spacer`. Add theme-specific classes for dimensions and presentation, then style them only inside the theme scope.

## Custom navigation example

```json
{
  "type": "container",
  "className": ["layout-column", "custom-nav"],
  "children": [
    { "type": "text", "text": { "zh-CN": "{{app.name}} 工作台", "en-US": "{{app.name}} workspace" } },
    { "type": "button", "label": { "zh-CN": "新会话", "en-US": "New conversation" }, "icon": "plus", "action": { "name": "thread.new" } },
    {
      "type": "repeat",
      "source": "threads",
      "item": "item",
      "children": [
        {
          "type": "button",
          "label": "{{item.title}}",
          "activeWhen": { "path": "item.active" },
          "action": { "name": "thread.activate", "args": { "threadId": "{{item.id}}" } }
        }
      ]
    }
  ]
}
```
