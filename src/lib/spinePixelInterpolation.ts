import { SPINE_LIMITS, type SpineMotionStudy, type SpinePoseFrame } from "./spine";
import { loadSpineImage } from "./spineAssets";
import { spinePoseImageNeighbors } from "./spinePoseGeneration";

export interface SpinePixelPlan {
  studyId: string;
  clipId: string;
  time: number;
  endpoints: [SpinePoseFrame, SpinePoseFrame];
  times: number[];
}

export function planSpinePixelFrames(study: SpineMotionStudy, time: number, count: number): SpinePixelPlan {
  const endpoints = spinePoseImageNeighbors(study, time);
  if (!Number.isFinite(time) || endpoints.length !== 2 || ![1, 3, 7].includes(count) ||
      study.frames.some(frame => frame.image && Math.abs(frame.time - time) < 0.0005))
    throw new Error("请选择两张姿态图之间的时间与 1 / 3 / 7 帧 / Choose a time between two pose images and 1 / 3 / 7 frames.");
  if (study.frames.length + count > SPINE_LIMITS.poseFrames)
    throw new Error("关键姿态超过 64 帧上限 / The study would exceed 64 poses.");
  const [first, last] = endpoints;
  const times = Array.from({ length: count }, (_, i) => first.time + (last.time - first.time) * (i + 1) / (count + 1));
  if (times.some((t, i) => study.frames.some(f => Math.abs(f.time - t) < 0.0005) ||
      (i > 0 && t - times[i - 1] < 0.0005)))
    throw new Error("补帧时间已有姿态或间隔太小，请选择空白区间 / Interpolated times are occupied or too close; choose an empty interval.");
  return { studyId: study.id, clipId: study.clipId, time, endpoints: structuredClone([first, last]), times };
}

export function spinePixelPlanMatches(plan: SpinePixelPlan, study: SpineMotionStudy): boolean {
  const neighbors = spinePoseImageNeighbors(study, plan.time);
  return study.id === plan.studyId && study.clipId === plan.clipId &&
    !study.frames.some(frame => frame.image && Math.abs(frame.time - plan.time) < 0.0005) &&
    neighbors.length === 2 && neighbors.every((frame, index) => frame.id === plan.endpoints[index].id) &&
    plan.endpoints.every(endpoint => study.frames.some(frame => frame.id === endpoint.id &&
      frame.time === endpoint.time && frame.image === endpoint.image &&
      JSON.stringify(frame.targets) === JSON.stringify(endpoint.targets))) &&
    !study.frames.some(frame => plan.times.some(time => Math.abs(frame.time - time) < 0.0005));
}

/** RGB reference frames retain full framing. RIFE does not reconstruct alpha. */
export async function prepareSpinePixelInputs(plan: SpinePixelPlan) {
  const images = await Promise.all(plan.endpoints.map(frame => loadSpineImage(frame.image!)));
  const [a, b] = images;
  if (Math.abs(a.naturalWidth / a.naturalHeight - b.naturalWidth / b.naturalHeight) > 0.001)
    throw new Error("两端图片宽高比须一致，请先统一画布 / Endpoint images need the same aspect ratio.");
  const scale = Math.min(1, 512 / Math.max(a.naturalWidth, a.naturalHeight));
  const width = Math.max(1, Math.round(a.naturalWidth * scale));
  const height = Math.max(1, Math.round(a.naturalHeight * scale));
  const inputs = images.map(image => {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#eef2f8"; ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  });
  return { first: inputs[0], last: inputs[1], width, height };
}
