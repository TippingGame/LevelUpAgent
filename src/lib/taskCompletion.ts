export interface TaskCompletionNotice {
  threadId: string;
  title: string;
  completedAt: number;
  unread: boolean;
}

const MAX_TASK_COMPLETION_NOTICES = 20;

export function shouldMarkTaskCompletionUnread({
  threadId,
  activeThreadId,
  workspaceView,
  documentFocused,
}: {
  threadId: string;
  activeThreadId: string;
  workspaceView: string;
  documentFocused: boolean;
}) {
  return threadId !== activeThreadId || workspaceView !== "chat" || !documentFocused;
}

export function upsertTaskCompletionNotice(
  notices: TaskCompletionNotice[],
  notice: TaskCompletionNotice,
): TaskCompletionNotice[] {
  const normalized = normalizeTaskCompletionNotice(notice);
  if (!normalized) return notices;
  return [normalized, ...notices.filter((item) => item.threadId !== normalized.threadId)]
    .sort((left, right) => right.completedAt - left.completedAt)
    .slice(0, MAX_TASK_COMPLETION_NOTICES);
}

export function acknowledgeTaskCompletionNotices(
  notices: TaskCompletionNotice[],
  threadId: string,
): TaskCompletionNotice[] {
  return notices.filter((notice) => notice.threadId !== threadId);
}

export function normalizeTaskCompletionNotices(value: unknown): TaskCompletionNotice[] {
  if (!Array.isArray(value)) return [];
  let normalized: TaskCompletionNotice[] = [];
  for (const candidate of value) {
    const notice = normalizeTaskCompletionNotice(candidate);
    if (notice?.unread) normalized = upsertTaskCompletionNotice(normalized, notice);
  }
  return normalized;
}

function normalizeTaskCompletionNotice(value: unknown): TaskCompletionNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.threadId !== "string" || !candidate.threadId.trim()) return null;
  if (typeof candidate.title !== "string") return null;
  if (typeof candidate.completedAt !== "number" || !Number.isFinite(candidate.completedAt)) return null;
  return {
    threadId: candidate.threadId.trim().slice(0, 128),
    title: candidate.title.trim().slice(0, 80),
    completedAt: Math.max(0, Math.trunc(candidate.completedAt)),
    unread: candidate.unread !== false,
  };
}
