import type { Edge as FlowEdge, Node as FlowNode, XYPosition } from "@xyflow/react";
import type {
  ImageAttachment,
  MediaAsset,
  MediaKind,
  ProviderProtocol,
} from "./types";

export const CONSTELLATION_SCHEMA_VERSION = 1 as const;
export const CONSTELLATION_STORAGE_KEY = "levelup-agent.constellation.v1";
export const CONSTELLATION_BLUEPRINTS_KEY = "levelup-agent.constellation-blueprints.v1";

export type ConstellationNodeKind =
  | "prompt"
  | "writing"
  | "image"
  | "video"
  | "audio"
  | "canvas"
  | "output"
  | "note";

export type ConstellationPortType = "text" | "image" | "video" | "audio" | "media";
export type ConstellationRunStatus = "idle" | "queued" | "running" | "success" | "error";
export type ImageOperation = "generate" | "edit" | "outpaint" | "inpaint";

export interface ConstellationValue {
  type: Exclude<ConstellationPortType, "media">;
  text?: string;
  asset?: MediaAsset;
  attachment?: ImageAttachment;
  createdAt: number;
}

export interface ConstellationModelRoute {
  profileId: string;
  profileName: string;
  model: string;
  protocol: ProviderProtocol;
}

export interface ConstellationNodeData extends Record<string, unknown> {
  kind: ConstellationNodeKind;
  title: string;
  subtitle?: string;
  prompt?: string;
  instruction?: string;
  operation?: ImageOperation;
  modelRoute?: ConstellationModelRoute;
  size?: string;
  quality?: string;
  outputFormat?: string;
  background?: string;
  count?: number;
  seconds?: number;
  voice?: string;
  videoResolution?: string;
  videoAspectRatio?: string;
  references?: ImageAttachment[];
  canvasSource?: ImageAttachment;
  canvasResult?: ImageAttachment;
  maskAttachment?: ImageAttachment;
  outputs?: Partial<Record<string, ConstellationValue>>;
  status: ConstellationRunStatus;
  error?: string;
  collapsed?: boolean;
  noteColor?: "amber" | "rose" | "sky" | "emerald";
}

export type ConstellationNode = FlowNode<ConstellationNodeData, "constellation">;
export type ConstellationEdgeData = Record<string, unknown> & {
  valueType: ConstellationPortType;
};
export type ConstellationEdge = FlowEdge<ConstellationEdgeData>;

export interface ConstellationGraph {
  schemaVersion: typeof CONSTELLATION_SCHEMA_VERSION;
  id: string;
  title: string;
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  createdAt: number;
  updatedAt: number;
}

export interface ConstellationBlueprint {
  schemaVersion: typeof CONSTELLATION_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  tags: string[];
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  createdAt: number;
  updatedAt: number;
  builtIn?: boolean;
}

export interface ConstellationPort {
  id: string;
  type: ConstellationPortType;
  label: string;
  labelEn: string;
  optional?: boolean;
  multiple?: boolean;
}

export interface ConstellationNodeDefinition {
  kind: ConstellationNodeKind;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  category: "input" | "ability" | "tool" | "output";
  inputs: ConstellationPort[];
  outputs: ConstellationPort[];
  defaultSize: { width: number; height: number };
}

