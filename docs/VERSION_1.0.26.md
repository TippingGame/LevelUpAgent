# LevelUpAgent 1.0.26 Release Notes

## Responsive workspace layout

- The standard layout now supports dragging the left navigation sidebar to adjust its width.
- Left and right sidebars cooperate when the window gets narrower, preserving the conversation area without horizontal overflow.
- Narrow windows keep the existing compact icon sidebar behavior.

## Theme generation workflow

- Theme generation creates a dedicated temporary conversation and prepares its Harness before running.
- Reference images are sent as real multimodal attachments.
- Optional AI-generated conversation background art is prepared once by the host before the theme Harness starts.
- Theme generation keeps the generated result and preparation status visible in the conversation.

## Verification

- TypeScript checks and the full Node test suite pass locally.
- The production frontend build succeeds.
- Windows release assets are built by GitHub Actions with the existing Tauri updater signing key.

Tauri updater signatures protect update integrity and publisher continuity. They are not Windows Authenticode signatures, so SmartScreen may still show an unknown-publisher warning.
