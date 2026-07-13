import type { ToolCall } from "./types";

const MEDIA_TOOL_NAMES = new Set([
  "generate_images",
  "generate_videos",
  "generate_speech",
  "check_media_jobs",
]);

const PARALLEL_MEDIA_TOOL_NAMES = new Set([
  "generate_images",
  "generate_videos",
  "generate_speech",
]);

export function isMediaTool(name: string) {
  return MEDIA_TOOL_NAMES.has(name);
}

export async function executeCallsWithParallelMedia<T>(
  calls: ToolCall[],
  execute: (call: ToolCall) => Promise<T>,
): Promise<Array<{ call: ToolCall; result: T }>> {
  const results: Array<{ call: ToolCall; result: T }> = [];
  for (let index = 0; index < calls.length;) {
    if (!PARALLEL_MEDIA_TOOL_NAMES.has(calls[index].name)) {
      const call = calls[index];
      results.push({ call, result: await execute(call) });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < calls.length && PARALLEL_MEDIA_TOOL_NAMES.has(calls[end].name)) end += 1;
    const batch = calls.slice(index, end);
    const batchResults = await Promise.all(
      batch.map(async (call) => ({ call, result: await execute(call) })),
    );
    results.push(...batchResults);
    index = end;
  }
  return results;
}
