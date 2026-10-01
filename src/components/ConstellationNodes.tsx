import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import {
  AudioLines,
  BookOpenText,
  Brush,
  Wrench,
  Link2,
  Globe2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Plus,
  Play,
  RefreshCw,
  ScanLine,
  Sparkles,
  StickyNote,
  Trash2,
  Video,
  Volume2,
  WandSparkles,
} from "lucide-react";
import { mediaAssetUrl, previewAttachment } from "../lib/bridge";
import {
  CONSTELLATION_NODE_DEFINITIONS,
  DEFAULT_CONSTELLATION_TOOL_TEMPLATE,
  constellationNodePorts,
  sameConstellationValue,
  UNIVERSAL_INPUT_HANDLE,
  UNIVERSAL_OUTPUT_HANDLE,
  type ConstellationEdge,
  type ConstellationModelRoute,
  type ConstellationNode,
  type ConstellationNodeData,
  type ConstellationNodeKind,
  type ConstellationValue,
} from "../lib/constellation";
import { tr } from "../lib/i18n";
import type { ConstellationToolTemplate, ImageAttachment, MediaKind, MediaModelInfo, ProviderModelInfo } from "../lib/types";


export interface ConstellationNodeActions {
  locale: string;
  edges: ConstellationEdge[];
  mediaModels: MediaModelInfo[];
  writingModels: ProviderModelInfo[];
  running: boolean;
  updateNode: (nodeId: string, patch: Partial<ConstellationNodeData>) => void;
  runNode: (nodeId: string) => void;
  removeNode: (nodeId: string) => void;
  chooseReferences: (nodeId: string, kind: "image" | "video") => void;
  openImageSourcePicker: (nodeId: string, purpose: "canvas" | "image") => void;
  openCanvas: (nodeId: string) => void;
  openPreview: (value: ConstellationValue) => void;
  downloadValue: (value: ConstellationValue) => void;
  getInputValue: (nodeId: string, handle: string) => ConstellationValue | undefined;
  openSourcePicker: (nodeId: string, kind: "conversation" | "input" | "projectRef") => void;
  openConversation: (threadId: string) => void;
  selectCandidate: (nodeId: string, handle: string, index: number) => void;
  refreshCandidates: (nodeId: string) => void;
  toolTemplates: ConstellationToolTemplate[];
  saveToolTemplate: (nodeId: string) => void;
}

const NodeActionsContext = createContext<ConstellationNodeActions | null>(null);

export function ConstellationNodeActionsProvider({
  value,
  children,
}: {
  value: ConstellationNodeActions;
  children: React.ReactNode;
}) {
  return <NodeActionsContext.Provider value={value}>{children}</NodeActionsContext.Provider>;
}

function useNodeActions() {
  const value = useContext(NodeActionsContext);
  if (!value) throw new Error("Constellation node actions are unavailable");
  return value;
}

const NODE_ICONS: Record<ConstellationNodeKind, ComponentType<{ size?: number; className?: string }>> = {
  conversation: BookOpenText,
  input: Globe2,
  localTool: Wrench,
  projectRef: Link2,
  prompt: FileText,
  writing: BookOpenText,
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
  canvas: Brush,
  output: ScanLine,
  note: StickyNote,
};

const MEDIA_KIND_BY_NODE: Partial<Record<ConstellationNodeKind, MediaKind>> = {
  image: "image",
  video: "video",
  audio: "audio",
};

function modelRouteKey(route: ConstellationModelRoute) {
  return `${route.profileId}::${route.model}::${route.protocol}`;
}

function mediaModelRoute(model: MediaModelInfo): ConstellationModelRoute {
  return {
    profileId: model.profileId,
    profileName: model.profileName,
    model: model.id,
    protocol: model.protocol,
  };
}

function writingModelRoute(model: ProviderModelInfo): ConstellationModelRoute {
  return {
    profileId: model.profileId,
    profileName: model.profileName,
    model: model.id,
    protocol: model.protocol,
  };
}

export function ConstellationNodeCard({ id, data, selected, isConnectable }: NodeProps<ConstellationNode>) {
  return <ConstellationNodeContent id={id} data={data} selected={selected} isConnectable={isConnectable} />;
}

