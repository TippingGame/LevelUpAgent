# UI appearance guard

LevelUpAgent has two independent appearance inputs: the operating-system light/dark preference and the optional Armor Mode skin. New UI must inherit semantic tokens from the nearest app or studio boundary:

```css
.new-panel {
  color: var(--text);
  background: var(--surface);
  border-color: var(--line);
}
```

Do not add fixed white, black, gray, or light-only `color-scheme` declarations to UI CSS/TSX. Use `--surface`, `--surface-soft`, `--text`, `--muted`, `--line`, and the status tokens in `src/App.css`. If a color is intentionally part of an image preview, brand mark, saturated action, or other contrast pair, put an inline comment immediately above it:

```css
/* appearance-allow: white is the foreground of this saturated action */
```

`pnpm check` runs `scripts/check-appearance.mjs`. It parses every CSS and TSX file, including new files, without depending on Git state. Existing legacy declarations are recorded by exact selector/property/value in `scripts/appearance-baseline.json`; moving them to another selector or adding another copy does not inherit the exemption. Do not expand the baseline. Remove an entry when migrating its declaration to tokens. Use a local `appearance-allow` explanation for a reviewed, deliberate contrast pair.

Armor Mode declares the base palette both on the shell and on `:root:has(.app-shell.armor-mode)`. Body portals inherit the active palette automatically. Derived tokens must be computed at the same boundary as their inputs; otherwise a child may inherit a light value already resolved on its parent. New creative workspaces use the shared `creative-studio` class and `CreativeStudioHeader`.

Validate all four combinations: system light/dark, each with Armor Mode off/on. Check hover, focus, selected, disabled, error, dialogs, portals and at least the 720px minimum window. Check switching both directions and reload. The static guard catches fixed neutral UI colors and light-only schemes, not every possible contrast or layout problem; retain browser screenshots and real Tauri verification. Do not replace deliberate image colors, sprite data or fixed art canvases with UI tokens.
