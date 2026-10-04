import { loadSpineImage } from "./spineAssets";
import { spinePartMesh, spineWorldPose, spineWorldVertices, type SpineClip, type SpinePart } from "./spine";
import { SpineRenderer } from "./spineRenderer";

export interface SpineAssistantImage {
  name: string;
  image: string;
  description: string;
}

/** Keep endpoints and the requested timeline instant; cover actual keys before filling gaps. */
export function spineMotionSampleTimes(clip: SpineClip, focusTime = 0): number[] {
  const limit = 9;
  const clamp = (time: number) => Math.max(0, Math.min(clip.duration, time));
  const selected = new Set([0, clip.duration, clamp(Number.isFinite(focusTime) ? focusTime : 0)]);
  const addSpread = (candidates: number[]) => {
    const remaining = [...new Set(candidates.filter(Number.isFinite).map(clamp))].sort((a, b) => a - b);
    while (selected.size < limit) {
      let best: number | undefined, distance = 1e-7;
      for (const time of remaining) {
        const nearest = Math.min(...[...selected].map((other) => Math.abs(other - time)));
        if (nearest > distance) { best = time; distance = nearest; }
      }
      if (best === undefined) break;
      selected.add(best);
    }
  };
  addSpread(Object.values(clip.tracks).flatMap((keys) => keys.map((key) => key.time)));
  addSpread(Array.from({ length: 17 }, (_, index) => clip.duration * index / 16));
  return [...selected].sort((a, b) => a - b);
}

