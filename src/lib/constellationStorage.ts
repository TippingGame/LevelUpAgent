import type { ConstellationProjectRecord } from "./types";

export const CONSTELLATION_PROJECTS_KEY = "levelup-agent.constellation-projects.v1";
type StorageAdapter = Pick<Storage, "getItem" | "setItem">;

export function validateConstellationProject(value: unknown): asserts value is ConstellationProjectRecord {
  const record = value as Partial<ConstellationProjectRecord> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)
    || typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id)
    || typeof record.title !== "string" || !record.title.trim() || Array.from(record.title.trim()).length > 200
    || !Number.isSafeInteger(record.createdAt) || Number(record.createdAt) < 0
    || !Number.isSafeInteger(record.updatedAt) || Number(record.updatedAt) < Number(record.createdAt)
    || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new Error("Invalid constellation project record");
  if (new TextEncoder().encode(JSON.stringify(record.payload)).byteLength > 16 * 1024 * 1024) throw new Error("Constellation project data may not exceed 16 MiB");
}

export function createConstellationBrowserStore(storage: () => StorageAdapter) {
  let queue: Promise<unknown> = Promise.resolve();
  function read(): ConstellationProjectRecord[] {
    const raw = storage().getItem(CONSTELLATION_PROJECTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Constellation project storage is corrupted");
    parsed.forEach(validateConstellationProject);
    if (new Set(parsed.map((record) => record.id)).size !== parsed.length) throw new Error("Duplicate constellation project IDs in storage");
    return parsed;
  }
  function enqueue<T>(operation: () => T): Promise<T> {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  }
  return {
    list: () => enqueue(read),
    save: (project: ConstellationProjectRecord) => {
      // Capture this revision before waiting for earlier writes.
      validateConstellationProject(project);
      const snapshot = structuredClone(project);
      return enqueue(() => {
        const current = read();
        const previous = current.find((item) => item.id === snapshot.id);
        const record = { ...snapshot, title: snapshot.title.trim(), createdAt: previous?.createdAt ?? snapshot.createdAt };
        validateConstellationProject(record);
        const next = [record, ...current.filter((item) => item.id !== record.id)].sort((a, b) => b.updatedAt - a.updatedAt);
        storage().setItem(CONSTELLATION_PROJECTS_KEY, JSON.stringify(next));
      });
    },
    remove: (id: string) => enqueue(() => {
      const current = read();
      const next = current.filter((item) => item.id !== id);
      storage().setItem(CONSTELLATION_PROJECTS_KEY, JSON.stringify(next));
      return next.length !== current.length;
    }),
  };
}
