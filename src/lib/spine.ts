/** The editable subset authored by Spine Studio. Coordinates are Spine units, Y up. */
export interface SpineKey {
  time: number;
  rotation: number;
  bend: number;
  x: number;
  y: number;
  curve: "linear" | "stepped";
}
export interface SpinePart {
  id: string;
  name: string;
  parent: string | null;
  role:
    | "body"
    | "head"
    | "arm-left"
    | "arm-right"
    | "leg-left"
    | "leg-right"
    | "other";
  image: string;
  imageWidth: number;
  imageHeight: number;
  /** Setup pivot in world space; parent-local translations are derived at compilation. */
  x: number;
  y: number;
  width: number;
  height: number;
  pivotX: number;
  pivotY: number;
  flexibility: number;
  layerSource?: {
    name: string;
    filename: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
    depth_median?: number;
    originalImage: string;
  };
}
export interface SpineClip {
  id: string;
  name: string;
  duration: number;
  tracks: Record<string, SpineKey[]>;
}
export type SpinePoseTarget = Pick<SpineKey, "rotation" | "bend" | "x" | "y">;
export interface SpinePoseFrame {
  id: string;
  name: string;
  time: number;
  source: "upload" | "generated" | "capture" | "reference";
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  targets: Record<string, SpinePoseTarget>;
  fitError?: number;
  fitStatus?: "ready" | "review" | "applied";
  notes?: string;
}
export interface SpineMotionStudy {
  id: string;
  name: string;
  clipId: string;
  fps: 12 | 24 | 30;
  interpolation: "linear" | "stepped";
  frames: SpinePoseFrame[];
  createdAt: number;
  updatedAt: number;
}
export interface SpineProject {
  format: "levelup-spine";
  version: 1;
  id: string;
  name: string;
  updatedAt: number;
  parts: SpinePart[];
  clips: SpineClip[];
  prompt: string;
  motionStudies?: SpineMotionStudy[];
  layerImport?: {
    sourceName: string;
    canvasWidth: number;
    canvasHeight: number;
    worldScale: number;
    importedAt: number;
  };
}
export const SPINE_LIMITS = {
  parts: 24,
  clips: 16,
  keys: 300,
  imageSize: 1024,
  bytes: 48 * 1024 * 1024,
  motionStudies: 8,
  poseFrames: 64,
  poseImageBytes: 24 * 1024 * 1024,
};
export const SPINE_ROLES = [
  "body",
  "head",
  "arm-left",
  "arm-right",
  "leg-left",
  "leg-right",
  "other",
] as const;
export const ZERO_POSE: SpineKey = {
  time: 0,
  rotation: 0,
  bend: 0,
  x: 0,
  y: 0,
  curve: "linear",
};
const id = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
export function newSpineProject(name = "Untitled"): SpineProject {
  return {
    format: "levelup-spine",
    version: 1,
    id: id("project"),
    name,
    updatedAt: Date.now(),
    parts: [],
    clips: [],
    prompt: "",
    motionStudies: [],
  };
}
export function createSpinePart(
  name: string,
  image: string,
  imageWidth: number,
  imageHeight: number,
  role: SpinePart["role"] = "other",
): SpinePart {
  const placement: Record<SpinePart["role"], [number, number, number, number]> =
    {
      body: [0, 120, 125, 195],
      head: [0, 138, 135, 140],
      "arm-left": [-62, 118, 46, 175],
      "arm-right": [62, 118, 46, 175],
      "leg-left": [-34, -55, 54, 175],
      "leg-right": [34, -55, 54, 175],
      other: [0, 100, 150, 150],
    };
  const [x, y, width, height] = placement[role];
  return {
    id: id(role),
    name,
    parent: null,
    role,
    image,
    imageWidth,
    imageHeight,
    x,
    y,
    width:
      role === "other"
        ? (180 * imageWidth) / Math.max(imageWidth, imageHeight)
        : width,
    height:
      role === "other"
        ? (180 * imageHeight) / Math.max(imageWidth, imageHeight)
        : height,
    pivotX: 0.5,
    pivotY: role === "head" ? 0.88 : 0.08,
    flexibility: role.includes("arm") || role.includes("leg") ? 0.75 : 0,
  };
}
export function addSpineParts(
  project: SpineProject,
  incoming: SpinePart[],
): SpineProject {
  if (project.parts.length + incoming.length > SPINE_LIMITS.parts)
    throw new Error(`At most ${SPINE_LIMITS.parts} parts are supported.`);
  const body = [...project.parts, ...incoming].find((p) => p.role === "body");
  return {
    ...project,
    parts: [
      ...project.parts,
      ...incoming.map((p) => ({
        ...p,
        parent: p.parent ?? (body && p.id !== body.id ? body.id : null),
      })),
    ],
  };
}
export function orderedSpineParts(parts: SpinePart[]): SpinePart[] {
  const ordered: SpinePart[] = [],
    visiting = new Set<string>(),
    done = new Set<string>();
  const byId = new Map(parts.map((part) => [part.id, part]));
  const visit = (part: SpinePart) => {
    if (done.has(part.id)) return;
    if (visiting.has(part.id))
      throw new Error("Bone hierarchy contains a cycle.");
    visiting.add(part.id);
    if (part.parent) {
      const parent = byId.get(part.parent);
      if (!parent) throw new Error("Bone parent does not exist.");
      visit(parent);
    }
    visiting.delete(part.id);
    done.add(part.id);
    ordered.push(part);
  };
  parts.forEach(visit);
  return ordered;
}
export function validateSpineProject(value: unknown): SpineProject {
  const fail = (message: string): never => {
    throw new Error(`Invalid Spine project: ${message}`);
  };
  const obj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const num = (v: unknown, min: number, max: number): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const str = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 160;
  const safeId = (v: unknown): v is string =>
    str(v) &&
    /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) &&
    !["root", "__proto__", "constructor", "prototype"].includes(v);
  if (!obj(value) || value.format !== "levelup-spine" || value.version !== 1)
    return fail("unsupported format/version");
  if (
    !safeId(value.id) ||
    !str(value.name) ||
    !num(value.updatedAt, 0, Number.MAX_SAFE_INTEGER) ||
    typeof value.prompt !== "string" ||
    value.prompt.length > 10000
  )
    return fail("metadata");
  if (
    !Array.isArray(value.parts) ||
    value.parts.length > SPINE_LIMITS.parts ||
    !Array.isArray(value.clips) ||
    value.clips.length > SPINE_LIMITS.clips
  )
    return fail("part/clip limit");
  const ids = new Set<string>(),
    boneNames = new Set(["root"]);
  let bytes = 0;
  if (value.layerImport !== undefined) {
    const source = value.layerImport;
    if (
      !obj(source) ||
      !str(source.sourceName) ||
      !num(source.canvasWidth, 1, 8192) ||
      !num(source.canvasHeight, 1, 8192) ||
      !Number.isInteger(source.canvasWidth) ||
      !Number.isInteger(source.canvasHeight) ||
      source.canvasWidth * source.canvasHeight > 32 * 1024 * 1024 ||
      !num(source.worldScale, 0.001, 480) ||
      !num(source.importedAt, 0, Number.MAX_SAFE_INTEGER)
    )
      return fail("layer source canvas");
  }
  for (const p of value.parts) {
    if (
      !obj(p) ||
      !safeId(p.id) ||
      ids.has(p.id) ||
      !str(p.name) ||
      !(SPINE_ROLES as readonly unknown[]).includes(p.role)
    )
      return fail("part identity");
    for (const bone of [p.id, `${p.id}_bend`]) {
      if (boneNames.has(bone)) return fail("bone name collision");
      boneNames.add(bone);
    }
    ids.add(p.id);
    if (
      typeof p.image !== "string" ||
      p.image.length > 8 * 1024 * 1024 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image)
    )
      return fail("PNG image required");
    bytes += p.image.length;
    if (p.layerSource !== undefined) {
      const source = p.layerSource,
        canvas = value.layerImport;
      if (
        !obj(source) ||
        !obj(canvas) ||
        !str(source.name) ||
        typeof source.filename !== "string" ||
        source.filename.length > 240 ||
        !/\.png$/i.test(source.filename) ||
        /[\\:\x00-\x1f]/.test(source.filename) ||
        source.filename.split("/").some((s) => !s || s === "." || s === "..") ||
        typeof source.originalImage !== "string" ||
        source.originalImage.length > 24 * 1024 * 1024 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(
          source.originalImage,
        )
      )
        return fail("layer source image");
      for (const key of ["left", "top", "right", "bottom"])
        if (!num(source[key], 0, 8192) || !Number.isInteger(source[key]))
          return fail("layer source bounds");
      if (
        Number(source.left) >= Number(source.right) ||
        Number(source.top) >= Number(source.bottom) ||
        Number(source.right) > Number(canvas.canvasWidth) ||
        Number(source.bottom) > Number(canvas.canvasHeight)
      )
        return fail("layer source bounds");
      if (
        source.depth_median !== undefined &&
        (typeof source.depth_median !== "number" ||
          !Number.isFinite(source.depth_median))
      )
        return fail("layer source depth");
      bytes += source.originalImage.length;
    }
    for (const key of ["imageWidth", "imageHeight"])
      if (!num(p[key], 1, 1024) || !Number.isInteger(p[key]))
        return fail("image dimensions");
    for (const key of ["width", "height"])
      if (!num(p[key], 0.01, 2000)) return fail("part size");
    for (const key of ["x", "y"])
      if (!num(p[key], -4000, 4000)) return fail("part position");
    for (const key of ["pivotX", "pivotY", "flexibility"])
      if (!num(p[key], 0, 1)) return fail("pivot/weight");
    if (p.parent !== null && !safeId(p.parent)) return fail("parent identity");
  }
  if (bytes > SPINE_LIMITS.bytes) return fail("images exceed 48 MiB");
  orderedSpineParts(value.parts as unknown as SpinePart[]);
  const clipIds = new Set<string>(),
    names = new Set<string>();
  for (const c of value.clips) {
    if (
      !obj(c) ||
      !safeId(c.id) ||
      clipIds.has(c.id) ||
      !str(c.name) ||
      ["__proto__", "constructor", "prototype"].includes(c.name) ||
      names.has(c.name) ||
      !num(c.duration, 0.1, 30) ||
      !obj(c.tracks)
    )
      return fail("clip metadata");
    clipIds.add(c.id);
    names.add(c.name);
    for (const [partId, keys] of Object.entries(c.tracks)) {
      if (
        !ids.has(partId) ||
        !Array.isArray(keys) ||
        keys.length > SPINE_LIMITS.keys
      )
        return fail("animation track");
      let previous = -1;
      for (const k of keys) {
        if (
          !obj(k) ||
          !num(k.time, 0, c.duration) ||
          k.time <= previous ||
          !["linear", "stepped"].includes(k.curve as string)
        )
          return fail("key timing/curve");
        previous = k.time;
        for (const key of ["rotation", "bend"])
          if (!num(k[key], -360, 360)) return fail("key rotation");
        for (const key of ["x", "y"])
          if (!num(k[key], -1000, 1000)) return fail("key translation");
      }
    }
  }
  if (value.motionStudies !== undefined) {
    if (!Array.isArray(value.motionStudies) || value.motionStudies.length > SPINE_LIMITS.motionStudies)
      return fail("motion study limit");
    const studyIds = new Set<string>();
    for (const study of value.motionStudies) {
      if (
        !obj(study) ||
        !safeId(study.id) ||
        studyIds.has(study.id) ||
        !str(study.name) ||
        !str(study.clipId) ||
        !clipIds.has(study.clipId) ||
        ![12, 24, 30].includes(study.fps as number) ||
        !["linear", "stepped"].includes(study.interpolation as string) ||
        !num(study.createdAt, 0, Number.MAX_SAFE_INTEGER) ||
        !num(study.updatedAt, 0, Number.MAX_SAFE_INTEGER) ||
        !Array.isArray(study.frames) ||
        study.frames.length > SPINE_LIMITS.poseFrames
      )
        return fail("motion study metadata");
      studyIds.add(study.id);
      const frameIds = new Set<string>();
      let poseBytes = 0;
      const duration = value.clips.find((c) => c.id === study.clipId)!.duration;
      for (const frame of study.frames) {
        if (
          !obj(frame) ||
          !safeId(frame.id) ||
          frameIds.has(frame.id) ||
          !str(frame.name) ||
          !num(frame.time, 0, duration) ||
          !["upload", "generated", "capture", "reference"].includes(frame.source as string) ||
          !obj(frame.targets)
        )
          return fail("pose frame metadata");
        frameIds.add(frame.id);
        if (frame.image !== undefined) {
          if (
            typeof frame.image !== "string" ||
            frame.image.length > 8 * 1024 * 1024 ||
            !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.image)
          )
            return fail("pose image");
          poseBytes += frame.image.length;
          if (
            !num(frame.imageWidth, 1, 4096) ||
            !Number.isInteger(frame.imageWidth) ||
            !num(frame.imageHeight, 1, 4096) ||
            !Number.isInteger(frame.imageHeight)
          )
            return fail("pose image dimensions");
        }
        if (frame.fitError !== undefined && !num(frame.fitError, 0, 100000))
          return fail("pose fit error");
        if (frame.fitStatus !== undefined && (typeof frame.fitStatus !== "string" || !["ready", "review", "applied"].includes(frame.fitStatus)))
          return fail("pose fit status");
        if (frame.notes !== undefined && (typeof frame.notes !== "string" || frame.notes.length > 2000))
          return fail("pose notes");
        for (const [partId, target] of Object.entries(frame.targets)) {
          if (!ids.has(partId) || !obj(target)) return fail("pose target");
          for (const key of ["rotation", "bend"])
            if (!num(target[key], -360, 360)) return fail("pose target rotation");
          for (const key of ["x", "y"])
            if (!num(target[key], -1000, 1000)) return fail("pose target translation");
        }
      }
      if (poseBytes > SPINE_LIMITS.poseImageBytes) return fail("pose images exceed 24 MiB");
    }
  }
  return value as unknown as SpineProject;
}
export function sampleSpineKeys(keys: SpineKey[] = [], time: number): SpineKey {
  if (!keys.length || time < keys[0].time) return { ...ZERO_POSE, time };
  const next = keys.findIndex((key) => key.time > time);
  if (next === -1) return { ...keys[keys.length - 1], time };
  const a = keys[next - 1],
    b = keys[next];
  const t = a.curve === "stepped" ? 0 : (time - a.time) / (b.time - a.time);
  const mix = (key: "rotation" | "bend" | "x" | "y") =>
    a[key] + (b[key] - a[key]) * t;
  return {
    time,
    rotation: mix("rotation"),
    bend: mix("bend"),
    x: mix("x"),
    y: mix("y"),
    curve: a.curve,
  };
}
export function upsertSpineKey(
  clip: SpineClip,
  partId: string,
  key: SpineKey,
): SpineClip {
  const time = Math.min(
    clip.duration,
    Math.max(0, Math.round(key.time * 1000) / 1000),
  );
  const keys = (clip.tracks[partId] ?? []).filter(
    (k) => Math.abs(k.time - time) > 0.0005,
  );
  if (keys.length >= SPINE_LIMITS.keys)
    throw new Error("Keyframe limit reached.");
  keys.push({ ...key, time });
  keys.sort((a, b) => a.time - b.time);
  return { ...clip, tracks: { ...clip.tracks, [partId]: keys } };
}
export function generateSpineClip(
  parts: SpinePart[],
  preset: "idle" | "wave" | "walk",
  name = preset as string,
): SpineClip {
  const duration = preset === "walk" ? 1 : 2;
  const tracks: SpineClip["tracks"] = {};
  for (const part of parts) {
    tracks[part.id] = Array.from({ length: 17 }, (_, i) => {
      const phase = (i / 16) * Math.PI * 2;
      const wave = Math.sin(phase),
        opposite = part.role.endsWith("right") ? -1 : 1;
      const key = { ...ZERO_POSE, time: (i / 16) * duration };
      if (part.role === "body")
        key.y =
          (1 - Math.cos(phase * (preset === "walk" ? 2 : 1))) *
          (preset === "walk" ? 3 : 1.5);
      if (part.role === "head") key.rotation = wave * 2;
      if (part.role.startsWith("arm")) {
        key.rotation = wave * (preset === "walk" ? 20 : 3) * opposite;
        if (preset === "wave" && part.role === "arm-right") {
          key.rotation = 115 + wave * 12;
          key.bend = 12 + Math.sin(phase * 2) * 25;
        }
      }
      if (preset === "walk" && part.role.startsWith("leg")) {
        key.rotation = wave * 22 * opposite;
        key.bend = Math.max(0, wave * opposite) * 24;
      }
      return key;
    });
    tracks[part.id][16] = { ...tracks[part.id][0], time: duration };
  }
  return { id: id("clip"), name, duration, tracks };
}
export interface SpineMesh {
  uvs: number[];
  positions: number[];
  weights: number[];
  triangles: number[];
  hull: number;
}
export function spinePartMesh(part: SpinePart): SpineMesh {
  const n = 4,
    points: [number, number][] = [];
  // Spine's hull vertices must precede interior vertices.
  for (let x = 0; x < n; x++) points.push([x, 0]);
  for (let y = 0; y < n; y++) points.push([n, y]);
  for (let x = n; x > 0; x--) points.push([x, n]);
  for (let y = n; y > 0; y--) points.push([0, y]);
  for (let y = 1; y < n; y++) for (let x = 1; x < n; x++) points.push([x, y]);
  const lookup = new Map(points.map(([x, y], i) => [`${x},${y}`, i]));
  const triangles: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = lookup.get(`${x},${y}`)!,
        b = lookup.get(`${x + 1},${y}`)!,
        c = lookup.get(`${x},${y + 1}`)!,
        d = lookup.get(`${x + 1},${y + 1}`)!;
      triangles.push(a, c, b, b, c, d);
    }
  return {
    uvs: points.flatMap(([x, y]) => [x / n, y / n]),
    positions: points.flatMap(([x, y]) => [
      (x / n - part.pivotX) * part.width,
      (part.pivotY - y / n) * part.height,
    ]),
    weights: points.map(
      ([, y]) =>
        part.flexibility *
        Math.max(0, (y / n - part.pivotY) / Math.max(0.01, 1 - part.pivotY)) **
          2,
    ),
    triangles,
    hull: n * 4,
  };
}
export type SpineTransform = { x: number; y: number; rotation: number };
export function transformSpinePoint(
  t: SpineTransform,
  x: number,
  y: number,
): [number, number] {
  const rad = (t.rotation * Math.PI) / 180,
    cos = Math.cos(rad),
    sin = Math.sin(rad);
  return [t.x + cos * x - sin * y, t.y + sin * x + cos * y];
}
export function spineWorldPose(parts: SpinePart[], clip?: SpineClip, time = 0) {
  const transforms = new Map<string, SpineTransform>();
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const p of orderedSpineParts(parts)) {
    const key = sampleSpineKeys(clip?.tracks[p.id], time);
    const parent = p.parent ? byId.get(p.parent)! : undefined;
    const parentTransform = p.parent
      ? transforms.get(p.parent)!
      : { x: 0, y: 0, rotation: 0 };
    const [x, y] = transformSpinePoint(
      parentTransform,
      p.x - (parent?.x ?? 0) + key.x,
      p.y - (parent?.y ?? 0) + key.y,
    );
    const base = { x, y, rotation: parentTransform.rotation + key.rotation };
    transforms.set(p.id, base);
    const [bx, by] = transformSpinePoint(base, 0, -p.height * 0.45);
    transforms.set(`${p.id}_bend`, {
      x: bx,
      y: by,
      rotation: base.rotation + key.bend,
    });
  }
  return transforms;
}
export function spineWorldVertices(
  part: SpinePart,
  pose: Map<string, SpineTransform>,
  mesh = spinePartMesh(part),
): number[] {
  return mesh.weights.flatMap((weight, i) => {
    const x = mesh.positions[i * 2],
      y = mesh.positions[i * 2 + 1];
    const a = transformSpinePoint(pose.get(part.id)!, x, y);
    const b = transformSpinePoint(
      pose.get(`${part.id}_bend`)!,
      x,
      y + part.height * 0.45,
    );
    return [
      a[0] * (1 - weight) + b[0] * weight,
      a[1] * (1 - weight) + b[1] * weight,
    ];
  });
}
/** Emit actual weighted meshes and bone timelines, using the Spine 4.2 JSON schema. */
export function compileSpineProject(project: SpineProject) {
  validateSpineProject(project);
  if (!project.parts.length)
    throw new Error("Add at least one part before exporting.");
  const bones: {
    name: string;
    parent?: string;
    x?: number;
    y?: number;
    length?: number;
  }[] = [{ name: "root" }];
  const indices = new Map<string, number>();
  for (const part of orderedSpineParts(project.parts)) {
    const parent = project.parts.find((p) => p.id === part.parent);
    indices.set(part.id, bones.length);
    bones.push({
      name: part.id,
      parent: part.parent ?? "root",
      x: part.x - (parent?.x ?? 0),
      y: part.y - (parent?.y ?? 0),
      length: part.height * 0.45,
    });
    bones.push({
      name: `${part.id}_bend`,
      parent: part.id,
      y: -part.height * 0.45,
      length: part.height * 0.45,
    });
  }
  const attachments: Record<string, unknown> = {};
  for (const part of project.parts) {
    const mesh = spinePartMesh(part),
      base = indices.get(part.id)!;
    const vertices = mesh.weights.flatMap((weight, i) => {
      const x = mesh.positions[2 * i],
        y = mesh.positions[2 * i + 1];
      return weight === 0
        ? [1, base, x, y, 1]
        : [
            2,
            base,
            x,
            y,
            1 - weight,
            base + 1,
            x,
            y + part.height * 0.45,
            weight,
          ];
    });
    attachments[part.id] = {
      [part.id]: {
        type: "mesh",
        path: part.id,
        uvs: mesh.uvs,
        triangles: mesh.triangles,
        vertices,
        hull: mesh.hull,
        width: part.imageWidth,
        height: part.imageHeight,
      },
    };
  }
  const animations: Record<string, unknown> = {};
  for (const clip of project.clips) {
    const timelines: Record<string, unknown> = {
      root: { rotate: [{ time: clip.duration, value: 0 }] },
    };
    for (const [partId, keys] of Object.entries(clip.tracks)) {
      if (!keys.length) continue;
      const curve = (k: SpineKey) =>
        k.curve === "stepped" ? { curve: "stepped" } : {};
      timelines[partId] = {
        rotate: keys.map((k) => ({
          time: k.time,
          value: k.rotation,
          ...curve(k),
        })),
        translate: keys.map((k) => ({
          time: k.time,
          x: k.x,
          y: k.y,
          ...curve(k),
        })),
      };
      timelines[`${partId}_bend`] = {
        rotate: keys.map((k) => ({ time: k.time, value: k.bend, ...curve(k) })),
      };
    }
    animations[clip.name] = { bones: timelines };
  }
  const minX = Math.min(...project.parts.map((p) => p.x - p.width * p.pivotX));
  const minY = Math.min(
    ...project.parts.map((p) => p.y - p.height * (1 - p.pivotY)),
  );
  const maxX = Math.max(
    ...project.parts.map((p) => p.x + p.width * (1 - p.pivotX)),
  );
  const maxY = Math.max(...project.parts.map((p) => p.y + p.height * p.pivotY));
  return {
    skeleton: {
      spine: "4.2.00",
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      fps: 30,
      images: "./images/",
      audio: "",
      name: project.name,
    },
    bones,
    slots: project.parts.map((p) => ({
      name: p.id,
      bone: p.id,
      attachment: p.id,
    })),
    skins: [{ name: "default", attachments }],
    animations,
  };
}
export interface AtlasRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface AtlasPage {
  name: string;
  width: number;
  height: number;
  regions: AtlasRegion[];
}
export function packSpineAtlas(parts: SpinePart[]): AtlasPage[] {
  const pages: AtlasPage[] = [];
  let page: AtlasPage = {
      name: "atlas-1.png",
      width: 2048,
      height: 2048,
      regions: [],
    },
    x = 2,
    y = 2,
    row = 0;
  for (const p of parts) {
    if (x + p.imageWidth + 2 > 2048) {
      x = 2;
      y += row + 4;
      row = 0;
    }
    if (y + p.imageHeight + 2 > 2048) {
      pages.push(page);
      page = {
        name: `atlas-${pages.length + 1}.png`,
        width: 2048,
        height: 2048,
        regions: [],
      };
      x = 2;
      y = 2;
      row = 0;
    }
    page.regions.push({
      id: p.id,
      x,
      y,
      width: p.imageWidth,
      height: p.imageHeight,
    });
    x += p.imageWidth + 4;
    row = Math.max(row, p.imageHeight);
  }
  if (page.regions.length) pages.push(page);
  return pages.map((p) => ({
    ...p,
    width: Math.max(...p.regions.map((r) => r.x + r.width + 2)),
    height: Math.max(...p.regions.map((r) => r.y + r.height + 2)),
  }));
}
export function spineAtlasText(pages: AtlasPage[]): string {
  return pages
    .map(
      (p) =>
        `${p.name}\nsize: ${p.width}, ${p.height}\nformat: RGBA8888\nfilter: Linear, Linear\nrepeat: none\npma: false\n${p.regions.map((r) => `${r.id}\n  rotate: false\n  xy: ${r.x}, ${r.y}\n  size: ${r.width}, ${r.height}\n  orig: ${r.width}, ${r.height}\n  offset: 0, 0\n  index: -1`).join("\n")}\n`,
    )
    .join("\n");
}
