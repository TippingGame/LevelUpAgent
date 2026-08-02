import type { AgentMessage, AgentThread, DiffViewSettings, ImageAttachment, PermissionLevel, ProviderProfile, ProviderProtocol, ToolCall } from "./types";
import { tr } from "./i18n";

const PROFILE_KEY = "levelup-agent.profiles.v1";
const ACTIVE_PROFILE_KEY = "levelup-agent.active-profile.v1";
const THREAD_KEY = "levelup-agent.threads.v1";
const ACTIVE_THREAD_KEY = "levelup-agent.active-thread.v1";
const PERMISSION_LEVEL_KEY = "levelup-agent.permission-level.v1";
const HIDDEN_PROJECTS_KEY = "levelup-agent.hidden-projects.v1";
const PINNED_THREADS_KEY = "levelup-agent.pinned-threads.v1";
const ACTIVE_THEME_KEY = "levelup-agent.active-theme.v1";
const DIFF_VIEW_SETTINGS_KEY = "levelup-agent.diff-view-settings.v1";

export const DEFAULT_DIFF_VIEW_SETTINGS: DiffViewSettings = {
  fontFamily: "monaco",
  fontSize: 13,
};

export const DEFAULT_LEVELUP_BASE_URL = "https://levelup.mom";

export const defaultProfile: ProviderProfile = {
  id: "levelup-api",
  name: "LevelUpAPI",
  baseUrl: DEFAULT_LEVELUP_BASE_URL,
  model: "gpt-5.6-sol",
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

function readStorageValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeProtocol(value: unknown): ProviderProtocol {
  return value === "openai_chat" || value === "anthropic_messages" || value === "gemini_generate_content"
    ? value
    : "openai_responses";
}

function normalizeProfile(value: unknown, index: number): ProviderProfile | null {
  if (!isRecord(value)
    || typeof value.id !== "string" || !value.id.trim()
    || typeof value.name !== "string"
    || typeof value.baseUrl !== "string"
    || typeof value.model !== "string") return null;
  return migrateDefaultProfile({
    id: value.id,
    name: value.name,
    baseUrl: value.baseUrl,
    model: value.model,
    protocol: normalizeProtocol(value.protocol),
    allowUnauthenticated: value.allowUnauthenticated === true,
    priority: finiteNumber(value.priority, (index + 1) * 10),
    failoverEnabled: value.failoverEnabled !== false,
  });
}

function normalizeToolCall(value: unknown): ToolCall | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    arguments: isRecord(value.arguments) ? value.arguments : {},
  };
}

function normalizeAttachment(value: unknown): ImageAttachment | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.mimeType !== "string") return null;
  const kind = value.kind === "video" || value.kind === "text" || value.kind === "document"
    ? value.kind
    : "image";
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    sizeBytes: Math.max(0, finiteNumber(value.sizeBytes)),
    kind,
  };
}

function normalizeMessage(value: unknown): AgentMessage | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || (value.role !== "user" && value.role !== "assistant" && value.role !== "tool")
    || typeof value.content !== "string") return null;
  const status = value.status === "reconnecting" || value.status === "reconnected" || value.status === "failed"
    ? value.status
    : undefined;
  const providerBrand = value.providerBrand === "openai" || value.providerBrand === "anthropic"
    || value.providerBrand === "gemini" || value.providerBrand === "antigravity"
    || value.providerBrand === "grok" || value.providerBrand === "levelup"
    ? value.providerBrand
    : undefined;
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    toolCalls: Array.isArray(value.toolCalls)
      ? value.toolCalls.map(normalizeToolCall).filter((item): item is ToolCall => item !== null)
      : [],
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
    createdAt: finiteNumber(value.createdAt, Date.now()),
    isError: typeof value.isError === "boolean" ? value.isError : undefined,
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    modelName: typeof value.modelName === "string" ? value.modelName : undefined,
    providerBrand,
    status,
    durationMs: typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? value.durationMs : undefined,
    internal: typeof value.internal === "boolean" ? value.internal : undefined,
    changeSet: isRecord(value.changeSet) ? value.changeSet as unknown as AgentMessage["changeSet"] : undefined,
    attachments: Array.isArray(value.attachments)
      ? value.attachments.map(normalizeAttachment).filter((item): item is ImageAttachment => item !== null)
      : [],
  };
}

function normalizeThread(value: unknown): AgentThread | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return null;
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : tr("新会话", "New conversation"),
    workspace: typeof value.workspace === "string" ? value.workspace : undefined,
    kind: value.kind === "pet" ? "pet" : value.kind === "standard" ? "standard" : undefined,
    petId: typeof value.petId === "string" ? value.petId : undefined,
    messages: Array.isArray(value.messages)
      ? value.messages.map(normalizeMessage).filter((item): item is AgentMessage => item !== null)
      : [],
    updatedAt: finiteNumber(value.updatedAt, Date.now()),
    inputTokens: Math.max(0, finiteNumber(value.inputTokens)),
    outputTokens: Math.max(0, finiteNumber(value.outputTokens)),
  };
}

