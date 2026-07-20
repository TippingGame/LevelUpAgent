import type { AgentMessage, ToolCall } from "./types";

export const HATCH_MAX_IDENTICAL_OBSERVATIONS = 3;
export const HATCH_MAX_OBSERVATIONS_WITHOUT_ACTION = 16;

const HATCH_OBSERVATION_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_files",
  "read_skill",
  "get_goal",
  "check_media_jobs",
]);

export interface HatchObservationState {
  count: number;
  fingerprints: Map<string, number>;
}

export interface HatchObservationGuard {
  kind: "duplicate" | "stagnant";
  toolName: string;
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
    if (item.role === "user") {
      state.count = 0;
      state.fingerprints.clear();
    }
    for (const call of item.toolCalls) advanceHatchObservationState(state, call);
  }
  return state;
}
