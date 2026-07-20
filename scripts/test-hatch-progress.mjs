import assert from "node:assert/strict";
import test from "node:test";

import {
  HATCH_MAX_IDENTICAL_OBSERVATIONS,
  HATCH_MAX_OBSERVATIONS_WITHOUT_ACTION,
  advanceHatchObservationState,
  hatchObservationFingerprint,
  hatchObservationHistory,
} from "../src/lib/hatchProgress.ts";

const call = (id, name, args = {}) => ({ id, name, arguments: args });
const state = () => ({ count: 0, fingerprints: new Map() });
const assistant = (toolCalls) => ({ role: "assistant", toolCalls });

test("hatch observation fingerprints ignore argument key order", () => {
  assert.equal(
    hatchObservationFingerprint(call("a", "search_files", { query: " pet ", glob: "*.md" })),
    hatchObservationFingerprint(call("b", "search_files", { glob: "*.md", query: "pet" })),
  );
});

test("hatch guard stops the fourth identical observation without an action", () => {
  const current = state();
  for (let index = 0; index < HATCH_MAX_IDENTICAL_OBSERVATIONS; index += 1) {
    assert.equal(advanceHatchObservationState(current, call(String(index), "get_goal")), null);
  }
  assert.deepEqual(
    advanceHatchObservationState(current, call("blocked", "get_goal")),
    { kind: "duplicate", toolName: "get_goal" },
  );
});

test("hatch guard bounds unique observations without a concrete action", () => {
  const current = state();
  for (let index = 0; index < HATCH_MAX_OBSERVATIONS_WITHOUT_ACTION; index += 1) {
    assert.equal(
      advanceHatchObservationState(current, call(String(index), "read_file", { path: `reference-${index}.md` })),
      null,
    );
  }
  assert.deepEqual(
    advanceHatchObservationState(current, call("blocked", "list_files", { path: "." })),
    { kind: "stagnant", toolName: "list_files" },
  );
});

test("a command or generation resets the hatch observation window", () => {
  const history = [
    assistant([
      call("goal", "get_goal"),
      call("config", "read_file", { path: "levelup-pet-hatch.json" }),
      call("prepare", "run_command", { command: "python prepare_pet_run.py" }),
      call("status", "read_file", { path: "run/imagegen-jobs.json" }),
    ]),
  ];
  const current = hatchObservationHistory(history);
  assert.equal(current.count, 1);
  assert.equal(current.fingerprints.size, 1);
  assert.equal(advanceHatchObservationState(current, call("image", "generate_images")), null);
  assert.equal(current.count, 0);
  assert.equal(current.fingerprints.size, 0);
});

test("a user resume instruction resets an old stalled observation window", () => {
  const history = [
    assistant([
      call("one", "get_goal"),
      call("two", "list_files", { path: "." }),
      call("three", "read_file", { path: "levelup-pet-hatch.json" }),
    ]),
    { role: "user", toolCalls: [] },
  ];
  const current = hatchObservationHistory(history);
  assert.equal(current.count, 0);
  assert.equal(current.fingerprints.size, 0);
});