export function migrateDefaultProfile(profile: ProviderProfile): ProviderProfile {
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, "");
  if (profile.id === defaultProfile.id
    && (baseUrl === "http://127.0.0.1:8080" || baseUrl === "http://127.0.0.1:8080/v1")) {
    return { ...profile, baseUrl: DEFAULT_LEVELUP_BASE_URL };
  }
  return profile;
}

export function loadProfiles(): ProviderProfile[] {
  const stored = readJson<unknown>(PROFILE_KEY, []);
  const profiles = Array.isArray(stored)
    ? stored.map(normalizeProfile).filter((item): item is ProviderProfile => item !== null)
    : [];
  const available = profiles.length > 0 ? profiles : [defaultProfile];
  return available;
}

export function saveProfiles(profiles: ProviderProfile[]) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
}

export function loadActiveProfileId(profiles: ProviderProfile[]): string {
  const selected = readStorageValue(ACTIVE_PROFILE_KEY);
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
  const stored = readJson<unknown>(THREAD_KEY, []);
  return Array.isArray(stored)
    ? stored.map(normalizeThread).filter((item): item is AgentThread => item !== null)
    : [];
}

export function saveThreads(threads: AgentThread[]) {
  localStorage.setItem(THREAD_KEY, JSON.stringify(threads.slice(0, 80)));
}

export function loadActiveThreadId(threads: AgentThread[]): string {
  const selected = readStorageValue(ACTIVE_THREAD_KEY);
  return threads.some((thread) => thread.id === selected) ? selected! : threads[0]?.id ?? "";
}

export function saveActiveThreadId(threadId: string) {
  localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
}

export function loadPermissionLevel(): PermissionLevel {
  const stored = readStorageValue(PERMISSION_LEVEL_KEY);
  return stored === "request" || stored === "agent" || stored === "full" ? stored : "request";
}

export function savePermissionLevel(level: PermissionLevel) {
  localStorage.setItem(PERMISSION_LEVEL_KEY, level);
}

export function loadHiddenProjectKeys(): Set<string> {
  const stored = readJson<unknown>(HIDDEN_PROJECTS_KEY, []);
  return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
}

export function saveHiddenProjectKeys(keys: Set<string>) {
  localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...keys]));
}

export function loadPinnedThreadIds(): Set<string> {
  const stored = readJson<unknown>(PINNED_THREADS_KEY, []);
  return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
}

export function savePinnedThreadIds(ids: Set<string>) {
  localStorage.setItem(PINNED_THREADS_KEY, JSON.stringify([...ids]));
}

export function loadActiveThemeId(): string {
  return readStorageValue(ACTIVE_THEME_KEY) ?? "default";
}

export function saveActiveThemeId(themeId: string) {
  if (themeId === "default") localStorage.removeItem(ACTIVE_THEME_KEY);
  else localStorage.setItem(ACTIVE_THEME_KEY, themeId);
}

export function loadDiffViewSettings(): DiffViewSettings {
  const parsed = readJson<unknown>(DIFF_VIEW_SETTINGS_KEY, {});
  const stored = isRecord(parsed) ? parsed : {};
  const fontFamily = stored.fontFamily === "system" || stored.fontFamily === "consolas"
    ? stored.fontFamily
    : DEFAULT_DIFF_VIEW_SETTINGS.fontFamily;
  const fontSize = typeof stored.fontSize === "number" && Number.isFinite(stored.fontSize)
    ? Math.min(24, Math.max(10, Math.round(stored.fontSize)))
    : DEFAULT_DIFF_VIEW_SETTINGS.fontSize;
  return { fontFamily, fontSize };
}

export function saveDiffViewSettings(settings: DiffViewSettings) {
  localStorage.setItem(DIFF_VIEW_SETTINGS_KEY, JSON.stringify({
    fontFamily: settings.fontFamily,
    fontSize: Math.min(24, Math.max(10, Math.round(settings.fontSize))),
  } satisfies DiffViewSettings));
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
  options: Partial<Pick<import("./types").AgentMessage, "toolCalls" | "toolCallId" | "isError" | "requestId" | "modelName" | "providerBrand" | "status" | "durationMs" | "internal" | "changeSet" | "attachments">> = {},
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
    status: options.status,
    durationMs: options.durationMs,
    internal: options.internal,
    changeSet: options.changeSet,
    attachments: options.attachments ?? [],
    createdAt: Date.now(),
  } satisfies import("./types").AgentMessage;
}

type AgentMessageRole = "user" | "assistant" | "tool";
