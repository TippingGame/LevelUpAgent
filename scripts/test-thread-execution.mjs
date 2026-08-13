import assert from "node:assert/strict";
import test from "node:test";

import { providerThreadId, usesDurableHarness } from "../src/lib/threadExecution.ts";

test("temporary pet conversations bypass the durable Harness", () => {
  const thread = { id: "temporary-pet-chat", kind: "pet" };
  assert.equal(usesDurableHarness(thread, true), false);
  assert.equal(providerThreadId(thread), undefined);
});

test("desktop conversations use Harness while browser previews stay local", () => {
  assert.equal(usesDurableHarness({}, true), true);
  assert.equal(usesDurableHarness({ kind: "standard" }, true), true);
  assert.equal(usesDurableHarness({ kind: "standard" }, false), false);
  assert.equal(providerThreadId({ id: "saved-thread", kind: "standard" }), "saved-thread");
});
