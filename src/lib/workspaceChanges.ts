import type { ConversationFileChange, WorkspaceSnapshot } from "./types";

export const MAX_TURN_DIFF_LINES = 4_000;
export const MAX_TURN_DIFF_CHARS = 512 * 1024;
export const MAX_CHANGE_SET_DIFF_CHARS = 2 * 1024 * 1024;

export type DiffDisplayRow =
  | { kind: "line"; content: string; sourceIndex: number }
  | { kind: "collapsed"; count: number };

export type SplitDiffCell = {
  kind: "context" | "addition" | "deletion";
  content: string;
  lineNumber: number;
  sourceIndex: number;
};

export type SplitDiffDisplayRow =
  | { kind: "line"; left: SplitDiffCell | null; right: SplitDiffCell | null }
  | { kind: "collapsed"; count: number }
  | { kind: "notice"; left: string | null; right: string | null };

/** Collapse unchanged unified-diff runs while keeping nearby context addressable. */
export function buildDiffDisplayRows(
  content: string,
  fullFile = false,
  contextLines = 1,
): DiffDisplayRow[] {
  const lines = content.split("\n");
  const lineRow = (sourceIndex: number): DiffDisplayRow => ({
    kind: "line",
    content: lines[sourceIndex],
    sourceIndex,
  });
  if (fullFile) return lines.map((_, sourceIndex) => lineRow(sourceIndex));

  const rows: DiffDisplayRow[] = [];
  const visibleContext = Number.isFinite(contextLines)
    ? Math.max(0, Math.floor(contextLines))
    : 1;
  let changeSeenInHunk = false;
  let insideHunk = false;
  let previousHunkNewEnd: number | null = null;
  let index = 0;

  const appendLines = (start: number, end: number) => {
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      rows.push(lineRow(sourceIndex));
    }
  };
  const appendCollapsed = (count: number) => {
    if (count > 0) rows.push({ kind: "collapsed", count });
  };

  while (index < lines.length) {
    const line = lines[index];
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      const newStart = Number(hunk[1]);
      const newCount = hunk[2] == null ? 1 : Number(hunk[2]);
      const newCursorStart = newCount === 0 ? newStart + 1 : newStart;
      const omittedLines = newCursorStart - (previousHunkNewEnd ?? 1);
      appendCollapsed(Math.max(0, omittedLines));
      rows.push(lineRow(index));
      insideHunk = true;
      changeSeenInHunk = false;
      previousHunkNewEnd = newCursorStart + newCount;
      index += 1;
      continue;
    }
    if (!insideHunk || !line.startsWith(" ")) {
      rows.push(lineRow(index));
      if (line.startsWith("@@")) {
        insideHunk = true;
        changeSeenInHunk = false;
      } else if (insideHunk && (line.startsWith("+") || line.startsWith("-"))) {
        changeSeenInHunk = true;
      }
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < lines.length && lines[index].startsWith(" ")) index += 1;
    const runEnd = index;
    let changeFollowsInHunk = false;
    for (let lookahead = runEnd; lookahead < lines.length; lookahead += 1) {
      const next = lines[lookahead];
      if (next.startsWith("@@")) break;
      if (next.startsWith("+") || next.startsWith("-")) {
        changeFollowsInHunk = true;
        break;
      }
    }

    if (!changeSeenInHunk && changeFollowsInHunk) {
      const keptStart = Math.max(runStart, runEnd - visibleContext);
      appendCollapsed(keptStart - runStart);
      appendLines(keptStart, runEnd);
    } else if (changeSeenInHunk && !changeFollowsInHunk) {
      const keptEnd = Math.min(runEnd, runStart + visibleContext);
      appendLines(runStart, keptEnd);
      appendCollapsed(runEnd - keptEnd);
    } else if (changeSeenInHunk && changeFollowsInHunk) {
      const keptEnd = Math.min(runEnd, runStart + visibleContext);
      const keptStart = Math.max(keptEnd, runEnd - visibleContext);
      appendLines(runStart, keptEnd);
      appendCollapsed(keptStart - keptEnd);
      appendLines(keptStart, runEnd);
    } else {
      appendLines(runStart, runEnd);
    }
  }

  return rows;
}

