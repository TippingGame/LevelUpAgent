import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, GripVertical, Plus, Search, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { mediaAssetUrl } from "../lib/bridge";
import { normalizeConstellationGraph, type ConstellationBlueprint, type ConstellationGraph } from "../lib/constellation";
import type { ConstellationProjectRecord } from "../lib/types";
import { tr } from "../lib/i18n";

export function ConstellationOverview({ ready, loading, onRetry, onMedia, onWriting, records, query, error, onQuery, onOpen, onCreate, onImport, onCreateTemplate, onPosition, onRename, onDuplicate, onDelete, templates, onDismissError }: {
  ready: boolean;
  loading: boolean;
  onRetry: () => void;
  onMedia: () => void;
  onWriting: () => void;
  records: ConstellationProjectRecord[];
  query: string;
  error?: string;
  onQuery: (value: string) => void;
  onOpen: (record: ConstellationProjectRecord) => void;
  onCreate: () => void;
  onImport: () => void;
  onCreateTemplate: (blueprint: ConstellationBlueprint) => void;
  onPosition: (record: ConstellationProjectRecord, position: { x: number; y: number }) => void;
  onRename: (record: ConstellationProjectRecord, title: string) => void;
  onDuplicate: (record: ConstellationProjectRecord) => void;
  onDelete: (record: ConstellationProjectRecord) => void;
  templates: ConstellationBlueprint[];
  onDismissError: () => void;
}) {
  const projects = useMemo(() => [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map((record, index) => {
    const payload = isRecord(record.payload) ? record.payload : {};
    const raw = payload.overviewPosition;
    const position = payload.overviewLayoutVersion === 2 && isRecord(raw) && Number.isFinite(raw.x) && Number.isFinite(raw.y) ? { x: Number(raw.x), y: Number(raw.y) } : overviewPositionFor(index);
    return { record, graph: graphFromProjectRecord(record), position };
  }), [records]);
  const filtered = projects.filter(({ record }) => !query.trim() || record.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const planeHeight = Math.max(340, ...projects.map(({ position }) => position.y + 260));
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const selectedTemplate = templates.find((template) => template.id === templateId);
  return <section className="constellation-overview">
    <header><div><span>✦</span><div><strong>{tr("星图", "Constellation")}</strong><small>{tr("把灵感连成作品", "Connect ideas into finished work")}</small></div></div><div><button type="button" onClick={onMedia}>{tr("媒体", "Media")}</button><button type="button" onClick={onWriting}>{tr("写作", "Writing")}</button><label><Search size={14} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={tr("寻找一片星图", "Find a constellation")} /></label><button type="button" disabled={!ready} onClick={onCreate}><Plus size={14} />{tr("新建项目", "New project")}</button><select aria-label={tr("选择模板", "Choose template")} value={templateId} onChange={(event) => setTemplateId(event.target.value)}><option value="">{tr("模板", "Template")}</option>{templates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select><button type="button" disabled={!ready || !selectedTemplate} onClick={() => selectedTemplate && onCreateTemplate(selectedTemplate)}><Sparkles size={14} />{tr("从模板", "From template")}</button></div></header>
    <div className="constellation-starfield" aria-hidden="true">{Array.from({ length: 64 }, (_, index) => <i key={index} style={{ left: `${(index * 37 + 11) % 100}%`, top: `${(index * 19 + 7) % 100}%`, opacity: .15 + (index % 4) * .12, width: index % 7 === 0 ? 2 : 1, height: index % 7 === 0 ? 2 : 1 }} />)}</div>
    <div className="constellation-overview-intro"><small>YOUR CREATIVE UNIVERSE</small><h1>{tr("让灵感，在这里相遇。", "A place for ideas to meet.")}</h1><p>{tr("每一扇小窗，都是一份可以继续生长的创作。", "Every window holds a creation ready to grow.")}</p></div>
    <div className="constellation-project-grid" style={{ height: planeHeight }} inert={!ready}>
      {filtered.map(({ record, graph, position }) => <ConstellationProjectCard key={record.id} record={record} graph={graph} position={position} onOpen={onOpen} onPosition={onPosition} onRename={onRename} onDuplicate={onDuplicate} onDelete={onDelete} />)}
      {loading && <div className="constellation-overview-empty" role="status">{tr("正在加载项目…", "Loading projects…")}</div>}
      {!loading && filtered.length === 0 && <div className="constellation-overview-empty"><Sparkles size={24} /><span>{query ? tr("没有找到这片星图", "No matching constellation") : tr("从一个想法开始", "Start with an idea")}</span><button type="button" disabled={!ready} onClick={onCreate}>{tr("创建第一份项目", "Create your first project")}</button></div>}
    </div>
    {error && <div className="constellation-overview-error" role="alert"><CircleAlert size={14} /><span>{error}</span>{!ready && <button type="button" onClick={onRetry}>{tr("重试加载", "Retry loading")}</button>}<button type="button" onClick={onDismissError}><X size={14} /></button></div>}
    <footer>{tr("点开一份创作，进入它的蓝图。", "Open a creation to enter its blueprint.")} <button type="button" disabled={!ready} onClick={onImport}>{tr("导入项目", "Import project")}</button></footer>
  </section>;
}

function ConstellationProjectCard({ record, graph, position, onOpen, onPosition, onRename, onDuplicate, onDelete }: {
  record: ConstellationProjectRecord;
  graph: ConstellationGraph | null;
  position: { x: number; y: number };
  onOpen: (record: ConstellationProjectRecord) => void;
  onPosition: (record: ConstellationProjectRecord, position: { x: number; y: number }) => void;
  onRename: (record: ConstellationProjectRecord, title: string) => void;
  onDuplicate: (record: ConstellationProjectRecord) => void;
  onDelete: (record: ConstellationProjectRecord) => void;
}) {
  const dragRef = useRef<{ pointerId: number; x: number; y: number; origin: { x: number; y: number } } | undefined>(undefined);
  const [offset, setOffset] = useState(position);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(record.title);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setOffset(position), [position.x, position.y]);
  useEffect(() => { if (!editing) setTitle(record.title); }, [editing, record.title]);
  const clamp = (x: number, y: number) => ({ x: Math.max(-350, Math.min(220, x)), y: Math.max(0, Math.min(100000, y)) });
  return <article className="constellation-project-card" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
    <button type="button" className="constellation-project-drag" aria-label={tr(`移动 ${record.title}`, `Move ${record.title}`)} title={tr("拖动排列；方向键微调", "Drag to arrange; arrow keys to adjust")}
      onKeyDown={(event) => {
        const delta = event.shiftKey ? 40 : 10;
        const dx = event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0;
        const dy = event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0;
        if (!dx && !dy) return;
        event.preventDefault(); const next = clamp(offset.x + dx, offset.y + dy); setOffset(next); onPosition(record, next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: offset };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return;
        setOffset(clamp(drag.origin.x + event.clientX - drag.x, drag.origin.y + event.clientY - drag.y));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId);
        onPosition(record, clamp(drag.origin.x + event.clientX - drag.x, drag.origin.y + event.clientY - drag.y));
      }}
      onPointerCancel={() => { dragRef.current = undefined; setOffset(position); }}><GripVertical size={13} /></button>
    <button type="button" className="constellation-project-open" onClick={() => onOpen(record)}>
      <div className="constellation-project-cover"><ProjectPreview graph={graph} /></div>
      <strong>{record.title}</strong><small>{tr(`${graph?.nodes.length ?? 0} 个创作节点`, `${graph?.nodes.length ?? 0} creative nodes`)} · {new Date(record.updatedAt).toLocaleDateString()}</small>
    </button>
    {editing ? <form className="constellation-project-title-edit" onSubmit={(event) => { event.preventDefault(); if (title.trim()) { onRename(record, title); setEditing(false); } }}>
      <input autoFocus aria-label={tr("项目名称", "Project name")} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }} />
      <button type="submit" aria-label={tr("保存名称", "Save name")}><Check size={12} /></button><button type="button" aria-label={tr("取消", "Cancel")} onClick={() => setEditing(false)}><X size={12} /></button>
    </form> : deleting ? <div className="constellation-project-delete-confirm" role="alert"><span>{tr("删除此项目？", "Delete this project?")}</span><button type="button" onClick={() => onDelete(record)}>{tr("确认删除", "Delete")}</button><button type="button" onClick={() => setDeleting(false)}>{tr("取消", "Cancel")}</button></div> : <div className="constellation-project-actions">
      <button type="button" onClick={() => { setTitle(record.title); setEditing(true); }} title={tr("重命名", "Rename")}><Settings2 size={12} /></button>
      <button type="button" onClick={() => onDuplicate(record)} title={tr("复制项目", "Duplicate")}><Plus size={12} /></button>
      <button type="button" onClick={() => setDeleting(true)} title={tr("删除项目", "Delete")}><Trash2 size={12} /></button>
    </div>}
  </article>;
}

