import type { AgentMessage, ToolCall } from "./types";

// These limits apply only to a hatch run that is repeatedly observing state
// without taking a concrete action. They are not a general tool-call limit.
export const HATCH_MAX_IDENTICAL_OBSERVATIONS = 3;
export const HATCH_MAX_OBSERVATIONS_WITHOUT_ACTION = 16;
export const HATCH_MAX_IDENTICAL_COMMANDS = 3;
export const HATCH_DEFAULT_CHROMA_KEY = "#00FF00";

// The application owns the hatch bootstrap. Persisting a small internal
// marker in the conversation lets resumed/compacted runs retain that phase
// without asking the provider to infer it from an old tool exchange.
export const HATCH_BOOTSTRAP_MARKER = "[LEVELUP_HATCH_BOOTSTRAP_COMPLETE]";

const HATCH_OBSERVATION_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_files",
  "read_skill",
  "get_goal",
  "check_media_jobs",
]);

export type HatchToolPolicyViolation = "observation" | "manifest";

export interface HatchObservationState {
  count: number;
  fingerprints: Map<string, number>;
}

export interface HatchObservationGuard {
  kind: "duplicate" | "stagnant";
  toolName: string;
}

export type HatchGateViolation = "workspace" | "observation" | "manifest" | "command";

export interface HatchExecutionState {
  skillLoaded: boolean;
  observations: HatchObservationState;
  lastCommandKind: string | null;
  commandRepeatCount: number;
}

export interface HatchToolDecision {
  call: ToolCall;
  skillLoadedForCall: boolean;
  violation: HatchGateViolation | null;
  observationGuard?: HatchObservationGuard;
}

/**
 * Remove provider-owned observation exchanges from a legacy hatch history
 * before it is sent to the provider again. Older releases exposed read_skill,
 * get_goal, and workspace browsing during hatch runs; keeping those stale
 * tool-call groups in context can make an otherwise fixed model replay them
 * after resume. Only the offending calls and their paired results are
 * removed; generation, script, Goal-update, and user messages are retained.
 */
export function sanitizeHatchHistory(history: AgentMessage[]) {
  const removedCallIds = new Set<string>();
  const sanitized: AgentMessage[] = [];

  for (const item of history) {
    if (item.role === "assistant" && item.toolCalls.length > 0) {
      const allowedCalls = item.toolCalls.filter((call) => {
        const blocked = ["read_skill", "get_goal", "list_files", "read_file", "search_files"]
          .includes(call.name)
          || (call.name === "run_command" && hatchCommandIsObservation(call.arguments?.command));
        if (blocked && call.id) removedCallIds.add(call.id);
        return !blocked;
      });
      if (allowedCalls.length === 0 && (item.content ?? "").trim().length === 0) continue;
      sanitized.push({ ...item, toolCalls: allowedCalls });
      continue;
    }
    if (item.role === "tool" && item.toolCallId && removedCallIds.has(item.toolCallId)) continue;
    sanitized.push(item);
  }

  return sanitized;
}

function isManifestPath(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return true;
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase() === "skill.md";
}

export function isHatchSkillManifestRead(call: ToolCall) {
  return call.name === "read_skill" && isManifestPath(call.arguments?.path);
}

/**
 * Return the terminal policy violation for a hatch tool call, if any. Keeping
 * this decision pure makes the frontend executor and its regression tests use
 * the same rule: once the manifest is loaded, a provider cannot restart the
 * bootstrap phase by rereading it.
 */
export function hatchToolPolicyViolation(
  call: ToolCall,
  _skillLoaded: boolean,
): HatchToolPolicyViolation | null {
  if (["get_goal", "list_files", "read_file", "search_files"].includes(call.name)) {
    return "observation";
  }
  // `read_skill` is an application-owned bootstrap operation for hatch runs.
  // The provider must never be allowed to start that phase (or restart it)
  // itself; otherwise a model can emit a batch of identical reads before the
  // client-side circuit breaker gets a chance to stop the run.
  if (call.name === "read_skill") return "manifest";
  return null;
}

