import {
  sampleSpineKeys,
  interpolateSpineDeformation,
  SPINE_DEFORMATION_FIELDS,
  validSpineDeformation,
  SPINE_LIMITS,
  type SpineClip,
  type SpineKey,
  type SpineMotionStudy,
  type SpinePart,
  type SpinePoseFrame,
  type SpinePoseTarget,
  type SpineProject,
} from "./spine";
export type { SpineMotionStudy } from "./spine";

export interface SpinePoseInference {
  summary: string;
  targets: Record<string, SpinePoseTarget>;
  uncertain: string[];
}

/** Validate a vision model's complete target pose before it can enter the editable study. */
export function parseSpinePoseInference(text: string, parts: SpinePart[]): SpinePoseInference {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Pose analysis did not return valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pose analysis must be a JSON object.");
  const result = value as Record<string, unknown>;
  if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 1500 ||
      !result.targets || typeof result.targets !== "object" || Array.isArray(result.targets) ||
      !Array.isArray(result.uncertain))
    throw new Error("Pose analysis is missing its summary, targets or uncertainty list.");
  const ids = new Set(parts.map((part) => part.id));
  const targets = result.targets as Record<string, unknown>;
  if (Object.keys(targets).length !== ids.size || Object.keys(targets).some((id) => !ids.has(id)))
    throw new Error("Pose analysis must contain every current part exactly once.");
  for (const id of ids) {
    const target = targets[id];
    if (!target || typeof target !== "object" || Array.isArray(target))
      throw new Error(`Invalid pose target for ${id}.`);
    const fields = target as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !["rotation", "bend", "x", "y", ...SPINE_DEFORMATION_FIELDS].includes(key)) || !validSpineDeformation(fields) ||
        !["rotation", "bend"].every((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]) && Math.abs(fields[key]) <= 360) ||
        !["x", "y"].every((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]) && Math.abs(fields[key]) <= 1000))
      throw new Error(`Pose target for ${id} needs bounded rotation, bend, x and y.`);
  }
  if (result.uncertain.length > ids.size || result.uncertain.some((id) => typeof id !== "string" || !ids.has(id)) ||
      new Set(result.uncertain).size !== result.uncertain.length)
    throw new Error("Pose analysis has unknown or duplicate uncertain parts.");
  return result as unknown as SpinePoseInference;
}

export function acceptSpinePoseInference(frame: SpinePoseFrame, inference: SpinePoseInference): SpinePoseFrame {
  const note = `Pose analysis: ${inference.summary}${inference.uncertain.length ? ` Uncertain part IDs: ${inference.uncertain.join(", ")}.` : ""}`;
  return {
    ...frame,
    targets: inference.targets,
    fitStatus: "review",
    fitError: undefined,
    notes: [frame.notes, note].filter(Boolean).join("\n").slice(0, 2000),
  };
}

const motionId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

export function emptyPoseTarget(): SpinePoseTarget {
  return { rotation: 0, bend: 0, x: 0, y: 0 };
}

export function poseTargetFromKey(key: SpineKey): SpinePoseTarget {
  return {
    rotation: key.rotation,
    bend: key.bend,
    x: key.x,
    y: key.y,
    ...interpolateSpineDeformation(key, key, 0),
  };
}

export function captureSpinePose(
  clip: SpineClip,
  parts: SpinePart[],
  time: number,
  name = "Pose",
  source: SpinePoseFrame["source"] = "capture",
  image?: Pick<SpinePoseFrame, "image" | "imageWidth" | "imageHeight">,
): SpinePoseFrame {
  const targets: Record<string, SpinePoseTarget> = {};
  for (const part of parts)
    targets[part.id] = poseTargetFromKey(
      sampleSpineKeys(clip.tracks[part.id], time),
    );
  return {
    id: motionId("pose"),
    name,
    time: Math.max(0, Math.min(clip.duration, time)),
    source,
    targets,
    fitStatus: "ready",
    ...(image ?? {}),
  };
}

function clampTarget(target: SpinePoseTarget): SpinePoseTarget {
  return {
    rotation: Math.max(-360, Math.min(360, Number(target.rotation) || 0)),
    bend: Math.max(-360, Math.min(360, Number(target.bend) || 0)),
    x: Math.max(-1000, Math.min(1000, Number(target.x) || 0)),
    y: Math.max(-1000, Math.min(1000, Number(target.y) || 0)),
    ...Object.fromEntries(SPINE_DEFORMATION_FIELDS.filter((key) => target[key] !== undefined).map((key) =>
      [key, key.startsWith("scale") ? Math.max(0.25, Math.min(2, Number(target[key]) || 1)) : Math.max(-1000, Math.min(1000, Number(target[key]) || 0))])),
  };
}

