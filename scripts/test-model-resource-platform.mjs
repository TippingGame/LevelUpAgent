import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { modelResourcePlatform } from "./model-resource-platform.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("3D publishing selects independent Windows ZIP and Linux TAR resources", () => {
  const windows = modelResourcePlatform(root, "windows");
  const linux = modelResourcePlatform(root, "linux");
  assert.equal(windows.spec.target, "windows-x64-cu118");
  assert.equal(windows.archive, "zip");
  assert.equal(linux.spec.target, "linux-x64-cu118");
  assert.equal(linux.archive, "tar");
  assert.deepEqual(modelResourcePlatform(root), linux);
  assert.equal(windows.spec.releaseTag, linux.spec.releaseTag);
  assert.notEqual(windows.spec.resourceVersion, linux.spec.resourceVersion);
});
test("unsupported and ambiguous resource platforms cannot fall back to Linux", () => {
  for (const platform of ["darwin", "macos", "windows-arm64", "", "constructor", "../windows"])
    assert.throws(() => modelResourcePlatform(root, platform), /Unsupported/);
});
