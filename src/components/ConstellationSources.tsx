import { useEffect, useMemo, useState } from "react";
import { X, Search, Folder, FolderOpen, Plus, MessageSquareText, ChevronRight } from "lucide-react";
import { isDesktop, listThreadSummaries } from "../lib/bridge";
import { constellationValueReady, normalizeConstellationGraph, type ConstellationValue } from "../lib/constellation";
import type { AgentThread, ConstellationProjectRecord, ConstellationProjectOutputReference, ThreadCursor } from "../lib/types";
import { tr } from "../lib/i18n";

export function ConstellationConversationPicker({ threads, selectedThreadId, onChoose, onCreate, onClose }: {
  threads: AgentThread[];
  selectedThreadId?: string;
  onChoose: (thread: AgentThread) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState(threads);
  const [cursor, setCursor] = useState<ThreadCursor | undefined>();
  const [threadId, setThreadId] = useState(selectedThreadId ?? "");
  const [error, setError] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [collapsedSearchGroups, setCollapsedSearchGroups] = useState<Set<string>>(() => new Set());
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
  const grouped = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = catalog
      .filter((item) => !normalized || `${item.title} ${item.workspace ?? ""}`.toLocaleLowerCase().includes(normalized))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const groups = new Map<string, { key: string; label: string; threads: AgentThread[] }>();
    for (const item of filtered) {
      const key = item.workspace?.trim() || "__default__";
      const label = item.workspace?.split(/[\\/]/).filter(Boolean).pop() || tr("默认项目", "Default project");
      const group = groups.get(key) ?? { key, label, threads: [] };
      group.threads.push(item);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [catalog, query]);
  const selected = catalog.find((item) => item.id === threadId) ?? threads.find((item) => item.id === threadId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const toggleGroup = (key: string) => (normalizedQuery ? setCollapsedSearchGroups : setCollapsedGroups)((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const choose = () => { if (selected) onChoose(selected); };
  return <SourceDialog title={tr("选择会话", "Choose conversation")} onClose={onClose}>
    <label className="constellation-source-search"><Search size={14} /><input autoFocus placeholder={tr("搜索会话", "Search conversations")} value={query} onChange={(event) => { setQuery(event.target.value); setCollapsedSearchGroups(new Set()); }} /></label>
    <div className="constellation-thread-picker-list">
      {grouped.map((group) => {
        const collapsed = (normalizedQuery ? collapsedSearchGroups : collapsedGroups).has(group.key);
        const active = group.threads.some((item) => item.id === threadId);
        return <section className={`constellation-thread-group${active ? " active" : ""}`} key={group.key}>
          <div className="constellation-thread-project-row">
            <button
              type="button"
              className="constellation-thread-project-toggle"
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? tr("展开项目", "Expand project") : tr("折叠项目", "Collapse project")} ${group.label}`}
              title={group.key === "__default__" ? tr("默认项目", "Default project") : group.key}
              onClick={() => toggleGroup(group.key)}
            >
              <ChevronRight className="constellation-thread-project-chevron" size={14} />
              {collapsed ? <Folder size={16} /> : <FolderOpen size={16} />}
              <span className="constellation-thread-project-meta"><strong>{group.label}</strong><small>{group.threads.length} {tr("个会话", "conversations")}</small></span>
            </button>
          </div>
          {!collapsed && <div className="constellation-thread-group-threads">
            {group.threads.map((item) => <div className="constellation-thread-row" key={item.id}>
              <button type="button" className={item.id === threadId ? "active" : ""} aria-pressed={item.id === threadId} title={item.title || tr("新会话", "New conversation")} onClick={() => setThreadId(item.id)}>
                <MessageSquareText size={14} />
                <span className="constellation-thread-title">{item.title || tr("新会话", "New conversation")}</span>
                {item.id === threadId && <span className="constellation-thread-selected">{tr("已选", "Selected")}</span>}
              </button>
            </div>)}
          </div>}
        </section>;
      })}
      {grouped.length === 0 && <p className="constellation-thread-picker-empty">{tr("没有匹配的会话", "No matching conversations")}</p>}
      {cursor && <button className="constellation-thread-load-more" type="button" onClick={() => { void listThreadSummaries(query, cursor).then((page) => { setCatalog((current) => [...current, ...page.threads.filter((item) => !current.some((old) => old.id === item.id))]); setCursor(page.nextCursor ?? undefined); }).catch((reason) => setError(String(reason))); }}>{tr("加载更多会话", "Load more conversations")}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" className="constellation-thread-create" onClick={onCreate}><Plus size={14} />{tr("新建会话", "New conversation")}</button><small>{selected ? tr(`将复用“${selected.title}”的完整会话能力`, `Reuse the full conversation capability of “${selected.title}”`) : tr("未选择时，运行节点会自动新建会话", "If none is selected, running the node creates a new conversation")}</small><button type="button" disabled={!selected} onClick={choose}>{tr("使用此会话", "Use conversation")}</button></footer>
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

