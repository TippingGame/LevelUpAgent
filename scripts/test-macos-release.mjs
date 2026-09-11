import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("release workflow uses the verified macOS packaging path", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");

  assert.match(workflow, /name: Build and sign macOS DMG/);
  assert.match(workflow, /MACOS_SIGNING_IDENTITY: "-"/);
  assert.match(workflow, /run: bash scripts\/build-macos\.sh/);
  assert.doesNotMatch(
    workflow,
    /args: "--target (?:aarch64|x86_64)-apple-darwin --bundles dmg --no-sign"/,
  );
});

test("macOS packaging signs after bundling and verifies the installed copy", async () => {
  const script = await readFile(resolve(root, "scripts/build-macos.sh"), "utf8");
  const build = script.indexOf('"$PNPM_BIN" tauri build --target "$target" --bundles app --no-sign');
  const sign = script.indexOf('sign_app "$app_source"');
  const copy = script.indexOf('ditto "$bundled_app" "$installed_app"');
  const verifyCopy = script.indexOf(
    'codesign --verify --deep --strict --all-architectures --verbose=2 "$installed_app"',
  );

  assert.ok(build >= 0 && sign > build, "the completed app bundle must be signed after Tauri builds it");
  assert.ok(copy >= 0 && verifyCopy > copy, "the simulated installed copy must be signature-verified");
  assert.match(script, /hdiutil verify "\$dmg_path"/);
  assert.match(script, /LevelUpAgent_\$\{VERSION\}_macOS_\$\{label\}\.dmg/);
  assert.match(script, /INSTALL\.txt/);
});