/** Fixed camera across the sampled animation: never recenter individual poses. */
export async function createSpineMotionImage(parts: SpinePart[], clip: SpineClip, focusTime = 0): Promise<SpineAssistantImage> {
  if (!parts.length) throw new Error("No parts to render.");
  const times = spineMotionSampleTimes(clip, focusTime);
  const images = await Promise.all(parts.map((part) => loadSpineImage(part.image)));
  const meshes = parts.map(spinePartMesh);
  const frames = times.map((time) => {
    const pose = spineWorldPose(parts, clip, time);
    return parts.map((part, index) => spineWorldVertices(part, pose, meshes[index]));
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const geometry of frames) for (const vertices of geometry) for (let i = 0; i < vertices.length; i += 2) {
    minX = Math.min(minX, vertices[i]); maxX = Math.max(maxX, vertices[i]);
    minY = Math.min(minY, vertices[i + 1]); maxY = Math.max(maxY, vertices[i + 1]);
  }
  const width = 400, height = 400, labelHeight = 32, heading = 52, padding = 20;
  const scale = Math.min((width - padding * 2) / Math.max(1, maxX - minX), (height - padding * 2) / Math.max(1, maxY - minY));
  const cx = width / 2 - (minX + maxX) * scale / 2;
  const cy = height / 2 + (minY + maxY) * scale / 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * 3; canvas.height = heading + (height + labelHeight) * Math.ceil(times.length / 3);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#edf1f5"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "bold 18px sans-serif"; ctx.fillStyle = "#142b43";
  ctx.fillText(`ANIMATION: ${clip.name}`, 12, 22, canvas.width - 24);
  ctx.font = "14px sans-serif";
  ctx.fillText("Sampled moments in chronological order | Fixed camera | Not full playback", 12, 43);
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = width; frameCanvas.height = height;
  const renderer = new SpineRenderer(frameCanvas);
  try {
    for (let index = 0; index < frames.length; index++) {
      renderer.begin(width, height, scale, cx, cy, parts.map((part) => part.id));
      for (let p = 0; p < parts.length; p++)
        renderer.draw(parts[p].id, images[p], frames[index][p], meshes[p].uvs, meshes[p].triangles);
      // Copy immediately, before the WebGL drawing buffer can be cleared by the browser.
      const x = index % 3 * width, y = heading + Math.floor(index / 3) * (height + labelHeight);
      ctx.drawImage(frameCanvas, x, y + labelHeight);
      ctx.strokeStyle = "#b9c8d8"; ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height + labelHeight - 1);
      ctx.fillStyle = "#142b43"; ctx.font = "bold 16px sans-serif";
      const time = times[index], label = Number(time.toFixed(6));
      ctx.fillText(`#${index + 1}  ${label}s${time === 0 ? " START" : time === clip.duration ? " END" : ""}${Math.abs(time - focusTime) < 1e-7 ? " / FOCUS" : ""}`, x + 12, y + 23);
    }
    return { name: "spine-current-motion.png", image: canvas.toDataURL("image/png"),
      description: `ACTUAL SAMPLED ANIMATION: clip ${JSON.stringify(clip.name)}, id=${clip.id}, duration=${clip.duration}s. ${times.length} frames in chronological order, left-to-right then top-to-bottom: ${times.map((time, index) => `#${index + 1}=${time}s`).join("; ")}. Focus time at request=${Math.max(0, Math.min(clip.duration, focusTime))}s. Every frame uses the SAME camera and scale; translations and relative sizes remain visible. Production weighted-mesh rendering and current back-to-front drawing order; no pivot overlays. Per-tile picture is ${width}x${height}px below its ${labelHeight}px label. Picture pixel mapping: px=${cx}+worldX*${scale}; py=${cy}-worldY*${scale}. Gray is review background, not texture. Both 0 and exact duration are sampled without loop wrapping. Compare first/last for closure and middle poses for joints/occlusion. These are sparse samples, NOT video; do not claim unsampled continuity, seamless velocity or full playback inspection.` };
  } finally { renderer.dispose(); }
}

/** Fresh visual evidence of the setup pose, independent of viewport zoom or playback. */
export async function createSpineAssistantImages(parts: SpinePart[]): Promise<SpineAssistantImage[]> {
  if (!parts.length) return [];
  const panelWidth = 640, panelHeight = 720, titleHeight = 40, padding = 32;
  const minX = Math.min(...parts.map((p) => p.x - p.width * p.pivotX));
  const maxX = Math.max(...parts.map((p) => p.x + p.width * (1 - p.pivotX)));
  const minY = Math.min(...parts.map((p) => p.y - p.height * (1 - p.pivotY)));
  const maxY = Math.max(...parts.map((p) => p.y + p.height * p.pivotY));
  const scale = Math.min((panelWidth - padding * 2) / (maxX - minX), (panelHeight - titleHeight - padding * 2) / (maxY - minY));
  const cx = panelWidth / 2 - (minX + maxX) * scale / 2;
  const cy = titleHeight + (panelHeight - titleHeight) / 2 + (minY + maxY) * scale / 2;
  const createCanvas = (width: number, height: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#edf1f5"; ctx.fillRect(0, 0, width, height);
    ctx.font = "bold 18px sans-serif"; ctx.fillStyle = "#142b43";
    return { canvas, ctx };
  };
  const { canvas, ctx } = createCanvas(panelWidth * 2, panelHeight);
  ctx.fillText("SETUP ASSEMBLY", 16, 26);
  ctx.fillText("SAME POSE + PIVOTS / PARENTS", panelWidth + 16, 26);
  const contacts: SpineAssistantImage[] = [];
  const tileWidth = 224, tileHeight = 256, perPage = 8;
  for (let start = 0; start < parts.length; start += perPage) {
    const pageParts = parts.slice(start, start + perPage);
    const sheet = createCanvas(tileWidth * 4, tileHeight * Math.ceil(pageParts.length / 4));
    for (let offset = 0; offset < pageParts.length; offset++) {
      const part = pageParts[offset], index = start + offset;
      const image = await loadSpineImage(part.image);
      const left = cx + (part.x - part.width * part.pivotX) * scale;
      const top = cy - (part.y + part.height * part.pivotY) * scale;
      for (const shift of [0, panelWidth]) ctx.drawImage(image, left + shift, top, part.width * scale, part.height * scale);
      const x = offset % 4 * tileWidth, y = Math.floor(offset / 4) * tileHeight;
      sheet.ctx.fillStyle = "#142b43";
      sheet.ctx.fillText(`#${index + 1}`, x + 10, y + 24);
      const imageScale = Math.min((tileWidth - 24) / image.naturalWidth, (tileHeight - 56) / image.naturalHeight);
      const width = image.naturalWidth * imageScale, height = image.naturalHeight * imageScale;
      const imageX = x + (tileWidth - width) / 2, imageY = y + 40 + (tileHeight - 56 - height) / 2;
      sheet.ctx.drawImage(image, imageX, imageY, width, height);
      markPivot(sheet.ctx, imageX + part.pivotX * width, imageY + part.pivotY * height);
    }
    contacts.push({ name: `spine-parts-${start / perPage + 1}.png`, image: sheet.canvas.toDataURL("image/png"),
      description: `Individual current textures, natural aspect ratio, # labels match the part list. Orange cross = pivot. ${pageParts.map((part, i) => `#${start + i + 1}=${part.id} (${part.name})`).join("; ")}` });
  }
  // Paint annotations only after every texture so foreground images cannot hide them.
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index], x = cx + part.x * scale + panelWidth, y = cy - part.y * scale;
    const parent = parts.find((p) => p.id === part.parent);
    if (parent) {
      ctx.strokeStyle = "#1257a6"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cx + parent.x * scale + panelWidth, cy - parent.y * scale); ctx.stroke(); ctx.setLineDash([]);
    }
    markPivot(ctx, x, y);
    const label = `#${index + 1}`;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(x + 8, y - 22, ctx.measureText(label).width + 8, 24);
    ctx.fillStyle = "#142b43"; ctx.fillText(label, x + 12, y - 4);
  }
  return [{ name: "spine-setup-assembly.png", image: canvas.toDataURL("image/png"),
    description: `CURRENT SETUP POSE, not an animation frame. Left half: actual assembly in back-to-front order; right half: identical assembly with numbered pivots and dashed parent connections. Each half is ${panelWidth}x${panelHeight}px. Pixel mapping in LEFT half: px=${cx}+worldX*${scale}; py=${cy}-worldY*${scale}. Right half adds ${panelWidth}px to px. Plain gray is the review background, not part of a texture. Compare with source for gaps, overlaps and proportions. Part # numbers are one-based positions in Parts back-to-front.` }, ...contacts];
}

function markPivot(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke();
  ctx.strokeStyle = "#c65300"; ctx.lineWidth = 2; ctx.stroke();
}

export function spineAssistantImageFile(image: Pick<SpineAssistantImage, "name" | "image">): File {
  const bytes = Uint8Array.from(atob(image.image.split(",")[1]), (char) => char.charCodeAt(0));
  return new File([bytes], image.name, { type: "image/png" });
}
