import type { MediaModelInfo } from "./types";

export function mediaModelSupportsExplicitImageMask(
  model: Pick<MediaModelInfo, "id" | "protocol">,
) {
  const id = model.id.trim().replace(/^models\//i, "").toLocaleLowerCase();
  const grokImage = id === "grok-imagine"
    || id === "grok-imagine-edit"
    || id.startsWith("grok-imagine-image");
  return model.protocol !== "gemini_generate_content" && !grokImage;
}
