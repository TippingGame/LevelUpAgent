import type { AgentThread, PermissionLevel, ProviderProfile } from "./types";
import { tr } from "./i18n";

const PROFILE_KEY = "levelup-agent.profiles.v1";
const ACTIVE_PROFILE_KEY = "levelup-agent.active-profile.v1";
const THREAD_KEY = "levelup-agent.threads.v1";
const ACTIVE_THREAD_KEY = "levelup-agent.active-thread.v1";
const PERMISSION_LEVEL_KEY = "levelup-agent.permission-level.v1";
const HIDDEN_PROJECTS_KEY = "levelup-agent.hidden-projects.v1";
const PINNED_THREADS_KEY = "levelup-agent.pinned-threads.v1";

export const defaultProfile: ProviderProfile = {
  id: "levelup-api",
  name: "LevelUpAPI",
  baseUrl: "http://127.0.0.1:8080",
  model: "gpt-5.5",
  protocol: "openai_responses",
  allowUnauthenticated: false,
  priority: 10,
  failoverEnabled: true,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadProfiles(): ProviderProfile[] {
  const profiles = readJson<ProviderProfile[]>(PROFILE_KEY, [defaultProfile]);
  const available = profiles.length > 0 ? profiles : [defaultProfile];
  return available.map((profile, index) => ({
    ...profile,
    allowUnauthenticated: profile.allowUnauthenticated ?? false,
    priority: Number.isFinite(profile.priority) ? profile.priority : (index + 1) * 10,
    failoverEnabled: profile.failoverEnabled ?? true,
  }));
}

export function saveProfiles(profiles: ProviderProfile[]) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
}

export function loadActiveProfileId(profiles: ProviderProfile[]): string {
  const selected = localStorage.getItem(ACTIVE_PROFILE_KEY);
  return profiles.some((profile) => profile.id === selected) ? selected! : profiles[0].id;
}

export function saveActiveProfileId(profileId: string) {
  localStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
}

export function clearLegacyProfiles() {
  localStorage.removeItem(PROFILE_KEY);
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
}

export function loadThreads(): AgentThread[] {
  return readJson<AgentThread[]>(THREAD_KEY, []).map((thread) => ({
    ...thread,
    messages: thread.messages.map((item) => ({
      ...item,
      attachments: (item.attachments ?? []).map((attachment) => ({
        ...attachment,
        kind: attachment.kind ?? "image",
      })),
    })),
  }));
}

export function saveThreads(threads: AgentThread[]) {
  localStorage.setItem(THREAD_KEY, JSON.stringify(threads.slice(0, 80)));
}

export function loadActiveThreadId(threads: AgentThread[]): string {
  const selected = localStorage.getItem(ACTIVE_THREAD_KEY);
  return threads.some((thread) => thread.id === selected) ? selected! : threads[0]?.id ?? "";
}

export function saveActiveThreadId(threadId: string) {
  localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
}

export function loadPermissionLevel(): PermissionLevel {
  const stored = localStorage.getItem(PERMISSION_LEVEL_KEY);
  return stored === "request" || stored === "agent" || stored === "full" ? stored : "full";
}

export function savePermissionLevel(level: PermissionLevel) {
  localStorage.setItem(PERMISSION_LEVEL_KEY, level);
}

export function loadHiddenProjectKeys(): Set<string> {
  return new Set(readJson<string[]>(HIDDEN_PROJECTS_KEY, []));
}

export function saveHiddenProjectKeys(keys: Set<string>) {
  localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...keys]));
}

export function loadPinnedThreadIds(): Set<string> {
  return new Set(readJson<string[]>(PINNED_THREADS_KEY, []));
}

export function savePinnedThreadIds(ids: Set<string>) {
  localStorage.setItem(PINNED_THREADS_KEY, JSON.stringify([...ids]));
}

export function clearLegacyThreads() {
  localStorage.removeItem(THREAD_KEY);
}

export function createThread(workspace?: string): AgentThread {
  return {
    id: crypto.randomUUID(),
    title: tr("新会话", "New conversation"),
    workspace,
    messages: [],
    updatedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function message(
  role: AgentMessageRole,
  content: string,
  options: Partial<Pick<import("./types").AgentMessage, "toolCalls" | "toolCallId" | "isError" | "requestId" | "modelName" | "providerBrand" | "durationMs" | "internal" | "attachments">> = {},
) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    toolCalls: options.toolCalls ?? [],
    toolCallId: options.toolCallId,
    isError: options.isError,
    requestId: options.requestId,
    modelName: options.modelName,
    providerBrand: options.providerBrand,
    durationMs: options.durationMs,
    internal: options.internal,
    attachments: options.attachments ?? [],
    createdAt: Date.now(),
  } satisfies import("./types").AgentMessage;
}

type AgentMessageRole = "user" | "assistant" | "tool";
