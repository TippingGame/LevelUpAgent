import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface MusicParams { title: string; prompt: string; duration: number; seed: number; guidance: number; engine: "musicgen"; }
export interface MusicJob {
  id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  kind: string; params: MusicParams; progress: number; phase: string; error?: string;
  created_at: number; favorite: boolean; archived: boolean; parent_id?: string;
  audio?: { duration: number; sample_rate: number; peaks: number[]; bytes: number };
  metrics?: { seconds: number; peak_gpu_gb: number; device: string };
}
export interface MusicOperation { status: string; phase?: string; detail: string; progress?: number; downloadedBytes?: number; totalBytes?: number; bytesPerSecond?: number; }
export interface MusicStatus {
  supported: boolean; ready: boolean; runtimeReady: boolean; modelReady: boolean; serviceError?: string;
  root: string; jobs: MusicJob[]; operation: MusicOperation | null; resourceVersion: string;
  memory: { totalMiB: number | null; availableMiB: number | null }; diskFreeBytes: number | null;
}
export interface MusicHardware { gpus: { name: string; totalMiB: number; freeMiB: number; driver: string }[]; memory: MusicStatus["memory"]; checkedAt: number; }
export interface MusicManifest { resourceVersion: string; components: Record<string, { unpackedBytes: number; parts: { bytes: number; name: string; sha256: string }[] }>; }
export const musicBytes = (n?: number | null) => n == null ? "—" : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
export const musicBusy = (job: MusicJob) => job.status === "queued" || job.status === "running";
export const musicRequest = <T,>(action: string, request: unknown) => invoke<T>("music_request", { action, request });
export const musicArtifact = async (id: string) => convertFileSrc(await invoke<string>("music_artifact", { id }));
export const musicDefaults: MusicParams = { title: "", prompt: "", duration: 10, seed: 42, guidance: 3, engine: "musicgen" };
export function loadMusicDraft(): MusicParams {
  try {
    const value = JSON.parse(localStorage.getItem("levelup.music.draft") ?? "null");
    if (!value || typeof value.prompt !== "string") return musicDefaults;
    const number = (key: "duration" | "seed" | "guidance", min: number, max: number) =>
      typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= min && value[key] <= max ? value[key] : musicDefaults[key];
    return { engine: "musicgen", title: typeof value.title === "string" ? value.title.slice(0, 80) : "", prompt: value.prompt.slice(0, 2000), duration: number("duration", 4, 30), seed: Math.floor(number("seed", 0, 2147483647)), guidance: number("guidance", 1, 8) };
  } catch { return musicDefaults; }
}
