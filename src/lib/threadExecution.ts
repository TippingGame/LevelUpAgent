import type { AgentThread } from "./types";

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
