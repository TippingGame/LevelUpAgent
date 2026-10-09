import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type ModelStage = "shape" | "texture" | "rig";
export type ModelComponent = "runtime" | "triposg" | "texture" | "blender";
export type ModelJoint = [number, number, number];
export interface ModelProject {
  id: string; name: string; updatedAt: number;
  stages: Partial<Record<ModelStage, { directory: string; completedAt: number; version: string;
    validation: { triangles?: number; bytes?: number; animations?: number; clips?: string[]; limitations?: string[];
      resources?: { seconds: number; peakTorchReservedMiB: number } } }>>;
}
export interface ModelManifest {
  resourceVersion: string; releaseTag: string; cuda: string; target: string;
  components: Record<ModelComponent, { label: string; license: string; unpackedBytes: number;
    sources: string[]; parts: { name: string; bytes: number; sha256: string }[] }>;
}
export interface ModelOperation {
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  kind: string; phase?: string; detail?: string; projectId?: string; stage?: ModelStage;
  progress: number; stageIndex?: number; stageCount?: number;
  downloadedBytes?: number; totalBytes?: number; bytesPerSecond?: number;
  worker?: { phase: string; progress: number; detail: string };
}
export interface ModelStatus {
  version: string; resourceVersion: string; runtimeRoot: string;
  system: { gpus: { name: string; totalMiB: number; freeMiB: number; driver: string }[];
    ramTotalMiB: number | null; ramAvailableMiB: number | null; diskFreeBytes: number };
  components: Record<ModelComponent, boolean>; manifest: ModelManifest | null;
  projects: ModelProject[]; operation: ModelOperation | null;
  estimates: Record<ModelStage, { vramMiB: number; ramMiB: number }>;
}
export const MODEL_COMPONENTS: ModelComponent[] = ["runtime", "triposg", "texture", "blender"];
export const MODEL_NEEDS: Record<ModelStage, ModelComponent[]> = {
  shape: ["runtime", "triposg"], texture: ["runtime", "texture"], rig: ["blender"],
};
export function defaultModelJoints(proportion: "standard" | "chibi" = "standard"): Record<string, ModelJoint> {
  const joints: Record<string, ModelJoint> = { hips: [0, .48, 0], spine: [0, .57, 0], chest: [0, .68, 0],
    neck: [0, .76, 0], head: [0, .83, 0], headTip: [0, .98, 0] };
  for (const [side, sign] of [["L", 1], ["R", -1]] as const) {
    for (const [name, point] of Object.entries({ shoulder: [.17,.70,0], elbow: [.30,.56,0], wrist: [.39,.43,0],
      hand: [.44,.38,0], hip: [.10,.48,0], knee: [.10,.27,0], ankle: [.10,.06,0], toe: [.10,.035,.12] })) {
      joints[name + side] = [sign * point[0], point[1], point[2]];
    }
  }
  if (proportion === "chibi") {
    Object.assign(joints, { hips:[0,.31,.06], spine:[0,.39,.06], chest:[0,.46,.07],
      neck:[0,.52,.08], head:[0,.59,.08], headTip:[0,.9,.06] });
    for (const [side, sign] of [["L",1],["R",-1]] as const) {
      for (const [name, point] of Object.entries({ shoulder:[.07,.51,.06], elbow:[.12,.41,.06],
        wrist:[.15,.34,.06],hand:[.16,.30,.06],hip:[.06,.31,.06],knee:[.065,.18,.06],
        ankle:[.07,.06,.04],toe:[.07,.015,.14] })) joints[name+side] = [sign*point[0],point[1],point[2]];
    }
  }
  return joints;
}
export function modelProgress(operation: ModelOperation): number {
  if (operation.status === "completed") return 1;
  const worker = operation.worker?.phase === operation.phase ? operation.worker : undefined;
  return Math.max(0, Math.min(1, worker && operation.stageCount
    ? ((operation.stageIndex ?? 0) + worker.progress) / operation.stageCount : operation.progress || 0));
}
export function modelBytes(value: number | undefined): string {
  if (value == null) return "—";
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
export async function modelArtifact(projectId: string, stage: ModelStage | "input", name: string, cacheKey?: string | number): Promise<string> {
  const path = await invoke<string>("model3d_artifact", { projectId, stage, name });
  const url = convertFileSrc(path);
  // A stage can be regenerated in place while the desktop remains open.
  // model-viewer caches its parsed asset by URL, so each completed result needs
  // a stable but distinct resource URL.
  return cacheKey == null ? url : `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(cacheKey))}`;
}
