import {
  parseSpineLayerManifest,
  type SpineLayerManifest,
} from "./spineLayers";

export const SPINE_COMFY_NODES = [
  "LoadImage",
  "SeeThrough_LoadLayerDiffModel",
  "SeeThrough_LoadDepthModel",
  "SeeThrough_GenerateLayers",
  "SeeThrough_GenerateDepth",
  "SeeThrough_PostProcess",
  "LevelUpSpineExport",
] as const;
export type SpineComfyOperation =
  | "info"
  | "upload"
  | "submit"
  | "history"
  | "recover"
  | "image";
export type SpineComfyTransport = (
  endpoint: string,
  operation: SpineComfyOperation,
  payload: Record<string, unknown>,
) => Promise<unknown>;
export interface SpineComfyConfig {
  endpoint: string;
  layerModel: string;
  depthModel: string;
  resolution: number;
  steps: number;
  seed: number;
  quant: "none" | "nf4";
  groupOffload: boolean;
}
export interface SpineComfyJob {
  id: string;
  sourceName: string;
  config: SpineComfyConfig;
  createdAt: number;
  updatedAt: number;
  state:
    | "preparing"
    | "submitting"
    | "running"
    | "complete"
    | "failed"
    | "uncertain"
    | "untracked";
  promptId?: string;
  manifest?: SpineLayerManifest;
  error?: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function validateSpineComfyEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "仅支持本机 ComfyUI，例如 http://127.0.0.1:8188 / Use a loopback ComfyUI address",
    );
  return url.origin;
}
export function inspectSpineComfy(value: unknown) {
  const info = record(value),
    missing: string[] = SPINE_COMFY_NODES.filter((name) => !info[name]);
  const choices = (name: string) => {
    const candidate = record(record(record(info[name]).input).required).model;
    const models = Array.isArray(candidate) ? candidate[0] : undefined;
    return Array.isArray(models)
      ? models.filter((m): m is string => typeof m === "string")
      : [];
  };
  for (const name of [
    "SeeThrough_LoadLayerDiffModel",
    "SeeThrough_LoadDepthModel",
  ]) {
    if (
      info[name] &&
      !record(record(record(info[name]).input).optional).auto_download
    )
      missing.push(`${name}.auto_download`);
  }
  return {
    missing,
    layerModels: choices("SeeThrough_LoadLayerDiffModel"),
    depthModels: choices("SeeThrough_LoadDepthModel"),
  };
}
export function buildSpineComfyGraph(
  jobId: string,
  image: string,
  config: SpineComfyConfig,
) {
  validateSpineComfyEndpoint(config.endpoint);
  if (
    !/^[a-f0-9]{32}$/.test(jobId) ||
    !config.layerModel ||
    !config.depthModel ||
    config.layerModel.length > 256 ||
    config.depthModel.length > 256 ||
    ![512, 768, 1024, 1280].includes(config.resolution) ||
    !Number.isInteger(config.steps) ||
    config.steps < 1 ||
    config.steps > 100 ||
    !Number.isInteger(config.seed) ||
    config.seed < 0 ||
    config.seed > 4294967295 ||
    !["none", "nf4"].includes(config.quant)
  )
    throw new Error("Invalid See-through settings");
  const model = (name: string) => ({
    model: name,
    quant_mode: config.quant,
    cache_tag_embeds: true,
    group_offload: config.groupOffload,
    auto_download: false,
  });
  return {
    "1": { class_type: "LoadImage", inputs: { image } },
    "2": {
      class_type: "SeeThrough_LoadLayerDiffModel",
      inputs: model(config.layerModel),
    },
    "3": {
      class_type: "SeeThrough_GenerateLayers",
      inputs: {
        image: ["1", 0],
        layerdiff_model: ["2", 0],
        seed: config.seed,
        resolution: config.resolution,
        num_inference_steps: config.steps,
      },
    },
    "4": {
      class_type: "SeeThrough_LoadDepthModel",
      inputs: model(config.depthModel),
    },
    "5": {
      class_type: "SeeThrough_GenerateDepth",
      inputs: {
        layers: ["3", 0],
        depth_model: ["4", 0],
        seed: config.seed,
        resolution_depth: config.resolution,
      },
    },
    "6": {
      class_type: "SeeThrough_PostProcess",
      inputs: { layers_depth: ["5", 0], tblr_split: true, use_lama: false },
    },
    "7": {
      class_type: "LevelUpSpineExport",
      inputs: { parts: ["6", 0], job_id: jobId },
    },
  };
}
export function reduceSpineComfyHistory(
  job: SpineComfyJob,
  response: unknown,
): SpineComfyJob {
  if (!job.promptId) throw new Error("Missing prompt receipt");
  const history = record(record(response)[job.promptId]);
  if (!Object.keys(history).length)
    return {
      ...job,
      state: "running",
      error: undefined,
      updatedAt: Date.now(),
    };
  const status = record(history.status);
  if (status.status_str === "error") {
    const messages = Array.isArray(status.messages) ? status.messages : [];
    const exception = messages.find(
      (m) => Array.isArray(m) && m[0] === "execution_error",
    )?.[1];
    return {
      ...job,
      state: "failed",
      error: String(
        record(exception).exception_message ?? "ComfyUI execution failed",
      ).slice(0, 2000),
      updatedAt: Date.now(),
    };
  }
  if (status.completed !== true)
    return {
      ...job,
      state: "running",
      error: undefined,
      updatedAt: Date.now(),
    };
  const raw = record(record(history.outputs)["7"]).levelup_spine;
  const manifest = parseSpineLayerManifest(
    Array.isArray(raw) ? raw[0] : undefined,
  );
  for (const layer of manifest.layers)
    if (
      !new RegExp(`^levelup_spine_${job.id}_[0-9]{3}\\.png$`).test(
        layer.filename,
      )
    )
      throw new Error("ComfyUI returned an image belonging to another job");
  return {
    ...job,
    state: "complete",
    manifest,
    error: undefined,
    updatedAt: Date.now(),
  };
}
export async function submitSpineComfyJob(
  job: SpineComfyJob,
  image: string,
  transport: SpineComfyTransport,
  checkpoint: (job: SpineComfyJob) => Promise<void>,
) {
  if (job.state !== "preparing")
    throw new Error(
      "Only a new job can be submitted; do not automatically resubmit uncertain jobs.",
    );
  let current = job;
  let submitted = false;
  try {
    await checkpoint(job);
    const upload = record(
      await transport(job.config.endpoint, "upload", { jobId: job.id, image }),
    );
    if (
      upload.name !== `levelup_spine_input_${job.id}.png` ||
      (upload.subfolder && upload.subfolder !== "") ||
      (upload.type && upload.type !== "input")
    )
      throw new Error("Unexpected ComfyUI upload receipt");
    buildSpineComfyGraph(job.id, upload.name, job.config);
    current = { ...job, state: "submitting", updatedAt: Date.now() };
    await checkpoint(current);
    submitted = true;
    const receipt = record(
      await transport(job.config.endpoint, "submit", {
        jobId: job.id,
        config: job.config,
      }),
    );
    if (
      typeof receipt.prompt_id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(receipt.prompt_id)
    )
      throw new Error(
        "ComfyUI did not return a prompt ID; recover this job instead of resubmitting.",
      );
    current = {
      ...current,
      state: "running",
      promptId: receipt.prompt_id,
      updatedAt: Date.now(),
    };
    await checkpoint(current);
    return current;
  } catch (error) {
    current = {
      ...current,
      state: current.promptId ? "running" : submitted ? "uncertain" : "failed",
      error: String(error),
      updatedAt: Date.now(),
    };
    await checkpoint(current);
    return current;
  }
}

export async function refreshSpineComfyJob(
  job: SpineComfyJob,
  transport: SpineComfyTransport,
  checkpoint: (job: SpineComfyJob) => Promise<void>,
) {
  let current = job;
  if (!current.promptId) {
    const receipt = record(
      await transport(current.config.endpoint, "recover", {
        jobId: current.id,
      }),
    );
    if (
      typeof receipt.promptId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(receipt.promptId)
    )
      throw new Error(
        "未在队列或最近 100 条记录中找到回执；请检查 ComfyUI，不会自动重发 / Receipt not found; inspect ComfyUI. No automatic resubmission.",
      );
    current = {
      ...current,
      promptId: receipt.promptId,
      state: "running",
      error: undefined,
      updatedAt: Date.now(),
    };
    await checkpoint(current);
  }
  try {
    current = reduceSpineComfyHistory(
      current,
      await transport(current.config.endpoint, "history", {
        promptId: current.promptId,
      }),
    );
    await checkpoint(current);
    return current;
  } catch (error) {
    await checkpoint({
      ...current,
      error: String(error),
      updatedAt: Date.now(),
    });
    throw error;
  }
}
