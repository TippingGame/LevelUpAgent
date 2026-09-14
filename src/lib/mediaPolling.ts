type RefreshMedia<T> = (id: string) => Promise<T>;

export function deduplicateMediaRefresh<T>(refresh: RefreshMedia<T>): RefreshMedia<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (id) => {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const task = Promise.resolve().then(() => refresh(id)).finally(() => {
      if (inFlight.get(id) === task) inFlight.delete(id);
    });
    inFlight.set(id, task);
    return task;
  };
}

export function createMediaPoller<T>(
  refresh: RefreshMedia<T>,
  onAsset: (asset: T) => void,
  onError: (id: string, reason: unknown | null) => void,
) {
  const inFlight = new Set<string>();
  let stopped = false;
  return {
    poll(ids: readonly string[]) {
      if (stopped) return;
      for (const id of ids) {
        if (inFlight.has(id)) continue;
        inFlight.add(id);
        // Publish each result without waiting for another video's download.
        void Promise.resolve().then(() => refresh(id)).then(
          (asset) => {
            if (stopped) return;
            onError(id, null);
            onAsset(asset);
          },
          (reason: unknown) => {
            if (!stopped) onError(id, reason);
          },
        ).finally(() => inFlight.delete(id));
      }
    },
    stop() { stopped = true; },
  };
}
