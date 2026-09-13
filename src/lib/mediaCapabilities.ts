import type { MediaModelInfo, VideoGenerationMode } from "./types";

export function selectStudioMediaModel(models: MediaModelInfo[], savedKey?: string) {
  return models.find((model) => `${model.profileId}::${model.id}` === savedKey)
    ?? models.find((model) => model.recommended)
    ?? models[0];
}

export function mediaModelSupportsExplicitImageMask(
  model: Pick<MediaModelInfo, "id" | "protocol">,
) {
  const id = model.id.trim().replace(/^models\//i, "").toLocaleLowerCase();
  const grokImage = id === "grok-imagine"
    || id === "grok-imagine-edit"
    || id.startsWith("grok-imagine-image");
  return model.protocol !== "gemini_generate_content" && !grokImage && !isMiniMaxImageModel(id);
}

export function isMiniMaxImageModel(id: string) {
  return /^image-01(?:-live)?$/i.test(id.replace(/^models\//i, ""));
}

export function videoModelCapabilities(model: string, mode: VideoGenerationMode = "text") {
  const id = model.replace(/^models\//i, "").toLowerCase();
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
    : seedance ? version25 ? ["480p", "720p"] : ["480p", "720p", "1080p", "4K"]
    : grok15 ? ["480p", "720p", "1080p"] : ["480p", "720p"];
  const durations = native ? [max ? 5 : 4, ...(max ? [] : [5]), 8, 10, 12, 15, ...(version25 ? [20, 30] : [])]
    : grok ? mode === "reference" ? [4, 8, 10] : [4, 8, 10, 12, 15] : [4, 8, 12];
  const ratios = native ? ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] : ["16:9", "9:16"];
  const referenceLimit = mode === "text" ? 0 : mode === "first_last" ? 2 : mode === "reference" ? version25 ? 30 : native ? 9 : 7 : 1;
  return { minimax, seedance, grok, grok15, native, modes, resolutions, durations, ratios, referenceLimit };
}