function unifiedDiffCoordinates(lines: string[]) {
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;
  return lines.map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] == null ? 1 : Number(hunk[2]);
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] == null ? 1 : Number(hunk[4]);
      oldLine = oldCount === 0 ? oldStart + 1 : oldStart;
      newLine = newCount === 0 ? newStart + 1 : newStart;
      insideHunk = true;
      return null;
    }
    if (line === "@@ new file @@") {
      oldLine = 0;
      newLine = 1;
      insideHunk = true;
      return null;
    }
    if (!insideHunk) return null;
    if (line.startsWith("+")) {
      const coordinates = { oldLine: null, newLine };
      newLine += 1;
      return coordinates;
    }
    if (line.startsWith("-")) {
      const coordinates = { oldLine, newLine: null };
      oldLine += 1;
      return coordinates;
    }
    if (line.startsWith(" ")) {
      const coordinates = { oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return coordinates;
    }
    return null;
  });
}

/** Build aligned source/modified rows from a unified diff. */
export function buildSplitDiffDisplayRows(
  content: string,
  fullFile = false,
  contextLines = 1,
): SplitDiffDisplayRow[] {
  const lines = content.split("\n");
  const coordinates = unifiedDiffCoordinates(lines);
  const visibleRows = buildDiffDisplayRows(content, fullFile, contextLines);
  const rows: SplitDiffDisplayRow[] = [];
  let deletions: SplitDiffCell[] = [];
  let additions: SplitDiffCell[] = [];
  let leftNotice: string | null = null;
  let rightNotice: string | null = null;
  let lastChangeSide: "left" | "right" | "both" | null = null;

  const flushChanges = () => {
    const length = Math.max(deletions.length, additions.length);
    for (let index = 0; index < length; index += 1) {
      rows.push({
        kind: "line",
        left: deletions[index] ?? null,
        right: additions[index] ?? null,
      });
    }
    if (leftNotice || rightNotice) {
      rows.push({ kind: "notice", left: leftNotice, right: rightNotice });
    }
    deletions = [];
    additions = [];
    leftNotice = null;
    rightNotice = null;
    lastChangeSide = null;
  };
  const appendCollapsed = (count: number) => {
    if (count <= 0) return;
    const previous = rows[rows.length - 1];
    if (previous?.kind === "collapsed") previous.count += count;
    else rows.push({ kind: "collapsed", count });
  };

  for (const row of visibleRows) {
    if (row.kind === "collapsed") {
      flushChanges();
      appendCollapsed(row.count);
      continue;
    }
    if (row.content === "\\ No newline at end of file") {
      const content = row.content.slice(2);
      if (lastChangeSide === "left" || lastChangeSide === "both") leftNotice = content;
      if (lastChangeSide === "right" || lastChangeSide === "both") rightNotice = content;
      continue;
    }
    const position = coordinates[row.sourceIndex];
    if (!position) {
      flushChanges();
      continue;
    }
    if (position.oldLine != null && position.newLine != null) {
      flushChanges();
      const lineContent = row.content.startsWith(" ") ? row.content.slice(1) : row.content;
      rows.push({
        kind: "line",
        left: { kind: "context", content: lineContent, lineNumber: position.oldLine, sourceIndex: row.sourceIndex },
        right: { kind: "context", content: lineContent, lineNumber: position.newLine, sourceIndex: row.sourceIndex },
      });
      lastChangeSide = "both";
      continue;
    }
    if (position.oldLine != null) {
      deletions.push({
        kind: "deletion",
        content: row.content.slice(1),
        lineNumber: position.oldLine,
        sourceIndex: row.sourceIndex,
      });
      lastChangeSide = "left";
      continue;
    }
    if (position.newLine != null) {
      additions.push({
        kind: "addition",
        content: row.content.slice(1),
        lineNumber: position.newLine,
        sourceIndex: row.sourceIndex,
      });
      lastChangeSide = "right";
    }
  }
  flushChanges();
  return rows;
}