const ProjectPreview = memo(function ProjectPreview({ graph }: { graph: ConstellationGraph | null }) {
  const nodes = graph?.nodes ?? [];
  const image = nodes.flatMap((node) => Object.values(node.data.outputs ?? {})).find((value) => value?.type === "image" && value.asset && mediaAssetUrl(value.asset));
  if (image?.asset) return <img src={mediaAssetUrl(image.asset)} alt="" />;
  if (!nodes.length) return <span className="constellation-cover-empty">✦</span>;
  const minX = Math.min(...nodes.map((node) => node.position.x)); const minY = Math.min(...nodes.map((node) => node.position.y));
  const width = Math.max(300, ...nodes.map((node) => node.position.x - minX + 260)); const height = Math.max(180, ...nodes.map((node) => node.position.y - minY + 170));
  const points = new Map(nodes.map((node) => [node.id, { x: node.position.x - minX + 130, y: node.position.y - minY + 85 }]));
  return <svg viewBox={`-40 -40 ${width + 80} ${height + 80}`} aria-hidden="true">
    {graph?.edges.map((edge) => { const a = points.get(edge.source); const b = points.get(edge.target); return a && b ? <path key={edge.id} d={`M${a.x},${a.y} C${(a.x+b.x)/2},${a.y} ${(a.x+b.x)/2},${b.y} ${b.x},${b.y}`} fill="none" stroke="#8296ba" strokeWidth="5" opacity=".55" /> : null; })}
    {nodes.map((node) => { const p = points.get(node.id)!; return <g key={node.id}><rect x={p.x-105} y={p.y-55} width="210" height="110" rx="12" fill="#fff" stroke="#cbd5e1" strokeWidth="3" /><circle cx={p.x-80} cy={p.y-30} r="7" fill="#8b5cf6" /><path d={`M${p.x-57},${p.y-30}h110 M${p.x-78},${p.y}h155 M${p.x-78},${p.y+20}h90`} stroke="#94a3b8" strokeWidth="6" opacity=".5" /></g>; })}
  </svg>;
});

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function graphFromProjectRecord(record: ConstellationProjectRecord) {
  const payload = isRecord(record.payload) ? record.payload : {};
  return normalizeConstellationGraph(payload.graph ?? payload);
}
export function overviewPositionFor(index: number) { return { x: -350 + (index % 3) * 246, y: Math.floor(index / 3) * 250 + (index % 3 === 1 ? 30 : 0) }; }

export function overviewPositionForRecords(records: ConstellationProjectRecord[]) {
  const occupied = records.map((record, index) => {
    const payload = isRecord(record.payload) ? record.payload : {};
    const position = payload.overviewPosition;
    return payload.overviewLayoutVersion === 2 && isRecord(position) && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? { x: Number(position.x), y: Number(position.y) }
      : overviewPositionFor(index);
  });
  for (let index = 0; index < 100_000; index += 1) {
    const candidate = overviewPositionFor(index);
    if (!occupied.some((position) => Math.abs(candidate.x - position.x) < 236 && Math.abs(candidate.y - position.y) < 235)) return candidate;
  }
  return overviewPositionFor(records.length);
}
