import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeTaskCompletionNotices,
  normalizeTaskCompletionNotices,
  shouldMarkTaskCompletionUnread,
  upsertTaskCompletionNotice,
} from "../src/lib/taskCompletion.ts";

test("a visible active chat gets a transient completion instead of an unread badge", () => {
  assert.equal(shouldMarkTaskCompletionUnread({
    threadId: "thread-a",
    activeThreadId: "thread-a",
    workspaceView: "chat",
    documentFocused: true,
  }), false);
  assert.equal(shouldMarkTaskCompletionUnread({
    threadId: "thread-a",
    activeThreadId: "thread-a",
    workspaceView: "media",
    documentFocused: true,
  }), true);
  assert.equal(shouldMarkTaskCompletionUnread({
    threadId: "thread-a",
    activeThreadId: "thread-a",
    workspaceView: "chat",
    documentFocused: false,
  }), true);
  assert.equal(shouldMarkTaskCompletionUnread({
    threadId: "thread-a",
    activeThreadId: "thread-b",
    workspaceView: "chat",
    documentFocused: true,
  }), true);
});

test("completion notices count conversations once and retain the newest result", () => {
  const first = upsertTaskCompletionNotice([], {
    threadId: "thread-a",
    title: "First title",
    completedAt: 100,
    unread: true,
  });
  const second = upsertTaskCompletionNotice(first, {
    threadId: "thread-a",
    title: "Latest title",
    completedAt: 200,
    unread: true,
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].title, "Latest title");
  assert.equal(second[0].completedAt, 200);
});

test("storage restores unread completions only and viewing a thread acknowledges it", () => {
  const restored = normalizeTaskCompletionNotices([
    { threadId: "thread-a", title: "Unread", completedAt: 200, unread: true },
    { threadId: "thread-b", title: "Transient", completedAt: 300, unread: false },
    { threadId: "", title: "Invalid", completedAt: 400, unread: true },
  ]);
  assert.deepEqual(restored.map((notice) => notice.threadId), ["thread-a"]);
  assert.deepEqual(acknowledgeTaskCompletionNotices(restored, "thread-a"), []);
});
