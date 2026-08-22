---
name: skill-creator
description: Create or improve a reusable LevelUpAgent Skill with a precise trigger, bounded workflow, and testable acceptance criteria.
---

# Skill Creator

Use this Skill when the user asks to create, refine, review, or package a Skill.

## Workflow

1. Inspect the current Skill catalog and writable roots with `skill_locations` and `scan_skills`; use `inspect_skill` to read an existing valid draft before changing it.
2. Clarify the Skill's trigger, inputs, outputs, non-goals, and failure conditions. Keep the description specific enough for reliable activation.
3. Draft a complete `SKILL.md` with valid YAML frontmatter. Put stable procedure in the body; put optional long references or scripts in separate files.
4. Use `create_skill` for a new Skill or `update_skill` for an existing user/workspace Skill. Never attempt to modify bundled or Codex system Skills.
5. Re-scan and verify that the Skill is valid and enabled. Exercise one representative workflow before reporting completion.

## Quality bar

- Prefer imperative, numbered steps and explicit stop conditions.
- Do not include secrets, credentials, destructive shell commands, or instructions that bypass host policy.
- Keep the manifest concise. Move large examples and reference material into `references/`.
- State which host tools are expected instead of pretending Markdown can grant permissions.
