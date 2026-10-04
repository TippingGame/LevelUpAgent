import { loadSpineImage } from "./spineAssets";
import {
  parseSpineLayerManifest,
  proposeSpineLayerRoles,
  type PreparedSpineLayers,
} from "./spineLayers";

export async function prepareSpineLayers(
  manifestValue: unknown,
  sourceName: string,
  readImage: (filename: string) => Promise<string>,
): Promise<PreparedSpineLayers> {
  const manifest = parseSpineLayerManifest(manifestValue),
    proposals = proposeSpineLayerRoles(manifest);
  const layers: PreparedSpineLayers["layers"] = [];
  let total = 0;
  for (const [index, entry] of manifest.layers.entries()) {
    const originalImage = await readImage(entry.filename);
    if (
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(originalImage) ||
      originalImage.length > 24 * 1024 * 1024
    )
      throw new Error(
        `PNG 超过 16 MiB 或格式不正确 / Invalid PNG: ${entry.filename}`,
      );
    total += originalImage.length;
    if (total > 64 * 1024 * 1024)
      throw new Error("图层包超过 64 MiB / Layer package exceeds 64 MiB");
    const w = entry.right - entry.left,
      h = entry.bottom - entry.top;
    // Check dimensions before asking the browser to allocate decoded pixel storage.
    const header = Uint8Array.from(atob(originalImage.slice(22, 66)), (c) =>
      c.charCodeAt(0),
    );
    const view = new DataView(header.buffer);
    if (
      header.length < 24 ||
      view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(12) !== 0x49484452 ||
      view.getUint32(16) !== w ||
      view.getUint32(20) !== h
    )
      throw new Error(
        `PNG 尺寸与边界不匹配或头部损坏 / Invalid PNG dimensions or header: ${entry.filename}`,
      );
    const image = await loadSpineImage(originalImage);
    if (image.naturalWidth !== w || image.naturalHeight !== h)
      throw new Error(
        `PNG 尺寸与边界不匹配 / PNG dimensions do not match bounds: ${entry.filename} (${image.naturalWidth}×${image.naturalHeight}, expected ${w}×${h})`,
      );
    const scale = Math.min(1, 1024 / Math.max(w, h)),
      canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 8) opaque++;
    layers.push({
      entry,
      originalImage,
      image: scale === 1 ? originalImage : canvas.toDataURL("image/png"),
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      included: opaque > 0,
      ...proposals[index],
      ...(opaque === 0
        ? { warning: "全透明 / Empty layer" }
        : opaque === canvas.width * canvas.height
          ? { warning: "整层不透明，请检查背景 / Fully opaque layer" }
          : {}),
    });
  }
  // Empty layers are omitted; children fall back to root instead of referencing an omitted parent.
  for (const layer of layers)
    if (layer.parentIndex !== null && !layers[layer.parentIndex].included)
      layer.parentIndex = null;
  return { sourceName: sourceName.slice(0, 160), manifest, layers };
}
export async function prepareSpineLayerFiles(
  files: File[],
): Promise<PreparedSpineLayers> {
  const manifests = files.filter((f) => /\.json$/i.test(f.name));
  if (manifests.length !== 1 || manifests[0].size > 1024 * 1024)
    throw new Error(
      "请选择一份图层 JSON 清单及其 PNG（清单不超过 1 MiB） / Select one layer manifest and its PNG files",
    );
  const map = new Map<string, File>();
  for (const file of files.filter((f) => /\.png$/i.test(f.name))) {
    const path = file.webkitRelativePath || file.name;
    if (map.has(path.toLowerCase()))
      throw new Error(`重复文件 / Duplicate file: ${path}`);
    map.set(path.toLowerCase(), file);
  }
  return prepareSpineLayers(
    JSON.parse(await manifests[0].text()),
    manifests[0].name,
    async (name) => {
      const file = map.get(name.toLowerCase());
      if (!file || file.size > 16 * 1024 * 1024)
        throw new Error(`缺失或过大的 PNG / Missing or oversized PNG: ${name}`);
      const bytes = new Uint8Array(await file.arrayBuffer()),
        chunks: string[] = [];
      for (let i = 0; i < bytes.length; i += 0x8000)
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
      return `data:image/png;base64,${btoa(chunks.join(""))}`;
    },
  );
}