type LineDiffOperation = {
  kind: "context" | "addition" | "deletion";
  line: string;
};

type DiffSegment = { start: number; end: number };

type TurnDiffVariants = {
  additions: number;
  deletions: number;
  compactContent: string;
  compactHasChange: boolean;
  compactTruncated: boolean;
  fullContent: string;
  fullTruncated: boolean;
};

const MAX_LCS_CELLS = 250_000;
const MAX_PATIENCE_DEPTH = 64;

function textLines(content: string | null) {
  return content == null ? [] : content.split("\n");
}

function appendLcsDiff(
  before: string[],
  oldStart: number,
  oldEnd: number,
  after: string[],
  newStart: number,
  newEnd: number,
  operations: LineDiffOperation[],
) {
  const oldLength = oldEnd - oldStart;
  const newLength = newEnd - newStart;
  const width = newLength + 1;
  const table = new Uint32Array((oldLength + 1) * width);
  for (let oldOffset = oldLength - 1; oldOffset >= 0; oldOffset -= 1) {
    for (let newOffset = newLength - 1; newOffset >= 0; newOffset -= 1) {
      const index = oldOffset * width + newOffset;
      table[index] = before[oldStart + oldOffset] === after[newStart + newOffset]
        ? table[(oldOffset + 1) * width + newOffset + 1] + 1
        : Math.max(table[(oldOffset + 1) * width + newOffset], table[index + 1]);
    }
  }

  let oldOffset = 0;
  let newOffset = 0;
  while (oldOffset < oldLength || newOffset < newLength) {
    if (
      oldOffset < oldLength
      && newOffset < newLength
      && before[oldStart + oldOffset] === after[newStart + newOffset]
    ) {
      operations.push({ kind: "context", line: before[oldStart + oldOffset] });
      oldOffset += 1;
      newOffset += 1;
    } else if (
      oldOffset < oldLength
      && (
        newOffset >= newLength
        || table[(oldOffset + 1) * width + newOffset] >= table[oldOffset * width + newOffset + 1]
      )
    ) {
      operations.push({ kind: "deletion", line: before[oldStart + oldOffset] });
      oldOffset += 1;
    } else {
      operations.push({ kind: "addition", line: after[newStart + newOffset] });
      newOffset += 1;
    }
  }
}

function patienceAnchors(
  before: string[],
  oldStart: number,
  oldEnd: number,
  after: string[],
  newStart: number,
  newEnd: number,
) {
  const oldOccurrences = new Map<string, { count: number; index: number }>();
  const newOccurrences = new Map<string, { count: number; index: number }>();
  for (let index = oldStart; index < oldEnd; index += 1) {
    const current = oldOccurrences.get(before[index]);
    if (current) current.count += 1;
    else oldOccurrences.set(before[index], { count: 1, index });
  }
  for (let index = newStart; index < newEnd; index += 1) {
    const current = newOccurrences.get(after[index]);
    if (current) current.count += 1;
    else newOccurrences.set(after[index], { count: 1, index });
  }

  const pairs: Array<{ oldIndex: number; newIndex: number }> = [];
  for (const occurrence of oldOccurrences.values()) {
    if (occurrence.count !== 1) continue;
    const matching = newOccurrences.get(before[occurrence.index]);
    if (matching?.count === 1) {
      pairs.push({ oldIndex: occurrence.index, newIndex: matching.index });
    }
  }
  pairs.sort((left, right) => left.oldIndex - right.oldIndex);
  if (pairs.length < 2) return pairs;

  const tails: number[] = [];
  const previous = new Int32Array(pairs.length);
  previous.fill(-1);
  for (let index = 0; index < pairs.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]].newIndex < pairs[index].newIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }

  const anchors: Array<{ oldIndex: number; newIndex: number }> = [];
  let cursor = tails[tails.length - 1];
  while (cursor >= 0) {
    anchors.push(pairs[cursor]);
    cursor = previous[cursor];
  }
  anchors.reverse();
  return anchors;
}

