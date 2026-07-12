export function validateUpdaterEndpoint(endpoint) {
  let updaterUrl;
  try {
    updaterUrl = new URL(endpoint);
  } catch {
    throw new Error("TAURI_UPDATER_ENDPOINT must be a valid absolute URL");
  }
  if (updaterUrl.protocol !== "https:") {
    throw new Error("TAURI_UPDATER_ENDPOINT must use HTTPS");
  }
  if (updaterUrl.username || updaterUrl.password || updaterUrl.hash) {
    throw new Error("TAURI_UPDATER_ENDPOINT must not contain URL credentials or a fragment");
  }
  return updaterUrl.href;
}

