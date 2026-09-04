import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDiffDisplayRows,
  buildSplitDiffDisplayRows,
  buildTurnDiff,
  compareWorkspaceSnapshots,
  MAX_CHANGE_SET_DIFF_CHARS,
  MAX_TURN_DIFF_CHARS,
  MAX_TURN_DIFF_LINES,
} from "../src/lib/workspaceChanges.ts";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

function sourceSection(start, end) {
  const startIndex = appSource.indexOf(start);
  const endIndex = appSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return appSource.slice(startIndex, endIndex);
}

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

test("conversation expansion selects its changes without stealing the inspector tab", () => {
  const finalize = sourceSection(
    "const finalizeWorkspaceRunChanges = async",
    "const selectChangeSet = useCallback",
  );
  const select = sourceSection(
    "const selectChangeSet = useCallback",
    "const reviewChangeSet = useCallback",
  );
  const review = sourceSection(
    "const reviewChangeSet = useCallback",
    "const editConversationMessage = useCallback",
  );

  assert.doesNotMatch(finalize, /setInspectorTab|setRightPanelOpen/);
  assert.match(select, /setReviewedChangeSet\(changeSet\)/);
  assert.doesNotMatch(select, /setInspectorTab|setRightPanelOpen/);
  assert.match(review, /setInspectorTab\("changes"\)/);
  assert.match(review, /setRightPanelOpen\(true\)/);
  assert.match(appSource, /if \(open && changeSet\) onSelectChanges\(changeSet\)/);
  assert.match(appSource, /changeSet && changeSet\.files\.length > 0/);
});

test("turn-change inspector keeps inline diff controls off by default", () => {
  const inspector = sourceSection(
    "function ChangeInspectorPanel({",
    "function fileChangeKindLabel(",
  );

  assert.match(inspector, /const \[wrapLines, setWrapLines\] = useState\(false\)/);
  assert.match(inspector, /const \[splitView, setSplitView\] = useState\(false\)/);
  assert.match(inspector, /const \[showFullFile, setShowFullFile\] = useState\(false\)/);
  assert.match(inspector, /buildSplitDiffDisplayRows\(diff\.content, effectiveFullFile\)/);
  assert.match(inspector, /onClick=\{\(\) => setSplitView\(\(current\) => !current\)\}/);
  assert.match(inspector, /onClick=\{\(\) => setShowFullFile\(\(current\) => !current\)\}/);
  assert.match(inspector, /className="change-review-inline-diff"/);
  assert.match(inspector, /tr\("复制路径", "Copy path"\)/);
  assert.match(inspector, /tr\("打开所在目录", "Open containing folder"\)/);
});

test("turn diffs include unchanged context across the full file", () => {
  const beforeLines = Array.from({ length: 25 }, (_, index) => `shared-${index}`);
  const afterLines = [...beforeLines];
  beforeLines[12] = "before-change";
  afterLines[12] = "after-change";

  const diff = buildTurnDiff(beforeLines.join("\n"), afterLines.join("\n"), "context.txt");

  assert.match(diff.content, /^ shared-0$/m);
  assert.match(diff.content, /^ shared-24$/m);
  assert.match(diff.content, /^-before-change$/m);
  assert.match(diff.content, /^\+after-change$/m);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.equal(diff.truncated, false);
});

test("compact diff rows collapse leading, trailing, and between-change context", () => {
  const content = [
    "--- a/context.txt",
    "+++ b/context.txt",
    "@@ -1,12 +1,12 @@",
    " leading-0",
    " leading-1",
    " leading-2",
    "-before-one",
    "+after-one",
    " between-0",
    " between-1",
    " between-2",
    " between-3",
    "-before-two",
    "+after-two",
    " trailing-0",
    " trailing-1",
    " trailing-2",
  ].join("\n");

  assert.deepEqual(buildDiffDisplayRows(content), [
    { kind: "line", content: "--- a/context.txt", sourceIndex: 0 },
    { kind: "line", content: "+++ b/context.txt", sourceIndex: 1 },
    { kind: "line", content: "@@ -1,12 +1,12 @@", sourceIndex: 2 },
    { kind: "collapsed", count: 2 },
    { kind: "line", content: " leading-2", sourceIndex: 5 },
    { kind: "line", content: "-before-one", sourceIndex: 6 },
    { kind: "line", content: "+after-one", sourceIndex: 7 },
    { kind: "line", content: " between-0", sourceIndex: 8 },
    { kind: "collapsed", count: 2 },
    { kind: "line", content: " between-3", sourceIndex: 11 },
    { kind: "line", content: "-before-two", sourceIndex: 12 },
    { kind: "line", content: "+after-two", sourceIndex: 13 },
    { kind: "line", content: " trailing-0", sourceIndex: 14 },
    { kind: "collapsed", count: 2 },
  ]);

  assert.deepEqual(
    buildDiffDisplayRows(content, true),
    content.split("\n").map((line, sourceIndex) => ({ kind: "line", content: line, sourceIndex })),
  );
});

