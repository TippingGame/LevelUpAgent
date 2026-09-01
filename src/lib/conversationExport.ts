import type { AgentMessage, AgentThread, ToolCall } from "./types";

export const CONVERSATION_EXPORT_FORMAT = "levelup-agent.conversation";
export const CONVERSATION_EXPORT_VERSION = 1;

const MAX_IMPORTED_MESSAGES = 500;
const MAX_IMPORTED_CONTENT_CHARS = 1_000_000;

export interface ConversationExportDocument {
  format: typeof CONVERSATION_EXPORT_FORMAT;
  version: typeof CONVERSATION_EXPORT_VERSION;
  source: "LevelUpAgent";
  exportedAt: string;
  title: string;
  workspace?: string;
  kind?: AgentThread["kind"];
  petId?: string;
  inputTokens: number;
  outputTokens: number;
  messages: ConversationExportMessage[];
  /** A provider-neutral, human-readable transcript for other agents. */
  transcript: string;
}

export interface ConversationExportMessage {
  id: string;
  role: AgentMessage["role"];
  content: string;
  createdAt: number;
  toolCalls: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  requestId?: string;
  modelName?: string;
  providerBrand?: AgentMessage["providerBrand"];
  status?: AgentMessage["status"];
  internal?: boolean;
  changeSet?: AgentMessage["changeSet"];
  providerReasoningBlocks?: unknown[];
  attachments: ConversationExportAttachment[];
}

export interface ConversationExportAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
}

export interface ImportedConversation {
  title: string;
  workspace?: string;
  kind?: AgentThread["kind"];
  petId?: string;
  inputTokens: number;
  outputTokens: number;
  messages: ImportedConversationMessage[];
}

export interface ImportedConversationMessage {
  role: AgentMessage["role"];
  content: string;
  createdAt: number;
  toolCalls: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  requestId?: string;
  modelName?: string;
  providerBrand?: AgentMessage["providerBrand"];
  internal?: boolean;
  changeSet?: AgentMessage["changeSet"];
  providerReasoningBlocks?: unknown[];
}

export function serializeConversationExport(thread: AgentThread): string {
  const messages = thread.messages.map((item) => ({
    id: item.id,
    role: item.role,
    content: item.content,
    createdAt: item.createdAt,
    toolCalls: item.toolCalls,
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.isError ? { isError: true } : {}),
    ...(item.requestId ? { requestId: item.requestId } : {}),
    ...(item.modelName ? { modelName: item.modelName } : {}),
    ...(item.providerBrand ? { providerBrand: item.providerBrand } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(item.internal ? { internal: true } : {}),
    ...(item.changeSet ? { changeSet: item.changeSet } : {}),
    ...(item.providerReasoningBlocks?.length ? { providerReasoningBlocks: item.providerReasoningBlocks } : {}),
    attachments: item.attachments.map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      kind: attachment.kind,
    })),
  } satisfies ConversationExportMessage));
  const document: ConversationExportDocument = {
    format: CONVERSATION_EXPORT_FORMAT,
    version: CONVERSATION_EXPORT_VERSION,
    source: "LevelUpAgent",
    exportedAt: new Date().toISOString(),
    title: thread.title,
    workspace: thread.workspace,
    kind: thread.kind,
    petId: thread.petId,
    inputTokens: thread.inputTokens,
    outputTokens: thread.outputTokens,
    messages,
    transcript: conversationTranscript(thread.title, messages),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseConversationExport(text: string): ImportedConversation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The selected conversation file is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("The selected conversation file must contain a JSON object");

  const source = isRecord(parsed.conversation) ? parsed.conversation : parsed;
  const rawMessages = source.messages;
  if (!Array.isArray(rawMessages)) {
    throw new Error("The selected file does not contain a messages array");
  }
  if (rawMessages.length === 0) throw new Error("The selected conversation has no messages");
  if (rawMessages.length > MAX_IMPORTED_MESSAGES) {
    throw new Error(`A conversation import may contain at most ${MAX_IMPORTED_MESSAGES} messages`);
  }

  const title = stringValue(source.title) || "Imported conversation";
  const messages = rawMessages.map((value, index) => normalizeImportedMessage(value, index));
  const totalChars = messages.reduce((total, item) => total + item.content.length, 0);
  if (totalChars > MAX_IMPORTED_CONTENT_CHARS) {
    throw new Error("The selected conversation is too large to import");
  }
  return {
    title: title.slice(0, 80),
    workspace: stringValue(source.workspace),
    kind: source.kind === "pet" ? "pet" : "standard",
    petId: stringValue(source.petId),
    inputTokens: nonNegativeNumber(source.inputTokens),
    outputTokens: nonNegativeNumber(source.outputTokens),
    messages,
  };
}

