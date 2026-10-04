import {
  createSpinePart,
  newSpineProject,
  orderedSpineParts,
  SPINE_LIMITS,
  validateSpineProject,
  type SpinePart,
  type SpineProject,
} from "./spine";

export interface SpineLayerEntry {
  name: string;
  filename: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  depth_median?: number;
}
export interface SpineLayerManifest {
  width: number;
  height: number;
  layers: SpineLayerEntry[];
}
export interface PreparedSpineLayer {
  entry: SpineLayerEntry;
  originalImage: string;
  image: string;
  imageWidth: number;
  imageHeight: number;
  included: boolean;
  role: SpinePart["role"];
  parentIndex: number | null;
  pivotX: number;
  pivotY: number;
  warning?: string;
}
export interface PreparedSpineLayers {
  sourceName: string;
  manifest: SpineLayerManifest;
  layers: PreparedSpineLayer[];
}
export function safeLayerFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !/[\\:\x00-\x1f]/.test(value) &&
    !value.startsWith("/") &&
    value.split("/").every((p) => p !== ".." && p !== "." && p !== "") &&
    /\.png$/i.test(value)
  );
}
export function parseSpineLayerManifest(value: unknown): SpineLayerManifest {
  const fail = (message: string): never => {
    throw new Error(`图层清单 / Layer manifest: ${message}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("expected width, height and layers");
  const m = value as Record<string, unknown>;
  const integer = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v);
  if (
    !integer(m.width) ||
    !integer(m.height) ||
    m.width < 1 ||
    m.height < 1 ||
    m.width > 8192 ||
    m.height > 8192 ||
    m.width * m.height > 32 * 1024 * 1024
  )
    return fail("canvas exceeds 8192 px / 32 MP");
  if (!Array.isArray(m.layers) || m.layers.length < 1 || m.layers.length > 128)
    return fail("expected 1–128 layers");
  const filenames = new Set<string>();
  const layers = m.layers.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail(`layer ${index + 1}`);
    const l = value as Record<string, unknown>;
    if (
      typeof l.name !== "string" ||
      !l.name.trim() ||
      l.name.length > 160 ||
      !safeLayerFilename(l.filename) ||
      filenames.has(l.filename.toLowerCase())
    )
      return fail(`invalid/duplicate name or filename at ${index + 1}`);
    filenames.add(l.filename.toLowerCase());
    if (
      !integer(l.left) ||
      !integer(l.top) ||
      !integer(l.right) ||
      !integer(l.bottom) ||
      l.left < 0 ||
      l.top < 0 ||
      l.right <= l.left ||
      l.bottom <= l.top ||
      l.right > Number(m.width) ||
      l.bottom > Number(m.height)
    )
      return fail(`bounds outside canvas: ${l.name}`);
    if (
      l.depth_median !== undefined &&
      (typeof l.depth_median !== "number" || !Number.isFinite(l.depth_median))
    )
      return fail(`depth: ${l.name}`);
    return {
      name: l.name,
      filename: l.filename,
      left: l.left,
      top: l.top,
      right: l.right,
      bottom: l.bottom,
      ...(typeof l.depth_median === "number"
        ? { depth_median: l.depth_median }
        : {}),
    };
  });
  // The exporter already orders the layers back-to-front; sorting depth again can alter ties.
  return { width: m.width, height: m.height, layers };
}
export function proposeSpineLayerRoles(manifest: SpineLayerManifest) {
  const roles = manifest.layers.map((l): SpinePart["role"] => {
    const name = l.name.toLowerCase();
    const side = (l.left + l.right) / 2 < manifest.width / 2 ? "left" : "right";
    if (/^(body|torso|躯干|身体)$/.test(name)) return "body";
    if (/^(head|face|头|头部|脸)$/.test(name)) return "head";
    if (/(arm|手臂|胳膊)/.test(name)) return `arm-${side}`;
    if (/(leg|腿)/.test(name)) return `leg-${side}`;
    return "other";
  });
  const body = roles.indexOf("body"),
    head = roles.indexOf("head");
  return roles.map((role, i) => ({
    role,
    parentIndex:
      role === "body"
        ? null
        : role === "other" &&
            head >= 0 &&
            /hair|eye|brow|mouth|ear|nose|face|头发|眼|眉|嘴|耳/.test(
              manifest.layers[i].name.toLowerCase(),
            )
          ? head
          : body >= 0
            ? body
            : null,
    pivotX: 0.5,
    pivotY: role === "head" ? 0.88 : 0.08,
  }));
}
export function layerWorldPlacement(
  manifest: SpineLayerManifest,
  entry: SpineLayerEntry,
  pivotX: number,
  pivotY: number,
) {
  const scale = 480 / Math.max(manifest.width, manifest.height);
  return {
    x:
      (entry.left + (entry.right - entry.left) * pivotX - manifest.width / 2) *
      scale,
    y:
      (manifest.height - entry.top - (entry.bottom - entry.top) * pivotY) *
      scale,
    width: (entry.right - entry.left) * scale,
    height: (entry.bottom - entry.top) * scale,
  };
}
export function createSpineProjectFromLayers(
  prepared: PreparedSpineLayers,
  name: string,
): SpineProject {
  const selected = prepared.layers.filter((l) => l.included);
  if (!selected.length || selected.length > SPINE_LIMITS.parts)
    throw new Error(
      `请选择 1–${SPINE_LIMITS.parts} 个图层 / Select 1–${SPINE_LIMITS.parts} layers`,
    );
  const all = prepared.layers.map((l) => ({
    ...createSpinePart(
      l.entry.name,
      l.image,
      l.imageWidth,
      l.imageHeight,
      l.role,
    ),
    ...layerWorldPlacement(prepared.manifest, l.entry, l.pivotX, l.pivotY),
    pivotX: l.pivotX,
    pivotY: l.pivotY,
    layerSource: { ...l.entry, originalImage: l.originalImage },
  }));
  for (let i = 0; i < all.length; i++) {
    if (!prepared.layers[i].included) continue;
    const parent = prepared.layers[i].parentIndex;
    if (parent !== null) {
      if (
        !Number.isInteger(parent) ||
        parent < 0 ||
        parent >= all.length ||
        !prepared.layers[parent].included
      )
        throw new Error(
          `父图层未选中 / Parent layer is excluded: ${all[i].name}`,
        );
      all[i].parent = all[parent].id;
    }
  }
  const parts = all.filter((_, i) => prepared.layers[i].included);
  orderedSpineParts(parts);
  const project = {
    ...newSpineProject(name.trim() || prepared.sourceName),
    parts,
    layerImport: {
      sourceName: prepared.sourceName,
      canvasWidth: prepared.manifest.width,
      canvasHeight: prepared.manifest.height,
      worldScale:
        480 / Math.max(prepared.manifest.width, prepared.manifest.height),
      importedAt: Date.now(),
    },
  };
  return validateSpineProject(project);
}