test("compact diff rows disclose lines omitted between separate hunks", () => {
  const content = [
    "--- a/context.txt",
    "+++ b/context.txt",
    "@@ -5,2 +5,2 @@",
    " shared-5",
    "-before-6",
    "+after-6",
    "@@ -20,1 +20,1 @@",
    "-before-20",
    "+after-20",
  ].join("\n");

  const collapsedCounts = buildDiffDisplayRows(content)
    .filter((row) => row.kind === "collapsed")
    .map((row) => row.count);

  assert.deepEqual(collapsedCounts, [4, 13]);
});

test("side-by-side rows align asymmetric replacements with independent line numbers", () => {
  const content = [
    "--- a/replacement.txt",
    "+++ b/replacement.txt",
    "@@ -3,4 +3,3 @@",
    " same",
    "-old-one",
    "-old-two",
    "+new-one",
    " tail",
  ].join("\n");

  const rows = buildSplitDiffDisplayRows(content, true);
  assert.deepEqual(rows, [
    {
      kind: "line",
      left: { kind: "context", content: "same", lineNumber: 3, sourceIndex: 3 },
      right: { kind: "context", content: "same", lineNumber: 3, sourceIndex: 3 },
    },
    {
      kind: "line",
      left: { kind: "deletion", content: "old-one", lineNumber: 4, sourceIndex: 4 },
      right: { kind: "addition", content: "new-one", lineNumber: 4, sourceIndex: 6 },
    },
    {
      kind: "line",
      left: { kind: "deletion", content: "old-two", lineNumber: 5, sourceIndex: 5 },
      right: null,
    },
    {
      kind: "line",
      left: { kind: "context", content: "tail", lineNumber: 6, sourceIndex: 7 },
      right: { kind: "context", content: "tail", lineNumber: 5, sourceIndex: 7 },
    },
  ]);
});

test("side-by-side rows keep compact gaps and remove them only for full-file context", () => {
  const content = [
    "--- a/context.txt",
    "+++ b/context.txt",
    "@@ -1,8 +1,8 @@",
    " leading-0",
    " leading-1",
    " leading-2",
    "-before",
    "+after",
    " trailing-0",
    " trailing-1",
    " trailing-2",
  ].join("\n");

  const compactRows = buildSplitDiffDisplayRows(content);
  const fullRows = buildSplitDiffDisplayRows(content, true);
  assert.deepEqual(
    compactRows.filter((row) => row.kind === "collapsed").map((row) => row.count),
    [2, 2],
  );
  assert.equal(fullRows.some((row) => row.kind === "collapsed"), false);
  assert.equal(fullRows.filter((row) => row.kind === "line").length, 7);
});

test("side-by-side rows isolate zero-count hunks instead of pairing across them", () => {
  const content = [
    "--- a/separate.txt",
    "+++ b/separate.txt",
    "@@ -5,1 +4,0 @@",
    "-old-5",
    "@@ -19,0 +20,1 @@",
    "+new-20",
  ].join("\n");

  const rows = buildSplitDiffDisplayRows(content);
  assert.deepEqual(rows.filter((row) => row.kind === "collapsed").map((row) => row.count), [4, 15]);
  const changedRows = rows.filter((row) => row.kind === "line");
  assert.equal(changedRows.length, 2);
  assert.deepEqual(changedRows[0], {
    kind: "line",
    left: { kind: "deletion", content: "old-5", lineNumber: 5, sourceIndex: 3 },
    right: null,
  });
  assert.deepEqual(changedRows[1], {
    kind: "line",
    left: null,
    right: { kind: "addition", content: "new-20", lineNumber: 20, sourceIndex: 5 },
  });
});

test("side-by-side rows preserve raw marker-like content and newline notices", () => {
  const content = [
    "--- a/markers.txt",
    "+++ b/markers.txt",
    "@@ -1,1 +1,1 @@",
    "--- source text",
    "\\ No newline at end of file",
    "+++ modified text",
    "\\ No newline at end of file",
  ].join("\n");

  assert.deepEqual(buildSplitDiffDisplayRows(content, true), [
    {
      kind: "line",
      left: { kind: "deletion", content: "-- source text", lineNumber: 1, sourceIndex: 3 },
      right: { kind: "addition", content: "++ modified text", lineNumber: 1, sourceIndex: 5 },
    },
    {
      kind: "notice",
      left: "No newline at end of file",
      right: "No newline at end of file",
    },
  ]);
});

test("side-by-side newline notices retain their source or modified side", () => {
  const leftOnly = [
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,1 +1,1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
  ].join("\n");
  const rightOnly = [
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
  ].join("\n");
  const sharedContext = [
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " same ending",
    "\\ No newline at end of file",
  ].join("\n");

  assert.deepEqual(buildSplitDiffDisplayRows(leftOnly, true).at(-1), {
    kind: "notice",
    left: "No newline at end of file",
    right: null,
  });
  assert.deepEqual(buildSplitDiffDisplayRows(rightOnly, true).at(-1), {
    kind: "notice",
    left: null,
    right: "No newline at end of file",
  });
  assert.deepEqual(buildSplitDiffDisplayRows(sharedContext, true).at(-1), {
    kind: "notice",
    left: "No newline at end of file",
    right: "No newline at end of file",
  });
});