function appendLineDiff(
  before: string[],
  oldStart: number,
  oldEnd: number,
  after: string[],
  newStart: number,
  newEnd: number,
  operations: LineDiffOperation[],
  depth = 0,
) {
  while (oldStart < oldEnd && newStart < newEnd && before[oldStart] === after[newStart]) {
    operations.push({ kind: "context", line: before[oldStart] });
    oldStart += 1;
    newStart += 1;
  }
  let suffix = 0;
  while (
    oldStart + suffix < oldEnd
    && newStart + suffix < newEnd
    && before[oldEnd - 1 - suffix] === after[newEnd - 1 - suffix]
  ) suffix += 1;
  const oldMiddleEnd = oldEnd - suffix;
  const newMiddleEnd = newEnd - suffix;

  if (oldStart === oldMiddleEnd) {
    for (let index = newStart; index < newMiddleEnd; index += 1) {
      operations.push({ kind: "addition", line: after[index] });
    }
  } else if (newStart === newMiddleEnd) {
    for (let index = oldStart; index < oldMiddleEnd; index += 1) {
      operations.push({ kind: "deletion", line: before[index] });
    }
  } else {
    const oldLength = oldMiddleEnd - oldStart;
    const newLength = newMiddleEnd - newStart;
    if (oldLength * newLength <= MAX_LCS_CELLS) {
      appendLcsDiff(before, oldStart, oldMiddleEnd, after, newStart, newMiddleEnd, operations);
    } else {
      const anchors = depth < MAX_PATIENCE_DEPTH
        ? patienceAnchors(before, oldStart, oldMiddleEnd, after, newStart, newMiddleEnd)
        : [];
      if (anchors.length > 0) {
        let oldCursor = oldStart;
        let newCursor = newStart;
        for (const anchor of anchors) {
          appendLineDiff(
            before,
            oldCursor,
            anchor.oldIndex,
            after,
            newCursor,
            anchor.newIndex,
            operations,
            depth + 1,
          );
          operations.push({ kind: "context", line: before[anchor.oldIndex] });
          oldCursor = anchor.oldIndex + 1;
          newCursor = anchor.newIndex + 1;
        }
        appendLineDiff(
          before,
          oldCursor,
          oldMiddleEnd,
          after,
          newCursor,
          newMiddleEnd,
          operations,
          depth + 1,
        );
      } else {
        for (let index = oldStart; index < oldMiddleEnd; index += 1) {
          operations.push({ kind: "deletion", line: before[index] });
        }
        for (let index = newStart; index < newMiddleEnd; index += 1) {
          operations.push({ kind: "addition", line: after[index] });
        }
      }
    }
  }

  for (let offset = 0; offset < suffix; offset += 1) {
    operations.push({ kind: "context", line: before[oldMiddleEnd + offset] });
  }
}

function diffSegments(operations: LineDiffOperation[], contextLines: number): DiffSegment[] {
  if (!Number.isFinite(contextLines)) return [{ start: 0, end: operations.length }];
  const context = Math.max(0, Math.floor(contextLines));
  const segments: DiffSegment[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].kind === "context") continue;
    const start = Math.max(0, index - context);
    const end = Math.min(operations.length, index + context + 1);
    const previous = segments[segments.length - 1];
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else segments.push({ start, end });
  }
  return segments;
}

