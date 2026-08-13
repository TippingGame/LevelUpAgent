import type { AgentThread } from "./types";

export function usesDurableHarness(
  thread: Pick<AgentThread, "kind">,
  desktop: boolean,
): boolean {
  return desktop && thread.kind !== "pet";
}

export function providerThreadId(
  thread: Pick<AgentThread, "id" | "kind">,
): string | undefined {
  return thread.kind === "pet" ? undefined : thread.id;
}