const ConstellationNodeContent = memo(function ConstellationNodeContent({ id, data, selected, isConnectable }: Pick<NodeProps<ConstellationNode>, "id" | "data" | "selected" | "isConnectable">) {
  const actions = useNodeActions();
  const definition = CONSTELLATION_NODE_DEFINITIONS[data.kind];
  const inputs = constellationNodePorts({ id, type: "constellation", data, position: { x: 0, y: 0 } }, "input");
  const outputs = constellationNodePorts({ id, type: "constellation", data, position: { x: 0, y: 0 } }, "output");
  const Icon = NODE_ICONS[data.kind];
  const collapsed = Boolean(data.collapsed);
  const updateNodeInternals = useUpdateNodeInternals();
  const inputSignature = inputs.map((port) => `${port.id}:${port.type}`).join(",");
  const outputSignature = outputs.map((port) => `${port.id}:${port.type}`).join(",");
  useEffect(() => updateNodeInternals(id), [id, collapsed, selected, inputSignature, outputSignature, updateNodeInternals]);
  const statusLabel = data.status === "running"
    ? tr("执行中", "Running")
    : data.status === "queued"
      ? tr("等待中", "Queued")
      : data.status === "success"
        ? tr("已完成", "Done")
        : data.status === "error"
          ? tr("需要处理", "Needs attention")
          : data.status === "stale" ? tr("输入已变化", "Inputs changed") : data.status === "waiting" ? tr("等待选择结果", "Choose an output") : tr("就绪", "Ready");

  return (
    <article
      className={`constellation-node kind-${data.kind} status-${data.status}${selected ? " selected" : ""}${collapsed ? " collapsed" : ""}`}
      aria-label={`${tr(definition.label, definition.labelEn)} · ${statusLabel}`}
    >
      <header className="constellation-node-header">
        <span className="constellation-node-icon"><Icon size={15} /></span>
        <div>
          <input
            className="nodrag nopan"
            disabled={actions.running}
            value={data.title}
            maxLength={64}
            aria-label={tr("节点名称", "Node name")}
            onChange={(event) => actions.updateNode(id, { title: event.target.value })}
          />
          <small>{statusLabel}</small>
        </div>
        <span className="constellation-node-status" aria-hidden="true">
          {data.status === "running" || data.status === "queued"
            ? <LoaderCircle className="spin" size={13} />
            : data.status === "success"
              ? <CircleCheck size={13} />
              : data.status === "error"
                ? <CircleAlert size={13} />
                : <Sparkles size={12} />}
        </span>
        <button
          type="button"
          className="nodrag constellation-node-icon-button"
          title={collapsed ? tr("展开节点", "Expand node") : tr("折叠节点", "Collapse node")}
          onClick={() => actions.updateNode(id, { collapsed: !collapsed })}
        >
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        <button
          type="button"
          className="nodrag constellation-node-icon-button danger"
          disabled={actions.running}
          title={tr("删除节点", "Delete node")}
          onClick={() => actions.removeNode(id)}
        >
          <Trash2 size={13} />
        </button>
      </header>

      {inputs.length > 0 && <Handle
        type="target"
        position={Position.Left}
        id={UNIVERSAL_INPUT_HANDLE}
        isConnectable={isConnectable && !actions.running}
        className="constellation-universal-handle constellation-universal-input"
        aria-label={tr("通用输入连接点", "Universal input connection point")}
        title={tr("拖到卡片任意位置，自动匹配输入", "Drop on the card to automatically match an input")}
      />}
      {outputs.length > 0 && <Handle
        type="source"
        position={Position.Right}
        id={UNIVERSAL_OUTPUT_HANDLE}
        isConnectable={isConnectable && !actions.running}
        className="constellation-universal-handle constellation-universal-output"
        aria-label={tr("通用输出连接点", "Universal output connection point")}
        title={tr("从卡片拖出，自动匹配输出", "Drag from the card to automatically match an output")}
      />}

      {!collapsed && (
        <>
          {selected && inputs.length > 0 && (
            <div className="constellation-node-ports inputs" aria-label={tr("输入端口", "Input ports")}>
              {inputs.map((port) => {
                const connected = actions.edges.some((edge) => edge.target === id && edge.targetHandle === port.id);
                return (
                  <div className={`constellation-port-row input type-${port.type}${connected ? " connected" : ""}`} key={port.id}>
                    <span>{tr(port.label, port.labelEn)}</span>
                    {port.optional && <small>{tr("可选", "optional")}</small>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="constellation-node-body" inert={actions.running}>
          {data.kind === "conversation" && <ConversationNodeBody id={id} data={data} />}
            {data.kind === "input" && <InputNodeBody id={id} data={data} />}
            {data.kind === "localTool" && <LocalToolNodeBody id={id} data={data} />}
            {data.kind === "projectRef" && <ProjectReferenceNodeBody id={id} data={data} />}
            {data.kind === "prompt" && <PromptNodeBody id={id} data={data} />}
            {data.kind === "writing" && <WritingNodeBody id={id} data={data} />}
            {data.kind === "image" && <ImageNodeBody id={id} data={data} />}
            {data.kind === "video" && <VideoNodeBody id={id} data={data} />}
            {data.kind === "audio" && <AudioNodeBody id={id} data={data} />}
            {data.kind === "canvas" && <CanvasNodeBody id={id} data={data} />}
            {data.kind === "output" && <OutputNodeBody id={id} data={data} />}
            {data.kind === "note" && <NoteNodeBody id={id} data={data} />}
          </div>

          {data.error && (
            <div className="constellation-node-error" title={data.error}>
              <CircleAlert size={12} /><span>{data.error}</span>
            </div>
          )}

          {Object.entries(data.outputCandidates ?? {}).some(([, values]) => (values?.length ?? 0) > 0) && (
            <CandidatePicker id={id} candidates={data.outputCandidates ?? {}} selected={data.outputs ?? {}} stale={data.status === "stale"} />
          )}

          {selected && outputs.length > 0 && (
            <div className="constellation-node-ports outputs" aria-label={tr("输出端口", "Output ports")}>
              {outputs.map((port) => {
                const ready = Boolean(data.outputs?.[port.id]);
                return (
                  <div className={`constellation-port-row output type-${port.type}${ready ? " ready" : ""}`} key={port.id}>
                    {ready && <CircleCheck size={10} />}
                    <span>{tr(port.label, port.labelEn)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {data.kind !== "note" && data.kind !== "prompt" && (
        <button
          type="button"
          className="nodrag constellation-node-run"
          disabled={actions.running}
          onClick={() => actions.runNode(id)}
        >
          {data.status === "running" ? <LoaderCircle className="spin" size={13} /> : <Play size={12} />}
          {tr("运行到这里", "Run to here")}
        </button>
      )}
    </article>
  );
});

function ConversationNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const threadId = data.conversationThreadId;
  const threadTitle = data.conversationThreadTitle;
  return <>
    <label className="constellation-field"><span>{tr("本轮命令", "Session command")}</span><textarea className="nodrag nowheel" value={data.sessionCommand ?? ""} maxLength={32_000} placeholder={tr("例如：把上游内容整理成下一步执行计划", "For example: turn the upstream content into the next execution plan")} onChange={(event) => actions.updateNode(id, { sessionCommand: event.target.value, outputs: undefined, status: "idle" })} /></label>
    <div className="constellation-node-actions">
      <button type="button" className="nodrag constellation-source-button" onClick={() => actions.openSourcePicker(id, "conversation")}><BookOpenText size={13} />{threadId ? tr("更换会话", "Change conversation") : tr("选择会话", "Choose conversation")}</button>
      {threadId && <button type="button" className="nodrag constellation-source-button" onClick={() => actions.openConversation(threadId)}><ExternalLink size={13} />{tr("打开会话", "Open conversation")}</button>}
    </div>
    <small className="constellation-conversation-binding">{threadId ? threadTitle || tr("已绑定会话", "Conversation bound") : tr("未绑定会话；运行时会自动新建", "No conversation bound; a new one is created when this runs")}</small>
    {data.outputs?.text && <ValuePreview value={data.outputs.text} />}
  </>;
}

function InputNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const mode = data.inputMode ?? "text";
  return <>
    <div className="constellation-segmented nodrag" role="radiogroup" aria-label={tr("输入类型", "Input type")}>
      {([["text", tr("文本", "Text")], ["file", tr("文件", "File")], ["url", tr("网址", "URL")]] as const).map(([value, label]) => <button type="button" role="radio" aria-checked={mode === value} className={mode === value ? "active" : ""} key={value} onClick={() => actions.updateNode(id, { inputMode: value, inputAttachment: undefined, inputPath: value === "file" ? data.inputPath : "", outputs: undefined, status: "idle" })}>{label}</button>)}
    </div>
    {mode === "text" && <label className="constellation-field"><span>{tr("输入文本", "Input text")}</span><textarea className="nodrag nowheel" value={data.inputText ?? ""} maxLength={80_000} onChange={(event) => actions.updateNode(id, { inputText: event.target.value, outputs: undefined, status: "idle" })} /></label>}
    {mode === "file" && <><button type="button" className="nodrag constellation-source-button" onClick={() => actions.openSourcePicker(id, "input")}><FolderInputIcon />{tr("选择本地文件", "Choose local file")}</button><label className="constellation-field"><span>{tr("文件路径", "File path")}</span><input className="nodrag" value={data.inputPath ?? ""} placeholder={tr("选择后自动填写", "Filled after selection")} onChange={(event) => actions.updateNode(id, { inputPath: event.target.value, inputAttachment: undefined, inputText: undefined, outputs: undefined, status: "idle" })} /></label></>}
    {mode === "url" && <label className="constellation-field"><span>URL</span><input className="nodrag" type="url" value={data.inputUrl ?? ""} placeholder="https://" onChange={(event) => actions.updateNode(id, { inputUrl: event.target.value, outputs: undefined, status: "idle" })} /></label>}
    {data.outputs?.text && <ValuePreview value={data.outputs.text} />}
  </>;
}

function LocalToolNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const template = data.toolTemplate;
  const fields = template?.inputSchema ?? [];
  const builtInTemplates = actions.toolTemplates.filter((item) => item.id === DEFAULT_CONSTELLATION_TOOL_TEMPLATE.id);
  const savedTemplates = actions.toolTemplates.filter((item) => item.id !== DEFAULT_CONSTELLATION_TOOL_TEMPLATE.id);
  const updateTemplate = (next: ConstellationToolTemplate) => actions.updateNode(id, { toolTemplate: next, legacyToolName: undefined, outputs: undefined, status: "idle" });
  return <>
    <label className="constellation-field"><span>{tr("工具模板", "Tool template")}</span><select className="nodrag nowheel" value={data.toolTemplateId ?? template?.id ?? ""} onChange={(event) => { const next = actions.toolTemplates.find((item) => item.id === event.target.value); if (next) actions.updateNode(id, { toolTemplateId: next.id, toolTemplate: structuredClone(next), legacyToolName: undefined, toolInputs: Object.fromEntries(next.inputSchema.map((field) => [field.id, field.defaultValue ?? ""])), outputs: undefined, status: "idle" }); }}>
      {actions.toolTemplates.length === 0 && <option value="">{tr("暂无模板", "No templates")}</option>}
      {builtInTemplates.length > 0 && <optgroup label={tr("内置示例", "Built-in examples")}>{builtInTemplates.map((item) => <option value={item.id} key={item.id}>{item.name}{tr("（内置）", " (built-in)")}</option>)}</optgroup>}
      {savedTemplates.length > 0 && <optgroup label={tr("我的模板", "My templates")}>{savedTemplates.map((item, index) => {
        const sameName = savedTemplates.filter((other) => other.name === item.name);
        const ordinal = savedTemplates.slice(0, index + 1).filter((other) => other.name === item.name).length;
        return <option value={item.id} key={item.id}>{item.name}{tr("（自定义）", " (custom)")}{sameName.length > 1 ? ` · ${ordinal}` : ""}</option>;
      })}</optgroup>}
    </select></label>
    {template && <>
      <label className="constellation-field"><span>{tr("模板名称", "Template name")}</span><input className="nodrag" value={template.name} maxLength={120} onChange={(event) => actions.updateNode(id, { toolTemplate: { ...template, name: event.target.value }, legacyToolName: undefined, outputs: undefined, status: "idle" })} /></label>
      <label className="constellation-field"><span>{tr("命令模板", "Command template")}</span><textarea className="nodrag nowheel compact" value={template.command} maxLength={20_000} onChange={(event) => actions.updateNode(id, { toolTemplate: { ...template, command: event.target.value }, legacyToolName: undefined, outputs: undefined, status: "idle" })} /></label>
      <label className="constellation-field"><span title={tr("命令中的 {{args}} 会替换为这里的参数模板", "{{args}} in the command is replaced with this argument template")}>{tr("参数模板", "Argument template")}</span><textarea className="nodrag nowheel compact" value={template.argumentTemplate} maxLength={20_000} onChange={(event) => actions.updateNode(id, { toolTemplate: { ...template, argumentTemplate: event.target.value }, legacyToolName: undefined, outputs: undefined, status: "idle" })} /></label>
      <div className="constellation-tool-schema-heading"><strong>{tr("输入字段", "Input fields")}</strong><button type="button" className="nodrag" onClick={() => updateTemplate({ ...template, inputSchema: [...template.inputSchema, { id: `field${template.inputSchema.length + 1}`, name: tr("新字段", "New field"), type: "text", required: false }] })}><Plus size={12} />{tr("添加", "Add")}</button></div>
      {fields.map((field, index) => <div className="constellation-tool-field" key={`${field.id}-${index}`}><input className="nodrag" aria-label={tr("字段名称", "Field name")} value={field.name} onChange={(event) => updateTemplate({ ...template, inputSchema: template.inputSchema.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} /><input className="nodrag" aria-label={tr("字段 ID", "Field id")} value={field.id} onChange={(event) => updateTemplate({ ...template, inputSchema: template.inputSchema.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) } : item) })} /><select className="nodrag nowheel" value={field.type} onChange={(event) => updateTemplate({ ...template, inputSchema: template.inputSchema.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as typeof item.type } : item) })}><option value="text">text</option><option value="number">number</option><option value="boolean">boolean</option><option value="json">json</option></select><label><input className="nodrag" type="checkbox" checked={field.required} onChange={(event) => updateTemplate({ ...template, inputSchema: template.inputSchema.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item) })} />{tr("必填", "Required")}</label><button type="button" className="nodrag constellation-node-icon-button danger" title={tr("删除字段", "Delete field")} onClick={() => updateTemplate({ ...template, inputSchema: template.inputSchema.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={11} /></button></div>)}
      {fields.map((field) => <label className="constellation-field" key={`value-${field.id}`}><span>{field.name}{field.required ? " *" : ""}</span><input className="nodrag" value={data.toolInputs?.[field.id] ?? field.defaultValue ?? ""} placeholder={`{{field:${field.id}}}`} onChange={(event) => actions.updateNode(id, { toolInputs: { ...(data.toolInputs ?? {}), [field.id]: event.target.value }, outputs: undefined, status: "idle" })} /></label>)}
      <div className="constellation-tool-schema-heading"><strong>{tr("输出字段", "Output fields")}</strong><button type="button" className="nodrag" onClick={() => updateTemplate({ ...template, outputSchema: [...template.outputSchema, { id: `output${template.outputSchema.length + 1}`, name: tr("输出字段", "Output field"), type: "text", source: `{{json:output${template.outputSchema.length + 1}}}` }] })}><Plus size={12} />{tr("添加", "Add")}</button></div>
      {(template.outputSchema ?? []).map((field, index) => <div className="constellation-tool-field constellation-tool-output-field" key={`${field.id}-${index}`}><input className="nodrag" aria-label={tr("输出名称", "Output name")} value={field.name} onChange={(event) => updateTemplate({ ...template, outputSchema: template.outputSchema.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} /><input className="nodrag" aria-label={tr("输出 ID", "Output id")} value={field.id} onChange={(event) => updateTemplate({ ...template, outputSchema: template.outputSchema.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) } : item) })} /><select className="nodrag nowheel" value={field.type} onChange={(event) => updateTemplate({ ...template, outputSchema: template.outputSchema.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as typeof item.type } : item) })}><option value="text">text</option><option value="json">json</option></select><input className="nodrag" aria-label={tr("输出来源", "Output source")} value={field.source ?? "{{stdout}}"} placeholder="{{stdout}} / {{json:key}}" onChange={(event) => updateTemplate({ ...template, outputSchema: template.outputSchema.map((item, itemIndex) => itemIndex === index ? { ...item, source: event.target.value } : item) })} /><button type="button" className="nodrag constellation-node-icon-button danger" title={tr("删除输出", "Delete output")} onClick={() => updateTemplate({ ...template, outputSchema: template.outputSchema.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={11} /></button></div>)}
      <div className="constellation-tool-footer">
        <p className="constellation-source-hint">{tr("命令变量：{{input}} 上游文本、{{field:id}} 字段、{{json}} 全部字段、{{args}} 参数模板。", "Command variables: {{input}} upstream text, {{field:id}} field, {{json}} all fields, {{args}} argument template.")}</p>
        <div className="constellation-node-actions"><button type="button" className="nodrag constellation-source-button" onClick={() => actions.saveToolTemplate(id)}><Wrench size={13} />{tr("保存为可复用模板", "Save reusable template")}</button></div>
      </div>
    </>}
    {data.outputs?.text && <ValuePreview value={data.outputs.text} />}
  </>;
}

function ProjectReferenceNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const reference = data.projectReference;
  return <div className="constellation-source-summary">
    <button type="button" className="nodrag constellation-source-button" onClick={() => actions.openSourcePicker(id, "projectRef")}><Link2 size={13} />{tr("选择作品输出", "Choose project output")}</button>
    {reference && <button type="button" className="nodrag constellation-source-button" onClick={() => actions.refreshCandidates(id)} disabled={actions.running}><RefreshCw size={12} />{tr("刷新来源", "Refresh source")}</button>}
    <strong>{reference ? tr("已固定作品快照", "Pinned project snapshot") : tr("未选择作品", "No project selected")}</strong>
    <small>{reference ? `${reference.projectId} · ${reference.nodeId} · ${reference.outputHandle}` : tr("选择后只在刷新时更新", "Refresh explicitly to update")}</small>
    {data.projectValue && <ValuePreview value={data.projectValue} />}
  </div>;
}

function CandidatePicker({
  id,
  candidates,
  selected,
  stale,
}: {
  id: string;
  candidates: Partial<Record<string, ConstellationValue[]>>;
  selected: Partial<Record<string, ConstellationValue>>;
  stale: boolean;
}) {
  const actions = useNodeActions();
  const entries = Object.entries(candidates).flatMap(([handle, values]) => (values ?? []).map((value, index) => ({ handle, value, index })));
  if (entries.length === 0) return null;
  return <section className="constellation-candidate-picker" aria-label={tr("候选结果", "Output candidates")}>
    <div className="constellation-candidate-heading"><span>{tr(`${entries.length} 个候选结果`, `${entries.length} output candidates`)}</span><button type="button" className="nodrag" onClick={() => actions.refreshCandidates(id)} disabled={actions.running} title={tr("刷新候选状态", "Refresh candidate status")}><RefreshCw size={12} />{tr("刷新", "Refresh")}</button></div>
    {stale && <small>{tr("输入已变化，请重新运行；以下为之前的结果。", "Inputs changed. Run again; these are previous results.")}</small>}
    <div className="constellation-candidate-list">
      {entries.map(({ handle, value, index }) => {
        const chosen = sameConstellationValue(selected[handle], value);
        const pending = value.asset && value.asset.status !== "completed";
        return <div className={`constellation-candidate${chosen ? " selected" : ""}`} key={`${handle}:${value.asset?.id ?? value.createdAt}:${index}`}>
          <ValuePreview value={value} thumbnail />
          <div className="constellation-candidate-meta"><strong>{handle} · {index + 1}</strong><small>{pending ? value.asset?.status : tr("可选择", "Ready to choose")}</small></div>
          <button type="button" className="nodrag" disabled={actions.running || stale || Boolean(pending) || chosen} onClick={() => actions.selectCandidate(id, handle, index)}>{chosen ? tr("已选择", "Selected") : tr("选择", "Choose")}</button>
        </div>;
      })}
    </div>
  </section>;
}

function FolderInputIcon() { return <Download size={13} />; }

function PromptNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  return (
    <label className="constellation-field">
      <span>{tr("创作指令", "Creative direction")}</span>
      <textarea
        className="nodrag nowheel"
        value={data.prompt ?? ""}
        maxLength={32_000}
        placeholder={tr("描述主体、构图、节奏、风格与限制…", "Describe subject, composition, pace, style, and constraints…")}
        onChange={(event) => actions.updateNode(id, { prompt: event.target.value, status: "idle" })}
      />
    </label>
  );
}

function WritingNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const models = actions.writingModels;
  const selected = data.modelRoute ? modelRouteKey(data.modelRoute) : "";
  const text = data.outputs?.text?.text;
  return (
    <>
      <ModelSelect
        value={selected}
        options={models.map((model) => ({
          key: modelRouteKey(writingModelRoute(model)),
          label: `${model.id} · ${model.profileName}`,
          route: writingModelRoute(model),
        }))}
        onChange={(route) => actions.updateNode(id, { modelRoute: route })}
      />
      <label className="constellation-field">
        <span>{tr("写作要求", "Writing direction")}</span>
        <textarea
          className="nodrag nowheel compact"
          value={data.instruction ?? ""}
          placeholder={tr("例如：改成三幕式分镜，只输出正文", "For example: rewrite as a three-act storyboard")}
          onChange={(event) => actions.updateNode(id, { instruction: event.target.value })}
        />
      </label>
      {text && <div className="constellation-text-preview">{text}</div>}
    </>
  );
}

function ImageNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const models = actions.mediaModels.filter((model) => model.kind === "image");
  const output = data.outputs?.image;
  const connectedPrompt = actions.edges.some((edge) => edge.target === id && edge.targetHandle === "prompt");
  const operation = data.operation ?? "generate";
  return (
    <>
      <div className="constellation-segmented nodrag" role="radiogroup" aria-label={tr("图像操作", "Image operation")}>
        {([
          ["generate", tr("生成", "Generate")],
          ["edit", tr("编辑", "Edit")],
          ["outpaint", tr("扩图", "Outpaint")],
          ["inpaint", tr("重绘", "Inpaint")],
        ] as const).map(([value, label]) => (
          <button
            type="button"
            role="radio"
            aria-checked={operation === value}
            className={operation === value ? "active" : ""}
            key={value}
            onClick={() => actions.updateNode(id, { operation: value, outputs: undefined, status: "idle", error: undefined })}
          >{label}</button>
        ))}
      </div>
      <ModelSelect
        value={data.modelRoute ? modelRouteKey(data.modelRoute) : ""}
        options={models.map((model) => ({
          key: modelRouteKey(mediaModelRoute(model)),
          label: `${model.recommended ? "★ " : ""}${model.id} · ${model.profileName}`,
          route: mediaModelRoute(model),
        }))}
        onChange={(route) => actions.updateNode(id, { modelRoute: route })}
      />
      {!connectedPrompt && (
        <label className="constellation-field">
          <span>{tr("节点提示词", "Node prompt")}</span>
          <textarea
            className="nodrag nowheel compact"
            value={data.prompt ?? ""}
            placeholder={tr("也可以连接提示词节点", "You can also connect a Prompt node")}
            onChange={(event) => actions.updateNode(id, { prompt: event.target.value })}
          />
        </label>
      )}
      <div className="constellation-option-grid">
        <label><span>{tr("尺寸", "Size")}</span><select className="nodrag nowheel" value={data.size ?? "auto"} onChange={(event) => actions.updateNode(id, { size: event.target.value })}>
          {["auto", "1024x1024", "1536x1024", "1024x1536", "16:9", "9:16", "21:9"].map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label><span>{tr("质量", "Quality")}</span><select className="nodrag nowheel" value={data.quality ?? "auto"} onChange={(event) => actions.updateNode(id, { quality: event.target.value })}>
          {["auto", "high", "medium", "2K", "4K"].map((value) => <option key={value}>{value}</option>)}
        </select></label>
      </div>
      <ReferencePicker id={id} references={data.references ?? []} kind="image" sourceOnly={operation !== "generate"} />
      {output && <ValuePreview value={output} />}
    </>
  );
}

function VideoNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const models = actions.mediaModels.filter((model) => model.kind === "video");
  const output = data.outputs?.video;
  const connectedPrompt = actions.edges.some((edge) => edge.target === id && edge.targetHandle === "prompt");
  return (
    <>
      <ModelSelect
        value={data.modelRoute ? modelRouteKey(data.modelRoute) : ""}
        options={models.map((model) => ({
          key: modelRouteKey(mediaModelRoute(model)),
          label: `${model.recommended ? "★ " : ""}${model.id} · ${model.profileName}`,
          route: mediaModelRoute(model),
        }))}
        onChange={(route) => actions.updateNode(id, { modelRoute: route })}
      />
      {!connectedPrompt && <label className="constellation-field"><span>{tr("节点提示词", "Node prompt")}</span><textarea className="nodrag nowheel compact" value={data.prompt ?? ""} onChange={(event) => actions.updateNode(id, { prompt: event.target.value })} /></label>}
      <div className="constellation-option-grid three">
        <label><span>{tr("比例", "Ratio")}</span><select className="nodrag nowheel" value={data.videoAspectRatio ?? "16:9"} onChange={(event) => actions.updateNode(id, { videoAspectRatio: event.target.value })}>{["16:9", "9:16"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>{tr("清晰度", "Resolution")}</span><select className="nodrag nowheel" value={data.videoResolution ?? "720p"} onChange={(event) => actions.updateNode(id, { videoResolution: event.target.value })}>{["480p", "720p", "1080p"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>{tr("时长", "Duration")}</span><select className="nodrag nowheel" value={data.seconds ?? 8} onChange={(event) => actions.updateNode(id, { seconds: Number(event.target.value) })}>{[4, 8, 10, 12].map((value) => <option value={value} key={value}>{value}s</option>)}</select></label>
      </div>
      <ReferencePicker id={id} references={data.references ?? []} kind="image" />
      {output && <ValuePreview value={output} />}
    </>
  );
}

function AudioNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const models = actions.mediaModels.filter((model) => model.kind === "audio");
  const output = data.outputs?.audio;
  const connectedText = actions.edges.some((edge) => edge.target === id && edge.targetHandle === "text");
  return (
    <>
      <ModelSelect
        value={data.modelRoute ? modelRouteKey(data.modelRoute) : ""}
        options={models.map((model) => ({ key: modelRouteKey(mediaModelRoute(model)), label: `${model.recommended ? "★ " : ""}${model.id} · ${model.profileName}`, route: mediaModelRoute(model) }))}
        onChange={(route) => actions.updateNode(id, { modelRoute: route })}
      />
      {!connectedText && <label className="constellation-field"><span>{tr("朗读文案", "Speech text")}</span><textarea className="nodrag nowheel compact" value={data.prompt ?? ""} onChange={(event) => actions.updateNode(id, { prompt: event.target.value })} /></label>}
      <div className="constellation-option-grid">
        <label><span>{tr("声音", "Voice")}</span><input className="nodrag" value={data.voice ?? ""} placeholder={tr("自动", "Auto")} onChange={(event) => actions.updateNode(id, { voice: event.target.value })} /></label>
        <label><span>{tr("格式", "Format")}</span><select className="nodrag nowheel" value={data.outputFormat ?? "mp3"} onChange={(event) => actions.updateNode(id, { outputFormat: event.target.value })}>{["mp3", "wav", "aac", "flac", "opus"].map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      <label className="constellation-field"><span>{tr("演绎要求", "Delivery")}</span><input className="nodrag" value={data.instruction ?? ""} onChange={(event) => actions.updateNode(id, { instruction: event.target.value })} /></label>
      {output && <ValuePreview value={output} />}
    </>
  );
}

function CanvasNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const upstream = actions.getInputValue(id, "image");
  const attachment = data.canvasResult ?? data.canvasSource ?? upstream?.attachment;
  return (
    <>
      <button type="button" className="nodrag constellation-canvas-launch" onClick={() => actions.openCanvas(id)}>
        <span>{attachment || upstream?.asset ? <AttachmentOrValuePreview attachment={attachment} value={upstream} /> : <Brush size={26} />}</span>
        <strong>{tr("打开画板", "Open canvas")}</strong>
        <small>{tr("画蒙版 · 加标签 · 撤销重做", "Paint mask · add labels · undo/redo")}</small>
        <Maximize2 size={14} />
      </button>
      <div className="constellation-canvas-meta">
        <span className={data.canvasResult ? "ready" : ""}>{data.canvasResult ? tr("标注图已就绪", "Annotated image ready") : tr("标注图", "Annotated image")}</span>
        <span className={data.maskAttachment ? "ready" : ""}>{data.maskAttachment ? tr("蒙版已就绪", "Mask ready") : tr("可选蒙版", "Optional mask")}</span>
      </div>
    </>
  );
}

function OutputNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  const input = actions.getInputValue(id, "media") ?? data.outputs?.media;
  return input ? <ValuePreview value={input} large /> : <div className="constellation-output-empty"><WandSparkles size={27} /><strong>{tr("等待作品抵达", "Waiting for an output")}</strong><span>{tr("连接任意图像、视频或语音输出", "Connect any image, video, or audio output")}</span></div>;
}

function NoteNodeBody({ id, data }: { id: string; data: ConstellationNodeData }) {
  const actions = useNodeActions();
  return (
    <>
      <textarea
        className="nodrag nowheel constellation-note-editor"
        value={data.prompt ?? ""}
        aria-label={tr("便签内容", "Note content")}
        onChange={(event) => actions.updateNode(id, { prompt: event.target.value })}
      />
      <div className="constellation-note-colors nodrag">
        {(["amber", "rose", "sky", "emerald"] as const).map((color) => <button type="button" className={`${color}${data.noteColor === color ? " active" : ""}`} aria-label={color} onClick={() => actions.updateNode(id, { noteColor: color })} key={color} />)}
      </div>
    </>
  );
}

function ModelSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ key: string; label: string; route: ConstellationModelRoute }>;
  onChange: (route: ConstellationModelRoute | undefined) => void;
}) {
  return (
    <label className="constellation-field constellation-model-select">
      <span>{tr("模型路线", "Model route")}</span>
      <select
        className="nodrag nowheel"
        value={value}
        onChange={(event) => onChange(options.find((option) => option.key === event.target.value)?.route)}
      >
        <option value="">{tr("自动选择推荐模型", "Choose recommended automatically")}</option>
        {options.map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ReferencePicker({ id, references, kind, sourceOnly = false }: { id: string; references: ImageAttachment[]; kind: "image" | "video"; sourceOnly?: boolean }) {
  const actions = useNodeActions();
  return (
    <div className="constellation-reference-picker">
      <div>
        <span>{sourceOnly ? tr("编辑源图", "Edit source image") : kind === "video" ? tr("参考视频", "Reference video") : tr("本地参考", "Local references")}</span>
        <button type="button" className="nodrag" onClick={() => sourceOnly ? actions.openImageSourcePicker(id, "image") : actions.chooseReferences(id, kind)}>{sourceOnly ? tr("选择源图", "Choose source") : tr("选择", "Choose")}</button>
      </div>
      {references.length > 0 && <div className="constellation-reference-chips">{references.map((reference) => <button type="button" className="nodrag" title={tr(`移除 ${reference.name}`, `Remove ${reference.name}`)} aria-label={tr(`移除 ${reference.name}`, `Remove ${reference.name}`)} onClick={() => actions.updateNode(id, { references: references.filter((item) => item.id !== reference.id), outputs: undefined, status: "idle" })} key={reference.id}><AttachmentThumbnail attachment={reference} /><span>{reference.name}</span><i aria-hidden="true">×</i></button>)}</div>}
    </div>
  );
}

function AttachmentOrValuePreview({ attachment, value }: { attachment?: ImageAttachment; value?: ConstellationValue }) {
  if (attachment) return <AttachmentThumbnail attachment={attachment} />;
  if (value) return <ValuePreview value={value} thumbnail />;
  return null;
}

function AttachmentThumbnail({ attachment }: { attachment: ImageAttachment }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let disposed = false;
    void previewAttachment(attachment).then((preview) => {
      if (!disposed && preview.dataBase64) setUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [attachment.id]);
  return url ? <img src={url} alt={attachment.name} /> : <ImageIcon size={24} />;
}

function ValuePreview({ value, large = false, thumbnail = false }: { value: ConstellationValue; large?: boolean; thumbnail?: boolean }) {
  const actions = useNodeActions();
  const url = useMemo(() => value.asset ? mediaAssetUrl(value.asset) : undefined, [value.asset]);
  if (value.type === "text") return thumbnail ? <FileText size={24} /> : <div className={`constellation-text-preview${large ? " large" : ""}`}>{value.text}</div>;
  if (value.attachment) return <AttachmentThumbnail attachment={value.attachment} />;
  if (value.type === "image" && url) return <div className={`constellation-media-preview image${large ? " large" : ""}`}>
    {thumbnail ? <img src={url} alt={value.asset?.prompt || tr("生成图片", "Generated image")} /> : <button type="button" className="constellation-preview-trigger nodrag" onClick={() => actions.openPreview(value)} title={tr("打开图片预览", "Open image preview")}><img src={url} alt={value.asset?.prompt || tr("生成图片", "Generated image")} /><span><Maximize2 size={12} />{tr("预览", "Preview")}</span></button>}
    {!thumbnail && value.asset && <button type="button" className="constellation-preview-download nodrag" onClick={() => actions.downloadValue(value)} title={tr("下载图片", "Download image")}><Download size={12} />{tr("下载", "Download")}</button>}
  </div>;
  if (value.type === "video" && url) return <div className={`constellation-media-preview video${large ? " large" : ""}`}><video src={url} controls={!thumbnail} muted={thumbnail} loop={thumbnail} /></div>;
  if (value.type === "audio" && url) return <div className={`constellation-audio-preview${large ? " large" : ""}`}><span><Volume2 size={18} /></span><audio src={url} controls={!thumbnail} /></div>;
  const Icon = value.type === "video" ? Video : value.type === "audio" ? Volume2 : ImageIcon;
  return <div className="constellation-media-placeholder"><Icon size={24} /><span>{value.asset?.status === "queued" || value.asset?.status === "in_progress" ? tr("已进入后台队列", "Queued in the background") : tr("结果已保存", "Output saved")}</span></div>;
}

export const CONSTELLATION_NODE_TYPES = {
  constellation: ConstellationNodeCard,
};

export function constellationMiniMapColor(node: ConstellationNode) {
  return ({
    conversation: "#6366f1",
    input: "#06b6d4",
    localTool: "#0f766e",
    projectRef: "#db2777",
    prompt: "#a78bfa",
    writing: "#8b5cf6",
    image: "#f43f5e",
    video: "#0ea5e9",
    audio: "#10b981",
    canvas: "#f59e0b",
    output: "#64748b",
    note: "#eab308",
  } as const)[node.data.kind] ?? "#64748b";
}

export function mediaKindLabel(kind: MediaKind) {
  return kind === "image" ? tr("图像", "Image") : kind === "video" ? tr("视频", "Video") : tr("语音", "Speech");
}

export function nodeMediaKind(kind: ConstellationNodeKind) {
  return MEDIA_KIND_BY_NODE[kind];
}
