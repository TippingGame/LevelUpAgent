# LevelUpAgent Repository Instructions

- Follow the user-level instructions referenced by the active Codex environment.
- Preserve existing worktree changes and inspect `git status --short` before editing.
- For any task that creates, ports, reviews, packages, or extends a theme, read `docs/THEME_AGENT_WORKFLOW.md`, `docs/THEME_DEVELOPMENT.md`, and `docs/THEMES.md` completely before acting.
- Prefer a standalone, scoped `standard` theme. Add a host layout only when CSS cannot provide required semantic structure or real window behavior.
- A theme must never introduce executable JavaScript, remote CSS/assets, unscoped selectors, credential access, or changes to Agent/provider logic.
- Theme-related host changes require `pnpm check`, relevant Rust tests, a production build, and real Tauri lifecycle verification proportional to the change.
