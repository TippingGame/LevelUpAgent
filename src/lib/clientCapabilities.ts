import manifest from "../../capabilities/client-actions.json";

export const CLIENT_ACTION_EVENT = manifest.event;
export const CLIENT_ACTION_CAPABILITY_ID = manifest.capabilityId;
export const CLIENT_ACTION_CONTRACT_VERSION = manifest.version;

export type ClientWorkspaceView = "chat" | "media" | "writing" | "constellation";
export type ClientDialog = "settings" | "themes" | "extensions" | "skills" | "instructions" | "logs" | "pet" | "armor";

export interface ClientActionEvent {
  capabilityId: string;
  contractVersion: number;
  action: string;
}

export interface ClientActionTarget {
  showView: (view: ClientWorkspaceView) => void;
  setPanelOpen: (open: boolean) => void;
  showDialog: (dialog: ClientDialog | null) => void;
}

const CLIENT_ACTION_IDS = new Set(manifest.actions.map((action) => action.id));

export function isClientAction(action: unknown): action is string {
  return typeof action === "string" && CLIENT_ACTION_IDS.has(action);
}

export function isClientActionEvent(value: unknown): value is ClientActionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ClientActionEvent>;
  return candidate.capabilityId === CLIENT_ACTION_CAPABILITY_ID
    && candidate.contractVersion === CLIENT_ACTION_CONTRACT_VERSION
    && isClientAction(candidate.action);
}

export function dispatchClientAction(action: unknown, target: ClientActionTarget): boolean {
  if (!isClientAction(action)) return false;
  switch (action) {
    case "view.chat":
      target.showView("chat");
      return true;
    case "view.media":
      target.showView("media");
      return true;
    case "view.writing":
      target.showView("writing");
      return true;
    case "view.constellation":
      target.showView("constellation");
      return true;
    case "panel.open":
      target.setPanelOpen(true);
      return true;
    case "panel.close":
      target.setPanelOpen(false);
      return true;
    case "dialog.close":
      target.showDialog(null);
      return true;
    case "dialog.settings":
      target.showDialog("settings");
      return true;
    case "dialog.themes":
      target.showDialog("themes");
      return true;
    case "dialog.extensions":
      target.showDialog("extensions");
      return true;
    case "dialog.skills":
      target.showDialog("skills");
      return true;
    case "dialog.instructions":
      target.showDialog("instructions");
      return true;
    case "dialog.logs":
      target.showDialog("logs");
      return true;
    case "dialog.pet":
      target.showDialog("pet");
      return true;
    case "dialog.armor":
      target.showDialog("armor");
      return true;
    default:
      return false;
  }
}
