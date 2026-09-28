import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { Channel, invoke } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { runHarnessStream } from "../src/lib/harnessStream.ts";
import { appendAssistantDelta, finalizeAssistantMessage } from "../src/lib/threadExecution.ts";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../src/lib/bridge.ts", import.meta.url), "utf8");
const appRun = appSource.slice(appSource.indexOf("  const runHarnessAgent = async ("), appSource.indexOf("  const pausePetHatchGoal = async"));
const bridgeRun = bridgeSource.slice(bridgeSource.indexOf("export async function harnessRun("), bridgeSource.indexOf("export async function createGoal("));

function compile(source, expression, globals) {
  const { outputText } = ts.transpileModule(source.replace(/^export /gm, "") + `\n${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return runInNewContext(outputText, globals);
}

const request = { operationId: "operation-1", threadId: "thread-1", messages: [] };
const outcome = { state: "completed" };
const success = { status: "ok", outcome };
const event = (kind, payload = {}, sequence = 0, operationId = request.operationId) => ({
  schemaVersion: 1, operationId, sequence, kind, payload,
});

function transport(result = success) {
  globalThis.window = { crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout };
  let args;
  let resolve;
  let reject;
  const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
  mockIPC((command, input) => {
    assert.equal(command, "harness_run");
    args = input;
    return pending;
  });
  return {
    resolve: () => resolve(result), reject,
    get args() { return args; },
    send(index, message) { window.__TAURI_INTERNALS__.runCallback(args.onEvent.id, { index, message }); },
    end(index) { window.__TAURI_INTERNALS__.runCallback(args.onEvent.id, { index, end: true }); },
  };
}

function appHarness() {
  let current;
  let nextId = 0;
  const finished = [];
  const harnessRun = compile(bridgeRun, "harnessRun", { Channel, invoke, runHarnessStream });
  const run = compile(appRun, "runHarnessAgent", {
    window, performance, setThreadRunning() {},
    runModesRef: { current: new Map() }, operationIdsRef: { current: new Map() },
    ensureWorkspaceRunBaseline: async () => {},
    appendAssistantDelta, finalizeAssistantMessage,
    message: (role, content, extra) => ({ id: `message-${++nextId}`, role, content,
      createdAt: nextId, toolCalls: [], attachments: [], ...extra }),
    assistantMessageIdentity: () => ({ modelName: "test-model", providerBrand: "openai" }),
    commitThread: (thread) => { current = thread; },
    STREAMING_COMMIT_CHAR_THRESHOLD: 1024, STREAMING_COMMIT_INTERVAL_MS: 0,
    harnessRun, armorMode: false, armorModeLevel: "standard", armorModeSkills: {},
    armorModeRunInstructions() {}, reasoningEffortForProfile: () => "auto", effectiveReasoningEffort: "auto",
    pendingApprovalsRef: { current: {} }, activePetIdRef: { current: null },
    finishThreadRun: (...args) => finished.push(args),
    tr: (_, en) => en, errorText: String, friendlyAgentError: String,
    finalizeConversationMessages: (messages) => messages,
  });
  const thread = { id: request.threadId, inputTokens: 10, outputTokens: 20 };
  const history = [{ id: "user-1", role: "user", content: "Tell a story", toolCalls: [], attachments: [] }];
  return {
    run: () => run(thread, history, "agent", "full", { id: "profile-1" }, [], request.operationId),
    get current() { return current; }, finished,
  };
}

test("large delayed completion reaches the real App projection before run cleanup", async () => {
  const ipc = transport();
  const app = appHarness();
  const running = app.run();
  await nextTurn();
  const content = "这是完整的故事。".repeat(254);
  const reasoning = [{ type: "reasoning", encrypted_content: "x".repeat(5300) }];
  const completed = event("assistant_completed", {
    content, requestId: "request-1", inputTokens: 7193, outputTokens: 1933,
    providerReasoningBlocks: reasoning, toolCalls: [],
  }, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(completed)) > 8192);
  ipc.send(0, event("assistant_delta", { delta: content }));
  // Small events and IPC result overtake the large fetched payload. Real Tauri
  // Channel must buffer indexes 2/3 until missing index 1 arrives.
  ipc.send(2, event("operation_completed", { round: 1 }, 6));
  ipc.send(3, event("run_finished"));
  ipc.end(4);
  ipc.resolve();
  await nextTurn();
  const finishedBeforeFinalEvent = app.finished.length;
  ipc.send(1, completed);
  await running;
  const assistants = app.current.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 1, "the stream and final payload must remain one message");
  assert.equal(finishedBeforeFinalEvent, 0, "cleanup must wait for the delayed channel payload");
  assert.equal(assistants[0].id, "message-1");
  assert.equal(assistants[0].createdAt, 1);
  assert.equal(assistants[0].content, content);
  assert.equal(assistants[0].requestId, "request-1");
  assert.deepEqual(assistants[0].providerReasoningBlocks, reasoning);
  assert.equal(app.current.inputTokens, 7203);
  assert.equal(app.current.outputTokens, 1953);
  assert.equal(app.finished.length, 1);
});

test("the channel can drain before the command response, without resolving early", async () => {
  const ipc = transport();
  const seen = [];
  let settled = false;
  const run = runHarnessStream(request, (e) => seen.push(e.kind)).then((value) => { settled = true; return value; });
  ipc.send(0, event("assistant_completed"));
  ipc.send(1, event("run_finished"));
  ipc.end(2);
  await nextTurn();
  assert.equal(settled, false);
  ipc.resolve();
  assert.deepEqual(await run, outcome);
  assert.deepEqual(seen, ["assistant_completed"]);
});

for (const error of ["REQUEST_CANCELLED", "Provider failed after partial output"]) {
  test(`runtime failure drains partial output before rejecting: ${error}`, async () => {
    const ipc = transport({ status: "error", error });
    const seen = [];
    let rejected = false;
    const run = runHarnessStream(request, (e) => seen.push(e));
    const rejection = assert.rejects(run, (reason) => { rejected = true; return reason.message === error; });
    ipc.send(1, event("run_finished"));
    ipc.resolve();
    await nextTurn();
    assert.equal(rejected, false);
    ipc.send(0, event("assistant_delta", { delta: "partial output" }));
    ipc.end(2);
    await rejection;
    assert.equal(seen[0].payload.delta, "partial output");
  });
}

test("approval outcomes wait for delayed approval events", async () => {
  const ipc = transport({ status: "ok", outcome: { state: "awaiting_approval" } });
  const seen = [];
  const run = runHarnessStream(request, (e) => seen.push(e.kind));
  ipc.resolve();
  await nextTurn();
  ipc.send(1, event("run_finished"));
  ipc.send(0, event("approval_required", { token: "approval-1" }));
  ipc.end(2);
  assert.equal((await run).state, "awaiting_approval");
  assert.deepEqual(seen, ["approval_required"]);
});

test("separate rounds may intentionally return identical content", async () => {
  const ipc = transport();
  const app = appHarness();
  const running = app.run();
  await nextTurn();
  ipc.send(0, event("assistant_delta", { delta: "Same words" }));
  ipc.send(1, event("assistant_completed", { content: "Same words", requestId: "first", toolCalls: [{ id: "tool-1" }] }, 1));
  ipc.send(2, event("assistant_delta", { delta: "Same words" }));
  ipc.send(3, event("assistant_completed", { content: "Same words", requestId: "second" }, 2));
  ipc.send(4, event("run_finished"));
  ipc.end(5);
  ipc.resolve();
  await running;
  const assistants = app.current.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.notEqual(assistants[0].id, assistants[1].id);
  assert.deepEqual(assistants.map((message) => message.requestId), ["first", "second"]);
});

test("IPC rejection closes the consumer even if events arrive late", async () => {
  const ipc = transport();
  const seen = [];
  const run = runHarnessStream(request, (e) => seen.push(e));
  const rejection = assert.rejects(run, /command unavailable/);
  ipc.reject(new Error("command unavailable"));
  await rejection;
  ipc.send(0, event("assistant_completed"));
  ipc.end(1);
  assert.equal(seen.length, 0);
});

test("a callback exception is reported without blocking Channel's ordered drain", async () => {
  const ipc = transport();
  const failure = new Error("projection failed");
  const run = runHarnessStream(request, () => { throw failure; });
  const rejection = assert.rejects(run, (error) => error === failure);
  ipc.send(0, event("assistant_completed"));
  ipc.send(1, event("run_finished"));
  ipc.end(2);
  ipc.resolve();
  await rejection;
});

test("missing drain marker fails explicitly and ignores late events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ipc = transport();
  const seen = [];
  const run = runHarnessStream(request, (e) => seen.push(e));
  const rejection = assert.rejects(run, /event delivery timed out/);
  ipc.resolve();
  await nextTurn();
  t.mock.timers.tick(10_000);
  await rejection;
  ipc.send(0, event("assistant_completed"));
  ipc.send(1, event("run_finished"));
  ipc.end(2);
  assert.equal(seen.length, 0);
});

test("events belonging to another operation cannot complete or mutate this run", async () => {
  const ipc = transport();
  const seen = [];
  let settled = false;
  const run = runHarnessStream(request, (e) => seen.push(e)).then((value) => { settled = true; return value; });
  ipc.send(0, event("assistant_completed", {}, 1, "other-operation"));
  ipc.send(1, event("run_finished", {}, 0, "other-operation"));
  ipc.resolve();
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(seen.length, 0);
  ipc.send(2, event("run_finished"));
  ipc.end(3);
  await run;
});
