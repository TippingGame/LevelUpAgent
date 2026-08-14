import assert from "node:assert/strict";
import test from "node:test";

import { providerThreadId, usesDurableHarness } from "../src/lib/threadExecution.ts";

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
