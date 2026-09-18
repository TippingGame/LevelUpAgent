import { useCallback, useEffect, useState, useSyncExternalStore, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./bridge";
import { ComposerDraftStore, parseComposerDraft, type ComposerDraft } from "./composerDrafts";
import type { ImageAttachment } from "./types";

const DRAFT_KEY = "levelup-agent.composer-draft.v1.";

export function useComposerDraft(threadId: string) {
  const [store] = useState(() => new ComposerDraftStore({
    async read(id) {
      if (isDesktop()) return invoke<ComposerDraft>("get_composer_draft", { threadId: id });
      const raw = localStorage.getItem(DRAFT_KEY + id);
      if (!raw) return { content: "", attachments: [] };
      return parseComposerDraft(JSON.parse(raw));
    },
    async write(id, draft) {
      if (isDesktop()) return invoke("save_composer_draft", { threadId: id, draft });
      if (!draft.content && !draft.attachments.length) localStorage.removeItem(DRAFT_KEY + id);
      else localStorage.setItem(DRAFT_KEY + id, JSON.stringify(draft));
    },
  }));
  const snapshot = useSyncExternalStore(store.subscribe, () => store.get(threadId));
  const error = useSyncExternalStore(store.subscribe, store.getError);
  useEffect(() => {
    void store.load(threadId);
    return () => { void store.flush().catch(() => undefined); };
  }, [store, threadId]);

  useEffect(() => {
    const flush = () => { void store.flush().catch(() => undefined); };
    window.addEventListener("pagehide", flush);
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [store]);

  const setContent = useCallback((value: SetStateAction<string>) => {
    store.update(threadId, (current) => ({ ...current, content: typeof value === "function" ? value(current.content) : value }));
  }, [store, threadId]);
  const setAttachments = useCallback((value: SetStateAction<ImageAttachment[]>) => {
    store.update(threadId, (current) => ({ ...current, attachments: typeof value === "function" ? value(current.attachments) : value }));
  }, [store, threadId]);
  return { snapshot, error, setContent, setAttachments, store };
}
