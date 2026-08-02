import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

export type FrontendLogLevel = "info" | "warn" | "error";

interface FrontendLogEntry {
  level: FrontendLogLevel;
  event: string;
  message?: string;
  stack?: string;
  componentStack?: string;
  route?: string;
  visibility?: string;
}

export interface AppLogInfo {
  directory: string;
  currentFile: string;
}

const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let installed = false;
let queue = Promise.resolve();
let lastStallLoggedAt = 0;

function errorDetails(value: unknown): Pick<FrontendLogEntry, "message" | "stack"> {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  if (typeof value === "string") return { message: value };
  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
}

export function writeFrontendLog(
  level: FrontendLogLevel,
  event: string,
  detail: Partial<Omit<FrontendLogEntry, "level" | "event">> = {},
) {
  if (!desktop) return;
  const entry: FrontendLogEntry = {
    level,
    event,
    route: window.location.pathname,
    visibility: document.visibilityState,
    ...detail,
  };
  queue = queue
    .catch(() => undefined)
    .then(async () => {
      try {
        await invoke("frontend_log", { entry });
      } catch {
        // Logging must never become a new unhandled renderer failure.
      }
    });
}

export function reportFrontendError(event: string, error: unknown, componentStack?: string) {
  writeFrontendLog("error", event, { ...errorDetails(error), componentStack });
}

export function reportReactCommit(
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
  commitTime: number,
) {
  if (phase === "mount") {
    writeFrontendLog("info", "renderer_mounted", {
      message: `React mounted in ${actualDuration.toFixed(1)} ms at ${commitTime.toFixed(1)} ms`,
    });
  } else if (actualDuration >= 250) {
    writeFrontendLog("warn", "slow_react_commit", {
      message: `${phase} commit took ${actualDuration.toFixed(1)} ms`,
    });
  }
}

export function installFrontendDiagnostics() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  writeFrontendLog("info", "renderer_bootstrap_started", {
    message: `LevelUpAgent renderer started (${navigator.userAgent})`,
  });

  window.addEventListener("error", (event) => {
    reportFrontendError("window_error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportFrontendError("unhandled_promise_rejection", event.reason);
  });
  document.addEventListener("visibilitychange", () => {
    writeFrontendLog("info", "renderer_visibility_changed");
  });
  window.addEventListener("pagehide", () => {
    writeFrontendLog("info", "renderer_page_hidden");
  });

  let expectedTick = performance.now() + 1_000;
  window.setInterval(() => {
    const now = performance.now();
    const drift = now - expectedTick;
    expectedTick = now + 1_000;
    if (document.visibilityState === "visible" && drift >= 5_000 && Date.now() - lastStallLoggedAt >= 30_000) {
      lastStallLoggedAt = Date.now();
      writeFrontendLog("warn", "renderer_stall_recovered", {
        message: `The renderer event loop was unresponsive for approximately ${Math.round(drift)} ms`,
      });
    }
  }, 1_000);

  window.setInterval(() => {
    if (document.visibilityState === "visible") writeFrontendLog("info", "renderer_heartbeat");
  }, 60_000);
}

export async function getAppLogInfo(): Promise<AppLogInfo | null> {
  if (!desktop) return null;
  return invoke<AppLogInfo>("get_app_log_info");
}

export async function openAppLogDirectory(): Promise<void> {
  const info = await getAppLogInfo();
  if (info) await openPath(info.directory);
}
