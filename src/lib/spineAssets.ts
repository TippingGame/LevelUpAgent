import {
  compileSpineProject,
  packSpineAtlas,
  spineAtlasText,
  createSpinePart,
  newSpineProject,
  generateSpineClip,
  addSpineParts,
  SPINE_LIMITS,
  validateSpineProject,
  type SpineProject,
} from "./spine";
import { createSpineZip } from "./spineArchive";

export function loadSpineImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode image."));
    image.src = source;
  });
}
/** Crop alpha bounds; opaque model output stays opaque and is reported to the author. */
export async function normalizeSpineImage(source: string) {
  const image = await loadSpineImage(source);
  if (image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024)
    throw new Error("Image exceeds 32 megapixels.");
  const scale = Math.min(
    1,
    SPINE_LIMITS.imageSize / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width,
    top = canvas.height,
    right = -1,
    bottom = -1,
    transparent = 0;
  for (let y = 0; y < canvas.height; y++)
    for (let x = 0; x < canvas.width; x++) {
      const alpha = pixels[(y * canvas.width + x) * 4 + 3];
      if (alpha < 250) transparent++;
      if (alpha > 8) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  if (right < 0) throw new Error("Image is fully transparent.");
  const crop = document.createElement("canvas");
  crop.width = right - left + 1;
  crop.height = bottom - top + 1;
  crop
    .getContext("2d")!
    .drawImage(
      canvas,
      left,
      top,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );
  return {
    image: crop.toDataURL("image/png"),
    width: crop.width,
    height: crop.height,
    opaque: transparent < canvas.width * canvas.height * 0.01,
  };
}
export async function readSpineImageFile(file: File) {
  if (
    !/^image\/(png|jpeg|webp)$/.test(file.type) ||
    file.size > 16 * 1024 * 1024
  )
    throw new Error("Use PNG, JPEG or WebP images under 16 MiB.");
  const url = URL.createObjectURL(file);
  try {
    return await normalizeSpineImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function verifySpineProjectImages(project: SpineProject) {
  validateSpineProject(project);
  for (const part of project.parts) {
    const image = await loadSpineImage(part.image);
    if (
      image.naturalWidth !== part.imageWidth ||
      image.naturalHeight !== part.imageHeight
    )
      throw new Error("Image dimensions do not match project metadata.");
    if (part.layerSource) {
      const original = await loadSpineImage(part.layerSource.originalImage);
      if (
        original.naturalWidth !==
          part.layerSource.right - part.layerSource.left ||
        original.naturalHeight !==
          part.layerSource.bottom - part.layerSource.top
      )
        throw new Error(
          "Original layer image dimensions do not match source bounds.",
        );
    }
  }
  return project;
}
function pngBytes(url: string): Uint8Array {
  return Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) =>
    c.charCodeAt(0),
  );
}
export async function exportSpineArchive(project: SpineProject) {
  await verifySpineProjectImages(project);
  const skeleton = compileSpineProject(project),
    pages = packSpineAtlas(project.parts),
    encoder = new TextEncoder();
  const files = [
    {
      name: "skeleton.json",
      data: encoder.encode(JSON.stringify(skeleton, null, 2)),
    },
    { name: "skeleton.atlas", data: encoder.encode(spineAtlasText(pages)) },
    {
      name: "project.levelup-spine.json",
      data: encoder.encode(JSON.stringify(project)),
    },
    {
      name: "README.txt",
      data: encoder.encode(
        "LevelUpAgent Spine Studio / Spine 4.2\n\nImport skeleton.json as a NEW skeleton in Spine 4.2. Set the images folder to ./images/. Save from the editor to create a .spine project.\nFor runtime playback: skeleton.json + skeleton.atlas + atlas-*.png (straight alpha). Match the runtime version to 4.2.\nReopen project.levelup-spine.json in LevelUpAgent to continue authoring. This ZIP is not a .spine binary.\nEach part has a base bone and a bend bone with editable weighted mesh vertices. Linear and stepped bone timelines only.\nAI-generated parts may need cleanup, alignment and hidden-region painting. Procedural motion presets are starting points.\n\n部件 / bone IDs:\n" +
          project.parts.map((p) => `${p.name}: ${p.id}`).join("\n"),
      ),
    },
  ];
  for (const part of project.parts)
    files.push({ name: `images/${part.id}.png`, data: pngBytes(part.image) });
  if (project.layerImport && project.parts.some((p) => p.layerSource)) {
    const layers = project.parts
      .filter((p) => p.layerSource)
      .map((p) => {
        const { originalImage, ...entry } = p.layerSource!;
        files.push({
          name: `sources/${p.id}.png`,
          data: pngBytes(originalImage),
        });
        return { ...entry, filename: `${p.id}.png` };
      });
    files.push({
      name: "sources/layers.json",
      data: encoder.encode(
        JSON.stringify(
          {
            width: project.layerImport.canvasWidth,
            height: project.layerImport.canvasHeight,
            layers,
          },
          null,
          2,
        ),
      ),
    });
  }
  for (const page of pages) {
    const canvas = document.createElement("canvas");
    canvas.width = page.width;
    canvas.height = page.height;
    const ctx = canvas.getContext("2d")!;
    for (const r of page.regions) {
      const source = project.parts.find((p) => p.id === r.id)!,
        image = await loadSpineImage(source.image);
      ctx.drawImage(image, r.x, r.y);
      // Extrude edge texels into the padding to avoid linear-filter seams.
      ctx.drawImage(image, 0, 0, 1, r.height, r.x - 1, r.y, 1, r.height);
      ctx.drawImage(
        image,
        r.width - 1,
        0,
        1,
        r.height,
        r.x + r.width,
        r.y,
        1,
        r.height,
      );
      ctx.drawImage(image, 0, 0, r.width, 1, r.x, r.y - 1, r.width, 1);
      ctx.drawImage(
        image,
        0,
        r.height - 1,
        r.width,
        1,
        r.x,
        r.y + r.height,
        r.width,
        1,
      );
    }
    files.push({
      name: page.name,
      data: pngBytes(canvas.toDataURL("image/png")),
    });
  }
  return createSpineZip(files);
}
export function createSpineDemo(): SpineProject {
  const project = newSpineProject("Orbit · 机器人");
  const parts = (
    ["leg-left", "leg-right", "arm-left", "arm-right", "body", "head"] as const
  ).map((role) => {
    const canvas = document.createElement("canvas");
    canvas.width = role === "head" ? 200 : role === "body" ? 180 : 70;
    canvas.height = role === "head" ? 175 : 240;
    const c = canvas.getContext("2d")!,
      w = canvas.width,
      h = canvas.height;
    c.fillStyle = role === "head" || role === "body" ? "#f8ae57" : "#73c5bc";
    c.strokeStyle = "#28364c";
    c.lineWidth = 6;
    c.beginPath();
    c.roundRect(5, 5, w - 10, h - 10, role === "head" ? 48 : 28);
    c.fill();
    c.stroke();
    c.fillStyle = "#28364c";
    if (role === "head") {
      c.beginPath();
      c.roundRect(22, 40, w - 44, 87, 30);
      c.fill();
      c.fillStyle = "#acf5e3";
      c.beginPath();
      c.arc(65, 80, 11, 0, Math.PI * 2);
      c.arc(135, 80, 11, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "#acf5e3";
      c.beginPath();
      c.arc(100, 90, 15, 0.2, Math.PI - 0.2);
      c.stroke();
    } else if (role === "body") {
      c.beginPath();
      c.roundRect(28, 55, w - 56, 120, 22);
      c.fill();
      c.fillStyle = "#73c5bc";
      c.beginPath();
      c.arc(w / 2, 110, 27, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#f8ae57";
      c.fillRect(48, 163, 24, 6);
      c.fillRect(85, 163, 47, 6);
    } else {
      c.beginPath();
      c.arc(w / 2, 36, 13, 0, Math.PI * 2);
      c.fill();
      c.fillRect(17, h - 42, w - 34, 6);
    }
    return createSpinePart(role, canvas.toDataURL("image/png"), w, h, role);
  });
  const next = addSpineParts(project, parts);
  next.clips = [
    generateSpineClip(next.parts, "idle"),
    generateSpineClip(next.parts, "wave"),
    generateSpineClip(next.parts, "walk"),
  ];
  return next;
}
