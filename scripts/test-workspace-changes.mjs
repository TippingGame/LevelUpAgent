import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTurnDiff,
  compareWorkspaceSnapshots,
  MAX_TURN_DIFF_CHARS,
} from "../src/lib/workspaceChanges.ts";

function file(path, fingerprint, content) {
  return { path, fingerprint, content, contentTruncated: false, binary: false };
}

function snapshot(files, isAvailable = true) {
  return { isAvailable, files, truncated: false };
}

test("workspace comparison reports added, modified, and deleted files without Git state", () => {
  const before = snapshot([
    file("keep.txt", "same", "unchanged\n"),
    file("edit.txt", "before", "before\n"),
    file("remove.txt", "removed", "gone\n"),
  ]);
  const after = snapshot([
    file("keep.txt", "same", "unchanged\n"),
    file("edit.txt", "after", "after\n"),
    file("new.txt", "new", "created\n"),
  ]);

  const changes = compareWorkspaceSnapshots(before, after);
  assert.deepEqual(changes.map((change) => [change.path, change.kind]), [
    ["edit.txt", "modified"],
    ["new.txt", "added"],
    ["remove.txt", "deleted"],
  ]);
  assert.match(changes.find((change) => change.path === "edit.txt").turnDiff, /-before/);
  assert.match(changes.find((change) => change.path === "edit.txt").turnDiff, /\+after/);
  assert.match(changes.find((change) => change.path === "remove.txt").turnDiff, /-gone/);
});

test("unavailable snapshots fail closed instead of inventing changes", () => {
  const available = snapshot([file("edit.txt", "before", "before\n")]);
  const unavailable = snapshot([], false);
  assert.deepEqual(compareWorkspaceSnapshots(available, unavailable), []);
  assert.deepEqual(compareWorkspaceSnapshots(unavailable, available), []);
});

test("turn diffs stay bounded and disclose truncation", () => {
  const diff = buildTurnDiff("old\n".repeat(200_000), "new\n".repeat(200_000), "large.txt");
  assert.equal(diff.truncated, true);
  assert.ok(diff.content.length <= MAX_TURN_DIFF_CHARS);
});
