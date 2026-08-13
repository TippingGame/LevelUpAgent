export type PetSpriteState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export interface PetAnimationDefinition {
  row: number;
  frameDurations: readonly number[];
}

export const PET_ANIMATIONS: Record<PetSpriteState, PetAnimationDefinition> = {
  idle: { row: 0, frameDurations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, frameDurations: [90, 90, 90, 90, 90, 90, 90, 90] },
  "running-left": { row: 2, frameDurations: [90, 90, 90, 90, 90, 90, 90, 90] },
  waving: { row: 3, frameDurations: [140, 140, 140, 280] },
  jumping: { row: 4, frameDurations: [140, 140, 140, 140, 280] },
  failed: { row: 5, frameDurations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, frameDurations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, frameDurations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, frameDurations: [150, 150, 150, 150, 150, 280] },
};

export function animationDuration(frameDurations: readonly number[]) {
  return frameDurations.reduce((total, duration) => total + Math.max(1, duration), 0);
}

export function animationFrameAtTime(frameDurations: readonly number[], elapsedMs: number) {
  if (frameDurations.length === 0) return 0;
  const cycleDuration = animationDuration(frameDurations);
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const phase = safeElapsed % cycleDuration;
  let boundary = 0;
  for (let index = 0; index < frameDurations.length; index += 1) {
    boundary += Math.max(1, frameDurations[index]);
    if (phase < boundary) return index;
  }
  return frameDurations.length - 1;
}

/** The atlas contract is intentionally observable for QA and future renderers. */
export function animationFrameSequence(frameDurations: readonly number[]) {
  return frameDurations.map((_, index) => index);
}
