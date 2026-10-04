import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { isDesktop } from "./bridge";
import {
  validateSpineComfyEndpoint,
  type SpineComfyTransport,
} from "./spineComfy";

export const spineComfyRequest: SpineComfyTransport = async (
  endpoint,
  operation,
  payload,
) => {
  if (!isDesktop())
    throw new Error(
      "本地 ComfyUI 连接请使用桌面版 / Local ComfyUI requires the desktop app",
    );
  return invoke("spine_comfy_request", {
    endpoint: validateSpineComfyEndpoint(endpoint),
    operation,
    payload,
  });
};

export async function interpolateSpinePixels(request: {
  executable: string; modelDirectory: string; first: string; last: string; fraction: number; gpu: number;
}): Promise<string> {
  if (!isDesktop()) throw new Error("本地 RIFE 请使用桌面版 / Local RIFE requires the desktop app");
  return invoke<string>("spine_rife_frame", { request });
}

export async function saveSpineArchive(
  bytes: Uint8Array,
  name: string,
): Promise<string | null> {
  const filename = `${name.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 60) || "character"}-spine.zip`;
  if (!isDesktop()) {
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/zip" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
  }
  const destination = await save({
    defaultPath: filename,
    filters: [{ name: "Spine assets", extensions: ["zip"] }],
  });
  if (!destination) return null;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return invoke<string>("export_spine_archive", {
    destination,
    dataBase64: btoa(chunks.join("")),
  });
}