export const CONSTELLATION_NODE_DEFINITIONS: Record<ConstellationNodeKind, ConstellationNodeDefinition> = {
  prompt: {
    kind: "prompt",
    label: "提示词",
    labelEn: "Prompt",
    description: "一次编写，连接到任意创作能力",
    descriptionEn: "Write once and route to any creative ability",
    category: "input",
    inputs: [],
    outputs: [{ id: "text", type: "text", label: "文本", labelEn: "Text" }],
    defaultSize: { width: 292, height: 238 },
  },
  writing: {
    kind: "writing",
    label: "灵感写作",
    labelEn: "Creative Writing",
    description: "续写、改写、脚本和提示词增强",
    descriptionEn: "Draft, rewrite, script, or enrich prompts",
    category: "ability",
    inputs: [
      { id: "prompt", type: "text", label: "任务", labelEn: "Task" },
      { id: "context", type: "text", label: "上下文", labelEn: "Context", optional: true, multiple: true },
    ],
    outputs: [{ id: "text", type: "text", label: "文本", labelEn: "Text" }],
    defaultSize: { width: 310, height: 300 },
  },
  image: {
    kind: "image",
    label: "图像生成",
    labelEn: "Image Generation",
    description: "文生图、图生图、扩图与蒙版重绘",
    descriptionEn: "Generate, edit, outpaint, or masked inpaint",
    category: "ability",
    inputs: [
      { id: "prompt", type: "text", label: "提示词", labelEn: "Prompt" },
      { id: "image", type: "image", label: "参考图", labelEn: "Reference", optional: true, multiple: true },
      { id: "mask", type: "image", label: "蒙版", labelEn: "Mask", optional: true },
    ],
    outputs: [{ id: "image", type: "image", label: "图像", labelEn: "Image" }],
    defaultSize: { width: 326, height: 396 },
  },
  video: {
    kind: "video",
    label: "视频生成",
    labelEn: "Video Generation",
    description: "文生视频或从首帧生成动态画面",
    descriptionEn: "Generate video from text or a first frame",
    category: "ability",
    inputs: [
      { id: "prompt", type: "text", label: "提示词", labelEn: "Prompt" },
      { id: "image", type: "image", label: "首帧 / 参考", labelEn: "First frame / Reference", optional: true, multiple: true },
    ],
    outputs: [{ id: "video", type: "video", label: "视频", labelEn: "Video" }],
    defaultSize: { width: 318, height: 346 },
  },
  audio: {
    kind: "audio",
    label: "语音生成",
    labelEn: "Speech Generation",
    description: "把文案转换为可复用的语音素材",
    descriptionEn: "Turn copy into reusable speech assets",
    category: "ability",
    inputs: [{ id: "text", type: "text", label: "文案", labelEn: "Copy" }],
    outputs: [{ id: "audio", type: "audio", label: "语音", labelEn: "Speech" }],
    defaultSize: { width: 304, height: 314 },
  },
  canvas: {
    kind: "canvas",
    label: "画板与蒙版",
    labelEn: "Canvas & Mask",
    description: "标注图片并绘制局部重绘蒙版",
    descriptionEn: "Annotate an image and paint an inpainting mask",
    category: "tool",
    inputs: [{ id: "image", type: "image", label: "图像", labelEn: "Image", optional: true }],
    outputs: [
      { id: "image", type: "image", label: "标注图", labelEn: "Annotated image" },
      { id: "mask", type: "image", label: "蒙版", labelEn: "Mask", optional: true },
    ],
    defaultSize: { width: 306, height: 286 },
  },
  output: {
    kind: "output",
    label: "作品预览",
    labelEn: "Output Preview",
    description: "集中查看、播放和复用最终结果",
    descriptionEn: "Preview, play, and reuse the final result",
    category: "output",
    inputs: [{ id: "media", type: "media", label: "作品", labelEn: "Media" }],
    outputs: [],
    defaultSize: { width: 344, height: 300 },
  },
  note: {
    kind: "note",
    label: "便签",
    labelEn: "Note",
    description: "给流程留下说明和协作提示",
    descriptionEn: "Leave workflow notes and collaboration hints",
    category: "tool",
    inputs: [],
    outputs: [],
    defaultSize: { width: 260, height: 180 },
  },
};

const NODE_KINDS = new Set<ConstellationNodeKind>(Object.keys(CONSTELLATION_NODE_DEFINITIONS) as ConstellationNodeKind[]);

