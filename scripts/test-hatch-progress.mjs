import assert from "node:assert/strict";
import test from "node:test";

import {
  HATCH_MAX_IDENTICAL_OBSERVATIONS,
  HATCH_MAX_OBSERVATIONS_WITHOUT_ACTION,
  advanceHatchObservationState,
  hatchObservationFingerprint,
  hatchObservationHistory,
  hatchSkillManifestWasRead,
  hatchPrepareCommandFromHistory,
  hatchRunDirectoryFromHistory,
  normalizeHatchPrepareCall,
  hatchCommandIsObservation,
  hatchRepeatedCommandCount,
  HATCH_MAX_IDENTICAL_COMMANDS,
  normalizeHatchCommandCall,
  hatchToolPolicyViolation,
  createHatchExecutionState,
  gateHatchToolCall,
  sanitizeHatchHistory,
  hatchSourcePathsFromHistory,
  normalizeHatchRecordCall,
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

test("internal continuation prompts do not reset the observation circuit breaker", () => {
  const history = [];
  for (let index = 0; index < HATCH_MAX_IDENTICAL_OBSERVATIONS; index += 1) {
    history.push(
      assistant([call(`goal-${index}`, "get_goal")]),
      { role: "tool", toolCallId: `goal-${index}`, content: "{}", toolCalls: [] },
      { role: "user", internal: true, content: "Continue the active hatch Goal.", toolCalls: [] },
    );
  }
  const current = hatchObservationHistory(history);
  assert.deepEqual(
    advanceHatchObservationState(current, call("blocked", "get_goal")),
    { kind: "duplicate", toolName: "get_goal" },
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

test("hatch skill bootstrap recognizes only a successful hatch-pet manifest result", () => {
  const history = [
    assistant([call("imagegen", "read_skill", { skillId: "imagegen" })]),
    { role: "tool", toolCallId: "imagegen", content: "Skill: imagegen\nFile: SKILL.md", toolCalls: [] },
    assistant([call("hatch", "read_skill", { skillId: "hatch-pet" })]),
    { role: "tool", toolCallId: "hatch", content: "Skill: hatch-pet\nFile: SKILL.md", toolCalls: [] },
  ];
  assert.equal(hatchSkillManifestWasRead(history), true);
  assert.equal(hatchSkillManifestWasRead(history.slice(0, 2)), false);
});

test("failed or reference-only reads do not complete hatch bootstrap", () => {
  const history = [
    assistant([call("failed", "read_skill", { skillId: "hatch-pet" })]),
    { role: "tool", toolCallId: "failed", content: "Skill: hatch-pet\nFile: SKILL.md", isError: true, toolCalls: [] },
    assistant([call("reference", "read_skill", { skillId: "hatch-pet", path: "references/animation-rows.md" })]),
    { role: "tool", toolCallId: "reference", content: "Skill: hatch-pet\nFile: references/animation-rows.md", toolCalls: [] },
  ];
  assert.equal(hatchSkillManifestWasRead(history), false);
});

test("loaded hatch runs treat manifest rereads as terminal policy violations", () => {
  assert.equal(
    hatchToolPolicyViolation(call("manifest", "read_skill", { skillId: "hatch-pet" }), true),
    "manifest",
  );
  assert.equal(
    hatchToolPolicyViolation(call("reference", "read_skill", { skillId: "hatch-pet", path: "references/qa-rubric.md" }), true),
    "manifest",
  );
  assert.equal(
    hatchToolPolicyViolation(call("goal", "get_goal"), false),
    "observation",
  );
});

test("the hatch execution gate rejects provider-owned manifest reads", () => {
  const history = [{
    role: "user",
    internal: true,
    content: "Bundled Hatch Pet skill directory: C:/skill\nUse this unique hatch run directory: C:/run",
    toolCalls: [],
  }];
  const gate = createHatchExecutionState(history, false);
  const first = gateHatchToolCall(gate, call("first", "read_skill", { skillId: "hatch-pet" }), history);
  assert.equal(first.violation, "manifest");
  assert.equal(first.skillLoadedForCall, false);
  assert.equal(gate.skillLoaded, false);
  const second = gateHatchToolCall(gate, call("second", "read_skill", { skillId: "hatch-pet" }), history);
  assert.equal(second.violation, "manifest");
  const goal = gateHatchToolCall(gate, call("goal", "get_goal"), history);
  assert.equal(goal.violation, "observation");
});

test("the application bootstrap marker survives without a tool exchange", () => {
  const history = [{
    role: "user",
    internal: true,
    content: "[LEVELUP_HATCH_BOOTSTRAP_COMPLETE]\nready_jobs: [base]",
    toolCalls: [],
  }];
  assert.equal(hatchSkillManifestWasRead(history), true);
});

test("hatch execution restores the canonical prepare command after provider shortening", () => {
  const history = [{
    role: "user",
    internal: true,
    content: "Bundled Hatch Pet skill directory: C:/skill\nPython command: python\nUse this unique hatch run directory: C:/run\nImmediately after that one successful Skill read, call run_command with this exact PowerShell command:\npython 'C:/skill/scripts/prepare_pet_run.py' --pet-name 'Noct' --output-dir 'C:/run' --force\nDo not use Get-ChildItem.",
    toolCalls: [],
  }];
  const prepareCall = call("prepare", "run_command", { command: "python prepare_pet_run.py" });
  assert.equal(hatchPrepareCommandFromHistory(history), "python 'C:/skill/scripts/prepare_pet_run.py' --pet-name 'Noct' --output-dir 'C:/run' --force");
  assert.equal(hatchRunDirectoryFromHistory(history), "C:/run");
  assert.equal(normalizeHatchPrepareCall(prepareCall, history).arguments.command, "python 'C:/skill/scripts/prepare_pet_run.py' --pet-name 'Noct' --output-dir 'C:/run' --force");
  assert.equal(normalizeHatchCommandCall(call("browse", "run_command", { command: "Get-ChildItem -Force" }), history).arguments.command, "python 'C:/skill/scripts/prepare_pet_run.py' --pet-name 'Noct' --output-dir 'C:/run' --force");
  assert.match(normalizeHatchCommandCall(call("status", "run_command", { command: "python \"$env:APPDATA\\skills\\pet_job_status.py\"" }), history).arguments.command, /prepare_pet_run\.py/);
  const preparedHistory = [
    ...history,
    assistant([call("prepared", "run_command", { command: "python prepare_pet_run.py" })]),
    { role: "tool", toolCallId: "prepared", content: '"ok": true,\n"run_dir": "C:\\\\run"', toolCalls: [] },
  ];
  assert.match(normalizeHatchCommandCall(call("status-ready", "run_command", { command: "python pet_job_status.py" }), preparedHistory).arguments.command, /pet_job_status\.py/);
  assert.equal(hatchCommandIsObservation("Get-ChildItem -Force"), true);
  assert.equal(hatchCommandIsObservation("Get-Content .\\levelup-pet-hatch.json"), true);
  assert.equal(hatchCommandIsObservation("cat levelup-pet-hatch.json"), true);
  assert.equal(hatchCommandIsObservation("python prepare_pet_run.py --output-dir C:/run"), false);
});

test("generated fallback prepare commands pin the shared green chroma key", () => {
  const history = [{
    role: "user",
    internal: true,
    content: "Bundled Hatch Pet skill directory: C:/skill\nPython command: python\nUse this unique hatch run directory: C:/run\nPet name: Noct\nPet concept: a compact digital pet",
    toolCalls: [],
  }];
  const command = hatchPrepareCommandFromHistory(history);
  assert.match(command, /--chroma-key '#00FF00'/);
});

test("record commands use the adapter provenance path instead of a retyped thread path", () => {
  const source = "C:/Users/test/.codex/generated_images/levelup-agent/thread-real/ig_abc123.png";
  const history = [
    { role: "tool", content: JSON.stringify({ hatchSourcePaths: [source] }), toolCalls: [] },
  ];
  const recordCall = call("record", "run_command", {
    command: "python record_imagegen_result.py --run-dir 'C:/run' --job-id 'idle' --source 'C:/wrong/thread/ig_abc123.png'",
  });
  assert.deepEqual(hatchSourcePathsFromHistory(history), [source]);
  const normalized = normalizeHatchRecordCall(recordCall, history);
  assert.match(normalized.arguments.command, /--source 'C:\/Users\/test\/\.codex\/generated_images\/levelup-agent\/thread-real\/ig_abc123\.png'/);
  assert.doesNotMatch(normalized.arguments.command, /C:\/wrong\/thread/);
});

test("hatch execution recognizes wrapped prepare JSON before switching to status", () => {
  const history = [{
    role: "user",
    internal: true,
    content: "Bundled Hatch Pet skill directory: C:/skill\nPython command: python\nUse this unique hatch run directory: C:/run\nImmediately after that one successful Skill read, call run_command with this exact PowerShell command:\npython 'C:/skill/scripts/prepare_pet_run.py' --output-dir 'C:/run'\nDo not use Get-ChildItem.",
    toolCalls: [],
  },
  assistant([call("prepare", "run_command", { command: "python prepare_pet_run.py" })]),
  { role: "tool", toolCallId: "prepare", content: "exit code: 0\nstdout:\n{\n  \"ok\": true,\n  \"run_dir\": \"C:\\\\run\"\n}", toolCalls: [] }];
  const normalized = normalizeHatchCommandCall(
    call("status", "run_command", { command: "python pet_job_status.py" }),
    history,
  );
  assert.match(normalized.arguments.command, /pet_job_status\.py/);
  assert.match(normalized.arguments.command, /C:[\\/]run/);
});

test("hatch execution recovers legacy paths from skill and prepare results", () => {
  const extendedSkillRoot = String.fromCharCode(92, 92, 63, 92);
  const history = [
    assistant([call("skill", "read_skill", { skillId: "hatch-pet" })]),
    {
      role: "tool",
      toolCallId: "skill",
      content: `Skill: hatch-pet\nSkill root: ${extendedSkillRoot}C:/skill\nFile: SKILL.md`,
      toolCalls: [],
    },
    assistant([call("prepare", "run_command", { command: "python prepare_pet_run.py" })]),
    {
      role: "tool",
      toolCallId: "prepare",
      content: 'exit code: 0\nstdout:\n{\n  "ok": true,\n  "run_dir": "C:\\\\run-1"\n}',
      toolCalls: [],
    },
  ];
  const status = normalizeHatchCommandCall(
    call("status", "run_command", { command: "python pet_job_status.py" }),
    history,
  );
  assert.match(status.arguments.command, /run-1/);
  assert.match(status.arguments.command, /C:\/skill.*pet_job_status\.py/);
  assert.equal(status.arguments.command.includes("?"), false);
  const browse = normalizeHatchCommandCall(
    call("browse", "run_command", { command: "Get-ChildItem -Force" }),
    history,
  );
  assert.equal(browse.arguments.command, status.arguments.command);
  const repeatPrepare = normalizeHatchCommandCall(
    call("prepare-again", "run_command", { command: "python prepare_pet_run.py --force" }),
    history,
  );
  assert.equal(repeatPrepare.arguments.command, status.arguments.command);
});

test("hatch command repetition has a narrow circuit breaker", () => {
  const history = [];
  for (let index = 0; index < HATCH_MAX_IDENTICAL_COMMANDS; index += 1) {
    history.push(
      assistant([call(`status-${index}`, "run_command", { command: "python pet_job_status.py" })]),
      { role: "tool", toolCallId: `status-${index}`, content: "status", toolCalls: [] },
    );
  }
  assert.equal(
    hatchRepeatedCommandCount(history, call("next", "run_command", { command: "python pet_job_status.py" })),
    HATCH_MAX_IDENTICAL_COMMANDS,
  );
});

test("hatch command repetition uses normalized commands, not provider spellings", () => {
  const history = [
    {
      role: "user",
      internal: true,
      content: "Bundled Hatch Pet skill directory: C:/skill\nUse this unique hatch run directory: C:/run",
      toolCalls: [],
    },
    assistant([call("prepare", "run_command", { command: "python prepare_pet_run.py" })]),
    { role: "tool", toolCallId: "prepare", content: '"ok": true,\n"run_dir": "C:\\\\run"', toolCalls: [] },
    { role: "user", internal: true, content: "Continue.", toolCalls: [] },
    assistant([call("status", "run_command", { command: "python pet_job_status.py" })]),
    { role: "tool", toolCallId: "status", content: "ready_jobs", toolCalls: [] },
    { role: "user", internal: true, content: "Continue.", toolCalls: [] },
    assistant([call("browse", "run_command", { command: "Get-ChildItem -Force" })]),
    { role: "tool", toolCallId: "browse", content: "ready_jobs", toolCalls: [] },
    { role: "user", internal: true, content: "Continue.", toolCalls: [] },
  ];
  const next = call("next", "run_command", { command: "python pet_job_status.py" });
  assert.equal(hatchRepeatedCommandCount(history, next), 3);
});

test("legacy hatch observation exchanges are removed before provider resume", () => {
  const history = [
    { role: "user", content: "start hatch", toolCalls: [] },
    assistant([call("skill-1", "read_skill", { skillId: "hatch-pet" })]),
    { role: "tool", toolCallId: "skill-1", content: "Skill: hatch-pet", toolCalls: [] },
    assistant([call("goal-1", "get_goal")]),
    { role: "tool", toolCallId: "goal-1", content: "{}", toolCalls: [] },
    assistant([call("prepare-1", "run_command", { command: "python prepare_pet_run.py --force" })]),
    { role: "tool", toolCallId: "prepare-1", content: "ok", toolCalls: [] },
    assistant([
      call("browse-1", "run_command", { command: "Get-Content levelup-pet-hatch.json" }),
      call("image-1", "generate_images", { prompt: "next" }),
    ]),
    { role: "tool", toolCallId: "browse-1", content: "metadata", toolCalls: [] },
    { role: "tool", toolCallId: "image-1", content: "asset", toolCalls: [] },
  ];
  const sanitized = sanitizeHatchHistory(history);
  assert.deepEqual(
    sanitized.flatMap((item) => item.toolCalls.map((item) => item.name)),
    ["run_command", "generate_images"],
  );
  assert.equal(sanitized.some((item) => item.toolCallId === "skill-1"), false);
  assert.equal(sanitized.some((item) => item.toolCallId === "goal-1"), false);
  assert.equal(sanitized.some((item) => item.toolCallId === "browse-1"), false);
  assert.equal(sanitized.some((item) => item.toolCallId === "image-1"), true);
});
