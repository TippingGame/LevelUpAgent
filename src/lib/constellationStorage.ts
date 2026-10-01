import type { ConstellationProjectRecord, ConstellationToolTemplate } from "./types";

export const CONSTELLATION_PROJECTS_KEY = "levelup-agent.constellation-projects.v1";
export const CONSTELLATION_TOOL_TEMPLATES_KEY = "levelup-agent.constellation-tool-templates.v1";
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

export function loadConstellationToolTemplates(storage: () => StorageAdapter): ConstellationToolTemplate[] {
  try {
    const raw = storage().getItem(CONSTELLATION_TOOL_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .map(normalizeStoredToolTemplate)
      .filter((item): item is ConstellationToolTemplate => {
        if (!item || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .slice(0, 200);
  } catch {
    return [];
  }
}

export function saveConstellationToolTemplates(storage: () => StorageAdapter, templates: ConstellationToolTemplate[]) {
  const clean = templates.map(normalizeStoredToolTemplate).filter((item): item is ConstellationToolTemplate => Boolean(item)).slice(0, 200);
  storage().setItem(CONSTELLATION_TOOL_TEMPLATES_KEY, JSON.stringify(clean));
}

function normalizeStoredToolTemplate(value: unknown): ConstellationToolTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.command !== "string" || !record.id.trim() || !record.name.trim() || !record.command.trim()) return null;
  const inputSchema = Array.isArray(record.inputSchema) ? record.inputSchema.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).map((item) => ({
    id: typeof item.id === "string" ? item.id.slice(0, 64) : "input",
    name: typeof item.name === "string" ? item.name.slice(0, 120) : "输入",
    type: ["text", "number", "boolean", "json"].includes(String(item.type)) ? item.type as ConstellationToolTemplate["inputSchema"][number]["type"] : "text",
    required: item.required !== false,
    ...(typeof item.defaultValue === "string" ? { defaultValue: item.defaultValue.slice(0, 20_000) } : {}),
  })).slice(0, 32) : [];
  const outputSchema = Array.isArray(record.outputSchema) ? record.outputSchema.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).map((item) => ({
    id: typeof item.id === "string" ? item.id.slice(0, 64) : "stdout",
    name: typeof item.name === "string" ? item.name.slice(0, 120) : "标准输出",
    type: item.type === "json" ? "json" as const : "text" as const,
    ...(typeof item.source === "string" ? { source: item.source.slice(0, 500) } : {}),
  })).slice(0, 16) : [{ id: "stdout", name: "标准输出", type: "text" as const }];
  return {
    id: record.id.slice(0, 128), name: record.name.trim().slice(0, 120),
    description: typeof record.description === "string" ? record.description.slice(0, 500) : "",
    inputSchema, outputSchema, command: record.command.slice(0, 20_000),
    argumentTemplate: typeof record.argumentTemplate === "string" ? record.argumentTemplate.slice(0, 20_000) : "{{input}}",
    workdirMode: record.workdirMode === "custom" ? "custom" : "workspace",
    ...(typeof record.workdir === "string" ? { workdir: record.workdir.slice(0, 1_000) } : {}),
    createdAt: Number.isSafeInteger(record.createdAt) ? Number(record.createdAt) : Date.now(),
    updatedAt: Number.isSafeInteger(record.updatedAt) ? Number(record.updatedAt) : Date.now(),
  };
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