function makeId(prefix: string) {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export function createConstellationNode(kind: ConstellationNodeKind, position: XYPosition): ConstellationNode {
  const definition = CONSTELLATION_NODE_DEFINITIONS[kind];
  const common: ConstellationNodeData = {
    kind,
    title: definition.label,
    status: "idle",
  };
  const variants: Partial<Record<ConstellationNodeKind, Partial<ConstellationNodeData>>> = {
    prompt: { prompt: "", subtitle: "连接到能力节点" },
    writing: { prompt: "", instruction: "根据输入完成创作，只输出可直接使用的正文。" },
    image: {
      prompt: "",
      operation: "generate",
      size: "auto",
      quality: "auto",
      outputFormat: "png",
      background: "auto",
      count: 1,
      references: [],
    },
    video: {
      prompt: "",
      seconds: 8,
      count: 1,
      videoResolution: "720p",
      videoAspectRatio: "16:9",
      references: [],
    },
    audio: { prompt: "", voice: "", instruction: "自然、清晰、有感染力", outputFormat: "mp3", count: 1 },
    canvas: { references: [] },
    output: {},
    note: { prompt: "写下这段流程的意图、约束或下一步…", noteColor: "amber" },
  };
  return {
    id: makeId(kind),
    type: "constellation",
    position,
    width: definition.defaultSize.width,
    data: { ...common, ...(variants[kind] ?? {}) },
  };
}

export function createConstellationEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  valueType: ConstellationPortType,
): ConstellationEdge {
  return {
    id: makeId("edge"),
    source,
    sourceHandle,
    target,
    targetHandle,
    type: "smoothstep",
    animated: false,
    data: { valueType },
  };
}

export function findPort(kind: ConstellationNodeKind, direction: "input" | "output", handle?: string | null) {
  const ports = direction === "input"
    ? CONSTELLATION_NODE_DEFINITIONS[kind].inputs
    : CONSTELLATION_NODE_DEFINITIONS[kind].outputs;
  return ports.find((port) => port.id === handle);
}

export function portTypesCompatible(source: ConstellationPortType, target: ConstellationPortType) {
  return source === target || target === "media";
}

export function wouldCreateConstellationCycle(edges: ConstellationEdge[], source: string, target: string) {
  if (source === target) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const values = outgoing.get(edge.source) ?? [];
    values.push(edge.target);
    outgoing.set(edge.source, values);
  }
  const stack = [target];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (nodeId === source) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    stack.push(...(outgoing.get(nodeId) ?? []));
  }
  return false;
}

export function validateConstellationConnection(
  nodes: ConstellationNode[],
  edges: ConstellationEdge[],
  connection: { source?: string | null; sourceHandle?: string | null; target?: string | null; targetHandle?: string | null },
): { valid: true; valueType: ConstellationPortType } | { valid: false; reason: string; reasonEn: string } {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
    return { valid: false, reason: "连接缺少端点", reasonEn: "The connection is missing an endpoint" };
  }
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!source || !target) return { valid: false, reason: "节点不存在", reasonEn: "The node does not exist" };
  const output = findPort(source.data.kind, "output", connection.sourceHandle);
  const input = findPort(target.data.kind, "input", connection.targetHandle);
  if (!output || !input) return { valid: false, reason: "端口不存在", reasonEn: "The port does not exist" };
  if (!portTypesCompatible(output.type, input.type)) {
    return { valid: false, reason: `${output.label} 不能连接到 ${input.label}`, reasonEn: `${output.labelEn} cannot connect to ${input.labelEn}` };
  }
  if (edges.some((edge) => edge.source === source.id
    && edge.sourceHandle === output.id
    && edge.target === target.id
    && edge.targetHandle === input.id)) {
    return { valid: false, reason: "这条连接已经存在", reasonEn: "This connection already exists" };
  }
  if (!input.multiple && edges.some((edge) => edge.target === target.id && edge.targetHandle === input.id)) {
    return { valid: false, reason: `${input.label} 只接受一条连接`, reasonEn: `${input.labelEn} accepts only one connection` };
  }
  if (wouldCreateConstellationCycle(edges, source.id, target.id)) {
    return { valid: false, reason: "星图必须保持为无环流程", reasonEn: "A constellation must remain acyclic" };
  }
  return { valid: true, valueType: output.type };
}

