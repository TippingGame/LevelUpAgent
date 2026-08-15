---
name: customize-levelup-layout
description: Create or revise LevelUpAgent theme layouts embedded in schemaVersion 2 .levelup-theme packages. Use for requests to rearrange the client, add declarative interface components, bind visible LevelUpAgent data, or add safe UI behavior.
---

# Customize LevelUpAgent Layout

Build the requested interface with the declarative layout runtime. Keep structure and behavior in `layout.json`, visual branding in scoped theme CSS, and executable application logic in the host.

When the host asks only for a standard visual theme, keep schema version 1 and do not force a custom layout. Host-provided output paths and task-specific instructions take precedence over the generic release-directory workflow below.

## Single-file package format

Write a generated standard theme as one flat JSON object. Do not nest the manifest fields under a `manifest` key, and do not omit any of the seven required fields:

```json
{
  "schemaVersion": 1,
  "id": "theme-id",
  "name": "Theme Name",
  "version": "1.0.0",
  "author": "LevelUpAgent",
  "description": "Theme description",
  "css": "html[data-levelup-theme=\"theme-id\"] { /* scoped theme CSS */ }"
}
```

Keep `schemaVersion` numeric and all other required metadata and CSS fields as strings. For schema version 2, add the complete embedded `layout` object at the same top level. The package file itself must contain JSON only, without Markdown fences or explanatory text.

`schemaVersion: 1` keeps the standard DOM arrangement, but it is not a limited color preset. A complete standard-layout theme may deeply restyle every existing surface and control with scoped CSS. Establish a coherent token system and cover, at minimum:

- application canvas, sidebar, project rows, and thread rows;
- top bar, model selector, popovers, and menus;
- conversation stage, messages, Markdown, code blocks, and tool calls;
- composer, mode and permission controls, attachments, and send/stop actions;
- inspector, dialogs, fields, buttons, inputs, textareas, and selects;
- hover, focus-visible, active, selected, disabled, and scrollbar states.

When LevelUpAgent says it has already generated a final conversation background, treat the last attached image as a finished host asset. Use it to coordinate palette and readability, but do not call media tools, reproduce it as a data URL, or reference a local path. The host embeds the image and appends the authoritative `.conversation-stage` background CSS after validating the package. Keep the conversation surface transparent enough for that background, and make messages, the composer, menus, and tool cards readable over it.

Keep the `css` value on one line when practical. If it spans lines, encode newline, carriage return, and tab characters inside that JSON string as `\n`, `\r`, and `\t`; a physical line break between the string's opening and closing quotes makes the package invalid JSON.

Embed visual assets only as data URLs. Inside an SVG data URL, percent-encode the scheme delimiter in standard XML namespaces—for example, use `xmlns='http%3A//www.w3.org/2000/svg'` and encode the xlink namespace the same way. Literal `http:` and `https:` strings are forbidden anywhere in theme CSS because remote resources are not allowed.

## Workflow

1. Decide whether the request actually changes layout. For a standard visual-only theme, stay on schema version 1 and skip the layout-only steps below. Otherwise read [references/layout-schema.md](references/layout-schema.md) completely.
2. When revising an existing theme, inspect its manifest, CSS, assets, build script, and current layout before editing. For a new host-provided target, do not read or list paths that do not exist yet.
3. Map the request to existing slots, data paths, primitive nodes, local state, conditions, repeats, and host actions.
4. For a declarative layout, create a schema version 2 theme manifest and embed the parsed `layout.json` object in its `layout` field.
5. If the host provides an exact output path, emit the complete single-file `.levelup-theme` package there. Otherwise create a release directory named after the theme ID.
6. Keep all theme CSS under `html[data-levelup-theme="THEME_ID"]`. Style custom layout classes there.
7. For schema version 2, run `node scripts/validate-layout.mjs PATH_TO_LAYOUT PATH_TO_THEME_PACKAGE` from this skill directory when command execution is available and approved. Schema version 1 themes do not have a layout file to pass to this validator.
8. Build and test the theme, then verify install, activation, restart, default fallback, update, and uninstall.

## Boundaries

- Do not add JavaScript, HTML injection, remote assets, credentials, message-body bindings, shell actions, or arbitrary Tauri commands.
- Use declarative local state and the registered host actions for business behavior.
- Keep the `workspace` slot present so approvals, sending, stopping, and safety controls remain reachable.
- Do not invent data paths, slots, icons, node types, or actions. If the host does not expose a required capability, report the missing contract and propose a reusable host extension.
- Do not modify `App.tsx` or Rust merely to reproduce visual structure already expressible in `layout.json`.
- Preserve the built-in default fallback by omitting `layout` when a theme does not require custom structure.

## Deliverables

Return the absolute path of the `.levelup-theme`, validation results, lifecycle results, and any host capability the design could not express safely.