test("side-by-side rows place added and deleted files on their respective sides", () => {
  const added = [
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
  ].join("\n");
  const deleted = [
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-one",
    "-two",
  ].join("\n");

  const addedRows = buildSplitDiffDisplayRows(added, true).filter((row) => row.kind === "line");
  assert.deepEqual(addedRows.map((row) => [row.left, row.right?.lineNumber]), [[null, 1], [null, 2]]);
  const deletedRows = buildSplitDiffDisplayRows(deleted, true).filter((row) => row.kind === "line");
  assert.deepEqual(deletedRows.map((row) => [row.left?.lineNumber, row.right]), [[1, null], [2, null]]);
});

test("snapshot diffs preserve unchanged lines between separate edits", () => {
  const before = [
    "leading",
    "before-one",
    "shared-0",
    "shared-1",
    "shared-2",
    "shared-3",
    "before-two",
    "trailing",
  ].join("\n");
  const after = [
    "leading",
    "after-one",
    "shared-0",
    "shared-1",
    "shared-2",
    "shared-3",
    "after-two",
    "trailing",
  ].join("\n");

  const diff = buildTurnDiff(before, after, "separate.txt");
  const rows = buildDiffDisplayRows(diff.content);

  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 2);
  assert.match(diff.content, /^ shared-1$/m);
  assert.doesNotMatch(diff.content, /^[-+]shared-1$/m);
  assert.ok(rows.some((row) => row.kind === "collapsed" && row.count === 2));
});

test("line diff retains newline-only edits", () => {
  const diff = buildTurnDiff("line\n", "line", "newline.txt");

  assert.equal(diff.additions, 0);
  assert.equal(diff.deletions, 1);
  assert.match(diff.content, /^-$/m);
});

test("shared change-set budget keeps every compact diff before full context", () => {
  const sharedContext = Array.from(
    { length: 3_000 },
    (_, index) => `${String(index).padStart(4, "0")}:${"x".repeat(150)}`,
  );
  const beforeFiles = [];
  const afterFiles = [];
  for (let index = 0; index < 5; index += 1) {
    const path = `${index}.txt`;
    beforeFiles.push(file(path, `before-${index}`, [...sharedContext, `old-${index}`].join("\n")));
    afterFiles.push(file(path, `after-${index}`, [...sharedContext, `new-${index}`].join("\n")));
  }

  const changes = compareWorkspaceSnapshots(snapshot(beforeFiles), snapshot(afterFiles));
  const storedCharacters = changes.reduce((total, change) => total + (change.turnDiff?.length ?? 0), 0);

  assert.equal(changes.length, 5);
  assert.ok(storedCharacters <= MAX_CHANGE_SET_DIFF_CHARS);
  assert.ok(changes.some((change) => change.turnDiffTruncated));
  for (let index = 0; index < changes.length; index += 1) {
    assert.equal(changes[index].diffAvailable, true);
    assert.match(changes[index].turnDiff, new RegExp(`^-old-${index}$`, "m"));
    assert.match(changes[index].turnDiff, new RegExp(`^\\+new-${index}$`, "m"));
  }
});

test("turn diffs stay bounded and disclose truncation", () => {
  const sharedLines = Array.from(
    { length: MAX_TURN_DIFF_LINES + 50 },
    (_, index) => `shared-${index}`,
  );
  const lineBounded = buildTurnDiff(
    [...sharedLines, "late-old"].join("\n"),
    [...sharedLines, "late-new"].join("\n"),
    "many-lines.txt",
  );
  assert.equal(lineBounded.truncated, true);
  assert.ok(lineBounded.content.split("\n").length <= MAX_TURN_DIFF_LINES);
  assert.match(lineBounded.content, /^-late-old$/m);
  assert.match(lineBounded.content, /^\+late-new$/m);

  const charBounded = buildTurnDiff(
    `${"x".repeat(MAX_TURN_DIFF_CHARS)}\nlate-old`,
    `${"x".repeat(MAX_TURN_DIFF_CHARS)}\nlate-new`,
    "long-lines.txt",
  );
  assert.equal(charBounded.truncated, true);
  assert.ok(charBounded.content.length <= MAX_TURN_DIFF_CHARS);
  assert.match(charBounded.content, /^-late-old$/m);
  assert.match(charBounded.content, /^\+late-new$/m);
});

test("truncated replacements retain evidence from both sides", () => {
  const diff = buildTurnDiff(
    Array.from({ length: 5_000 }, (_, index) => `old-${index}`).join("\n"),
    "new",
    "large-replacement.txt",
  );

  assert.equal(diff.truncated, true);
  assert.ok(diff.content.split("\n").length <= MAX_TURN_DIFF_LINES);
  assert.match(diff.content, /^-old-0$/m);
  assert.match(diff.content, /^\+new$/m);
});