export function constellationDependencyClosure(targetIds: Iterable<string>, edges: ConstellationEdge[]) {
  const required = new Set(targetIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (required.has(edge.target) && !required.has(edge.source)) {
        required.add(edge.source);
        changed = true;
      }
    }
  }
  return required;
}

export function constellationExecutionLayers(
  nodes: ConstellationNode[],
  edges: ConstellationEdge[],
  includeIds: Iterable<string> = nodes.map((node) => node.id),
): ConstellationNode[][] {
  const included = new Set(includeIds);
  const selected = nodes.filter((node) => included.has(node.id));
  const indegree = new Map(selected.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!included.has(edge.source) || !included.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const values = outgoing.get(edge.source) ?? [];
    values.push(edge.target);
    outgoing.set(edge.source, values);
  }
  let frontier = selected.filter((node) => indegree.get(node.id) === 0);
  const layers: ConstellationNode[][] = [];
  let visited = 0;
  while (frontier.length > 0) {
    layers.push(frontier);
    visited += frontier.length;
    const nextIds: string[] = [];
    for (const node of frontier) {
      for (const target of outgoing.get(node.id) ?? []) {
        const value = (indegree.get(target) ?? 1) - 1;
        indegree.set(target, value);
        if (value === 0) nextIds.push(target);
      }
    }
    frontier = nextIds.map((id) => selected.find((node) => node.id === id)!).filter(Boolean);
  }
  if (visited !== selected.length) throw new Error("星图中存在循环连接，无法执行");
  return layers;
}

function serializableNode(node: ConstellationNode, forBlueprint = false): ConstellationNode {
  const data = structuredClone(node.data);
  data.status = "idle";
  delete data.error;
  if (forBlueprint) {
    delete data.outputs;
    delete data.references;
    delete data.canvasSource;
    delete data.canvasResult;
    delete data.maskAttachment;
  }
  return {
    id: node.id,
    type: "constellation",
    position: { x: finite(node.position.x), y: finite(node.position.y) },
    width: finite(node.measured?.width ?? node.width, CONSTELLATION_NODE_DEFINITIONS[data.kind].defaultSize.width),
    height: finite(node.measured?.height ?? node.height, undefined),
    parentId: undefined,
    extent: undefined,
    selected: false,
    dragging: false,
    data,
  };
}

export function serializeConstellationGraph(graph: ConstellationGraph): ConstellationGraph {
  return {
    ...graph,
    schemaVersion: CONSTELLATION_SCHEMA_VERSION,
    nodes: graph.nodes.map((node) => serializableNode(node)),
    edges: graph.edges.map((edge) => ({ ...structuredClone(edge), selected: false, animated: false })),
    updatedAt: Date.now(),
  };
}

export function createConstellationBlueprint(
  name: string,
  description: string,
  tags: string[],
  selectedNodes: ConstellationNode[],
  allEdges: ConstellationEdge[],
): ConstellationBlueprint {
  if (selectedNodes.length === 0) throw new Error("请先框选至少一个节点");
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const minX = Math.min(...selectedNodes.map((node) => node.position.x));
  const minY = Math.min(...selectedNodes.map((node) => node.position.y));
  const now = Date.now();
  const nodes = selectedNodes.map((node) => {
    const copy = serializableNode(node, true);
    copy.position = { x: copy.position.x - minX, y: copy.position.y - minY };
    return copy;
  });
  const edges = allEdges
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .map((edge) => ({ ...structuredClone(edge), selected: false, animated: false }));
  return {
    schemaVersion: CONSTELLATION_SCHEMA_VERSION,
    id: makeId("blueprint"),
    name: name.trim().slice(0, 80) || "未命名蓝图",
    description: description.trim().slice(0, 240),
    tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 8),
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
  };
}

