import { SPINE_LIMITS, type SpinePart, type SpineProject } from "./spine";

export function spineImageBackgroundPrompt(modelId: string, subject = "complete subject") {
  return /(?:^|\/)gpt-image-2(?:$|[.-])/i.test(modelId.trim())
    ? `Center the ${subject} with a small margin on a flat, uniform pure green (#00FF00) background. Keep the green uninterrupted around its silhouette, with no shadows, gradient, texture or extra marks. The green will be removed after generation. Output one PNG.`
    : `Center the ${subject} with a small margin on a genuinely transparent RGBA background. Keep clean antialiased alpha. Output one PNG.`;
}

export interface SpineGenerationProgress<T = SpinePart["role"]> {
  role: T;
  index: number;
  total: number;
}
/** One provider request at a time; checkpoint each completed part before proceeding. */
export async function runSpinePartGeneration<T = SpinePart["role"]>(options: {
  project: SpineProject;
  roles: T[];
  shouldStop: () => boolean;
  onProgress: (progress: SpineGenerationProgress<T>) => void;
  generate: (
    role: T,
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
