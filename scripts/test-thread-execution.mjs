import assert from "node:assert/strict";
import test from "node:test";

import {
  appendAssistantDelta,
  finalizeAssistantMessage,
  providerRetryProgressLabel,
  providerThreadId,
  usesDurableHarness,
} from "../src/lib/threadExecution.ts";

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

test("assistant deltas append to one placeholder and add it for a later round", () => {
  const placeholder = assistant("assistant-1", "");
  const first = appendAssistantDelta([], placeholder, "Hello");
  const second = appendAssistantDelta(first, placeholder, " world");

  assert.deepEqual(second, [{ ...placeholder, content: "Hello world" }]);
  assert.equal(second[0].id, "assistant-1");
});

test("finalizing a streamed assistant preserves placeholder identity", () => {
  const placeholder = assistant("assistant-1", "partial", 321);
  const completed = assistant("provider-id", "complete", 999);
  completed.requestId = "request-1";
  const finalized = finalizeAssistantMessage(
    [{ ...placeholder }],
    placeholder,
    completed,
  );

  assert.equal(finalized[0].id, "assistant-1");
  assert.equal(finalized[0].createdAt, 321);
  assert.equal(finalized[0].content, "complete");
  assert.equal(finalized[0].requestId, "request-1");
});
