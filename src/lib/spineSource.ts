import { loadSpineImage, normalizeSpineImage } from "./spineAssets";
import type { SpineProject } from "./spine";
import { matteSpineSolidBackground } from "./spineMatting";

export type SpineSourceImage = NonNullable<SpineProject["sourceImage"]>;

export async function cropSpineSourceReference(source: SpineSourceImage, bounds: {
  left: number; top: number; right: number; bottom: number;
}): Promise<string> {
  const image = await loadSpineImage(source.image);
  const padX = Math.max(12, (bounds.right - bounds.left) * source.width * 0.2);
  const padY = Math.max(12, (bounds.bottom - bounds.top) * source.height * 0.2);
  const left = Math.max(0, Math.floor(bounds.left * source.width - padX));
  const top = Math.max(0, Math.floor(bounds.top * source.height - padY));
  const right = Math.min(source.width, Math.ceil(bounds.right * source.width + padX));
  const bottom = Math.min(source.height, Math.ceil(bounds.bottom * source.height + padY));
  const canvas = document.createElement("canvas");
  canvas.width = right - left;
  canvas.height = bottom - top;
  if (!canvas.width || !canvas.height) throw new Error("Planned source crop is empty.");
  canvas.getContext("2d")!.drawImage(image, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export async function prepareSpineSource(source: string, name: string): Promise<SpineSourceImage> {
  const image = await loadSpineImage(source);
  if (image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024)
    throw new Error("Source image exceeds 32 MP.");
  const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = canvas.toDataURL("image/png");
  if (png.length > 12 * 1024 * 1024) throw new Error("Source PNG exceeds 9 MiB.");
  return { id: `source_${crypto.randomUUID().replace(/-/g, "")}`, name: name.slice(0, 160) || "source.png", image: png, originalImage: png, width: canvas.width, height: canvas.height };
}

export async function removeSpineSolidBackground(source: SpineSourceImage, tolerance: number): Promise<SpineSourceImage> {
  const image = await loadSpineImage(source.originalImage);
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;
  data.set(matteSpineSolidBackground(data, canvas.width, canvas.height, tolerance).pixels);
  ctx.putImageData(frame, 0, 0);
  const png = canvas.toDataURL("image/png");
  if (png.length > 12 * 1024 * 1024) throw new Error("Processed PNG exceeds 9 MiB.");
  return { ...source, image: png };
}

export async function prepareSpineGeneratedPart(imageUrl: string) {
  let data = await normalizeSpineImage(imageUrl);
  if (!data.opaque) return data;
  try {
    const cutout = await removeSpineSolidBackground({
      name: "generated-part.png", image: data.image, originalImage: data.image,
      width: data.width, height: data.height,
    }, 60);
    data = await normalizeSpineImage(cutout.image);
  } catch { /* Keep nonuniform opaque outputs available for manual correction. */ }
  return data;
}
