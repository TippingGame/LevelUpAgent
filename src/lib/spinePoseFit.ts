import type { SpinePart, SpinePoseTarget } from "./spine";
import { createSpinePoseRenderSession, measureSpinePose, spinePoseTargetPixels } from "./spinePoseComparison";

type Targets = Record<string, SpinePoseTarget>;
type Metrics = ReturnType<typeof measureSpinePose>;
export interface SpinePoseFitProgress { evaluations: number; limit: number; before: Metrics; after: Metrics }
export interface SpinePoseFitResult extends SpinePoseFitProgress { targets: Targets }

/** Local image-guided angle search. Never changes textures, bindings or caller-owned targets. */
export async function refineSpinePose(parts: SpinePart[], initial: Targets, targetImage: string, options: {
  partIds: string[];
  maxAngle: number;
  bend: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: SpinePoseFitProgress) => void;
}): Promise<SpinePoseFitResult> {
  const selected = new Set(options.partIds);
  if (!selected.size || selected.size !== options.partIds.length ||
      options.partIds.some((id) => !parts.some((part) => part.id === id)) ||
      !Number.isFinite(options.maxAngle) || options.maxAngle < 1 || options.maxAngle > 60)
    throw new Error("Select existing parts and an angle range between 1 and 60 degrees.");
  const check = () => { if (options.signal?.aborted) throw new DOMException("Pose fitting cancelled", "AbortError"); };
  check();
  const targets: Targets = Object.fromEntries(parts.map((part) => {
    const pose = initial[part.id] ?? { rotation: 0, bend: 0, x: 0, y: 0 };
    if (!["rotation", "bend", "x", "y"].every((key) => Number.isFinite(pose[key as keyof SpinePoseTarget])) ||
        Math.abs(pose.rotation) > 360 || Math.abs(pose.bend) > 360 || Math.abs(pose.x) > 1000 || Math.abs(pose.y) > 1000)
      throw new Error("Pose fitting requires valid bounded starting targets.");
    return [part.id, { ...pose }];
  }));
  const axes = parts.filter((part) => selected.has(part.id)).flatMap((part) =>
    (["rotation", ...(options.bend && part.flexibility > 0 ? ["bend" as const] : [])] as const).map((key) =>
      ({ id: part.id, key, start: targets[part.id][key] })));
  const target = await spinePoseTargetPixels(targetImage);
  check();
  const session = await createSpinePoseRenderSession(parts);
  try {
    check();
    const before = measureSpinePose(target, session.render(targets));
    let after = before, evaluations = 1;
    const steps = [...new Set([options.maxAngle / 2, options.maxAngle / 4, options.maxAngle / 8, 1, 0.25])].sort((a, b) => b - a);
    const limit = 1 + steps.length * 3 * axes.length * 2;
    let lastYield = performance.now();
    options.onProgress?.({ before, after, evaluations, limit });
    for (const step of steps) {
      for (let sweep = 0; sweep < 3; sweep++) {
        let changed = false;
        for (const axis of axes) {
          const original = targets[axis.id][axis.key];
          let bestValue = original, best = after;
          for (const direction of [-1, 1]) {
            check();
            const value = Math.max(-360, Math.min(360,
              Math.max(axis.start - options.maxAngle, Math.min(axis.start + options.maxAngle, original + step * direction))));
            if (value === original) continue;
            targets[axis.id][axis.key] = value;
            const metrics = measureSpinePose(target, session.render(targets));
            evaluations++;
            if (metrics.loss < best.loss - 0.00001) { best = metrics; bestValue = value; }
            targets[axis.id][axis.key] = original;
            if (performance.now() - lastYield >= 24) {
              options.onProgress?.({ before, after, evaluations, limit });
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              check(); lastYield = performance.now();
            }
          }
          targets[axis.id][axis.key] = bestValue;
          if (bestValue !== original) { after = best; changed = true; }
        }
        if (!changed) break;
      }
    }
    check();
    options.onProgress?.({ before, after, evaluations, limit });
    return { targets, before, after, evaluations, limit };
  } finally { session.dispose(); }
}