function segmentsForIndexes(indexes: number[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  for (const index of indexes) {
    const previous = segments[segments.length - 1];
    if (previous?.end === index) previous.end = index + 1;
    else segments.push({ start: index, end: index + 1 });
  }
  return segments;
}

function balancedChangedIndexes(indexes: number[], count: number) {
  if (count >= indexes.length) return indexes;
  const leadingCount = Math.ceil(count / 2);
  const trailingCount = count - leadingCount;
  return [
    ...indexes.slice(0, leadingCount),
    ...(trailingCount > 0 ? indexes.slice(-trailingCount) : []),
  ];
}

function renderDiffSegments(
  operations: LineDiffOperation[],
  segments: DiffSegment[],
  before: string | null,
  after: string | null,
  path: string,
) {
  const lines = [
    `--- ${before == null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after == null ? "/dev/null" : `b/${path}`}`,
  ];
  const oldPositions = new Uint32Array(operations.length + 1);
  const newPositions = new Uint32Array(operations.length + 1);
  oldPositions[0] = 1;
  newPositions[0] = 1;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    oldPositions[index + 1] = oldPositions[index] + (operation.kind === "addition" ? 0 : 1);
    newPositions[index + 1] = newPositions[index] + (operation.kind === "deletion" ? 0 : 1);
  }

  const renderedSegments = segments.length > 0
    ? segments
    : operations.length === 0
      ? [{ start: 0, end: 0 }]
      : [];
  for (const segment of renderedSegments) {
    let oldCount = 0;
    let newCount = 0;
    for (let index = segment.start; index < segment.end; index += 1) {
      if (operations[index].kind !== "addition") oldCount += 1;
      if (operations[index].kind !== "deletion") newCount += 1;
    }
    const oldStart = oldCount === 0 ? Math.max(0, oldPositions[segment.start] - 1) : oldPositions[segment.start];
    const newStart = newCount === 0 ? Math.max(0, newPositions[segment.start] - 1) : newPositions[segment.start];
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let index = segment.start; index < segment.end; index += 1) {
      const operation = operations[index];
      const prefix = operation.kind === "addition" ? "+" : operation.kind === "deletion" ? "-" : " ";
      lines.push(`${prefix}${operation.line}`);
    }
  }
  return lines.join("\n");
}

function withinTurnDiffBudget(content: string) {
  return content.length <= MAX_TURN_DIFF_CHARS
    && content.split("\n").length <= MAX_TURN_DIFF_LINES;
}

function boundedCompactDiff(
  operations: LineDiffOperation[],
  before: string | null,
  after: string | null,
  path: string,
) {
  for (const contextLines of [1, 0]) {
    const content = renderDiffSegments(
      operations,
      diffSegments(operations, contextLines),
      before,
      after,
      path,
    );
    if (withinTurnDiffBudget(content)) {
      return { content, hasChange: operations.some((operation) => operation.kind !== "context") };
    }
  }

  const changedIndexes = operations
    .map((operation, index) => operation.kind === "context" ? -1 : index)
    .filter((index) => index >= 0);
  let low = 0;
  let high = changedIndexes.length;
  let selectedContent = renderDiffSegments(operations, [], before, after, path);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const segments = segmentsForIndexes(balancedChangedIndexes(changedIndexes, middle));
    const content = renderDiffSegments(operations, segments, before, after, path);
    if (withinTurnDiffBudget(content)) {
      low = middle;
      selectedContent = content;
    } else {
      high = middle - 1;
    }
  }
  if (low > 0) {
    const segments = segmentsForIndexes(balancedChangedIndexes(changedIndexes, low));
    selectedContent = renderDiffSegments(operations, segments, before, after, path);
  }
  return { content: selectedContent, hasChange: low > 0 };
}

