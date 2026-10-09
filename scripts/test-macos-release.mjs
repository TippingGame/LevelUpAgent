import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function workflowScript(step) {
  const workflow = (await readFile(resolve(root, ".github/workflows/release.yml"), "utf8")).replaceAll("\r\n", "\n");
  const block = workflow.split(`- name: ${step}\n`)[1];
  assert.ok(block, step);
  const script = [];
  for (const line of block.split("          script: |\n")[1].split("\n")) {
    if (line.trim() && !line.startsWith("            ")) break;
    script.push(line.slice(12));
  }
  return script.join("\n");
}

test("a rerun reuses the existing draft and refuses ambiguous drafts", async () => {
  const run = new AsyncFunction("github", "context", "core", await workflowScript("Create or reuse draft release"));
  const context = { ref: "refs/tags/v1.2.71", repo: { owner: "test", repo: "app" } };
  let releases = [{ id: 42, tag_name: "v1.2.71", draft: true }];
  const outputs = [], failures = [];
  const github = { rest: { repos: { listReleases: () => {} } }, paginate: async () => releases };
  const core = { setOutput: (...args) => outputs.push(args), setFailed: message => failures.push(message) };
  await run(github, context, core);
  assert.deepEqual(outputs, [["release_id", "42"]]);
  assert.deepEqual(failures, []);
  releases = [...releases, { id: 43, tag_name: "v1.2.71", draft: true }];
  outputs.length = 0;
  await run(github, context, core);
  assert.equal(outputs.length, 0);
  assert.match(failures[0], /Multiple releases/);
});

test("macOS upload uses the selected release ID and refuses public releases", async () => {
  const run = new AsyncFunction("github", "context", "require", "process", await workflowScript("Upload macOS DMG"));
  const { createHash } = await import("node:crypto");
  const data = Buffer.from("test dmg bytes");
  let draft = true;
  const uploads = [];
  const repos = {
    getRelease: async params => { assert.equal(params.release_id, 42); return { data: { draft } }; },
    listReleaseAssets: () => {},
    uploadReleaseAsset: async params => uploads.push(params),
  };
  const github = { rest: { repos }, paginate: async (_method, params) => { assert.equal(params.release_id, 42); return []; } };
  const context = { repo: { owner: "test", repo: "app" } };
  const requireMock = name => name === "node:crypto" ? { createHash } : {
    readdir: async () => ["app.dmg"], readFile: async () => data,
  };
  await run(github, context, requireMock, { env: { RELEASE_ID: "42" } });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].release_id, 42);
  assert.equal(uploads[0].data, data);
  draft = false;
  await assert.rejects(run(github, context, requireMock, { env: { RELEASE_ID: "42" } }), /published release/);
  assert.equal(uploads.length, 1);
});

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