function normalizeImportedMessage(value: unknown, index: number): ImportedConversationMessage {
  if (!isRecord(value)) throw new Error(`Message ${index + 1} is not an object`);
  const role = value.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error(`Message ${index + 1} has an unsupported role`);
  }
  const content = normalizeContent(value.content);
  const attachmentNotes = normalizeAttachmentNotes(value.attachments);
  const combinedContent = [content, attachmentNotes].filter(Boolean).join("\n\n");
  return {
    role,
    content: combinedContent,
    createdAt: nonNegativeNumber(value.createdAt ?? value.created_at) || Date.now() + index,
    toolCalls: normalizeToolCalls(value.toolCalls ?? value.tool_calls),
    toolCallId: stringValue(value.toolCallId ?? value.tool_call_id),
    isError: value.isError === true || value.is_error === true ? true : undefined,
    requestId: stringValue(value.requestId ?? value.request_id),
    modelName: stringValue(value.modelName ?? value.model_name),
    providerBrand: providerBrand(value.providerBrand ?? value.provider_brand),
    internal: value.internal === true ? true : undefined,
    providerReasoningBlocks: Array.isArray(value.providerReasoningBlocks)
      ? value.providerReasoningBlocks
      : undefined,
    // Imported change sets can contain large, provider-specific objects and
    // are not needed to continue the conversation safely.
    changeSet: undefined,
  };
}

function normalizeContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : String(value);
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!isRecord(part)) return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    if (part.type === "image_url" || part.type === "input_image" || part.type === "image") return "[Image attachment]";
    return "";
  }).filter(Boolean).join("\n");
}

function normalizeAttachmentNotes(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const notes = value.map((item) => {
    if (!isRecord(item)) return "";
    const name = stringValue(item.name) || "attachment";
    const kind = stringValue(item.kind) || "file";
    const size = nonNegativeNumber(item.sizeBytes ?? item.size_bytes);
    return `[Attachment: ${name} · ${kind}${size ? ` · ${formatBytes(size)}` : ""}]`;
  }).filter(Boolean);
  return notes.join("\n");
}

function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const name = stringValue(item.name)
      || (isRecord(item.function) ? stringValue(item.function.name) : undefined)
      || `imported_tool_${index + 1}`;
    const id = stringValue(item.id) || `imported-call-${index + 1}`;
    const rawArguments = item.arguments ?? (isRecord(item.function) ? item.function.arguments : undefined);
    let argumentsValue: Record<string, unknown> = {};
    if (isRecord(rawArguments)) argumentsValue = rawArguments;
    else if (typeof rawArguments === "string") {
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (isRecord(parsed)) argumentsValue = parsed;
      } catch {
        argumentsValue = { raw: rawArguments };
      }
    }
    return [{ id, name, arguments: argumentsValue } satisfies ToolCall];
  });
}

function conversationTranscript(title: string, messages: ConversationExportMessage[]): string {
  const sections = [`# ${title}`, "", "Exported by LevelUpAgent", ""];
  for (const item of messages) {
    const label = item.role === "user" ? "User" : item.role === "assistant" ? "Assistant" : "Tool";
    const timestamp = Number.isFinite(item.createdAt) ? new Date(item.createdAt).toISOString() : "";
    sections.push(`## ${label}${timestamp ? ` · ${timestamp}` : ""}`, "", item.content || "[empty]", "");
    for (const attachment of item.attachments) {
      sections.push(`Attachment: ${attachment.name} (${attachment.kind}, ${formatBytes(attachment.sizeBytes)})`);
    }
    sections.push("");
  }
  return sections.join("\n").trimEnd() + "\n";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function providerBrand(value: unknown): AgentMessage["providerBrand"] {
  return value === "openai" || value === "anthropic" || value === "gemini" || value === "antigravity"
    || value === "grok" || value === "opencode" || value === "levelup"
    ? value
    : undefined;
}