function buildTurnDiffVariants(before: string | null, after: string | null, path: string): TurnDiffVariants {
  const beforeLines = textLines(before);
  const afterLines = textLines(after);
  const operations: LineDiffOperation[] = [];
  appendLineDiff(beforeLines, 0, beforeLines.length, afterLines, 0, afterLines.length, operations);
  const additions = operations.filter((operation) => operation.kind === "addition").length;
  const deletions = operations.filter((operation) => operation.kind === "deletion").length;
  const fullCandidate = renderDiffSegments(
    operations,
    [{ start: 0, end: operations.length }],
    before,
    after,
    path,
  );
  const compact = boundedCompactDiff(operations, before, after, path);
  const fullFits = withinTurnDiffBudget(fullCandidate);
  return {
    additions,
    deletions,
    compactContent: compact.content,
    compactHasChange: compact.hasChange,
    compactTruncated: compact.content !== fullCandidate,
    fullContent: fullFits ? fullCandidate : compact.content,
    fullTruncated: !fullFits,
  };
}

/** Build a bounded, full-file unified-style diff from two local file texts. */
export function buildTurnDiff(before: string | null, after: string | null, path: string) {
  const diff = buildTurnDiffVariants(before, after, path);
  return {
    content: diff.fullContent,
    additions: diff.additions,
    deletions: diff.deletions,
    truncated: diff.fullTruncated,
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
  const diffVariants = new Map<string, TurnDiffVariants>();
  for (const path of paths) {
    const previous = beforeFiles.get(path);
    const current = afterFiles.get(path);
    if (previous?.fingerprint === current?.fingerprint) continue;
    if (!current) {
      const turnDiff = previous?.content != null
        ? buildTurnDiffVariants(previous.content, null, path)
        : null;
      if (turnDiff) diffVariants.set(path, turnDiff);
      changes.push({
        path,
        kind: "deleted",
        indexStatus: " ",
        worktreeStatus: " ",
        additions: turnDiff?.additions,
        deletions: turnDiff?.deletions,
        diffAvailable: Boolean(turnDiff?.compactHasChange),
      });
      continue;
    }
    const kind = previous ? "modified" : "added";
    const turnDiff = previous?.content != null && current.content != null
      ? buildTurnDiffVariants(previous.content, current.content, path)
      : previous?.content != null
        ? buildTurnDiffVariants(previous.content, null, path)
        : !previous && current.content != null
          ? buildTurnDiffVariants(null, current.content, path)
          : null;
    if (turnDiff) diffVariants.set(path, turnDiff);
    changes.push({
      path,
      kind,
      indexStatus: " ",
      worktreeStatus: " ",
      additions: turnDiff?.additions,
      deletions: turnDiff?.deletions,
      diffAvailable: Boolean(turnDiff?.compactHasChange),
    });
  }
  const sorted = changes.sort((left, right) => left.path.localeCompare(right.path));
  let remainingDiffChars = MAX_CHANGE_SET_DIFF_CHARS;

  // Reserve a compact, structurally complete diff for every file before any
  // one file consumes the shared budget with its unchanged context.
  for (const change of sorted) {
    const candidate = diffVariants.get(change.path);
    if (!candidate?.compactHasChange || candidate.compactContent.length > remainingDiffChars) {
      change.turnDiffTruncated = true;
      change.diffAvailable = false;
      continue;
    }
    change.turnDiff = candidate.compactContent;
    change.turnDiffTruncated = candidate.compactTruncated || candidate.fullTruncated;
    remainingDiffChars -= change.turnDiff.length;
  }

  // Upgrade compact diffs to full-file context only after all files have a
  // useful change payload. Intrinsically oversized files remain compact.
  for (const change of sorted) {
    const candidate = diffVariants.get(change.path);
    if (!change.turnDiff || !candidate || candidate.fullTruncated) continue;
    const extraChars = candidate.fullContent.length - change.turnDiff.length;
    if (extraChars > remainingDiffChars) continue;
    change.turnDiff = candidate.fullContent;
    change.turnDiffTruncated = false;
    remainingDiffChars -= extraChars;
  }
  return sorted;
}
