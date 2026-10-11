import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type MusicEngine = "musicgen" | "acestep" | "yue2";
export const musicEngines = {
  acestep: { label: "ACE-Step 1.5", min: 10, max: 600, duration: 60, promptLimit: 512, lyricLimit: 4096, vram: 8, ram: 16, disk: 35, runtime: "Python 3.12 · PyTorch 2.7.1 · CUDA 12.8", license: "MIT · Qwen3 Apache-2.0" },
  yue2: { label: "YuE2 INT8", min: 8, max: 600, duration: 60, promptLimit: 2000, lyricLimit: 6000, vram: 8, ram: 32, disk: 30, runtime: "Python 3.13 · PyTorch 2.11 · CUDA 13.0", license: "CC-BY-NC-4.0" },
  musicgen: { label: "MusicGen Small", min: 4, max: 30, duration: 10, promptLimit: 2000, lyricLimit: 0, vram: 4, ram: 8, disk: 20, runtime: "Python 3.10 · PyTorch 2.8 · CUDA 12.8", license: "CC-BY-NC-4.0" },
} satisfies Record<MusicEngine, object>;
export interface MusicParams { title: string; prompt: string; lyrics: string; mode: "instrumental" | "song"; language: "auto" | "zh" | "en" | "ja"; duration: number; seed: number; guidance: number; engine: MusicEngine; reference_id?: string; reference_name?: string; reference_duration?: number; }
export interface MusicReference { id: string; name: string; duration: number; }
export interface MusicJob {
  id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  kind: string; params: MusicParams; progress: number; phase: string; error?: string;
  created_at: number; favorite: boolean; archived: boolean; parent_id?: string;
  audio?: { duration: number; sample_rate: number; peaks: number[]; bytes: number };
  metrics?: { seconds: number; peak_gpu_gb: number; peak_ram_gb?: number; device: string };
  warnings?: string[]; license?: string; truncated?: { abc: boolean; semantic: boolean };
  engine_label?: string;
}
export interface MusicOperation { status: string; engine?: MusicEngine; phase?: string; detail: string; progress?: number; downloadedBytes?: number; totalBytes?: number; bytesPerSecond?: number; }
export interface MusicEngineStatus { ready: boolean; runtimeReady: boolean; modelReady: boolean; resourceVersion: string; root: string; manifestName: string; }
export interface MusicStatus {
  supported: boolean; ready: boolean; runtimeReady: boolean; modelReady: boolean; serviceError?: string;
  root: string; jobs: MusicJob[]; operation: MusicOperation | null; resourceVersion: string;
  memory: { totalMiB: number | null; availableMiB: number | null }; diskFreeBytes: number | null;
  engines: Record<MusicEngine, MusicEngineStatus>;
}
export interface MusicHardware { gpus: { name: string; totalMiB: number; freeMiB: number; driver: string }[]; memory: MusicStatus["memory"]; checkedAt: number; }
export interface MusicManifest { resourceVersion: string; components: Record<string, { unpackedBytes: number; parts: { bytes: number; name: string; sha256: string }[] }>; }
export const musicBytes = (n?: number | null) => n == null ? "—" : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
export const musicBusy = (job: MusicJob) => job.status === "queued" || job.status === "running";
export const musicRequest = <T,>(action: string, request: unknown) => invoke<T>("music_request", { action, request });
export const musicArtifact = async (id: string) => convertFileSrc(await invoke<string>("music_artifact", { id }));
export const musicDefaults: MusicParams = { title: "", prompt: "", lyrics: "", mode: "instrumental", language: "auto", duration: 60, seed: 42, guidance: 3, engine: "acestep" };
export function normalizeMusicParams(value: Partial<MusicParams>): MusicParams {
  const engine: MusicEngine = value.engine && Object.prototype.hasOwnProperty.call(musicEngines, value.engine) ? value.engine : "musicgen";
  const info = musicEngines[engine];
  const number = (key: "duration" | "seed" | "guidance", min: number, max: number, fallback: number) =>
    typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= min && value[key] <= max ? value[key] : fallback;
  return { engine, title: typeof value.title === "string" ? value.title.slice(0, 80) : "", prompt: typeof value.prompt === "string" ? value.prompt.slice(0, 2000) : "",
    ...(engine === "yue2" && typeof value.reference_id === "string" && /^[a-f0-9]{32}$/.test(value.reference_id) ? { reference_id: value.reference_id, reference_name: typeof value.reference_name === "string" ? value.reference_name.slice(0, 160) : "", reference_duration: typeof value.reference_duration === "number" && Number.isFinite(value.reference_duration) && value.reference_duration >= 1 && value.reference_duration <= 600 ? value.reference_duration : undefined } : {}),
    lyrics: typeof value.lyrics === "string" ? value.lyrics.slice(0, 6000) : "", mode: engine !== "musicgen" && value.mode === "song" ? "song" : "instrumental",
    language: ["zh", "en", "ja"].includes(value.language ?? "") ? value.language! : "auto",
    duration: number("duration", info.min, info.max, info.duration), seed: Math.floor(number("seed", 0, 2147483647, 42)), guidance: number("guidance", 1, 8, 3) };
}
export function loadMusicDraft(): MusicParams {
  try {
    const value = JSON.parse(localStorage.getItem("levelup.music.draft") ?? "null");
    if (!value || typeof value.prompt !== "string") return musicDefaults;
    return normalizeMusicParams(value);
  } catch { return musicDefaults; }
}
