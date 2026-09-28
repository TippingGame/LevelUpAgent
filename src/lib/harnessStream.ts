import { Channel, invoke } from "@tauri-apps/api/core";
import type { HarnessRunOutcome, HarnessRunRequest, HarnessRuntimeEvent } from "./types";

// Runtime failures are values here so their queued events drain before the
// caller handles the error. IPC failures before the command runs still reject.
type HarnessRunCompletion =
  | { status: "ok"; outcome: HarnessRunOutcome }
  | { status: "error"; error: string };

const EVENT_DRAIN_TIMEOUT_MS = 10_000;

/** Wait for both the command result and its ordered event channel. */
export async function runHarnessStream(
  request: HarnessRunRequest,
  onEvent: (event: HarnessRuntimeEvent) => void,
): Promise<HarnessRunOutcome> {
  let closed = false;
  let drained = false;
  let callbackFailed = false;
  let callbackError: unknown;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finishDrain!: () => void;
  const drain = new Promise<void>((resolve) => { finishDrain = resolve; });
  const channel = new Channel<HarnessRuntimeEvent>((event) => {
    if (closed || event.operationId !== request.operationId) return;
    if (event.kind === "run_finished") {
      drained = true;
      closed = true;
      finishDrain();
      return;
    }
    if (callbackFailed) return;
    try {
      onEvent(event);
    } catch (error) {
      // A thrown consumer callback must not prevent Channel from advancing its
      // message index and delivering the final drain marker.
      callbackFailed = true;
      callbackError = error;
    }
  });

  try {
    const completion = await invoke<HarnessRunCompletion>("harness_run", {
      request: {
        ...request,
        messages: request.messages.filter((message) => !message.status),
      },
      onEvent: channel,
    });
    if (!drained) {
      // Tauri fetches large channel payloads asynchronously. The small command
      // result can arrive first, even though Rust sent all events before it.
      await Promise.race([
        drain,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(
            "Harness event delivery timed out after the command ended; the conversation may be incomplete",
          )), EVENT_DRAIN_TIMEOUT_MS);
        }),
      ]);
    }
    if (callbackFailed) throw callbackError;
    if (completion.status === "error") throw new Error(completion.error);
    return completion.outcome;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    closed = true;
    // A timed-out or rejected invocation cannot mutate a later conversation.
    // Tauri still owns and cleans up the ordered channel callback itself.
    channel.onmessage = () => {};
  }
}
