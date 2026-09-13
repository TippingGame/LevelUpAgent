export interface MediaReferenceUrl {
  id: string;
  url: string;
}

export function createMediaReferenceUrl(): MediaReferenceUrl {
  return { id: crypto.randomUUID(), url: "" };
}

/** Move the same reference object so its identity and payload stay together. */
export function moveMediaReference<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Keep empty slots in place: callers must require all numbered URLs to be filled. */
export function orderedMediaReferenceUrls(items: MediaReferenceUrl[]): string[] {
  return items.map((item) => item.url.trim());
}
