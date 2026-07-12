import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateUpdaterEndpoint } from "./release-config-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pubkey = process.env.TAURI_UPDATER_PUBKEY?.trim();
const endpoint = process.env.TAURI_UPDATER_ENDPOINT?.trim();
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();

if (!pubkey || !endpoint || !privateKey) {
  throw new Error("Release requires TAURI_UPDATER_PUBKEY, TAURI_UPDATER_ENDPOINT, and TAURI_SIGNING_PRIVATE_KEY");
}
validateUpdaterEndpoint(endpoint);

const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey,
      endpoints: [endpoint],
      windows: { installMode: "passive" },
    },
  },
};

if (process.env.RUNNER_OS === "Windows") {
  const certificateThumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.trim();
  if (!certificateThumbprint) {
    throw new Error("Windows release requires WINDOWS_CERTIFICATE_THUMBPRINT");
  }
  config.bundle.windows = {
    certificateThumbprint,
    digestAlgorithm: "sha256",
    timestampUrl: "http://timestamp.digicert.com",
  };
}

if (process.env.RUNNER_OS === "macOS") {
  const required = [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`macOS release requires ${missing.join(", ")}`);
  }
}

const destination = resolve(root, "src-tauri", "tauri.release.conf.json");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`Prepared release-only Tauri config for ${process.env.RUNNER_OS ?? "local"}`);
