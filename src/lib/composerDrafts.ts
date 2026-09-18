import type { ImageAttachment } from "./types";

export interface ComposerDraft {
  content: string;
  attachments: ImageAttachment[];
}

export interface DraftSnapshot extends ComposerDraft {
  ready: boolean;
  error?: string;
}

export interface DraftPersistence {
  read(threadId: string): Promise<ComposerDraft>;
  write(threadId: string, draft: ComposerDraft): Promise<void>;
}

export function parseComposerDraft(value: unknown): ComposerDraft {
  if (!value || typeof value !== "object" || !("content" in value) || typeof value.content !== "string"
    || !("attachments" in value) || !Array.isArray(value.attachments) || value.attachments.length > 12
    || !value.attachments.every((item: unknown) => item && typeof item === "object"
      && "id" in item && typeof item.id === "string" && item.id.length > 0
      && "name" in item && typeof item.name === "string"
      && "mimeType" in item && typeof item.mimeType === "string"
      && "sizeBytes" in item && Number.isSafeInteger(item.sizeBytes) && Number(item.sizeBytes) >= 0
      && "kind" in item && typeof item.kind === "string" && ["image", "video", "text", "document", "file"].includes(item.kind))) {
    throw new Error("Invalid saved draft");
  }
  return { content: value.content, attachments: value.attachments };
}

export class ComposerDraftStore {
  private snapshots = new Map<string, DraftSnapshot>();
  private loading = new Map<string, Promise<void>>();
  private pending = new Map<string, DraftSnapshot>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private persistence: DraftPersistence;

  constructor(persistence: DraftPersistence) { this.persistence = persistence; }

  getError = (): string | undefined => [...this.snapshots.values()].find((draft) => draft.error)?.error;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(threadId: string): DraftSnapshot {
    if (!this.snapshots.has(threadId)) this.snapshots.set(threadId, { content: "", attachments: [], ready: false });
    return this.snapshots.get(threadId)!;
  }

  load(threadId: string): Promise<void> {
    if (this.get(threadId).ready) return Promise.resolve();
    const running = this.loading.get(threadId);
    if (running) return running;
    const initial = this.get(threadId);
    const task = this.persistence.read(threadId).then((draft) => {
      if (this.get(threadId) === initial) this.publish(threadId, { ...draft, ready: true });
    }).catch((error) => {
      if (this.get(threadId) === initial) this.publish(threadId, { ...initial, error: String(error) });
    }).finally(() => { this.loading.delete(threadId); });
    this.loading.set(threadId, task);
    return task;
  }

  update(threadId: string, change: (draft: ComposerDraft) => ComposerDraft) {
    const next = { ...change(this.get(threadId)), ready: true };
    this.publish(threadId, next);
    this.pending.set(threadId, next);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 250);
  }

  clear(threadId: string) {
    this.update(threadId, () => ({ content: "", attachments: [] }));
  }

  consume(threadId: string, submitted: ComposerDraft) {
    const sentIds = new Set(submitted.attachments.map((item) => item.id));
    this.update(threadId, (current) => ({
      content: current.content === submitted.content ? "" : current.content,
      attachments: current.attachments.filter((item) => !sentIds.has(item.id)),
    }));
  }

  appendAttachments(threadId: string, attachments: ImageAttachment[]): ImageAttachment[] {
    const available = Math.max(0, 12 - this.get(threadId).attachments.length);
    this.update(threadId, (current) => ({ ...current, attachments: [...current.attachments, ...attachments.slice(0, available)] }));
    return attachments.slice(available);
  }

  async retry() {
    await Promise.all([...this.snapshots].filter(([, draft]) => draft.error && !draft.ready).map(([id]) => this.load(id)));
    await this.flush();
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = this.queue.catch(() => undefined).then(async () => {
      while (this.pending.size) {
        const entries = [...this.pending];
        this.pending.clear();
        let failure: unknown;
        for (const [threadId, draft] of entries) {
          try {
            await this.persistence.write(threadId, { content: draft.content, attachments: draft.attachments });
            if (draft.error && this.get(threadId) === draft) this.publish(threadId, { ...draft, error: undefined });
          } catch (error) {
            failure = error;
            if (this.get(threadId) === draft) {
              const failed = { ...draft, error: String(error) };
              this.publish(threadId, failed);
              this.pending.set(threadId, failed);
            }
          }
        }
        if (failure) throw failure;
      }
    });
    return this.queue;
  }

  private publish(threadId: string, value: DraftSnapshot) {
    this.snapshots.set(threadId, value);
    for (const listener of this.listeners) listener();
  }
}
