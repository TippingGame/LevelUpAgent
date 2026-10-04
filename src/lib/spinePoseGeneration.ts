import type { SpineMotionStudy, SpinePoseFrame, SpineProject } from "./spine";

export interface SpinePoseImageRequest {
  studyId: string;
  clipId: string;
  time: number;
  description: string;
  inbetween: boolean;
  neighbors: SpinePoseFrame[];
}

/** Same-time duplicates use the last image, matching the study's bone interpolation. */
export function spinePoseImageNeighbors(study: SpineMotionStudy, time: number): SpinePoseFrame[] {
  const byTime = new Map<number, SpinePoseFrame>();
  for (const frame of study.frames) if (frame.image) byTime.set(frame.time, frame);
  const frames = [...byTime.values()].sort((a, b) => a.time - b.time);
  const preceding = frames.filter((frame) => frame.time < time);
  const before = preceding[preceding.length - 1];
  const after = frames.find((frame) => frame.time > time);
  return [before, after].filter((frame): frame is SpinePoseFrame => !!frame);
}

export function createSpinePoseImageRequest(
  study: SpineMotionStudy, duration: number, time: number, description: string, inbetween = false,
): SpinePoseImageRequest {
  if (!Number.isFinite(time) || time < 0 || time > duration)
    throw new Error("关键姿态时间超出动作范围 / Pose time is outside the animation");
  const neighbors = spinePoseImageNeighbors(study, time);
  if (inbetween && (neighbors.length !== 2 || study.frames.some((frame) => Math.abs(frame.time - time) < 0.0005)))
    throw new Error("请选择两张姿态图之间尚未使用的时间 / Choose an unused time between two pose images");
  const instruction = description.trim();
  if (!inbetween && !instruction) throw new Error("请描述要生成的关键姿态 / Describe the key pose");
  return {
    studyId: study.id, clipId: study.clipId, time, inbetween, neighbors,
    description: instruction || "保持物体造型与镜头，在前后姿态之间自然过渡。",
  };
}

/** Changes to unrelated targets/settings can survive a request; its image constraints cannot. */
export function spinePoseImageReferencesMatch(request: SpinePoseImageRequest, study: SpineMotionStudy): boolean {
  const current = spinePoseImageNeighbors(study, request.time);
  return request.studyId === study.id && request.clipId === study.clipId &&
    current.length === request.neighbors.length && current.every((frame, index) => {
      const reference = request.neighbors[index];
      return frame.id === reference.id && frame.time === reference.time && frame.image === reference.image;
    });
}

export function spinePoseImagePrompt(project: SpineProject, request: SpinePoseImageRequest): string {
  let imageIndex = 0;
  const source = project.sourceImage
    ? `Reference Image ${++imageIndex} is the complete source subject: preserve its identity, design, component count, proportions, materials and palette.`
    : "Preserve identity and design from the supplied reference images.";
  const neighbors = request.neighbors.map((frame) =>
    `Reference Image ${++imageIndex} is the ${frame.time < request.time ? "PREVIOUS" : "NEXT"} key pose at ${frame.time}s.`);
  const transition = request.inbetween
    ? `Generate exactly ONE intermediate pose at ${request.time}s, ${((request.time - request.neighbors[0].time) / (request.neighbors[1].time - request.neighbors[0].time) * 100).toFixed(2)}% of the way from the PREVIOUS pose to the NEXT pose. Respect both endpoint images, plausible component trajectories and occlusion. Do not crossfade, duplicate or blend two silhouettes.`
    : `Generate the requested key pose at ${request.time}s. Neighboring poses constrain design and temporal continuity; the explicit requested pose takes priority over copying a neighbor.`;
  return `Create one clean 2D key pose for skeletal animation of a character OR object. Subject: ${project.prompt.trim() || "match the attached source image"}. Required pose: ${request.description}. ${source} ${neighbors.join(" ")} Any further reference images supply user-selected design details. ${transition} Show the full subject, preserve the same camera angle, canvas framing, scale and background across the pose images. No text, no contact sheet. This image is a visual pose reference; it does not contain bone motion data.`;
}