export function instantiateConstellationBlueprint(
  blueprint: ConstellationBlueprint,
  origin: XYPosition,
): { nodes: ConstellationNode[]; edges: ConstellationEdge[] } {
  const idMap = new Map(blueprint.nodes.map((node) => [node.id, makeId(node.data.kind)]));
  const nodes = blueprint.nodes.map((node) => ({
    ...serializableNode(node, true),
    id: idMap.get(node.id)!,
    position: { x: origin.x + node.position.x, y: origin.y + node.position.y },
    selected: true,
    data: { ...structuredClone(node.data), status: "idle" as const },
  }));
  const edges = blueprint.edges.map((edge) => ({
    ...structuredClone(edge),
    id: makeId("edge"),
    source: idMap.get(edge.source)!,
    target: idMap.get(edge.target)!,
    selected: false,
    animated: false,
  }));
  return { nodes, edges };
}

export function duplicateConstellationSelection(
  nodes: ConstellationNode[],
  edges: ConstellationEdge[],
  offset: XYPosition = { x: 42, y: 42 },
) {
  const selected = nodes.filter((node) => node.selected);
  if (selected.length === 0) return { nodes: [], edges: [] };
  const blueprint = createConstellationBlueprint("duplicate", "", [], selected, edges);
  const minX = Math.min(...selected.map((node) => node.position.x));
  const minY = Math.min(...selected.map((node) => node.position.y));
  return instantiateConstellationBlueprint(blueprint, { x: minX + offset.x, y: minY + offset.y });
}

export function autoLayoutConstellation(
  nodes: ConstellationNode[],
  edges: ConstellationEdge[],
): ConstellationNode[] {
  const layers = constellationExecutionLayers(nodes, edges);
  const positioned = new Map<string, XYPosition>();
  layers.forEach((layer, column) => {
    let y = 80;
    for (const node of layer) {
      positioned.set(node.id, { x: 80 + column * 390, y });
      const height = node.measured?.height ?? node.height ?? CONSTELLATION_NODE_DEFINITIONS[node.data.kind].defaultSize.height;
      y += Math.max(190, height) + 54;
    }
  });
  return nodes.map((node) => ({ ...node, position: positioned.get(node.id) ?? node.position }));
}

