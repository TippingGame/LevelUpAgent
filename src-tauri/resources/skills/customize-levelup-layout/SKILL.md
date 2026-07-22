---
name: customize-levelup-layout
description: Create or revise LevelUpAgent theme layouts embedded in schemaVersion 2 .levelup-theme packages. Use for requests to rearrange the client, add declarative interface components, bind visible LevelUpAgent data, or add safe UI behavior.
---

# Customize LevelUpAgent Layout

Build the requested interface with the declarative layout runtime. Keep structure and behavior in `layout.json`, visual branding in scoped theme CSS, and executable application logic in the host.

## Workflow

1. Read [references/layout-schema.md](references/layout-schema.md) completely.
2. Inspect the target theme manifest, CSS, assets, build script, and current layout before editing.
3. Map the request to existing slots, data paths, primitive nodes, local state, conditions, repeats, and host actions.
4. Create a schema version 2 theme manifest and embed the parsed `layout.json` object in its `layout` field.
5. Create a release directory named after the theme ID and emit the complete single-file `.levelup-theme` package.
6. Keep all theme CSS under `html[data-levelup-theme="THEME_ID"]`. Style custom layout classes there.
7. Run `node scripts/validate-layout.mjs PATH_TO_LAYOUT PATH_TO_THEME_PACKAGE` from this skill directory.
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
