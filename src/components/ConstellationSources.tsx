import { useEffect, useMemo, useState } from "react";
import { X, Search, LoaderCircle } from "lucide-react";
import { getPersistedThread, isDesktop, listThreadSummaries } from "../lib/bridge";
import { constellationValueReady, normalizeConstellationGraph, type ConstellationNodeData, type ConstellationValue } from "../lib/constellation";
import type { AgentThread, ConstellationConversationSnapshot, ConstellationProjectRecord, ConstellationProjectOutputReference, ThreadCursor } from "../lib/types";
import { tr } from "../lib/i18n";

export function ConstellationConversationPicker({ threads, snapshot, onChoose, onClose }: {
  threads: AgentThread[];
  snapshot?: ConstellationConversationSnapshot;
  onChoose: (snapshot: ConstellationConversationSnapshot) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState(threads);
  const [cursor, setCursor] = useState<ThreadCursor | undefined>();
  const [threadId, setThreadId] = useState(snapshot?.threadId ?? "");
  const [thread, setThread] = useState<AgentThread>();
  const [selected, setSelected] = useState(new Set(snapshot?.messageIds ?? []));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    if (!isDesktop()) { setCatalog(threads); return; }
    const timer = window.setTimeout(() => {
      void listThreadSummaries(query).then((page) => {
        if (!disposed) { setCatalog(page.threads); setCursor(page.nextCursor ?? undefined); setError(""); }
      }).catch((reason) => { if (!disposed) setError(String(reason)); });
    }, 200);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [query, threads]);
  useEffect(() => {
    let disposed = false;
    setThread(undefined); setError("");
    if (!threadId) return;
    setLoading(true);
    const local = threads.find((item) => item.id === threadId && item.historyLoaded !== false);
    void (local ? Promise.resolve(local) : isDesktop() ? getPersistedThread(threadId) : Promise.resolve(null))
      .then((value) => { if (!disposed) { if (!value) throw new Error(tr("原会话已不可用，已存快照不受影响", "Source conversation is unavailable; saved snapshot is retained")); setThread(value); } })
      .catch((reason) => { if (!disposed) setError(String(reason)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [threadId, threads]);
  const messages = thread?.messages.filter((message) => !message.internal && (message.content.trim() || message.attachments.length)) ?? [];
  const chosen = messages.filter((message) => selected.has(message.id));
  const choose = () => {
    if (!thread || !chosen.length) return;
    const value: ConstellationConversationSnapshot = {
      threadId: thread.id, threadTitle: thread.title, capturedAt: Date.now(),
      messageIds: chosen.map((message) => message.id),
      messages: chosen.map(({ id, role, content, createdAt, attachments }) => ({ id, role, content, createdAt, attachments: structuredClone(attachments) })),
    };
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_000_000) { setError(tr("选中的消息超过 1 MB，请减少选择", "Selected messages exceed 1 MB; select fewer messages")); return; }
    onChoose(value);
  };
  return <SourceDialog title={tr("选择会话消息", "Choose conversation messages")} onClose={onClose}>
    <label className="constellation-source-search"><Search size={14} /><input autoFocus placeholder={tr("搜索会话", "Search conversations")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="constellation-source-columns"><div className="constellation-source-list">
      {catalog.filter((item) => isDesktop() || item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((item) => <button type="button" className={item.id === threadId ? "active" : ""} key={item.id} onClick={() => { setThreadId(item.id); setSelected(new Set(item.id === snapshot?.threadId ? snapshot.messageIds : [])); }}>{item.title}</button>)}
      {cursor && <button type="button" onClick={() => { void listThreadSummaries(query, cursor).then((page) => { setCatalog((current) => [...current, ...page.threads.filter((item) => !current.some((old) => old.id === item.id))]); setCursor(page.nextCursor ?? undefined); }).catch((reason) => setError(String(reason))); }}>{tr("加载更多", "Load more")}</button>}
    </div><div className="constellation-message-list">
      {loading && <LoaderCircle className="spin" size={18} />}
      {!loading && !messages.length && <p>{tr("选择会话后，勾选需要带入的消息。", "Choose a conversation, then select the messages to include.")}</p>}
      {messages.map((message) => <label key={message.id}><input type="checkbox" checked={selected.has(message.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(message.id); else next.delete(message.id); return next; })} /><div><small>{message.role} · {new Date(message.createdAt).toLocaleString()}</small><p>{message.content}</p>{message.attachments.length > 0 && <small>{message.attachments.map((attachment) => attachment.name).join(" · ")}</small>}</div></label>)}
    </div></div>
    {error && <p role="alert">{error}</p>}
    <footer><small>{tr("仅保存勾选内容；原会话后续变化需重新选择。", "Only selected content is saved; refresh explicitly after source changes.")}</small><button type="button" disabled={!chosen.length || loading} onClick={choose}>{tr(`保存 ${chosen.length} 条消息`, `Save ${chosen.length} messages`)}</button></footer>
  </SourceDialog>;
}

export function ConstellationProjectPicker({ records, currentProjectId, onChoose, onClose }: {
  records: ConstellationProjectRecord[];
  currentProjectId: string;
  onChoose: (reference: ConstellationProjectOutputReference, value: ConstellationValue) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const choices = useMemo(() => records.filter((record) => record.id !== currentProjectId).flatMap((record) => {
    const payload = record.payload as { graph?: unknown };
    const graph = normalizeConstellationGraph(payload?.graph ?? payload);
    return (graph?.nodes ?? []).filter((node) => node.data.status === "success").flatMap((node) => Object.entries(node.data.outputs ?? {}).flatMap(([handle, value]) => constellationValueReady(value) ? [{ record, node, handle, value }] : []));
  }), [records, currentProjectId]);
  return <SourceDialog title={tr("选择项目作品", "Choose a project output")} onClose={onClose}>
    <label className="constellation-source-search"><Search size={14} /><input autoFocus placeholder={tr("搜索项目或节点", "Search projects or nodes")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="constellation-output-list">{choices.filter(({ record, node }) => `${record.title} ${node.data.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(({ record, node, handle, value }) => <button type="button" key={`${record.id}:${node.id}:${handle}`} onClick={() => onChoose({ projectId: record.id, nodeId: node.id, outputHandle: handle, valueType: value.type, capturedAt: Date.now() }, structuredClone(value))}><strong>{record.title} / {node.data.title}</strong><small>{value.type} · {handle} · {new Date(value.createdAt).toLocaleString()}</small><p>{value.text?.slice(0, 220) ?? value.asset?.prompt ?? value.attachment?.name}</p></button>)}</div>
    {!choices.length && <p>{tr("其它项目还没有可引用的已选结果。先运行一个项目，再回来选择。", "Other projects have no selected outputs yet. Run a project, then return to choose a result.")}</p>}
    <footer><small>{tr("保存当前作品快照；来源变动不会自动覆盖。", "Save a snapshot; source changes will not replace it automatically.")}</small></footer>
  </SourceDialog>;
}

export function SourceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", keydown, true); return () => window.removeEventListener("keydown", keydown, true); }, [onClose]);
  return <div className="constellation-source-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="constellation-source-dialog" role="dialog" aria-modal="true" aria-label={title}><header><strong>{title}</strong><button type="button" aria-label={tr("关闭", "Close")} onClick={onClose}><X size={16} /></button></header>{children}</section></div>;
}

export function conversationSnapshotText(data: ConstellationNodeData) {
  return data.conversationSnapshot?.messages.map((message) => `${message.role}: ${message.content}${message.attachments.length ? `\n${message.attachments.map((item) => item.name).join(", ")}` : ""}`).join("\n\n") ?? "";
}
