import type { AgentThread } from "./types";
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
