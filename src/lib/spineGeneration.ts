import { SPINE_LIMITS, type SpinePart, type SpineProject } from "./spine";

export interface SpineGenerationProgress {
  role: SpinePart["role"];
  index: number;
  total: number;
}
/** One provider request at a time; checkpoint each completed part before proceeding. */
export async function runSpinePartGeneration(options: {
  project: SpineProject;
  roles: SpinePart["role"][];
  shouldStop: () => boolean;
  onProgress: (progress: SpineGenerationProgress) => void;
  generate: (
    role: SpinePart["role"],
  ) => Promise<{ part: SpinePart; opaque: boolean }>;
  checkpoint: (part: SpinePart) => Promise<void>;
}) {
  if (options.project.parts.length + options.roles.length > SPINE_LIMITS.parts)
    throw new Error("This would exceed 24 parts.");
  let completed = 0,
    opaque = false;
  for (const role of options.roles) {
    if (options.shouldStop()) break;
    options.onProgress({
      role,
      index: completed + 1,
      total: options.roles.length,
    });
    const result = await options.generate(role);
    // Stop means finish and retain the current request, then do not start another.
    await options.checkpoint(result.part);
    completed++;
    opaque ||= result.opaque;
  }
  return { completed, opaque, stopped: options.shouldStop() };
}