export function createDefaultConstellationGraph(): ConstellationGraph {
  const prompt = createConstellationNode("prompt", { x: 80, y: 170 });
  prompt.data.prompt = "一座漂浮在云海上的东方未来城市，清晨薄雾，电影感光线，细节丰富";
  const image = createConstellationNode("image", { x: 450, y: 100 });
  const output = createConstellationNode("output", { x: 850, y: 150 });
  const now = Date.now();
  return {
    schemaVersion: CONSTELLATION_SCHEMA_VERSION,
    id: makeId("graph"),
    title: "我的第一张星图",
    nodes: [prompt, image, output],
    edges: [
      createConstellationEdge(prompt.id, "text", image.id, "prompt", "text"),
      createConstellationEdge(image.id, "image", output.id, "media", "image"),
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function builtInBlueprint(
  id: string,
  name: string,
  description: string,
  tags: string[],
  kinds: Array<{ kind: ConstellationNodeKind; position: XYPosition; patch?: Partial<ConstellationNodeData> }>,
  links: Array<[number, string, number, string, ConstellationPortType]>,
): ConstellationBlueprint {
  const nodes = kinds.map(({ kind, position, patch }, index) => {
    const node = createConstellationNode(kind, position);
    node.id = `${id}-node-${index + 1}`;
    node.data = { ...node.data, ...(patch ?? {}) };
    return node;
  });
  const edges = links.map(([source, sourceHandle, target, targetHandle, type], index) => ({
    ...createConstellationEdge(nodes[source].id, sourceHandle, nodes[target].id, targetHandle, type),
    id: `${id}-edge-${index + 1}`,
  }));
  return {
    schemaVersion: CONSTELLATION_SCHEMA_VERSION,
    id,
    name,
    description,
    tags,
    nodes,
    edges,
    createdAt: 0,
    updatedAt: 0,
    builtIn: true,
  };
}

export const BUILT_IN_CONSTELLATION_BLUEPRINTS: ConstellationBlueprint[] = [
  builtInBlueprint(
    "builtin-story-film",
    "灵感成片",
    "从一句想法扩写分镜文案，再生成主视觉和首帧视频。",
    ["写作", "图像", "视频"],
    [
      { kind: "prompt", position: { x: 0, y: 120 }, patch: { prompt: "一个能讲成 15 秒短片的创意" } },
      { kind: "writing", position: { x: 360, y: 80 }, patch: { instruction: "把想法扩写成简洁、可视化的单镜头画面描述。" } },
      { kind: "image", position: { x: 750, y: 0 } },
      { kind: "video", position: { x: 1140, y: 70 } },
      { kind: "output", position: { x: 1530, y: 110 } },
    ],
    [
      [0, "text", 1, "prompt", "text"],
      [1, "text", 2, "prompt", "text"],
      [1, "text", 3, "prompt", "text"],
      [2, "image", 3, "image", "image"],
      [3, "video", 4, "media", "video"],
    ],
  ),
  builtInBlueprint(
    "builtin-audio-story",
    "有声故事卡",
    "同一段文案同时生成封面与旁白，适合播客和短故事。",
    ["写作", "语音", "封面"],
    [
      { kind: "prompt", position: { x: 0, y: 150 }, patch: { prompt: "写一段 30 秒以内、有画面感的微故事" } },
      { kind: "writing", position: { x: 360, y: 110 } },
      { kind: "image", position: { x: 760, y: 0 }, patch: { title: "故事封面" } },
      { kind: "audio", position: { x: 760, y: 390 }, patch: { title: "故事旁白" } },
      { kind: "output", position: { x: 1160, y: 80 } },
      { kind: "output", position: { x: 1160, y: 420 } },
    ],
    [
      [0, "text", 1, "prompt", "text"],
      [1, "text", 2, "prompt", "text"],
      [1, "text", 3, "text", "text"],
      [2, "image", 4, "media", "image"],
      [3, "audio", 5, "media", "audio"],
    ],
  ),
  builtInBlueprint(
    "builtin-outpaint",
    "智能扩图工作台",
    "标注参考图、指定构图方向，再用扩图模式生成新画幅。",
    ["画板", "扩图", "标注"],
    [
      { kind: "canvas", position: { x: 0, y: 80 } },
      { kind: "prompt", position: { x: 0, y: 410 }, patch: { prompt: "自然延展画面，保持主体、光线、透视和材质一致" } },
      { kind: "image", position: { x: 390, y: 130 }, patch: { operation: "outpaint", size: "16:9", title: "智能扩图" } },
      { kind: "output", position: { x: 800, y: 180 } },
    ],
    [
      [0, "image", 2, "image", "image"],
      [0, "mask", 2, "mask", "image"],
      [1, "text", 2, "prompt", "text"],
      [2, "image", 3, "media", "image"],
    ],
  ),
  builtInBlueprint(
    "builtin-inpaint",
    "蒙版局部重绘",
    "在画板涂抹需要修改的区域，再交给图像能力局部重绘。",
    ["蒙版", "局部重绘", "图像"],
    [
      { kind: "canvas", position: { x: 0, y: 80 } },
      { kind: "prompt", position: { x: 0, y: 410 }, patch: { prompt: "描述涂抹区域需要替换成什么" } },
      { kind: "image", position: { x: 390, y: 130 }, patch: { operation: "inpaint", title: "局部重绘" } },
      { kind: "output", position: { x: 800, y: 180 } },
    ],
    [
      [0, "image", 2, "image", "image"],
      [0, "mask", 2, "mask", "image"],
      [1, "text", 2, "prompt", "text"],
      [2, "image", 3, "media", "image"],
    ],
  ),
];

export function normalizeConstellationGraph(value: unknown): ConstellationGraph | null {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  const nodes = value.nodes.map(normalizeNode).filter((node): node is ConstellationNode => Boolean(node));
  if (nodes.length === 0 || nodes.length > 500) return null;
  const seenNodeIds = new Set<string>();
  for (const node of nodes) {
    if (seenNodeIds.has(node.id)) node.id = makeId(node.data.kind);
    seenNodeIds.add(node.id);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const candidates = value.edges
    .map(normalizeEdge)
    .filter((edge): edge is ConstellationEdge => edge !== null)
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .slice(0, 1_500);
  const edges: ConstellationEdge[] = [];
  const seenEdgeIds = new Set<string>();
  for (const candidate of candidates) {
    const validation = validateConstellationConnection(nodes, edges, candidate);
    if (!validation.valid) continue;
    const edge = {
      ...candidate,
      id: seenEdgeIds.has(candidate.id) ? makeId("edge") : candidate.id,
      data: { valueType: validation.valueType },
    };
    seenEdgeIds.add(edge.id);
    edges.push(edge);
  }
  const now = Date.now();
  return {
    schemaVersion: CONSTELLATION_SCHEMA_VERSION,
    id: stringValue(value.id, makeId("graph"), 120),
    title: stringValue(value.title, "我的星图", 120),
    nodes,
    edges,
    createdAt: timestamp(value.createdAt, now),
    updatedAt: timestamp(value.updatedAt, now),
  };
}

export function normalizeConstellationBlueprint(value: unknown): ConstellationBlueprint | null {
  if (!isRecord(value)) return null;
  const graph = normalizeConstellationGraph({
    ...value,
    id: stringValue(value.id, makeId("blueprint"), 120),
    title: stringValue(value.name, "未命名蓝图", 80),
  });
  if (!graph) return null;
  return {
    schemaVersion: CONSTELLATION_SCHEMA_VERSION,
    id: graph.id,
    name: stringValue(value.name, graph.title, 80),
    description: stringValue(value.description, "", 240),
    tags: Array.isArray(value.tags)
      ? [...new Set(value.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))].slice(0, 8)
      : [],
    nodes: graph.nodes.map((node) => serializableNode(node, true)),
    edges: graph.edges,
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
    builtIn: value.builtIn === true,
  };
}

function normalizeNode(value: unknown): ConstellationNode | null {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.position)) return null;
  const kind = typeof value.data.kind === "string" && NODE_KINDS.has(value.data.kind as ConstellationNodeKind)
    ? value.data.kind as ConstellationNodeKind
    : null;
  if (!kind || typeof value.id !== "string" || !value.id.trim()) return null;
  const base = createConstellationNode(kind, {
    x: finite(value.position.x),
    y: finite(value.position.y),
  });
  const data = { ...base.data, ...structuredClone(value.data), kind, status: "idle" as const };
  delete data.error;
  return {
    ...base,
    id: value.id.slice(0, 160),
    width: finite(value.width, base.width ?? CONSTELLATION_NODE_DEFINITIONS[kind].defaultSize.width),
    height: finite(value.height, undefined),
    data,
  };
}

function normalizeEdge(value: unknown): ConstellationEdge | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.source !== "string"
    || typeof value.target !== "string"
    || typeof value.sourceHandle !== "string"
    || typeof value.targetHandle !== "string") return null;
  const data = isRecord(value.data) ? value.data : {};
  const valueType = typeof data.valueType === "string" && ["text", "image", "video", "audio", "media"].includes(data.valueType)
    ? data.valueType as ConstellationPortType
    : "media";
  return {
    id: value.id.slice(0, 160),
    source: value.source.slice(0, 160),
    sourceHandle: value.sourceHandle.slice(0, 80),
    target: value.target.slice(0, 160),
    targetHandle: value.targetHandle.slice(0, 80),
    type: "smoothstep",
    animated: false,
    data: { valueType },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number;
function finite(value: unknown, fallback: number): number;
function finite(value: unknown, fallback: undefined): number | undefined;
function finite(value: unknown, fallback: number | undefined = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function timestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringValue(value: unknown, fallback: string, maxLength: number) {
  return typeof value === "string" ? (value.trim().slice(0, maxLength) || fallback) : fallback;
}

export function mediaKindForConstellationNode(kind: ConstellationNodeKind): MediaKind | null {
  return kind === "image" || kind === "video" || kind === "audio" ? kind : null;
}
