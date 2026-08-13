import type {
  AgentMode,
  PermissionLevel,
  ProviderProfile,
  ToolCall,
} from "./types";
import { hatchBootstrapMetadata } from "./hatchProgress.ts";

export interface ToolExecutionRequestOptions {
  call: ToolCall;
  workspace: string;
  threadId?: string;
  profile?: ProviderProfile;
  fallbackProfiles?: ProviderProfile[];
  hatch?: boolean;
  hatchSkillLoaded?: boolean;
  hatchBootstrap?: boolean;
  mode?: AgentMode;
  permissionLevel?: PermissionLevel;
  operationId?: string;
  approvalGranted?: boolean;
}

export interface HatchBootstrapToolOptions {
  call: ToolCall;
  workspace: string;
  threadId?: string;
  profile?: ProviderProfile;
  fallbackProfiles?: ProviderProfile[];
  hatchSkillLoaded: boolean;
}

/** Build the camelCase payload consumed by the Tauri execute_tool command. */
export function createToolExecutionRequest({
  call,
  workspace,
  threadId,
  profile,
  fallbackProfiles = [],
  hatch = false,
  hatchSkillLoaded = false,
  hatchBootstrap = false,
  mode = "agent",
  permissionLevel = "request",
  operationId,
  approvalGranted = false,
}: ToolExecutionRequestOptions) {
  return {
    name: call.name,
    callId: call.id,
    operationId,
    arguments: call.arguments,
    workspace,
    threadId,
    profile,
    fallbackProfiles,
    hatch,
    hatchSkillLoaded,
    hatchBootstrap,
    mode,
    permissionLevel,
    approvalGranted,
  };
}

/**
 * Application-owned hatch startup is intentionally separate from provider
 * tool execution. Keep its trusted marker fixed here so positional booleans
 * cannot silently turn prepare/status calls back into ordinary shell calls.
 */
export function createHatchBootstrapToolRequest(options: HatchBootstrapToolOptions) {
  const bootstrap = options.call.name === "run_command"
    && typeof options.call.arguments?.command === "string"
    ? hatchBootstrapMetadata(options.call.arguments.command)
    : null;
  return createToolExecutionRequest({
    ...options,
    call: bootstrap
      ? { ...options.call, arguments: { ...options.call.arguments, hatchBootstrap: bootstrap } }
      : options.call,
    hatch: true,
    hatchBootstrap: true,
    mode: "agent",
    permissionLevel: "request",
    approvalGranted: false,
  });
}
