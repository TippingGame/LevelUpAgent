import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";

let badgeUpdateQueue = Promise.resolve();

export function syncTaskbarBadge(count: number): Promise<void> {
  const normalized = Math.max(0, Math.trunc(count));
  badgeUpdateQueue = badgeUpdateQueue
    .catch(() => undefined)
    .then(() => applyTaskbarBadge(normalized));
  return badgeUpdateQueue;
}

async function applyTaskbarBadge(count: number) {
  const appWindow = getCurrentWindow();
  if (!/Windows/i.test(navigator.userAgent)) {
    await appWindow.setBadgeCount(count > 0 ? count : undefined);
    return;
  }
  if (count === 0) {
    await appWindow.setOverlayIcon(undefined);
    return;
  }
  const image = await Image.new(renderWindowsBadge(count), 32, 32);
  try {
    await appWindow.setOverlayIcon(image);
  } finally {
    await image.close();
  }
}

function renderWindowsBadge(count: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) return new Uint8Array(32 * 32 * 4);
  const label = count > 99 ? "99+" : String(count);
  context.clearRect(0, 0, 32, 32);
  context.beginPath();
  context.arc(16, 16, 13, 0, Math.PI * 2);
  context.fillStyle = "#e5484d";
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "rgba(255,255,255,.96)";
  context.stroke();
  context.fillStyle = "#fff";
  context.font = `700 ${label.length > 2 ? 11 : 15}px "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 16, 16.5);
  return new Uint8Array(context.getImageData(0, 0, 32, 32).data);
}