function hatchPromptValue(history: AgentMessage[], label: string) {
  for (const item of history) {
    if (item.role !== "user" || !item.internal) continue;
    const match = item.content.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function hatchToolOutputValue(history: AgentMessage[], key: string) {
  const pattern = new RegExp(`(?:["']${key}["']|\\b${key}\\b)\\s*[:=]\\s*(?:["']([^"']+)["']|([^\\r\\n,}]+))`, "i");
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role !== "tool") continue;
    const match = item.content.match(pattern);
    const value = (match?.[1] ?? match?.[2])?.trim();
    if (value) return value.replace(/\\\\/g, "\\");
  }
  return null;
}

function hatchToolOutputJson(content: string) {
  const start = content.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(content.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Return adapter-owned provenance paths from the most recent image result. */
export function hatchSourcePathsFromHistory(history: AgentMessage[]) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role !== "tool") continue;
    const payload = hatchToolOutputJson(item.content);
    const paths = payload?.hatchSourcePaths;
    if (Array.isArray(paths)) {
      const valid = paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0);
      if (valid.length > 0) return valid;
    }
  }
  return [];
}

function replaceHatchCommandArgument(command: string, flag: string, value: string) {
  const escaped = value.replace(/'/g, "''");
  const pattern = new RegExp(`(${flag}\\s+)(?:'[^']*'|\"[^\"]*\"|[^\\s]+)`, "i");
  if (pattern.test(command)) return command.replace(pattern, `$1'${escaped}'`);
  return `${command} ${flag} '${escaped}'`;
}

/**
 * Providers sometimes retype the generated_images path and alter a thread ID
 * or asset directory. The adapter result is authoritative, so repair only
 * the command arguments while preserving the provider's selected job.
 */
export function normalizeHatchRecordCall(call: ToolCall, history: AgentMessage[]) {
  if (call.name !== "run_command" || typeof call.arguments?.command !== "string") return call;
  const command = call.arguments.command;
  if (!/record_imagegen_result\.py/i.test(command)) return call;
  const paths = hatchSourcePathsFromHistory(history);
  if (paths.length === 0) return call;

  const selected = paths.find((path) => command.includes(path.split(/[\\/]/).pop() ?? ""))
    || (paths.length === 1 ? paths[0] : null);
  if (!selected) return call;

  let normalizedCommand = replaceHatchCommandArgument(command, "--source", selected);
  const runDirectory = hatchRunDirectoryFromHistory(history);
  if (runDirectory) normalizedCommand = replaceHatchCommandArgument(normalizedCommand, "--run-dir", runDirectory);
  return { ...call, arguments: { ...call.arguments, command: normalizedCommand } };
}

function hatchPowerShellPath(value: string) {
  let path = value.trim();
  // Windows may report bundled resources with the extended-length prefix
  // `\\?\`. Match its actual characters instead of relying on a fragile
  // backslash-heavy regular expression.
  if (path.length >= 4 && path[0] === "\\" && path[1] === "\\" && path[2] === "?" && path[3] === "\\") {
    path = path.slice(4);
  } else if (path.length >= 3 && path[0] === "\\" && path[1] === "?" && path[2] === "\\") {
    // Tool output may already have JSON-unescaped the first backslash.
    path = path.slice(3);
  }
  return path.replace(/'/g, "''");
}

function powershellLiteral(value: string) {
  return `'${hatchPowerShellPath(value)}'`;
}

function hatchSkillDirectoryFromHistory(history: AgentMessage[]) {
  return hatchToolOutputValue(history, "Skill root")
    || hatchPromptValue(history, "Bundled Hatch Pet skill directory");
}

/** Recover the exact prepare command embedded in a generated hatch request. */
export function hatchPrepareCommandFromHistory(history: AgentMessage[]) {
  for (const item of history) {
    if (item.role !== "user" || !item.internal) continue;
    const match = item.content.match(
      /exact PowerShell command[^\r\n]*:\r?\n([^\r\n]+)\r?\nDo not use/i,
    );
    if (match?.[1]?.trim()) return match[1].trim();
  }
  const skillDirectory = hatchSkillDirectoryFromHistory(history);
  const runDirectory = hatchRunDirectoryFromHistory(history);
  if (!skillDirectory || !runDirectory) return null;
  const python = hatchPromptValue(history, "Python command") || "python";
  const name = hatchPromptValue(history, "Pet name") || "Starlight Echo";
  const description = hatchPromptValue(history, "Pet concept") || "a compact digital pet";
  const pythonInvocation = /^[A-Za-z0-9_.-]+$/.test(python)
    ? python
    : `& ${powershellLiteral(python)}`;
  return [
    pythonInvocation,
    powershellLiteral(`${skillDirectory}\\scripts\\prepare_pet_run.py`),
    "--pet-name", powershellLiteral(name),
    "--description", powershellLiteral(description),
    "--output-dir", powershellLiteral(runDirectory),
    "--pet-notes", powershellLiteral(description),
    "--style-notes", powershellLiteral("Bundled Codex digital-pet style: compact pixel-art-adjacent chibi sprite, thick dark outline, flat cel shading, clean chroma-key background, no text or detached effects."),
    "--chroma-key", powershellLiteral(HATCH_DEFAULT_CHROMA_KEY),
    "--force",
  ].join(" ");
}

/** Recover the app-owned run directory from the generated hatch request. */
export function hatchRunDirectoryFromHistory(history: AgentMessage[]) {
  return hatchToolOutputValue(history, "run_dir")
    || hatchPromptValue(history, "Use this unique hatch run directory");
}

function hatchPrepareSucceeded(history: AgentMessage[]) {
  return history.some((item) => {
    if (item.role !== "tool" || item.isError) return false;
    // prepare_pet_run.py normally wraps its JSON in command stdout. Accept
    // both that shape and the compact provider-rendered form; requiring both
    // fields prevents an unrelated status message from switching to status.
    const hasSuccess = /["']?ok["']?\s*:\s*true\b/i.test(item.content);
    const hasRunDirectory = /["']?run_dir["']?\s*:/i.test(item.content);
    return hasSuccess && hasRunDirectory;
  });
}

function hatchCommandKind(command: unknown) {
  if (typeof command !== "string") return null;
  if (/pet_job_status\.py/i.test(command)) return "status";
  if (/prepare_pet_run\.py/i.test(command)) return "prepare";
  if (hatchCommandIsObservation(command)) return "observation";
  return null;
}

/** Count immediately preceding same-kind hatch shell calls. */
export function hatchRepeatedCommandCount(history: AgentMessage[], call: ToolCall) {
  if (call.name !== "run_command") return 0;
  const kind = hatchCommandKind(call.arguments?.command);
  if (!kind) return 0;
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role === "user" && !item.internal) break;
    if (item.role !== "assistant") continue;
    const previous = item.toolCalls[item.toolCalls.length - 1];
    if (!previous || previous.name !== "run_command") break;
    const normalizedPrevious = normalizeHatchCommandCall(previous, history);
    if (hatchCommandKind(normalizedPrevious.arguments?.command) !== kind) break;
    count += 1;
  }
  return count;
}

export function createHatchExecutionState(
  history: AgentMessage[],
  skillLoaded = hatchSkillManifestWasRead(history),
): HatchExecutionState {
  return {
    skillLoaded,
    observations: hatchObservationHistory(history),
    lastCommandKind: null,
    commandRepeatCount: 0,
  };
}

/**
 * Apply every client-side hatch rule in one place before a tool is executed.
 * The returned skillLoadedForCall is deliberately the pre-call value, so the
 * first manifest read is allowed while a second one is rejected.
 */
export function gateHatchToolCall(
  state: HatchExecutionState,
  call: ToolCall,
  history: AgentMessage[],
): HatchToolDecision {
  const effectiveCall = normalizeHatchCommandCall(call, history);
  if (effectiveCall.name === "run_command" && hatchCommandIsObservation(effectiveCall.arguments?.command)) {
    return { call: effectiveCall, skillLoadedForCall: state.skillLoaded, violation: "workspace" };
  }

  const skillLoadedForCall = state.skillLoaded;
  const policyViolation = hatchToolPolicyViolation(effectiveCall, skillLoadedForCall);
  if (policyViolation) {
    return {
      call: effectiveCall,
      skillLoadedForCall,
      violation: policyViolation,
    };
  }

  if (isHatchSkillManifestRead(effectiveCall)) state.skillLoaded = true;

  const commandKind = effectiveCall.name === "run_command"
    ? hatchCommandKind(effectiveCall.arguments?.command)
    : null;
  if (commandKind) {
    const historyCount = hatchRepeatedCommandCount(history, effectiveCall);
    state.commandRepeatCount = state.lastCommandKind === commandKind
      ? Math.max(state.commandRepeatCount, historyCount) + 1
      : historyCount + 1;
    state.lastCommandKind = commandKind;
    if (state.commandRepeatCount > HATCH_MAX_IDENTICAL_COMMANDS) {
      return { call: effectiveCall, skillLoadedForCall, violation: "command" };
    }
  } else {
    state.lastCommandKind = null;
    state.commandRepeatCount = 0;
  }

  const observationGuard = advanceHatchObservationState(state.observations, effectiveCall);
  if (observationGuard) {
    return {
      call: effectiveCall,
      skillLoadedForCall,
      violation: "observation",
      observationGuard,
    };
  }
  return { call: effectiveCall, skillLoadedForCall, violation: null };
}

export function hatchStatusCommand(history: AgentMessage[]) {
  const skillDirectory = hatchSkillDirectoryFromHistory(history);
  const runDirectory = hatchRunDirectoryFromHistory(history);
  if (!skillDirectory || !runDirectory) return null;
  const python = hatchPromptValue(history, "Python command") || "python";
  const pythonInvocation = /^[A-Za-z0-9_.-]+$/.test(python)
    ? python
    : `& ${powershellLiteral(python)}`;
  return `${pythonInvocation} ${powershellLiteral(`${skillDirectory}\\scripts\\pet_job_status.py`)} --run-dir ${powershellLiteral(runDirectory)}`;
}

/** Replace a provider's shortened prepare call with the app-authored command. */
export function normalizeHatchPrepareCall(call: ToolCall, history: AgentMessage[]) {
  if (call.name !== "run_command" || typeof call.arguments?.command !== "string") return call;
  const command = call.arguments.command.trim();
  if (!/prepare_pet_run\.py/i.test(command)) {
    return call;
  }
  if (hatchPrepareSucceeded(history)) {
    const status = hatchStatusCommand(history);
    if (status) return { ...call, arguments: { ...call.arguments, command: status } };
  }
  if (/--(?:output-dir|pet-name|description)\b/i.test(command)) return call;
  const canonical = hatchPrepareCommandFromHistory(history);
  return canonical
    ? { ...call, arguments: { ...call.arguments, command: canonical } }
    : call;
}

/** Identify shell commands that only browse workspace state during hatching. */
export function hatchCommandIsObservation(command: unknown) {
  if (typeof command !== "string") return false;
  return command
    .split(/[;&|\r\n]+/)
    .map((part) => part.trim())
    .some((part) => /^(?:Get-ChildItem|gci|dir|ls|pwd|Get-Location|Get-Content|gc|type|cat|more|Select-String|findstr|rg|grep)\b/i.test(part)
      || /levelup-pet-hatch\.json\b/i.test(part));
}

/** Turn a provider's initial workspace browse into the prepared hatch action. */
export function normalizeHatchCommandCall(call: ToolCall, history: AgentMessage[]) {
  const normalized = normalizeHatchPrepareCall(normalizeHatchRecordCall(call, history), history);
  if (normalized.name !== "run_command") return normalized;
  const command = typeof normalized.arguments?.command === "string" ? normalized.arguments.command : "";
  if (/prepare_pet_run\.py/i.test(command) && hatchPrepareSucceeded(history)) {
    const canonicalStatus = hatchStatusCommand(history);
    if (canonicalStatus) {
      return { ...normalized, arguments: { ...normalized.arguments, command: canonicalStatus } };
    }
  }
  if (/pet_job_status\.py/i.test(command)) {
    const canonical = hatchPrepareSucceeded(history)
      ? hatchStatusCommand(history)
      : hatchPrepareCommandFromHistory(history);
    if (canonical) {
      return {
        ...normalized,
        arguments: { ...normalized.arguments, command: canonical },
      };
    }
  }
  if (!hatchCommandIsObservation(command)) {
    return normalized;
  }
  const canonical = hatchPrepareSucceeded(history)
    ? hatchStatusCommand(history)
    : hatchPrepareCommandFromHistory(history);
  return canonical
    ? { ...normalized, arguments: { ...normalized.arguments, command: canonical } }
    : normalized;
}

export function hatchSkillManifestWasRead(history: AgentMessage[]) {
  if (history.some((item) => item.role === "user" && item.internal && item.content.includes(HATCH_BOOTSTRAP_MARKER))) {
    return true;
  }
  const pending = new Map<string, boolean>();
  for (const item of history) {
    if (item.role === "assistant") {
      for (const call of item.toolCalls) {
        if (call.id && isHatchSkillManifestRead(call)) {
          pending.set(call.id, true);
        }
      }
      continue;
    }
    if (item.role !== "tool" || !item.toolCallId) continue;
    const manifest = pending.get(item.toolCallId) === true;
    pending.delete(item.toolCallId);
    if (!manifest || item.isError) continue;
    // Some compatible gateways prefix command/tool output with a short
    // status line. Accept the authoritative Skill header when it appears in
    // the first part of the result, while still rejecting reference-only
    // reads such as `references/animation-rows.md`.
    const header = item.content.slice(0, 512);
    if (/^\s*skill:\s*hatch-pet\b/im.test(header)) return true;
  }
  return false;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  if (typeof value === "string") return value.trim();
  if (value === undefined) return null;
  return value;
}

export function hatchObservationFingerprint(call: ToolCall) {
  if (!HATCH_OBSERVATION_TOOLS.has(call.name)) return null;
  return `${call.name}:${JSON.stringify(canonicalize(call.arguments ?? {}))}`;
}

export function advanceHatchObservationState(
  state: HatchObservationState,
  call: ToolCall,
): HatchObservationGuard | null {
  const fingerprint = hatchObservationFingerprint(call);
  if (!fingerprint) {
    state.count = 0;
    state.fingerprints.clear();
    return null;
  }

  const duplicateCount = state.fingerprints.get(fingerprint) ?? 0;
  if (duplicateCount >= HATCH_MAX_IDENTICAL_OBSERVATIONS) {
    return { kind: "duplicate", toolName: call.name };
  }
  if (state.count >= HATCH_MAX_OBSERVATIONS_WITHOUT_ACTION) {
    return { kind: "stagnant", toolName: call.name };
  }

  state.count += 1;
  state.fingerprints.set(fingerprint, duplicateCount + 1);
  return null;
}

export function hatchObservationHistory(history: AgentMessage[]): HatchObservationState {
  const state: HatchObservationState = { count: 0, fingerprints: new Map() };
  for (const item of history) {
    // Internal continuation prompts are part of the same hatch run. Reset the
    // window only for a real user message; otherwise a provider can evade the
    // circuit breaker by making one observation per automatic round.
    if (item.role === "user" && !item.internal) {
      state.count = 0;
      state.fingerprints.clear();
    }
    for (const call of item.toolCalls) advanceHatchObservationState(state, call);
  }
  return state;
}
