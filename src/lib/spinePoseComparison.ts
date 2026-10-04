import { spinePartMesh, spineWorldPose, spineWorldVertices, type SpineClip, type SpinePart, type SpinePoseTarget } from "./spine";
import { loadSpineImage } from "./spineAssets";
import { matteSpineSolidBackground } from "./spineMatting";
import { SpineRenderer } from "./spineRenderer";

const SIZE = 256;

export interface SpinePoseComparison {
  target: string;
  rig: string;
  overlap: number;
}

function foregroundBounds(pixels: Uint8ClampedArray, width: number, height: number) {
  let left = width, top = height, right = -1, bottom = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] < 96) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y); count++;
  }
  if (count < Math.max(4, width * height * 0.005) || count > width * height * 0.96)
    throw new Error("Foreground silhouette is not separable from the background.");
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function normalizedForeground(pixels: Uint8ClampedArray, width: number, height: number) {
  const bounds = foregroundBounds(pixels, width, height);
  const source = document.createElement("canvas");
  source.width = width; source.height = height;
  source.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE; canvas.height = SIZE;
  const scale = Math.min(SIZE * 0.86 / bounds.width, SIZE * 0.86 / bounds.height);
  const drawWidth = bounds.width * scale, drawHeight = bounds.height * scale;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, bounds.left, bounds.top, bounds.width, bounds.height,
    (SIZE - drawWidth) / 2, (SIZE - drawHeight) / 2, drawWidth, drawHeight);
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

export function spinePosePixelsImage(pixels: Uint8ClampedArray): string {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE; canvas.height = SIZE;
  canvas.getContext("2d")!.putImageData(new ImageData(pixels, SIZE, SIZE), 0, 0);
  return canvas.toDataURL("image/png");
}

export async function spinePoseTargetPixels(source: string) {
  const image = await loadSpineImage(source);
  const scale = Math.min(1, SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  let pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let transparent = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 224) transparent++;
  if (transparent < canvas.width * canvas.height * 0.005)
    pixels = matteSpineSolidBackground(pixels, canvas.width, canvas.height, 32).pixels;
  return normalizedForeground(pixels, canvas.width, canvas.height);
}

/** Reuse textures and one GL context across local fitting evaluations. Call dispose in finally. */
export async function createSpinePoseRenderSession(parts: SpinePart[]) {
  if (!parts.length) throw new Error("No parts to render.");
  const images = await Promise.all(parts.map((part) => loadSpineImage(part.image)));
  const meshes = parts.map(spinePartMesh);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE; canvas.height = SIZE;
  const renderer = new SpineRenderer(canvas);
  return {
    render(targets: Record<string, SpinePoseTarget>) {
      const clip: SpineClip = { id: "comparison", name: "Comparison", duration: 1,
        tracks: Object.fromEntries(parts.map((part) => [part.id, [{
          rotation: targets[part.id]?.rotation ?? 0, bend: targets[part.id]?.bend ?? 0,
          x: targets[part.id]?.x ?? 0, y: targets[part.id]?.y ?? 0, time: 0, curve: "linear" as const,
        }]])) };
      const pose = spineWorldPose(parts, clip);
      const geometry = parts.map((part, index) => {
        const mesh = meshes[index];
        return { part, mesh, vertices: spineWorldVertices(part, pose, mesh) };
      });
      const coordinates = geometry.flatMap(({ vertices }) => vertices);
      const xs = coordinates.filter((_, index) => index % 2 === 0);
      const ys = coordinates.filter((_, index) => index % 2 === 1);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const scale = Math.min(SIZE * 0.9 / Math.max(1, maxX - minX), SIZE * 0.9 / Math.max(1, maxY - minY));
      const cx = SIZE / 2 - (minX + maxX) * scale / 2;
      const cy = SIZE / 2 + (minY + maxY) * scale / 2;
      renderer.begin(SIZE, SIZE, scale, cx, cy, parts.map((part) => part.id));
      for (let i = 0; i < geometry.length; i++) {
        const { part, mesh, vertices } = geometry[i];
        renderer.draw(part.id, images[i], vertices, mesh.uvs, mesh.triangles);
      }
      return normalizedForeground(renderer.readPixels(SIZE, SIZE), SIZE, SIZE);
    },
    dispose() {
      renderer.dispose();
      canvas.getContext("webgl")?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

export async function renderSpinePoseImage(parts: SpinePart[], targets: Record<string, SpinePoseTarget>) {
  const session = await createSpinePoseRenderSession(parts);
  try {
    const pixels = session.render(targets);
    return { image: spinePosePixelsImage(pixels), pixels };
  } finally { session.dispose(); }
}

export function measureSpinePose(target: Uint8ClampedArray, rig: Uint8ClampedArray) {
  let intersection = 0, union = 0, colorDifference = 0;
  for (let i = 3; i < target.length; i += 4) {
    const a = target[i] >= 96, b = rig[i] >= 96;
    if (a && b) {
      intersection++;
      for (let c = 1; c <= 3; c++) colorDifference += Math.abs(target[i - c] - rig[i - c]);
    }
    if (a || b) union++;
  }
  const overlap = union ? intersection / union : 0;
  const colorError = intersection ? colorDifference / (intersection * 765) : 1;
  return { overlap, colorError, loss: 0.75 * (1 - overlap) + 0.25 * colorError };
}

export async function compareSpinePose(parts: SpinePart[], targets: Record<string, SpinePoseTarget>, targetImage: string): Promise<SpinePoseComparison> {
  const [target, rig] = await Promise.all([spinePoseTargetPixels(targetImage), renderSpinePoseImage(parts, targets)]);
  return { target: spinePosePixelsImage(target), rig: rig.image, overlap: measureSpinePose(target, rig.pixels).overlap };
}