/** Fit manually supplied pose targets to the fixed editable skeleton. */
export function fitSpinePose(
  project: SpineProject,
  study: SpineMotionStudy,
  frame: SpinePoseFrame,
): SpinePoseFrame {
  const clip = project.clips.find((item) => item.id === study.clipId);
  if (!clip) throw new Error("Motion study target animation does not exist.");
  const fallback = captureSpinePose(clip, project.parts, frame.time);
  const targets: Record<string, SpinePoseTarget> = {};
  let missing = 0;
  for (const part of project.parts) {
    const target = frame.targets[part.id];
    if (!target) missing++;
    targets[part.id] = clampTarget(target ?? fallback.targets[part.id]);
  }
  const fitError = missing / Math.max(1, project.parts.length);
  return {
    ...frame,
    targets,
    fitError,
    fitStatus: missing ? "review" : "applied",
    notes: missing
      ? `${missing} part target(s) filled from the current animation.`
      : frame.notes,
  };
}

export function shortestAngleDelta(from: number, to: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  if (delta === -180) delta = 180;
  return delta;
}

export function interpolateSpineTargets(
  from: SpinePoseTarget,
  to: SpinePoseTarget,
  amount: number,
  stepped = false,
): SpinePoseTarget {
  if (stepped && amount < 1) return { ...from };
  const t = Math.max(0, Math.min(1, amount));
  return {
    rotation: from.rotation + shortestAngleDelta(from.rotation, to.rotation) * t,
    bend: from.bend + shortestAngleDelta(from.bend, to.bend) * t,
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    ...interpolateSpineDeformation(from, to, t),
  };
}

function uniqueSortedFrames(frames: SpinePoseFrame[], duration: number) {
  const sorted = [...frames]
    .map((frame) => ({ ...frame, time: Math.max(0, Math.min(duration, frame.time)) }))
    .sort((a, b) => a.time - b.time);
  const result: SpinePoseFrame[] = [];
  for (const frame of sorted) {
    const previous = result[result.length - 1];
    if (previous && Math.abs(previous.time - frame.time) < 0.0005)
      result[result.length - 1] = frame;
    else result.push(frame);
  }
  return result;
}

/** Produce editable bone keys sampled at the requested frame rate. */
export function interpolateSpineStudy(
  project: SpineProject,
  study: SpineMotionStudy,
): Record<string, SpineKey[]> {
  const clip = project.clips.find((item) => item.id === study.clipId);
  if (!clip) throw new Error("Motion study target animation does not exist.");
  const frames = uniqueSortedFrames(study.frames, clip.duration);
  if (frames.length < 2)
    throw new Error("Add at least two key poses at different times first.");
  const fitted = frames.map((frame) => fitSpinePose(project, study, frame));
  const step = 1 / study.fps;
  const sampleTimes = new Set<number>(fitted.map((frame) => frame.time));
  for (let i = 0; i <= Math.ceil(clip.duration / step); i++) {
    const time = Math.min(clip.duration, i * step);
    if (time >= fitted[0].time - 0.0005 && time <= fitted[fitted.length - 1].time + 0.0005)
      sampleTimes.add(Math.round(time * 1000) / 1000);
  }
  const times = [...sampleTimes].sort((a, b) => a - b);
  if (times.length > SPINE_LIMITS.keys)
    throw new Error(`Interpolation would exceed ${SPINE_LIMITS.keys} keys per track.`);
  const tracks: Record<string, SpineKey[]> = {};
  for (const part of project.parts) {
    tracks[part.id] = times.map((time) => {
      let left = fitted[0], right = fitted[fitted.length - 1];
      for (let i = 1; i < fitted.length; i++) {
        if (fitted[i].time >= time) {
          right = fitted[i];
          left = fitted[i - 1];
          break;
        }
      }
      const span = Math.max(0.000001, right.time - left.time);
      const target = interpolateSpineTargets(
        left.targets[part.id],
        right.targets[part.id],
        (time - left.time) / span,
        study.interpolation === "stepped",
      );
      return {
        ...target,
        time,
        curve: study.interpolation,
      };
    });
  }
  return tracks;
}

export function applySpineStudy(
  project: SpineProject,
  study: SpineMotionStudy,
  name?: string,
): SpineClip {
  const clip = project.clips.find((item) => item.id === study.clipId);
  if (!clip) throw new Error("Motion study target animation does not exist.");
  return {
    ...clip,
    ...(name ? { name } : {}),
    tracks: interpolateSpineStudy(project, study),
  };
}

export function createSpineMotionStudy(
  clip: SpineClip,
  name = `${clip.name} · poses`,
): SpineMotionStudy {
  const now = Date.now();
  return {
    id: motionId("study"),
    name,
    clipId: clip.id,
    fps: 24,
    interpolation: "linear",
    frames: [],
    createdAt: now,
    updatedAt: now,
  };
}
