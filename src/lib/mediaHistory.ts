import type { MediaHistoryFilter } from "./types";

export type MediaHistoryRange = "all" | "today" | "7" | "30" | "custom";

export function mediaHistoryFilter(keyword: string, range: MediaHistoryRange, start: string, end: string, now = new Date()): MediaHistoryFilter | null {
  const filter: MediaHistoryFilter = { keyword: keyword.trim() || undefined };
  if (range === "custom") {
    if (start) filter.createdAfter = new Date(`${start}T00:00:00`).getTime();
    if (end) {
      const nextDay = new Date(`${end}T00:00:00`);
      nextDay.setDate(nextDay.getDate() + 1);
      filter.createdBefore = nextDay.getTime();
    }
    if ((filter.createdAfter !== undefined && !Number.isFinite(filter.createdAfter))
      || (filter.createdBefore !== undefined && !Number.isFinite(filter.createdBefore))
      || (filter.createdAfter !== undefined && filter.createdBefore !== undefined && filter.createdAfter >= filter.createdBefore)) return null;
  } else if (range !== "all") {
    const firstDay = new Date(now);
    firstDay.setHours(0, 0, 0, 0);
    if (range !== "today") firstDay.setDate(firstDay.getDate() - Number(range) + 1);
    filter.createdAfter = firstDay.getTime();
  }
  return filter;
}
