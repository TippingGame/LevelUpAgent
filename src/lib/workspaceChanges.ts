import type { ConversationFileChange, WorkspaceSnapshot } from "./types";

export const MAX_TURN_DIFF_LINES = 4_000;
export const MAX_TURN_DIFF_CHARS = 512 * 1024;
export const MAX_CHANGE_SET_DIFF_CHARS = 2 * 1024 * 1024;

/** Build a bounded, readable unified-style diff from two local file texts. */
export function buildTurnDiff(before: string | null, after: string | null, path: string) {
  const beforeLines = before == null ? [] : before.split("\n");
  const afterLines = after == null ? [] : after.split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const context = 3;
  const oldStart = Math.max(0, prefix - context);
  const newStart = Math.max(0, prefix - context);
  const oldChangeEnd = beforeLines.length - suffix;
  const newChangeEnd = afterLines.length - suffix;
  const oldEnd = Math.min(beforeLines.length, oldChangeEnd + context);
  const newEnd = Math.min(afterLines.length, newChangeEnd + context);
  const lines = [
    `--- ${before == null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after == null ? "/dev/null" : `b/${path}`}`,
    `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`,
    ...beforeLines.slice(oldStart, prefix).map((line) => ` ${line}`),
    ...beforeLines.slice(prefix, oldChangeEnd).map((line) => `-${line}`),
    ...afterLines.slice(prefix, newChangeEnd).map((line) => `+${line}`),
    ...afterLines.slice(newChangeEnd, newEnd).map((line) => ` ${line}`),
  ];
  const additions = Math.max(0, newChangeEnd - prefix);
  const deletions = Math.max(0, oldChangeEnd - prefix);
  const rendered = lines.join("\n");
  const truncated = lines.length > MAX_TURN_DIFF_LINES || rendered.length > MAX_TURN_DIFF_CHARS;
  const bounded = lines.slice(0, MAX_TURN_DIFF_LINES).join("\n");
  return {
    content: bounded.slice(0, MAX_TURN_DIFF_CHARS),
    additions,
    deletions,
    truncated,
  };
}

export function compareWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): ConversationFileChange[] {
  if (!before.isAvailable || !after.isAvailable) return [];
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const paths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  const changes: ConversationFileChange[] = [];
  for (const path of paths) {
    const previous = beforeFiles.get(path);
    const current = afterFiles.get(path);
    if (previous?.fingerprint === current?.fingerprint) continue;
    if (!current) {
      const turnDiff = previous?.content != null
        ? buildTurnDiff(previous.content, null, path)
        : null;
      changes.push({
        path,
        kind: "deleted",
        indexStatus: " ",
        worktreeStatus: " ",
        additions: turnDiff?.additions,
        deletions: turnDiff?.deletions,
        diffAvailable: Boolean(turnDiff),
        turnDiff: turnDiff?.content,
        turnDiffTruncated: turnDiff?.truncated,
      });
      continue;
    }
    const kind = previous ? "modified" : "added";
    const turnDiff = previous?.content != null && current.content != null
      ? buildTurnDiff(previous.content, current.content, path)
      : previous?.content != null
        ? buildTurnDiff(previous.content, null, path)
        : !previous && current.content != null
          ? buildTurnDiff(null, current.content, path)
          : null;
    changes.push({
      path,
      kind,
      indexStatus: " ",
      worktreeStatus: " ",
      additions: turnDiff?.additions,
      deletions: turnDiff?.deletions,
      diffAvailable: Boolean(turnDiff),
      turnDiff: turnDiff?.content,
      turnDiffTruncated: turnDiff?.truncated,
    });
  }
  const sorted = changes.sort((left, right) => left.path.localeCompare(right.path));
  let remainingDiffChars = MAX_CHANGE_SET_DIFF_CHARS;
  for (const change of sorted) {
    if (!change.turnDiff) continue;
    if (remainingDiffChars <= 0) {
      change.turnDiff = undefined;
      change.turnDiffTruncated = true;
      change.diffAvailable = false;
      continue;
    }
    if (change.turnDiff.length > remainingDiffChars) {
      change.turnDiff = change.turnDiff.slice(0, remainingDiffChars);
      change.turnDiffTruncated = true;
    }
    remainingDiffChars -= change.turnDiff.length;
  }
  return sorted;
}
