import type { MediaModelInfo, VideoGenerationMode } from "./types";

export interface ImageDimensionOption {
  value: string;
  ratio: string;
  experimental?: boolean;
}

export const IMAGE_DIMENSION_OPTIONS: ImageDimensionOption[] = [
  { value: "1024x1024", ratio: "1:1" },
  { value: "1536x1024", ratio: "3:2" },
  { value: "1024x1536", ratio: "2:3" },
  { value: "2048x1152", ratio: "16:9" },
  { value: "1152x2048", ratio: "9:16" },
  { value: "2048x2048", ratio: "1:1", experimental: true },
  { value: "3840x2160", ratio: "16:9", experimental: true },
  { value: "2160x3840", ratio: "9:16", experimental: true },
];
export const IMAGE_RATIO_OPTIONS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"];
export const VIDEO_SIZE_OPTIONS = ["1280x720", "720x1280", "16:9", "9:16"];

// Resolve capabilities only; requests and saved selections keep the full model ID.
export function mediaModelBaseId(model: string) {
  const id = model.trim().replace(/^models\//i, "").toLowerCase();
  return ["minimax-h3-max", "minimax-h3", "seedance-2.5", "seedance-2.0", "seedance-2", "image-01-live", "image-01"]
    .find((base) => id === base || id.startsWith(`${base}-`)) ?? id;
}

export function selectStudioMediaModel(models: MediaModelInfo[], savedKey?: string) {
  return models.find((model) => `${model.profileId}::${model.id}` === savedKey)
    ?? models[0];
}

export function sortStudioMediaModels(models: MediaModelInfo[]) {
  return [...models].sort((left, right) =>
    left.id.localeCompare(right.id, "en", { numeric: true, sensitivity: "base" })
    || left.profileName.localeCompare(right.profileName, "zh-CN", { numeric: true })
    || left.profileId.localeCompare(right.profileId, "en"),
  );
}

export function mediaModelSupportsExplicitImageMask(
  model: Pick<MediaModelInfo, "id" | "protocol">,
) {
  const id = model.id.trim().replace(/^models\//i, "").toLocaleLowerCase();
  const grokImage = (id === "grok-imagine" || id.startsWith("grok-imagine-"))
    && !id.startsWith("grok-imagine-video");
  return model.protocol !== "gemini_generate_content" && !grokImage && !isMiniMaxImageModel(id);
}

export function isMiniMaxImageModel(id: string) {
  return ["image-01", "image-01-live"].includes(mediaModelBaseId(id));
}

export function imageModelCapabilities(model: string) {
  const id = mediaModelBaseId(model);
  const minimax = isMiniMaxImageModel(id);
  return {
    minimax,
    dimensions: minimax
      ? id === "image-01-live" ? [] : IMAGE_DIMENSION_OPTIONS.filter((option) => !option.experimental || option.value === "2048x2048")
      : IMAGE_DIMENSION_OPTIONS,
    ratios: minimax
      ? IMAGE_RATIO_OPTIONS.filter((ratio) => ratio !== "9:21" && (id !== "image-01-live" || ratio !== "21:9"))
      : [...IMAGE_RATIO_OPTIONS],
  };
}

export function imageGenerationSize(model: string, size = "auto") {
  const capabilities = imageModelCapabilities(model);
  return capabilities.dimensions.some((option) => option.value === size) || capabilities.ratios.includes(size) ? size : "auto";
}

/** Keep displayed defaults and submitted parameters aligned after model changes. */
export function videoOutputOptions(model: string, mode: VideoGenerationMode, saved: {
  size?: string;
  videoAspectRatio?: string;
  videoResolution?: string;
  seconds?: number;
}) {
  const capabilities = videoModelCapabilities(model, mode);
  const hasControls = capabilities.native || capabilities.grok;
  const size = saved.size ?? saved.videoAspectRatio ?? "1280x720";
  const ratio = saved.videoAspectRatio ?? "16:9";
  const resolution = saved.videoResolution ?? "720p";
  const seconds = saved.seconds ?? 8;
  return {
    capabilities,
    hasControls,
    size: VIDEO_SIZE_OPTIONS.includes(size) ? size : "1280x720",
    aspectRatio: capabilities.native && (mode === "image" || mode === "first_last") ? "adaptive" : capabilities.ratios.includes(ratio) ? ratio : "16:9",
    resolution: capabilities.resolutions.includes(resolution) ? resolution : capabilities.resolutions[0],
    seconds: capabilities.durations.includes(seconds) ? seconds : capabilities.durations[0],
  };
}

export function videoModelCapabilities(model: string, mode: VideoGenerationMode = "text") {
  const id = mediaModelBaseId(model);
  const minimax = /^minimax-h3(?:-max)?$/.test(id);
  const seedance = /^seedance-2(?:\.0|\.5)?$/.test(id);
  const grok = id.startsWith("grok-imagine-video");
  const max = id.endsWith("-max");
  const version25 = id.endsWith("2.5");
  const grok15 = grok && id.includes("grok-imagine-video-1.5");
  const native = minimax || seedance;
  const modes: VideoGenerationMode[] = native
    ? max ? ["text", "image", "first_last"] : ["text", "image", "first_last", "reference"]
    : grok15 ? ["image"] : grok ? ["text", "image", "reference", "video"] : ["text"];
  const resolutions = minimax ? max ? ["480p", "768p"] : ["768p", "2K"]
    : seedance ? version25 ? ["480p", "720p", "1080p"] : ["480p", "720p", "1080p", "4K"]
    : grok15 ? ["480p", "720p", "1080p"] : ["480p", "720p"];
  const durations = native ? [max ? 5 : 4, ...(max ? [] : [5]), 8, 10, 12, 15, ...(version25 ? [20, 30] : [])]
    : grok ? mode === "reference" ? [4, 8, 10] : [4, 8, 10, 12, 15] : [4, 8, 12];
  const ratios = native ? ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] : ["16:9", "9:16"];
  const referenceLimit = mode === "text" ? 0 : mode === "first_last" ? 2 : mode === "reference" ? version25 ? 30 : native ? 9 : 7 : 1;
  return { minimax, seedance, grok, grok15, native, modes, resolutions, durations, ratios, referenceLimit };
}
