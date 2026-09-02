import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  appendAssistantDelta,
  finalizeAssistantMessage,
  providerRetryProgressLabel,
  providerThreadId,
  queueStateWithItem,
  queueStateWithoutItem,
  settleProviderReconnect,
  usesDurableHarness,
} from "../src/lib/threadExecution.ts";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const harnessSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

function assistant(id, content, createdAt = 100) {
  return {
    id,
    role: "assistant",
    content,
    toolCalls: [],
    createdAt,
    attachments: [],
  };
}

test("temporary pet conversations use a durable desktop Harness operation", () => {
  const thread = { id: "temporary-pet-chat", kind: "pet" };
  assert.equal(usesDurableHarness(thread, true), true);
  assert.equal(providerThreadId(thread), "temporary-pet-chat");
});

test("desktop conversations use Harness while browser previews stay local", () => {
  assert.equal(usesDurableHarness({}, true), true);
  assert.equal(usesDurableHarness({ kind: "standard" }, true), true);
  assert.equal(usesDurableHarness({ kind: "standard" }, false), false);
  assert.equal(providerThreadId({ id: "saved-thread", kind: "standard" }), "saved-thread");
});

test("all desktop conversations, including hatch and pet chats, use Harness", () => {
  assert.equal(usesDurableHarness({ kind: "standard" }, true), true);
  assert.equal(usesDurableHarness({}, true), true);
  assert.equal(usesDurableHarness({ kind: "pet" }, true), true);
  assert.equal(usesDurableHarness({ kind: "standard" }, false), false);
});

test("active-run queue remains visible until the runtime injects each item", () => {
  assert.match(appSource, /event\.kind === "queue_injected"/);
  assert.match(appSource, /const removeHarnessQueueItem =/);
  assert.doesNotMatch(appSource, /const setThreadQueue =/);
  assert.match(appSource, /injectedQueueIdsRef/);
  assert.match(appSource, /const recordHarnessQueueItem =/);
  assert.match(appSource, /const enqueueCurrentRunMessage[\s\S]*?recordHarnessQueueItem\(threadId, queued\)/);
  assert.match(appSource, /submission\.disposition === "queued"[\s\S]*?recordHarnessQueueItem\(thread\.id, queued\)/);
  assert.match(appSource, /replacementOperationId !== queueOperationId[\s\S]*?continue;/);
});

test("queue state reconciles either queue injection event order without reviving items", () => {
  const threadId = "thread-1";
  const first = { id: "queue-1", operationId: "operation-1", kind: "follow_up", body: "first", status: "pending" };
  const second = { id: "queue-2", operationId: "operation-1", kind: "follow_up", body: "second", status: "pending" };
  const empty = {};

  const eventFirst = queueStateWithItem(empty, threadId, first, new Set([first.id]));
  assert.strictEqual(eventFirst, empty);

  const ipcFirst = queueStateWithItem(empty, threadId, first, new Set());
  assert.deepEqual(ipcFirst[threadId], [first]);
  assert.deepEqual(queueStateWithoutItem(ipcFirst, threadId, first.id)[threadId], []);

  const withSecond = queueStateWithItem(ipcFirst, threadId, second, new Set());
  assert.deepEqual(queueStateWithoutItem(withSecond, threadId, first.id)[threadId], [second]);
});

test("Harness completion defers to pending queue messages", () => {
  assert.match(harnessSource, /complete_harness_operation_if_queue_empty/);
  assert.match(harnessSource, /outcome": "queued_follow_up"/);
});

test("provider retry progress identifies the active request and keeps ticking", () => {
  assert.equal(
    providerRetryProgressLabel(1, 5, 0, "zh-CN"),
    "第 2/6 次请求进行中 · 已等待 0 秒（上一请求失败）",
  );
  assert.equal(
    providerRetryProgressLabel(1, 5, 73_900, "en-US"),
    "Request 2/6 in progress · waiting 73s (previous request failed)",
  );
});

test("a successful provider reconnect clears the active retry marker", () => {
  assert.deepEqual(settleProviderReconnect(1), {
    completedAttempt: 1,
    lastReconnectAttempt: 0,
  });
  assert.deepEqual(settleProviderReconnect(1, 2), {
    completedAttempt: 2,
    lastReconnectAttempt: 0,
  });
});

test("assistant deltas append to one placeholder and add it for a later round", () => {
  const placeholder = assistant("assistant-1", "");
  const first = appendAssistantDelta([], placeholder, "Hello");
  const second = appendAssistantDelta(first, placeholder, " world");

  assert.deepEqual(second, [{ ...placeholder, content: "Hello world" }]);
  assert.equal(second[0].id, "assistant-1");
});

test("stream updates preserve the non-streaming message references", () => {
  const previous = assistant("previous", "old");
  const placeholder = assistant("assistant-1", "Hello");
  const next = appendAssistantDelta([previous, placeholder], placeholder, " world");

  assert.equal(next[0], previous);
  assert.notEqual(next[1], placeholder);
  assert.equal(next[1].content, "Hello world");
  assert.equal(appendAssistantDelta(next, placeholder, ""), next);
});

test("finalizing a streamed assistant preserves placeholder identity", () => {
  const placeholder = assistant("assistant-1", "partial", 321);
  const completed = assistant("provider-id", "complete", 999);
  completed.requestId = "request-1";
  completed.providerReasoningBlocks = [{ type: "thinking", signature: "sig-1" }];
  const finalized = finalizeAssistantMessage(
    [{ ...placeholder }],
    placeholder,
    completed,
  );

  assert.equal(finalized[0].id, "assistant-1");
  assert.equal(finalized[0].createdAt, 321);
  assert.equal(finalized[0].content, "complete");
  assert.equal(finalized[0].requestId, "request-1");
  assert.deepEqual(finalized[0].providerReasoningBlocks, completed.providerReasoningBlocks);
});
