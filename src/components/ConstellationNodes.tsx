import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AudioLines,
  BookOpenText,
  Brush,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Play,
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
  type ConstellationEdge,
  type ConstellationModelRoute,
  type ConstellationNode,
  type ConstellationNodeData,
  type ConstellationNodeKind,
  type ConstellationValue,
} from "../lib/constellation";
import { tr } from "../lib/i18n";
import type { ImageAttachment, MediaKind, MediaModelInfo, ProviderModelInfo } from "../lib/types";

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
  openCanvas: (nodeId: string) => void;
  getInputValue: (nodeId: string, handle: string) => ConstellationValue | undefined;
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
  const actions = useNodeActions();
  const definition = CONSTELLATION_NODE_DEFINITIONS[data.kind];
  const Icon = NODE_ICONS[data.kind];
  const collapsed = Boolean(data.collapsed);
  const statusLabel = data.status === "running"
    ? tr("执行中", "Running")
    : data.status === "queued"
      ? tr("等待中", "Queued")
      : data.status === "success"
        ? tr("已完成", "Done")
        : data.status === "error"
          ? tr("需要处理", "Needs attention")
          : tr("就绪", "Ready");

  return (
    <article
      className={`constellation-node kind-${data.kind} status-${data.status}${selected ? " selected" : ""}${collapsed ? " collapsed" : ""}`}
      aria-label={`${tr(definition.label, definition.labelEn)} · ${statusLabel}`}
    >
      <header className="constellation-node-header">
        <span className="constellation-node-icon"><Icon size={15} /></span>
        <div>
          <input
            className="nodrag"
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
          title={tr("删除节点", "Delete node")}
          onClick={() => actions.removeNode(id)}
        >
          <Trash2 size={13} />
        </button>
      </header>

      {!collapsed && (
        <>
          {definition.inputs.length > 0 && (
            <div className="constellation-node-ports inputs" aria-label={tr("输入端口", "Input ports")}>
              {definition.inputs.map((port) => {
                const connected = actions.edges.some((edge) => edge.target === id && edge.targetHandle === port.id);
                return (
                  <div className={`constellation-port-row input type-${port.type}${connected ? " connected" : ""}`} key={port.id}>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={port.id}
                      isConnectable={isConnectable}
                      className={`constellation-handle type-${port.type}`}
                      aria-label={`${tr(port.label, port.labelEn)} · ${tr("输入端口", "input port")}`}
                      title={`${tr(port.label, port.labelEn)} · ${tr("输入端口", "input port")}`}
                    />
                    <span>{tr(port.label, port.labelEn)}</span>
                    {port.optional && <small>{tr("可选", "optional")}</small>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="constellation-node-body">
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

          {definition.outputs.length > 0 && (
            <div className="constellation-node-ports outputs" aria-label={tr("输出端口", "Output ports")}>
              {definition.outputs.map((port) => {
                const ready = Boolean(data.outputs?.[port.id]);
                return (
                  <div className={`constellation-port-row output type-${port.type}${ready ? " ready" : ""}`} key={port.id}>
                    {ready && <CircleCheck size={10} />}
                    <span>{tr(port.label, port.labelEn)}</span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={port.id}
                      isConnectable={isConnectable}
                      className={`constellation-handle type-${port.type}`}
                      aria-label={`${tr(port.label, port.labelEn)} · ${tr("输出端口", "output port")}`}
                      title={`${tr(port.label, port.labelEn)} · ${tr("输出端口", "output port")}`}
                    />
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
}

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
            aria-checked={(data.operation ?? "generate") === value}
            className={(data.operation ?? "generate") === value ? "active" : ""}
            key={value}
            onClick={() => actions.updateNode(id, { operation: value })}
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
      <ReferencePicker id={id} references={data.references ?? []} kind="image" />
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

function ReferencePicker({ id, references, kind }: { id: string; references: ImageAttachment[]; kind: "image" | "video" }) {
  const actions = useNodeActions();
  return (
    <div className="constellation-reference-picker">
      <div>
        <span>{kind === "video" ? tr("参考视频", "Reference video") : tr("本地参考", "Local references")}</span>
        <button type="button" className="nodrag" onClick={() => actions.chooseReferences(id, kind)}>{tr("选择", "Choose")}</button>
      </div>
      {references.length > 0 && <div className="constellation-reference-chips">{references.map((reference) => <button type="button" className="nodrag" title={tr(`移除 ${reference.name}`, `Remove ${reference.name}`)} aria-label={tr(`移除 ${reference.name}`, `Remove ${reference.name}`)} onClick={() => actions.updateNode(id, { references: references.filter((item) => item.id !== reference.id) })} key={reference.id}><ImageIcon size={10} /><span>{reference.name}</span><i aria-hidden="true">×</i></button>)}</div>}
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
  const url = useMemo(() => value.asset ? mediaAssetUrl(value.asset) : undefined, [value.asset]);
  if (value.type === "text") return thumbnail ? <FileText size={24} /> : <div className={`constellation-text-preview${large ? " large" : ""}`}>{value.text}</div>;
  if (value.attachment) return <AttachmentThumbnail attachment={value.attachment} />;
  if (value.type === "image" && url) return <div className={`constellation-media-preview image${large ? " large" : ""}`}><img src={url} alt={value.asset?.prompt || tr("生成图片", "Generated image")} /></div>;
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
    prompt: "#a78bfa",
    writing: "#8b5cf6",
    image: "#f43f5e",
    video: "#0ea5e9",
    audio: "#10b981",
    canvas: "#f59e0b",
    output: "#64748b",
    note: "#eab308",
  } as const)[node.data.kind];
}

export function mediaKindLabel(kind: MediaKind) {
  return kind === "image" ? tr("图像", "Image") : kind === "video" ? tr("视频", "Video") : tr("语音", "Speech");
}

export function nodeMediaKind(kind: ConstellationNodeKind) {
  return MEDIA_KIND_BY_NODE[kind];
}
