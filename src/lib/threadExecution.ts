import type { AgentThread } from "./types";
import type { AgentMessage } from "./types";
import type { AppLocale } from "./i18n";

export function usesDurableHarness(
  thread: Pick<AgentThread, "kind">,
  desktop: boolean,
): boolean {
  // Every desktop conversation has a durable operation. The browser preview
  // has no Rust database/runtime, so it keeps its deliberately local loop.
  void thread;
  return desktop;
}

export function providerThreadId(
  thread: Pick<AgentThread, "id" | "kind">,
): string {
  return thread.id;
}

/**
 * Add a provider delta to the current assistant turn without changing the
 * placeholder's identity. The placeholder is added when a provider emits its
 * first delta after a tool round.
 */
export function appendAssistantDelta(
  messages: AgentMessage[],
  placeholder: AgentMessage,
  delta: string,
): AgentMessage[] {
  const lastIndex = messages.length - 1;
  if (messages[lastIndex]?.id === placeholder.id) {
    if (!delta) return messages;
    const next = messages.slice();
    next[lastIndex] = { ...next[lastIndex], content: `${next[lastIndex].content}${delta}` };
    return next;
  }
  const index = messages.findIndex((item) => item.id === placeholder.id);
  if (index < 0) {
    return [...messages, { ...placeholder, content: delta }];
  }
  if (!delta) return messages;
  return messages.map((item, itemIndex) => itemIndex === index
    ? { ...item, content: `${item.content}${delta}` }
    : item);
}

/**
 * Replace a streaming placeholder with the durable provider response while
 * preserving the id and creation time used by the conversation UI.
 */
export function finalizeAssistantMessage(
  messages: AgentMessage[],
  placeholder: AgentMessage,
  completed: AgentMessage,
): AgentMessage[] {
  const replacement: AgentMessage = {
    ...completed,
    id: placeholder.id,
    createdAt: placeholder.createdAt,
  };
  const lastIndex = messages.length - 1;
  if (messages[lastIndex]?.id === placeholder.id) {
    const next = messages.slice();
    next[lastIndex] = replacement;
    return next;
  }
  const index = messages.findIndex((item) => item.id === placeholder.id);
  if (index < 0) return [...messages, replacement];
  return messages.map((item, itemIndex) => itemIndex === index ? replacement : item);
}

export function providerRetryProgressLabel(
  retryAttempt: number,
  maxRetryAttempts: number,
  elapsedMs: number,
  locale: AppLocale,
): string {
  const retry = Math.max(1, Math.trunc(retryAttempt));
  const maxRetries = Math.max(retry, Math.trunc(maxRetryAttempts));
  const currentAttempt = retry + 1;
  const totalAttempts = maxRetries + 1;
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  return locale === "zh-CN"
    ? `第 ${currentAttempt}/${totalAttempts} 次请求进行中 · 已等待 ${elapsedSeconds} 秒（上一请求失败）`
    : `Request ${currentAttempt}/${totalAttempts} in progress · waiting ${elapsedSeconds}s (previous request failed)`;
}

export function settleProviderReconnect(
  lastReconnectAttempt: number,
  reportedRetryAttempt?: number,
): { completedAttempt: number; lastReconnectAttempt: number } {
  return {
    completedAttempt: reportedRetryAttempt ?? lastReconnectAttempt,
    lastReconnectAttempt: 0,
  };
}
