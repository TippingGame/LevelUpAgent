import type { AgentThread } from "./types";

export function mergeThreadCatalog(current: AgentThread[], incoming: AgentThread[]): AgentThread[] {
  const existing = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of incoming) {
    // A delayed search must not replace a live conversation with an empty summary.
    if (!existing.has(thread.id)) existing.set(thread.id, thread);
  }
  return [...existing.values()];
}

export function threadMatchesQuery(thread: AgentThread, query: string, locale: string): boolean {
  const normalized = query.trim().toLocaleLowerCase(locale);
  if (!normalized) return true;
  const contains = (text: string) => text.toLocaleLowerCase(locale).includes(normalized);
  return contains(thread.title) || contains(thread.workspace ?? "")
    || thread.messages.some((message) => !message.internal && message.role !== "tool" && contains(message.content));
}
