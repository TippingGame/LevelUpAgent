import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  reconnectEdge,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type OnConnectStartParams,
} from "@xyflow/react";
import {
  BookOpen,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  Focus,
  FolderInput,
  ImagePlus,
  LayoutGrid,
  LibraryBig,
  LoaderCircle,
  Maximize2,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  agentTurnStream,
  cancelAgentTurn,
  exportMediaAsset,
  exportWritingFile,
  generateMedia,
  getMediaCatalog,
  getModelCatalog,
  importMediaReferences,
  listMediaAssets,
  mediaAssetUrl,
  selectImageReferences,
  selectSingleImageReference,
  selectVideoReference,
} from "../lib/bridge";
import {
  armorModeMediaInstructions,
  armorModeMediaPrompt,
  armorModeWritingInstructions,
  type ArmorModeLevel,
  type ArmorSkillState,
  type ArmorWritingIntensity,
} from "../lib/armorMode";
import {
  autoLayoutConstellation,
  BUILT_IN_CONSTELLATION_BLUEPRINTS,
  CONSTELLATION_BLUEPRINTS_KEY,
  CONSTELLATION_NODE_DEFINITIONS,
  CONSTELLATION_STORAGE_KEY,
  constellationDependencyClosure,
  constellationExecutionLayers,
  createConstellationBlueprint,
  createConstellationEdge,
  createConstellationNode,
  createDefaultConstellationGraph,
  duplicateConstellationSelection,
  findPort,
  instantiateConstellationBlueprint,
  mediaKindForConstellationNode,
  normalizeConstellationBlueprint,
  normalizeConstellationGraph,
  serializeConstellationGraph,
  validateConstellationConnection,
  type ConstellationBlueprint,
  type ConstellationEdge,
  type ConstellationGraph,
  type ConstellationNode,
  type ConstellationNodeData,
  type ConstellationNodeKind,
  type ConstellationPortType,
  type ConstellationValue,
} from "../lib/constellation";
import { tr } from "../lib/i18n";
import { mediaModelSupportsExplicitImageMask } from "../lib/mediaCapabilities";
import { isTextGenerationModel } from "../lib/modelSelection";
import type {
  AgentMessage,
  ImageAttachment,
  MediaAsset,
  MediaCatalog,
  MediaGenerationRequest,
  ProviderModelInfo,
  ProviderProfile,
} from "../lib/types";
import { ConstellationCanvasEditor } from "./ConstellationCanvasEditor";
import { MediaImagePreview } from "./MediaStudio";
import {
  CONSTELLATION_NODE_TYPES,
  ConstellationNodeActionsProvider,
  constellationMiniMapColor,
  type ConstellationNodeActions,
} from "./ConstellationNodes";
import "@xyflow/react/dist/style.css";
import "./ConstellationStudio.css";

interface ConstellationStudioProps {
  active: boolean;
  locale: string;
  armorMode: boolean;
  armorModeLevel: ArmorModeLevel;
  armorModeSkills: ArmorSkillState;
  armorWritingIntensity: ArmorWritingIntensity;
  activeProfile: ProviderProfile;
  profiles: ProviderProfile[];
  workspace?: string;
  mediaCatalogRevision: number;
  onConfigureConnection: () => void;
  onMedia: () => void;
  onWriting: () => void;
  onPendingCountChange: (count: number) => void;
}

interface GraphSnapshot {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
}

interface BlueprintDraft {
  name: string;
  description: string;
  tags: string;
}

interface NodeLibraryItem {
  kind: ConstellationNodeKind;
  keywords: string;
}

type ImageSourcePickerPurpose = "canvas" | "image";

interface ImageSourcePickerState {
  nodeId: string;
  purpose: ImageSourcePickerPurpose;
}

const NODE_LIBRARY: NodeLibraryItem[] = (Object.keys(CONSTELLATION_NODE_DEFINITIONS) as ConstellationNodeKind[]).map((kind) => ({
  kind,
  keywords: `${CONSTELLATION_NODE_DEFINITIONS[kind].label} ${CONSTELLATION_NODE_DEFINITIONS[kind].labelEn} ${CONSTELLATION_NODE_DEFINITIONS[kind].description} ${CONSTELLATION_NODE_DEFINITIONS[kind].descriptionEn}`.toLocaleLowerCase(),
}));

const EXECUTABLE_NODE_KINDS = new Set<ConstellationNodeKind>(["prompt", "writing", "image", "video", "audio", "canvas", "output"]);
const CONSTELLATION_DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep",
  interactionWidth: 28,
  reconnectable: true,
} as const;
const CONSTELLATION_CONNECTION_STYLE = { stroke: "#7c3aed", strokeWidth: 2.2 } as const;

export function ConstellationStudio(props: ConstellationStudioProps) {
  const armorClassName = props.armorMode ? ` armor-mode armor-level-${props.armorModeLevel}` : "";
  return (
    <main className={`constellation-studio${armorClassName}`} data-armor-level={props.armorMode ? props.armorModeLevel : undefined} hidden={!props.active}>
      <ReactFlowProvider>
        <ConstellationStudioInner {...props} />
      </ReactFlowProvider>
    </main>
  );
}

function ConstellationStudioInner({
  active,
  locale,
  armorMode,
  armorModeLevel,
  armorModeSkills,
  armorWritingIntensity,
  activeProfile,
  profiles,
  workspace,
  mediaCatalogRevision,
  onConfigureConnection,
  onMedia,
  onWriting,
  onPendingCountChange,
}: ConstellationStudioProps) {
  const initialGraphRef = useRef(loadConstellationGraph());
  const [nodes, setNodes] = useState<ConstellationNode[]>(initialGraphRef.current.nodes);
  const [edges, setEdges] = useState<ConstellationEdge[]>(initialGraphRef.current.edges);
  const [graphTitle, setGraphTitle] = useState(initialGraphRef.current.title);
  const [blueprints, setBlueprints] = useState<ConstellationBlueprint[]>(loadPersonalBlueprints);
  const [mediaCatalog, setMediaCatalog] = useState<MediaCatalog>({ models: [], errors: [] });
  const [writingModels, setWritingModels] = useState<ProviderModelInfo[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [mediaPending, setMediaPending] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [libraryQuery, setLibraryQuery] = useState("");
  const [blueprintQuery, setBlueprintQuery] = useState("");
  const [leftPanelOpen, setLeftPanelOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 1_320);
  const [rightPanelOpen, setRightPanelOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 1_440);
  const [blueprintDialog, setBlueprintDialog] = useState<BlueprintDraft>();
  const [editorNodeId, setEditorNodeId] = useState<string>();
  const [historyRevision, setHistoryRevision] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [canvasInteracting, setCanvasInteracting] = useState(false);
  const [connectionType, setConnectionType] = useState<ConstellationPortType>();
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [sourcePicker, setSourcePicker] = useState<ImageSourcePickerState>();
  const [imageHistory, setImageHistory] = useState<MediaAsset[]>([]);
  const [imageHistoryLoading, setImageHistoryLoading] = useState(false);
  const [imageHistoryLoaded, setImageHistoryLoaded] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<MediaAsset>();
  const importInputRef = useRef<HTMLInputElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const compactPanelsRef = useRef<boolean | null>(null);
  const graphMetaRef = useRef({
    id: initialGraphRef.current.id,
    createdAt: initialGraphRef.current.createdAt,
  });
  const graphRef = useRef({ nodes, edges });
  const graphTitleRef = useRef(graphTitle);
  const autosaveTimerRef = useRef<number | null>(null);
  const historyRef = useRef<{ undo: GraphSnapshot[]; redo: GraphSnapshot[] }>({ undo: [], redo: [] });
  const dragCheckpointRef = useRef(false);
  const runEpochRef = useRef(0);
  const runningRef = useRef(false);
  const keyboardActionsRef = useRef<{
    undo: () => void;
    redo: () => void;
    duplicate: () => void;
    run: () => Promise<void>;
    stop: () => void;
  }>({
    undo: () => undefined,
    redo: () => undefined,
    duplicate: () => undefined,
    run: async () => undefined,
    stop: () => undefined,
  });
  const operationIdsRef = useRef(new Set<string>());
  const runtimeValuesRef = useRef(new Map<string, Partial<Record<string, ConstellationValue>>>());
  const imageHistoryRequestRef = useRef(0);
  const imageHistoryLoadingRef = useRef(false);
  const spacePanRef = useRef(false);
  const { fitView, screenToFlowPosition } = useReactFlow<ConstellationNode, ConstellationEdge>();

  graphRef.current = { nodes, edges };
  graphTitleRef.current = graphTitle;

  useEffect(() => {
    if (!active) return;
    let timer = window.setTimeout(() => void fitView({ padding: .18, duration: 320, maxZoom: 1 }), 80);
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void fitView({ padding: .18, duration: 260, maxZoom: 1 }), 120);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [active, fitView]);

  useEffect(() => {
    if (!active || !workbenchRef.current) return;
    compactPanelsRef.current = null;
    const updatePanelMode = (width: number) => {
      const compact = width <= 1_080;
      if (compact && compactPanelsRef.current !== true) {
        setLeftPanelOpen(false);
        setRightPanelOpen(false);
      }
      compactPanelsRef.current = compact;
    };
    const element = workbenchRef.current;
    updatePanelMode(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") updatePanelMode(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  const refreshCatalogs = useCallback(async (showSpinner = true) => {
    if (showSpinner) setCatalogLoading(true);
    setCatalogError(undefined);
    try {
      const [nextMedia, nextModels] = await Promise.all([getMediaCatalog(), getModelCatalog()]);
      setMediaCatalog(nextMedia);
      setWritingModels(nextModels.models.filter(isTextGenerationModel));
      if (nextMedia.errors.length > 0 || nextModels.errors.length > 0) {
        setCatalogError([...nextMedia.errors, ...nextModels.errors].join(" · "));
      }
    } catch (reason) {
      setCatalogError(errorText(reason));
    } finally {
      if (showSpinner) setCatalogLoading(false);
    }
  }, []);

  const loadImageHistory = useCallback(async (force = false) => {
    if (imageHistoryLoadingRef.current || (imageHistoryLoaded && !force)) return;
    const requestId = ++imageHistoryRequestRef.current;
    imageHistoryLoadingRef.current = true;
    setImageHistoryLoading(true);
    try {
      const page = await listMediaAssets("image", 100, 0);
      if (requestId !== imageHistoryRequestRef.current) return;
      setImageHistory(page.assets.filter((asset) => asset.kind === "image"));
      setImageHistoryLoaded(true);
    } catch (reason) {
      if (requestId === imageHistoryRequestRef.current) setNotice(errorText(reason));
    } finally {
      if (requestId === imageHistoryRequestRef.current) {
        imageHistoryLoadingRef.current = false;
        setImageHistoryLoading(false);
      }
    }
  }, [imageHistoryLoaded]);

  useEffect(() => {
    if (!active) return;
    void refreshCatalogs(mediaCatalog.models.length === 0 && writingModels.length === 0);
  }, [active, mediaCatalogRevision]);

  useEffect(() => {
    if (autosaveTimerRef.current !== null) return;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      const current = graphRef.current;
      const graph: ConstellationGraph = serializeConstellationGraph({
        schemaVersion: 1,
        id: graphMetaRef.current.id,
        title: graphTitleRef.current.trim() || tr("未命名星图", "Untitled Constellation"),
        nodes: current.nodes,
        edges: current.edges,
        createdAt: graphMetaRef.current.createdAt,
        updatedAt: Date.now(),
      });
      try {
        localStorage.setItem(CONSTELLATION_STORAGE_KEY, JSON.stringify(graph));
      } catch {
        setNotice(tr("星图自动保存失败：本地存储空间不足", "Constellation autosave failed: local storage is full"));
      }
    }, 450);
  }, [edges, graphTitle, nodes]);

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CONSTELLATION_BLUEPRINTS_KEY, JSON.stringify(blueprints));
    } catch {
      setNotice(tr("蓝图库保存失败：本地存储空间不足", "Blueprint library could not be saved"));
    }
  }, [blueprints]);

  useEffect(() => onPendingCountChange(mediaPending), [mediaPending, onPendingCountChange]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      const interactive = Boolean(target?.closest("button, a, input, textarea, select, [contenteditable='true']"));
      if (event.code === "Space") {
        // React Flow's built-in Space activation is intentionally disabled
        // below.  Keeping this state here means an editable node title can
        // receive normal spaces without accidentally turning the canvas into
        // a permanent pan gesture.
        if (!editing && !interactive) {
          event.preventDefault();
          if (!event.repeat) {
            spacePanRef.current = true;
            setSpacePanActive(true);
          }
        }
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => {
          if (!open) setCommandQuery("");
          return !open;
        });
        return;
      }
      if (editing) return;
      if (modifier && event.key.toLocaleLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) keyboardActionsRef.current.redo();
        else keyboardActionsRef.current.undo();
      } else if (modifier && event.key.toLocaleLowerCase() === "d") {
        event.preventDefault();
        keyboardActionsRef.current.duplicate();
      } else if (modifier && event.key === "Enter") {
        event.preventDefault();
        void keyboardActionsRef.current.run();
      } else if (event.key === "Escape" && runningRef.current) {
        event.preventDefault();
        keyboardActionsRef.current.stop();
      } else if (event.key.toLocaleLowerCase() === "f") {
        void fitView({ padding: .16, duration: 280 });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spacePanRef.current = false;
      setSpacePanActive(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      spacePanRef.current = false;
      setSpacePanActive(false);
    };
  }, [active, fitView]);

  const checkpoint = useCallback(() => {
    const snapshot: GraphSnapshot = {
      nodes: structuredClone(graphRef.current.nodes).map((node) => ({ ...node, selected: false, dragging: false })),
      edges: structuredClone(graphRef.current.edges).map((edge) => ({ ...edge, selected: false })),
    };
    historyRef.current.undo.push(snapshot);
    historyRef.current.undo = historyRef.current.undo.slice(-60);
    historyRef.current.redo = [];
    setHistoryRevision((value) => value + 1);
  }, []);

  const restoreSnapshot = (snapshot: GraphSnapshot) => {
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setHistoryRevision((value) => value + 1);
  };

  const undoGraph = () => {
    const previous = historyRef.current.undo.pop();
    if (!previous) return;
    historyRef.current.redo.push(structuredClone(graphRef.current));
    restoreSnapshot(previous);
  };

  const redoGraph = () => {
    const next = historyRef.current.redo.pop();
    if (!next) return;
    historyRef.current.undo.push(structuredClone(graphRef.current));
    restoreSnapshot(next);
  };

  const onNodesChange = useCallback((changes: NodeChange<ConstellationNode>[]) => {
    if (changes.some((change) => change.type === "remove")) checkpoint();
    setNodes((current) => applyNodeChanges(changes, current));
  }, [checkpoint]);

  const onEdgesChange = useCallback((changes: EdgeChange<ConstellationEdge>[]) => {
    if (changes.some((change) => change.type === "remove")) checkpoint();
    setEdges((current) => applyEdgeChanges(changes, current));
  }, [checkpoint]);

  const onConnect = useCallback((connection: Connection) => {
    const validation = validateConstellationConnection(graphRef.current.nodes, graphRef.current.edges, connection);
    if (!validation.valid) {
      setNotice(tr(validation.reason, validation.reasonEn));
      return;
    }
    checkpoint();
    setEdges((current) => [...current, createConstellationEdge(
      connection.source,
      connection.sourceHandle!,
      connection.target,
      connection.targetHandle!,
      validation.valueType,
    )]);
  }, [checkpoint]);

  const isValidConnection = useCallback((connection: Connection | ConstellationEdge) => (
    validateConstellationConnection(graphRef.current.nodes, graphRef.current.edges, connection).valid
  ), []);

  const onReconnect = useCallback((oldEdge: ConstellationEdge, connection: Connection) => {
    const remaining = graphRef.current.edges.filter((edge) => edge.id !== oldEdge.id);
    const validation = validateConstellationConnection(graphRef.current.nodes, remaining, connection);
    if (!validation.valid) {
      setNotice(tr(validation.reason, validation.reasonEn));
      return;
    }
    checkpoint();
    setEdges((current) => reconnectEdge(oldEdge, connection, current).map((edge) => edge.id === oldEdge.id
      ? { ...edge, data: { ...edge.data, valueType: validation.valueType } }
      : edge));
  }, [checkpoint]);

  const beginCanvasInteraction = useCallback(() => setCanvasInteracting(true), []);
  const endCanvasInteraction = useCallback(() => setCanvasInteracting(false), []);
  const onConnectionStart = useCallback((_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    setCanvasInteracting(true);
    if (params.handleType !== "source" || !params.nodeId) {
      setConnectionType(undefined);
      return;
    }
    const node = graphRef.current.nodes.find((item) => item.id === params.nodeId);
    setConnectionType(node ? findPort(node.data.kind, "output", params.handleId)?.type : undefined);
  }, []);
  const onConnectionEnd = useCallback((_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    setCanvasInteracting(false);
    setConnectionType(undefined);
    if (state.isValid || !state.fromHandle) return;
    if (!state.toHandle) {
      if (state.toNode) setNotice(tr("请落到节点左侧的同色输入端口；也可以依次点击两个端口", "Drop on a matching input port on the node's left, or click the two ports in sequence"));
      return;
    }
    const fromSource = state.fromHandle.type === "source";
    const connection: Connection = {
      source: fromSource ? state.fromHandle.nodeId : state.toHandle.nodeId,
      sourceHandle: fromSource ? state.fromHandle.id ?? null : state.toHandle.id ?? null,
      target: fromSource ? state.toHandle.nodeId : state.fromHandle.nodeId,
      targetHandle: fromSource ? state.toHandle.id ?? null : state.fromHandle.id ?? null,
    };
    const validation = validateConstellationConnection(graphRef.current.nodes, graphRef.current.edges, connection);
    if (!validation.valid) setNotice(tr(validation.reason, validation.reasonEn));
  }, []);

  const onNodeDragStart = useCallback(() => {
    if (!dragCheckpointRef.current) {
      checkpoint();
      dragCheckpointRef.current = true;
    }
    setCanvasInteracting(true);
  }, [checkpoint]);
  const onNodeDragStop = useCallback(() => {
    dragCheckpointRef.current = false;
    setCanvasInteracting(false);
  }, []);

  const onSelectionDragStart = useCallback(() => {
    if (!dragCheckpointRef.current) {
      checkpoint();
      dragCheckpointRef.current = true;
    }
    setCanvasInteracting(true);
  }, [checkpoint]);
  const onSelectionDragStop = useCallback(() => {
    dragCheckpointRef.current = false;
    setCanvasInteracting(false);
  }, []);

  const onCanvasMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) setCanvasInteracting(true);
  }, []);
  const onCanvasMoveEnd = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) setCanvasInteracting(false);
  }, []);

  const updateNode = useCallback((nodeId: string, patch: Partial<ConstellationNodeData>) => {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node));
  }, []);

  const removeNode = useCallback((nodeId: string) => {
    checkpoint();
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
  }, [checkpoint]);

  const addNode = useCallback((kind: ConstellationNodeKind, position?: { x: number; y: number }) => {
    checkpoint();
    const origin = position ?? screenToFlowPosition({
      x: window.innerWidth * .52 + Math.random() * 50,
      y: window.innerHeight * .48 + Math.random() * 50,
    });
    const node = createConstellationNode(kind, origin);
    setNodes((current) => current.map((item) => ({ ...item, selected: false })).concat({ ...node, selected: true }));
    setCommandOpen(false);
  }, [checkpoint, screenToFlowPosition]);

  const chooseReferences = useCallback(async (nodeId: string, kind: "image" | "video") => {
    try {
      const selected = kind === "video" ? await selectVideoReference() : await selectImageReferences();
      if (selected.length === 0) return;
      setNodes((current) => current.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, references: uniqueAttachments([...(node.data.references ?? []), ...selected]).slice(0, 8) } }
        : node));
    } catch (reason) {
      setNotice(errorText(reason));
    }
  }, []);

  const openImageSourcePicker = useCallback((nodeId: string, purpose: ImageSourcePickerPurpose) => {
    setSourcePicker({ nodeId, purpose });
    // Refresh on every open so a result generated moments ago is immediately
    // available as an explicit edit source.
    void loadImageHistory(true);
  }, [loadImageHistory]);

  const applyImageSource = useCallback((nodeId: string, purpose: ImageSourcePickerPurpose, source: ImageAttachment) => {
    const node = graphRef.current.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    // A new explicit source invalidates the previous in-memory output even
    // before React has committed the node update.
    runtimeValuesRef.current.delete(nodeId);
    if (purpose === "canvas") {
      updateNode(nodeId, {
        canvasSource: source,
        canvasResult: undefined,
        maskAttachment: undefined,
        outputs: undefined,
        status: "idle",
        error: undefined,
      });
      setSourcePicker(undefined);
      setEditorNodeId(nodeId);
      return;
    }
    updateNode(nodeId, {
      references: [source],
      operation: node.data.operation === "generate" ? "edit" : node.data.operation,
      outputs: undefined,
      status: "idle",
      error: undefined,
    });
    setSourcePicker(undefined);
  }, [updateNode]);

  const chooseLocalImageSource = useCallback(async () => {
    if (!sourcePicker) return;
    try {
      const source = await selectSingleImageReference();
      if (source) applyImageSource(sourcePicker.nodeId, sourcePicker.purpose, source);
    } catch (reason) {
      setNotice(errorText(reason));
    }
  }, [applyImageSource, sourcePicker]);

  const chooseHistoryImageSource = useCallback(async (asset: MediaAsset) => {
    if (!sourcePicker) return;
    if (!asset.filePath) {
      setNotice(tr("这张历史图片的本地文件已不存在", "The local file for this history image is no longer available"));
      return;
    }
    try {
      const imported = await importMediaReferences([asset.filePath]);
      const source = imported.find((item) => item.kind === "image");
      if (!source) throw new Error(tr("历史图片无法导入素材库", "The history image could not be imported"));
      applyImageSource(sourcePicker.nodeId, sourcePicker.purpose, source);
    } catch (reason) {
      setNotice(errorText(reason));
    }
  }, [applyImageSource, sourcePicker]);

  const inputValues = useCallback((nodeId: string, handle: string) => {
    const current = graphRef.current;
    return current.edges
      .filter((edge) => edge.target === nodeId && edge.targetHandle === handle)
      .map((edge) => runtimeValuesRef.current.get(edge.source)?.[edge.sourceHandle ?? ""]
        ?? current.nodes.find((node) => node.id === edge.source)?.data.outputs?.[edge.sourceHandle ?? ""])
      .filter((value): value is ConstellationValue => Boolean(value));
  }, []);

  const getInputValue = useCallback((nodeId: string, handle: string) => inputValues(nodeId, handle)[0], [inputValues]);

  const openCanvas = useCallback(async (nodeId: string) => {
    const node = graphRef.current.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    let source = node.data.canvasResult ?? node.data.canvasSource ?? getInputValue(nodeId, "image")?.attachment;
    try {
      if (!source) {
        const asset = getInputValue(nodeId, "image")?.asset;
        if (asset?.filePath) source = (await importMediaReferences([asset.filePath]))[0];
      }
      if (!source) {
        openImageSourcePicker(nodeId, "canvas");
        return;
      }
      updateNode(nodeId, { canvasSource: source });
      setEditorNodeId(nodeId);
    } catch (reason) {
      setNotice(errorText(reason));
    }
  }, [getInputValue, openImageSourcePicker, updateNode]);

  const previewableAssets = useMemo(() => {
    const byId = new Map<string, MediaAsset>();
    for (const asset of imageHistory) {
      if (asset.kind === "image" && asset.status === "completed" && asset.filePath) byId.set(asset.id, asset);
    }
    for (const node of nodes) {
      for (const value of Object.values(node.data.outputs ?? {})) {
        if (value?.type === "image" && value.asset?.status === "completed" && value.asset.filePath) {
          byId.set(value.asset.id, value.asset);
        }
      }
    }
    return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt);
  }, [imageHistory, nodes]);

  const openValuePreview = useCallback((value: ConstellationValue) => {
    if (value.type !== "image" || !value.asset?.filePath || value.asset.status !== "completed") return;
    setPreviewAsset(value.asset);
    void loadImageHistory();
  }, [loadImageHistory]);

  const downloadValue = useCallback(async (value: ConstellationValue) => {
    if (!value.asset || value.asset.status !== "completed") return;
    try {
      const destination = await exportMediaAsset(value.asset);
      if (destination) setNotice(tr(`图片已保存到 ${destination}`, `Image saved to ${destination}`));
    } catch (reason) {
      setNotice(errorText(reason));
    }
  }, []);

  const nodeActions = useMemo<ConstellationNodeActions>(() => ({
    locale,
    edges,
    mediaModels: mediaCatalog.models,
    writingModels,
    running,
    updateNode,
    runNode: (nodeId) => { void runGraph([nodeId]); },
    removeNode,
    chooseReferences: (nodeId, kind) => { void chooseReferences(nodeId, kind); },
    openImageSourcePicker,
    openCanvas: (nodeId) => { void openCanvas(nodeId); },
    openPreview: openValuePreview,
    downloadValue: (value) => { void downloadValue(value); },
    getInputValue,
  }), [chooseReferences, downloadValue, edges, getInputValue, locale, mediaCatalog.models, openCanvas, openImageSourcePicker, openValuePreview, removeNode, running, updateNode, writingModels]);

  const updateRuntimeOutput = (
    nodeId: string,
    outputs: Partial<Record<string, ConstellationValue>>,
    status: ConstellationNodeData["status"] = "success",
  ) => {
    runtimeValuesRef.current.set(nodeId, outputs);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, outputs, status, error: undefined } }
      : node));
  };

  async function runGraph(targetIds?: string[]) {
    if (runningRef.current) return;
    runningRef.current = true;
    const snapshot = graphRef.current;
    const epoch = ++runEpochRef.current;
    const included = targetIds?.length
      ? constellationDependencyClosure(targetIds, snapshot.edges)
      : new Set(snapshot.nodes.filter((node) => EXECUTABLE_NODE_KINDS.has(node.data.kind)).map((node) => node.id));
    let layers: ConstellationNode[][];
    try {
      layers = constellationExecutionLayers(snapshot.nodes, snapshot.edges, included);
    } catch (reason) {
      setNotice(errorText(reason));
      runningRef.current = false;
      return;
    }
    runtimeValuesRef.current = new Map(snapshot.nodes.map((node) => [node.id, { ...(node.data.outputs ?? {}) }]));
    const failed = new Set<string>();
    setRunning(true);
    setNotice(undefined);
    setNodes((current) => current.map((node) => included.has(node.id) && EXECUTABLE_NODE_KINDS.has(node.data.kind)
      ? { ...node, data: { ...node.data, status: "queued", error: undefined } }
      : node));
    try {
      for (const layer of layers) {
        if (runEpochRef.current !== epoch) break;
        await Promise.all(layer.map(async (node) => {
          if (!EXECUTABLE_NODE_KINDS.has(node.data.kind)) return;
          const blockedBy = snapshot.edges.find((edge) => edge.target === node.id && failed.has(edge.source));
          if (blockedBy) {
            failed.add(node.id);
            updateNode(node.id, { status: "error", error: tr("上游节点执行失败", "An upstream node failed") });
            return;
          }
          updateNode(node.id, { status: "running", error: undefined });
          try {
            const outputs = await executeNode(node, snapshot, epoch);
            if (runEpochRef.current === epoch) updateRuntimeOutput(node.id, outputs);
          } catch (reason) {
            if (runEpochRef.current !== epoch) return;
            failed.add(node.id);
            updateNode(node.id, { status: "error", error: errorText(reason) });
          }
        }));
      }
      if (runEpochRef.current === epoch) {
        setNotice(failed.size > 0
          ? tr(`${failed.size} 个节点需要处理，其余分支已继续完成`, `${failed.size} node(s) need attention; other branches completed`)
          : tr("星图执行完成，结果已保存到创作历史", "Constellation complete; outputs were saved to creation history"));
      }
    } finally {
      if (runEpochRef.current === epoch) {
        runningRef.current = false;
        setRunning(false);
      }
    }
  }

  async function executeNode(node: ConstellationNode, graph: GraphSnapshot, epoch: number): Promise<Partial<Record<string, ConstellationValue>>> {
    if (runEpochRef.current !== epoch) throw new Error(tr("执行已停止", "Run stopped"));
    const incoming = (handle: string) => graph.edges
      .filter((edge) => edge.target === node.id && edge.targetHandle === handle)
      .map((edge) => runtimeValuesRef.current.get(edge.source)?.[edge.sourceHandle ?? ""])
      .filter((value): value is ConstellationValue => Boolean(value));
    if (node.data.kind === "prompt") {
      const text = node.data.prompt?.trim() ?? "";
      if (!text) throw new Error(tr("提示词节点是空的", "The Prompt node is empty"));
      return { text: { type: "text", text, createdAt: Date.now() } };
    }
    if (node.data.kind === "writing") {
      const prompt = incoming("prompt").map((value) => value.text).filter(Boolean).join("\n\n") || node.data.prompt?.trim() || "";
      const context = incoming("context").map((value) => value.text).filter(Boolean).join("\n\n");
      if (!prompt) throw new Error(tr("写作节点需要任务文本", "The Writing node needs task text"));
      const route = resolveWritingRoute(node, writingModels, activeProfile);
      const baseProfile = profiles.find((profile) => profile.id === route.profileId) ?? activeProfile;
      const profile: ProviderProfile = { ...baseProfile, model: route.model, protocol: route.protocol };
      const operationId = crypto.randomUUID();
      operationIdsRef.current.add(operationId);
      let streamed = "";
      const content = [
        node.data.instruction?.trim() || tr("完成这项创作任务，只输出可直接使用的内容。", "Complete this creative task and output only ready-to-use content."),
        `\n${tr("任务", "Task")}:\n${prompt}`,
        context ? `\n${tr("上下文", "Context")}:\n${context}` : "",
      ].join("");
      const message: AgentMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        toolCalls: [],
        createdAt: Date.now(),
        attachments: [],
      };
      try {
        const response = await agentTurnStream(
          profile,
          [message],
          "chat",
          workspace,
          operationId,
          (delta) => {
            if (runEpochRef.current !== epoch) return;
            streamed += delta;
            updateRuntimeOutput(node.id, { text: { type: "text", text: streamed, createdAt: Date.now() } }, "running");
          },
          undefined,
          profiles.filter((item) => item.id !== profile.id && item.failoverEnabled),
          false,
          false,
          undefined,
          undefined,
          armorModeWritingInstructions(armorMode, armorModeLevel, armorWritingIntensity, {
            model: profile.model,
            protocol: profile.protocol,
            skills: armorModeSkills,
            surface: "constellation",
          }),
        );
        const text = (streamed || response.content).trim();
        if (!text) throw new Error(tr("写作模型没有返回正文", "The writing model returned no content"));
        return { text: { type: "text", text, createdAt: Date.now() } };
      } finally {
        operationIdsRef.current.delete(operationId);
      }
    }
    if (node.data.kind === "canvas") {
      const input = incoming("image")[0];
      const imageAttachment = node.data.canvasResult ?? node.data.canvasSource ?? input?.attachment;
      const image = imageAttachment
        ? { type: "image" as const, attachment: imageAttachment, createdAt: Date.now() }
        : input;
      if (!image) throw new Error(tr("请先打开画板并选择或连接一张图片", "Open the canvas and choose or connect an image first"));
      return {
        image,
        ...(node.data.maskAttachment ? { mask: { type: "image" as const, attachment: node.data.maskAttachment, createdAt: Date.now() } } : {}),
      };
    }
    if (node.data.kind === "output") {
      const value = incoming("media")[0];
      if (!value) throw new Error(tr("作品预览节点还没有输入", "The Output Preview node has no input"));
      return { media: value };
    }
    const mediaKind = mediaKindForConstellationNode(node.data.kind);
    if (!mediaKind) return {};
    const promptHandle = mediaKind === "audio" ? "text" : "prompt";
    const prompt = incoming(promptHandle).map((value) => value.text).filter(Boolean).join("\n\n") || node.data.prompt?.trim() || "";
    if (!prompt) throw new Error(tr("能力节点需要提示词或文案输入", "The ability node needs a prompt or text input"));
    const referenceValues = mediaKind === "image" || mediaKind === "video" ? incoming("image") : [];
    const attachments = uniqueAttachments([
      ...(node.data.references ?? []),
      ...(mediaKind === "image" && node.data.canvasSource ? [node.data.canvasSource] : []),
      ...(await Promise.all(referenceValues.map(valueToAttachment))).filter((value): value is ImageAttachment => Boolean(value)),
    ]);
    const maskValue = incoming("mask")[0];
    const maskAttachment = maskValue?.attachment
      ?? (maskValue ? await valueToAttachment(maskValue) : undefined)
      ?? (mediaKind === "image" ? node.data.maskAttachment : undefined);
    const operation = node.data.operation ?? "generate";
    if (mediaKind === "image" && operation !== "generate" && attachments.length === 0) {
      throw new Error(operation === "outpaint"
        ? tr("扩图需要一张源图片", "Outpainting needs a source image")
        : tr("图片编辑需要一张源图片", "Image editing needs a source image"));
    }
    if (mediaKind === "image" && operation === "inpaint" && !maskAttachment) {
      throw new Error(tr("局部重绘需要连接画板的蒙版输出", "Inpainting needs the Canvas mask output"));
    }
    const route = resolveMediaRoute(node, mediaCatalog, Boolean(mediaKind === "image" && maskAttachment));
    const effectivePrompt = mediaKind === "image" && operation === "outpaint"
      ? `${prompt}\n\n${tr("扩展画面边界并无缝补全新增区域；保持原图主体、光线、透视、色彩和材质完全一致。", "Extend the image beyond its current boundaries and seamlessly complete the new area while preserving subject, lighting, perspective, color, and material.")}`
      : prompt;
    const request: MediaGenerationRequest = {
      kind: mediaKind,
      profileId: route.profileId,
      model: route.model,
      protocol: route.protocol,
      prompt: armorModeMediaPrompt(armorMode, armorModeLevel, mediaKind, effectivePrompt, {
        model: route.model,
        protocol: route.protocol,
        skills: armorModeSkills,
        surface: "constellation",
      }),
      count: Math.max(1, Math.min(mediaKind === "image" ? 8 : 4, node.data.count ?? 1)),
      size: mediaKind === "image"
        ? node.data.size && node.data.size !== "auto" ? node.data.size : undefined
        : mediaKind === "video" ? node.data.videoAspectRatio : undefined,
      quality: mediaKind === "image" && node.data.quality !== "auto" ? node.data.quality : undefined,
      outputFormat: mediaKind === "video" ? undefined : node.data.outputFormat,
      background: mediaKind === "image" && node.data.background !== "auto" ? node.data.background : undefined,
      voice: mediaKind === "audio" ? node.data.voice?.trim() || undefined : undefined,
      instructions: armorModeMediaInstructions(
        armorMode,
        armorModeLevel,
        mediaKind,
        mediaKind === "audio" ? node.data.instruction?.trim() || undefined : undefined,
        {
          model: route.model,
          protocol: route.protocol,
          skills: armorModeSkills,
          surface: "constellation",
        },
      ),
      seconds: mediaKind === "video" ? node.data.seconds ?? 8 : undefined,
      videoMode: mediaKind === "video" ? attachments.length > 1 ? "reference" : attachments.length === 1 ? "image" : "text" : "text",
      videoResolution: mediaKind === "video" ? node.data.videoResolution : undefined,
      videoAspectRatio: mediaKind === "video" ? node.data.videoAspectRatio : undefined,
      referenceAttachmentIds: attachments.map((attachment) => attachment.id),
      maskAttachmentId: mediaKind === "image" ? maskAttachment?.id : undefined,
    };
    setMediaPending((value) => value + request.count);
    try {
      const result = await generateMedia(request);
      if (result.assets.length === 0) throw new Error(result.errors.join(" · ") || tr("模型没有返回可用结果", "The model returned no usable output"));
      const asset = result.assets.find((item) => item.status === "completed") ?? result.assets[0];
      return {
        [mediaKind]: {
          type: mediaKind,
          asset,
          createdAt: Date.now(),
        },
      };
    } finally {
      setMediaPending((value) => Math.max(0, value - request.count));
    }
  }

  async function valueToAttachment(value: ConstellationValue) {
    if (value.attachment) return value.attachment;
    if (!value.asset?.filePath) return undefined;
    return (await importMediaReferences([value.asset.filePath]))[0];
  }

  const stopRun = () => {
    runEpochRef.current += 1;
    runningRef.current = false;
    setRunning(false);
    setNodes((current) => current.map((node) => node.data.status === "running" || node.data.status === "queued"
      ? { ...node, data: { ...node.data, status: "idle", error: tr("已停止；媒体请求若已提交仍会在后台保存", "Stopped; submitted media requests may still finish in the background") } }
      : node));
    for (const operationId of operationIdsRef.current) void cancelAgentTurn(operationId).catch(() => false);
    operationIdsRef.current.clear();
    setNotice(tr("已停止星图执行", "Constellation run stopped"));
  };

  const duplicateSelection = () => {
    const copy = duplicateConstellationSelection(graphRef.current.nodes, graphRef.current.edges);
    if (copy.nodes.length === 0) {
      setNotice(tr("请先选择需要复制的节点", "Select nodes to duplicate first"));
      return;
    }
    checkpoint();
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...copy.nodes]);
    setEdges((current) => current.concat(copy.edges));
  };

  const autoLayout = () => {
    try {
      checkpoint();
      setNodes((current) => autoLayoutConstellation(current, graphRef.current.edges));
      window.setTimeout(() => void fitView({ padding: .16, duration: 320 }), 30);
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };

  const saveBlueprint = () => {
    const selected = nodes.filter((node) => node.selected);
    if (selected.length === 0) {
      setNotice(tr("请先框选需要保存的节点", "Select nodes to save first"));
      return;
    }
    setBlueprintDialog({
      name: selected.length === 1 ? selected[0].data.title : tr(`${selected.length} 节点蓝图`, `${selected.length}-node blueprint`),
      description: "",
      tags: "",
    });
  };

  const confirmBlueprint = () => {
    if (!blueprintDialog) return;
    try {
      const blueprint = createConstellationBlueprint(
        blueprintDialog.name,
        blueprintDialog.description,
        blueprintDialog.tags.split(/[,，\s]+/),
        nodes.filter((node) => node.selected),
        edges,
      );
      setBlueprints((current) => [blueprint, ...current]);
      setBlueprintDialog(undefined);
      setNotice(tr(`已保存蓝图“${blueprint.name}”`, `Saved blueprint “${blueprint.name}”`));
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };

  const insertBlueprint = (blueprint: ConstellationBlueprint) => {
    checkpoint();
    const origin = screenToFlowPosition({ x: window.innerWidth * .52, y: window.innerHeight * .45 });
    const instance = instantiateConstellationBlueprint(blueprint, origin);
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...instance.nodes]);
    setEdges((current) => current.concat(instance.edges));
    setNotice(tr(`已放入“${blueprint.name}”`, `Inserted “${blueprint.name}”`));
    window.setTimeout(() => void fitView({ nodes: instance.nodes.map((node) => ({ id: node.id })), padding: .24, duration: 280 }), 30);
  };

  const newGraph = () => {
    checkpoint();
    const graph = createDefaultConstellationGraph();
    graphMetaRef.current = { id: graph.id, createdAt: graph.createdAt };
    setGraphTitle(tr("未命名星图", "Untitled Constellation"));
    setNodes(graph.nodes.map((node) => ({ ...node, data: { ...node.data, prompt: node.data.kind === "prompt" ? "" : node.data.prompt } })));
    setEdges(graph.edges);
    runtimeValuesRef.current.clear();
    window.setTimeout(() => void fitView({ padding: .2, duration: 260 }), 20);
  };

  const exportGraph = async () => {
    try {
      const graph = serializeConstellationGraph({
        schemaVersion: 1,
        id: graphMetaRef.current.id,
        title: graphTitle,
        nodes,
        edges,
        createdAt: graphMetaRef.current.createdAt,
        updatedAt: Date.now(),
      });
      const fileName = `${safeFileName(graphTitle) || "constellation"}.levelup-constellation.json`;
      const saved = await exportWritingFile(fileName, JSON.stringify({ kind: "levelup-constellation", graph, blueprints }, null, 2), "json");
      if (saved) setNotice(tr(`星图已导出为 ${fileName}`, `Constellation exported as ${fileName}`));
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };

  const importGraph = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error(tr("星图文件不能超过 8 MiB", "Constellation files may not exceed 8 MiB"));
      const value = JSON.parse(await file.text()) as unknown;
      const record = isRecord(value) ? value : {};
      const graph = normalizeConstellationGraph(record.graph ?? value);
      if (!graph) throw new Error(tr("文件中没有有效星图", "The file does not contain a valid constellation"));
      checkpoint();
      graphMetaRef.current = { id: graph.id, createdAt: graph.createdAt };
      setGraphTitle(graph.title);
      setNodes(graph.nodes);
      setEdges(graph.edges);
      if (Array.isArray(record.blueprints)) {
        const incoming = record.blueprints.map(normalizeConstellationBlueprint).filter((item): item is ConstellationBlueprint => item !== null && !item.builtIn);
        setBlueprints((current) => mergeBlueprints(current, incoming));
      }
      setNotice(tr("星图导入完成", "Constellation imported"));
      window.setTimeout(() => void fitView({ padding: .18, duration: 320 }), 30);
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };

  const onLibraryDragStart = (event: DragEvent<HTMLButtonElement>, kind: ConstellationNodeKind) => {
    event.dataTransfer.setData("application/x-levelup-constellation-node", kind);
    event.dataTransfer.effectAllowed = "copy";
  };

  const onCanvasDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("application/x-levelup-constellation-node") as ConstellationNodeKind;
    if (!CONSTELLATION_NODE_DEFINITIONS[kind]) return;
    addNode(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  const filteredNodes = NODE_LIBRARY.filter((item) => !libraryQuery.trim() || item.keywords.includes(libraryQuery.trim().toLocaleLowerCase()));
  const commandNodes = NODE_LIBRARY.filter((item) => !commandQuery.trim() || item.keywords.includes(commandQuery.trim().toLocaleLowerCase()));
  const availableBlueprints = [...BUILT_IN_CONSTELLATION_BLUEPRINTS, ...blueprints].filter((blueprint) => {
    const query = blueprintQuery.trim().toLocaleLowerCase();
    return !query || `${blueprint.name} ${blueprint.description} ${blueprint.tags.join(" ")}`.toLocaleLowerCase().includes(query);
  });
  const selectedCount = nodes.filter((node) => node.selected).length;
  const displayEdges = useMemo(() => {
    if (!running) return edges;
    const runningSources = new Set(nodes.filter((node) => node.data.status === "running").map((node) => node.id));
    return edges.map((edge) => ({ ...edge, animated: runningSources.has(edge.source) }));
  }, [edges, nodes, running]);
  const editorNode = editorNodeId ? nodes.find((node) => node.id === editorNodeId) : undefined;
  const editorSource = editorNode?.data.canvasResult ?? editorNode?.data.canvasSource;
  keyboardActionsRef.current = {
    undo: undoGraph,
    redo: redoGraph,
    duplicate: duplicateSelection,
    run: runGraph,
    stop: stopRun,
  };

  return (
    <>
      <header className="constellation-topbar" data-tauri-drag-region>
        <div className="constellation-brand">
          <span><Boxes size={18} /></span>
          <div><strong>{tr("星图", "Constellation")}</strong><small>{tr("把灵感连成作品", "Connect ideas into finished work")}</small></div>
        </div>
        <input className="constellation-title-input nodrag nopan" value={graphTitle} maxLength={120} aria-label={tr("星图名称", "Constellation name")} onFocus={() => { spacePanRef.current = false; setSpacePanActive(false); }} onChange={(event) => setGraphTitle(event.target.value)} />
        <div className="creation-mode-switch constellation-mode-switch" role="tablist" aria-label={tr("创作空间", "Creative Studio")}>
          <button type="button" role="tab" aria-selected="false" onClick={onMedia}><ImagePlus size={13} />{tr("媒体", "Media")}</button>
          <button type="button" role="tab" aria-selected="false" onClick={onWriting}><BookOpen size={13} />{tr("写作", "Writing")}</button>
          <button type="button" role="tab" aria-selected="true" className="active"><Boxes size={13} />{tr("星图", "Constellation")}</button>
        </div>
        <div className="constellation-topbar-actions">
          {running ? <button type="button" className="danger" onClick={stopRun}><Square size={13} />{tr("停止", "Stop")}</button>
            : <button type="button" className="primary" onClick={() => void runGraph()}><Play size={13} />{tr("运行星图", "Run")}</button>}
          <button type="button" onClick={saveBlueprint} disabled={selectedCount === 0} title={tr("框选节点后保存为蓝图", "Save selected nodes as a blueprint")}><Save size={13} />{tr("存为蓝图", "Save blueprint")}</button>
          <button type="button" className="icon-only" onClick={onConfigureConnection} title={tr("模型连接", "Model connections")}><Settings2 size={15} /></button>
        </div>
      </header>

      <div ref={workbenchRef} className={`constellation-workbench${leftPanelOpen ? " left-open" : ""}${rightPanelOpen ? " right-open" : ""}`}>
        <aside className="constellation-library-panel" aria-label={tr("节点库", "Node library")} aria-hidden={!leftPanelOpen} inert={!leftPanelOpen}>
          <div className="constellation-panel-heading"><div><LibraryBig size={15} /><strong>{tr("节点库", "Node library")}</strong></div><button type="button" aria-label={tr("关闭节点库", "Close node library")} onClick={() => setLeftPanelOpen(false)}><ChevronLeft size={15} /></button></div>
          <label className="constellation-search"><Search size={13} /><input value={libraryQuery} placeholder={tr("搜索能力或工具", "Search abilities or tools")} onChange={(event) => setLibraryQuery(event.target.value)} />{libraryQuery && <button type="button" onClick={() => setLibraryQuery("")}><X size={12} /></button>}</label>
          <div className="constellation-library-scroll">
            {(["input", "ability", "tool", "output"] as const).map((category) => {
              const items = filteredNodes.filter((item) => CONSTELLATION_NODE_DEFINITIONS[item.kind].category === category);
              if (items.length === 0) return null;
              return <section key={category}><small>{categoryLabel(category)}</small>{items.map(({ kind }) => {
                const definition = CONSTELLATION_NODE_DEFINITIONS[kind];
                return <button type="button" draggable onDragStart={(event) => onLibraryDragStart(event, kind)} onClick={() => addNode(kind)} key={kind}><span className={`kind-dot kind-${kind}`} /><div><strong>{tr(definition.label, definition.labelEn)}</strong><small>{tr(definition.description, definition.descriptionEn)}</small></div><Plus size={13} /></button>;
              })}</section>;
            })}
          </div>
          <div className="constellation-library-tip"><Sparkles size={13} /><span>{tr("拖到画布放置；框选后可存为自己的蓝图", "Drag to place; box-select to save your own blueprint")}</span></div>
        </aside>

        <section className={`constellation-canvas-shell${canvasInteracting ? " interacting" : ""}${connectionType ? ` connecting-type-${connectionType}` : ""}`} onFocusCapture={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest("input, textarea, select, [contenteditable='true']")) {
            spacePanRef.current = false;
            setSpacePanActive(false);
          }
        }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={onCanvasDrop}>
          <ConstellationNodeActionsProvider value={nodeActions}>
            <ReactFlow<ConstellationNode, ConstellationEdge>
              nodes={nodes}
              edges={displayEdges}
              nodeTypes={CONSTELLATION_NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onReconnect={onReconnect}
              isValidConnection={isValidConnection}
              onConnectStart={onConnectionStart}
              onConnectEnd={onConnectionEnd}
              onClickConnectStart={onConnectionStart}
              onClickConnectEnd={onConnectionEnd}
              onNodeDragStart={onNodeDragStart}
              onNodeDragStop={onNodeDragStop}
              onSelectionStart={beginCanvasInteraction}
              onSelectionEnd={endCanvasInteraction}
              onSelectionDragStart={onSelectionDragStart}
              onSelectionDragStop={onSelectionDragStop}
              onMoveStart={onCanvasMoveStart}
              onMoveEnd={onCanvasMoveEnd}
              onPaneClick={(event) => {
                setNotice(undefined);
                if (event.detail >= 2) {
                  setCommandQuery("");
                  setCommandOpen(true);
                }
                else setCommandOpen(false);
              }}
              minZoom={.18}
              maxZoom={2.2}
              fitView
              fitViewOptions={{ padding: .18, maxZoom: 1 }}
              selectionMode={SelectionMode.Partial}
              selectionOnDrag
              panActivationKeyCode={null}
              panOnDrag={spacePanActive ? true : [1, 2]}
              nodesDraggable={!spacePanActive}
              connectOnClick
              connectionRadius={38}
              reconnectRadius={28}
              connectionDragThreshold={1}
              nodeDragThreshold={2}
              autoPanSpeed={10}
              defaultEdgeOptions={CONSTELLATION_DEFAULT_EDGE_OPTIONS}
              connectionLineStyle={CONSTELLATION_CONNECTION_STYLE}
              onlyRenderVisibleElements
              multiSelectionKeyCode={["Control", "Meta", "Shift"]}
              deleteKeyCode={["Backspace", "Delete"]}
              colorMode="light"
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.25} color="rgba(100,116,139,.28)" />
              {!canvasInteracting && <MiniMap nodeColor={constellationMiniMapColor} maskColor="rgba(248,250,252,.78)" pannable zoomable />}
              <Controls showInteractive={false} position="bottom-center" />
              <Panel position="top-left" className="constellation-canvas-toolbar">
                {!leftPanelOpen && <button type="button" onClick={() => setLeftPanelOpen(true)} title={tr("打开节点库", "Open node library")}><ChevronRight size={14} /><LibraryBig size={13} /></button>}
                <button type="button" disabled={historyRef.current.undo.length === 0} onClick={undoGraph} title={`${tr("撤销", "Undo")} Ctrl+Z`}><Undo2 size={14} /></button>
                <button type="button" disabled={historyRef.current.redo.length === 0} onClick={redoGraph} title={`${tr("重做", "Redo")} Ctrl+Shift+Z`}><Redo2 size={14} /></button>
                <span />
                <button type="button" onClick={duplicateSelection} disabled={selectedCount === 0} title={`${tr("复制选中", "Duplicate selection")} Ctrl+D`}><LayoutGrid size={14} /></button>
                <button type="button" onClick={autoLayout} title={tr("自动整理", "Auto layout")}><WandSparkles size={14} /></button>
                <button type="button" onClick={() => void fitView({ padding: .16, duration: 260 })} title={`${tr("适应画布", "Fit view")} F`}><Focus size={14} /></button>
                <span />
                <button type="button" onClick={newGraph} title={tr("新建星图", "New constellation")}><Plus size={14} /></button>
                <button type="button" onClick={() => importInputRef.current?.click()} title={tr("导入", "Import")}><FolderInput size={14} /></button>
                <button type="button" onClick={() => void exportGraph()} title={tr("导出", "Export")}><Download size={14} /></button>
              </Panel>
              <Panel position="bottom-left" className="constellation-selection-status">
                {selectedCount > 0 ? <><Check size={12} /><strong>{selectedCount}</strong><span>{tr("个节点已选中", "nodes selected")}</span><button type="button" onClick={saveBlueprint}><Save size={11} />{tr("存为蓝图", "Save")}</button></>
                  : <><Maximize2 size={12} /><span>{tr("点击或拖动端口连线 · 拖动框选 · Ctrl+K 搜索", "Click or drag ports to connect · drag to select · Ctrl+K search")}</span></>}
              </Panel>
              {commandOpen && <Panel position="top-center" className="constellation-command-panel"><CommandPalette query={commandQuery} onQuery={setCommandQuery} items={commandNodes} onChoose={addNode} onClose={() => setCommandOpen(false)} /></Panel>}
            </ReactFlow>
          </ConstellationNodeActionsProvider>
          {catalogLoading && <div className="constellation-catalog-loading"><LoaderCircle className="spin" size={14} />{tr("正在同步模型能力", "Syncing model capabilities")}</div>}
          {(notice || catalogError) && <div className={`constellation-notice${catalogError && !notice ? " warning" : ""}`} role="status"><CircleAlert size={14} /><span>{notice ?? catalogError}</span><button type="button" aria-label={tr("关闭提示", "Dismiss message")} onClick={() => { setNotice(undefined); setCatalogError(undefined); }}><X size={13} /></button></div>}
        </section>

        <aside className="constellation-blueprint-panel" aria-label={tr("蓝图库", "Blueprint library")} aria-hidden={!rightPanelOpen} inert={!rightPanelOpen}>
          <div className="constellation-panel-heading"><div><Boxes size={15} /><strong>{tr("蓝图库", "Blueprint library")}</strong></div><button type="button" aria-label={tr("关闭蓝图库", "Close blueprint library")} onClick={() => setRightPanelOpen(false)}><ChevronRight size={15} /></button></div>
          <label className="constellation-search"><Search size={13} /><input value={blueprintQuery} placeholder={tr("搜索蓝图", "Search blueprints")} onChange={(event) => setBlueprintQuery(event.target.value)} />{blueprintQuery && <button type="button" onClick={() => setBlueprintQuery("")}><X size={12} /></button>}</label>
          <div className="constellation-blueprint-scroll">
            <section className="constellation-blueprint-intro"><span><Sparkles size={16} /></span><div><strong>{tr("从成熟流程开始", "Start from a proven flow")}</strong><small>{tr("插入后仍可自由拆解和修改", "Every inserted blueprint remains fully editable")}</small></div></section>
            {availableBlueprints.map((blueprint) => <BlueprintCard blueprint={blueprint} onInsert={() => insertBlueprint(blueprint)} onDelete={blueprint.builtIn ? undefined : () => setBlueprints((current) => current.filter((item) => item.id !== blueprint.id))} key={blueprint.id} />)}
            {availableBlueprints.length === 0 && <div className="constellation-blueprint-empty"><Boxes size={24} /><span>{tr("没有匹配的蓝图", "No matching blueprints")}</span></div>}
          </div>
          <button type="button" className="constellation-save-selection" disabled={selectedCount === 0} onClick={saveBlueprint}><Save size={13} />{selectedCount > 0 ? tr(`保存选中的 ${selectedCount} 个节点`, `Save ${selectedCount} selected nodes`) : tr("框选节点以保存蓝图", "Select nodes to save a blueprint")}</button>
        </aside>

        {!rightPanelOpen && <button type="button" className="constellation-open-blueprints" onClick={() => setRightPanelOpen(true)} title={tr("打开蓝图库", "Open blueprint library")}><Boxes size={15} /><ChevronLeft size={13} /></button>}
      </div>

      <input ref={importInputRef} type="file" accept=".json,.levelup-constellation.json" hidden onChange={(event) => void importGraph(event)} />

      {blueprintDialog && <BlueprintDialog value={blueprintDialog} nodeCount={selectedCount} onChange={setBlueprintDialog} onCancel={() => setBlueprintDialog(undefined)} onSave={confirmBlueprint} />}
      {sourcePicker && <ConstellationImageSourcePicker
        purpose={sourcePicker.purpose}
        assets={imageHistory}
        loading={imageHistoryLoading}
        onRefresh={() => void loadImageHistory(true)}
        onChooseLocal={() => void chooseLocalImageSource()}
        onChooseHistory={(asset) => void chooseHistoryImageSource(asset)}
        onPreview={setPreviewAsset}
        onClose={() => setSourcePicker(undefined)}
      />}
      {previewAsset && <MediaImagePreview
        asset={previewAsset}
        locale={locale}
        previewAssets={previewableAssets}
        onNavigate={setPreviewAsset}
        onClose={() => setPreviewAsset(undefined)}
      />}
      {editorNode && editorSource && <ConstellationCanvasEditor source={editorSource} onClose={() => setEditorNodeId(undefined)} onSave={(image, mask) => {
        updateNode(editorNode.id, {
          canvasResult: image,
          maskAttachment: mask,
          outputs: {
            image: { type: "image", attachment: image, createdAt: Date.now() },
            ...(mask ? { mask: { type: "image" as const, attachment: mask, createdAt: Date.now() } } : {}),
          },
          status: "success",
        });
        runtimeValuesRef.current.set(editorNode.id, {
          image: { type: "image", attachment: image, createdAt: Date.now() },
          ...(mask ? { mask: { type: "image", attachment: mask, createdAt: Date.now() } } : {}),
        });
        setEditorNodeId(undefined);
        setNotice(mask ? tr("标注图与 PNG 蒙版已保存到节点", "Annotated image and PNG mask saved to the node") : tr("标注图已保存到节点", "Annotated image saved to the node"));
      }} />}
      <span hidden>{historyRevision}</span>
    </>
  );
}

function CommandPalette({ query, onQuery, items, onChoose, onClose }: {
  query: string;
  onQuery: (query: string) => void;
  items: NodeLibraryItem[];
  onChoose: (kind: ConstellationNodeKind) => void;
  onClose: () => void;
}) {
  const visibleItems = items.slice(0, 8);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => setActiveIndex(0), [query, visibleItems.length]);
  return <div className="constellation-command"><header><Search size={15} /><input
    autoFocus
    value={query}
    placeholder={tr("搜索并添加节点…", "Search and add a node…")}
    onChange={(event) => onQuery(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => visibleItems.length > 0 ? (index + 1) % visibleItems.length : 0);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => visibleItems.length > 0 ? (index - 1 + visibleItems.length) % visibleItems.length : 0);
      } else if (event.key === "Enter" && visibleItems[activeIndex]) {
        event.preventDefault();
        onChoose(visibleItems[activeIndex].kind);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }}
  /><button type="button" onClick={onClose}><X size={13} /></button></header><div>{visibleItems.map(({ kind }, index) => { const definition = CONSTELLATION_NODE_DEFINITIONS[kind]; return <button type="button" className={index === activeIndex ? "active" : ""} onMouseEnter={() => setActiveIndex(index)} onClick={() => onChoose(kind)} key={kind}><span className={`kind-dot kind-${kind}`} /><div><strong>{tr(definition.label, definition.labelEn)}</strong><small>{tr(definition.description, definition.descriptionEn)}</small></div><kbd>↵</kbd></button>; })}</div><footer><span>↑↓ {tr("选择", "select")}</span><span>Enter {tr("添加", "add")}</span><span>Esc {tr("关闭", "close")}</span></footer></div>;
}

function BlueprintCard({ blueprint, onInsert, onDelete }: { blueprint: ConstellationBlueprint; onInsert: () => void; onDelete?: () => void }) {
  const abilities = [...new Set(blueprint.nodes.map((node) => node.data.kind))];
  return <article className={`constellation-blueprint-card${blueprint.builtIn ? " built-in" : " personal"}`}>
    <header><span>{blueprint.builtIn ? <Sparkles size={13} /> : <Boxes size={13} />}{blueprint.builtIn ? tr("精选", "Featured") : tr("我的", "Mine")}</span>{onDelete && <button type="button" onClick={onDelete} title={tr("删除蓝图", "Delete blueprint")}><Trash2 size={12} /></button>}</header>
    <strong>{blueprint.name}</strong><p>{blueprint.description || tr("可复用的节点组合", "Reusable node composition")}</p>
    <div className="constellation-blueprint-map">{abilities.slice(0, 6).map((kind, index) => <span className={`kind-${kind}`} style={{ left: `${12 + index * (74 / Math.max(1, abilities.length - 1))}%` }} key={kind} />)}{abilities.length > 1 && <i />}</div>
    <footer><div>{blueprint.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div><button type="button" onClick={onInsert}><Plus size={12} />{tr("放入画布", "Insert")}</button></footer>
  </article>;
}

function BlueprintDialog({ value, nodeCount, onChange, onCancel, onSave }: { value: BlueprintDraft; nodeCount: number; onChange: (value: BlueprintDraft) => void; onCancel: () => void; onSave: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);
  return <div className="constellation-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="blueprint-dialog-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="constellation-blueprint-dialog"><header><span><Save size={17} /></span><div><strong id="blueprint-dialog-title">{tr("保存为我的蓝图", "Save as my blueprint")}</strong><small>{tr(`${nodeCount} 个节点及其内部连线`, `${nodeCount} nodes and their internal connections`)}</small></div><button type="button" onClick={onCancel}><X size={16} /></button></header><div><label><span>{tr("蓝图名称", "Blueprint name")}</span><input autoFocus value={value.name} maxLength={80} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label><label><span>{tr("用途说明", "Description")}</span><textarea value={value.description} maxLength={240} placeholder={tr("这个蓝图解决什么问题？", "What does this blueprint accomplish?")} onChange={(event) => onChange({ ...value, description: event.target.value })} /></label><label><span>{tr("标签", "Tags")}</span><input value={value.tags} placeholder={tr("例如：短片, 电商, 扩图", "For example: short film, product, outpaint")} onChange={(event) => onChange({ ...value, tags: event.target.value })} /></label><p><CircleAlert size={13} />{tr("运行结果、私有素材和临时状态不会写入蓝图；模型、参数与提示词会保留。", "Outputs, private assets, and temporary state are excluded; models, parameters, and prompts are retained.")}</p></div><footer><button type="button" onClick={onCancel}>{tr("取消", "Cancel")}</button><button type="button" className="primary" disabled={!value.name.trim()} onClick={onSave}><Save size={13} />{tr("保存蓝图", "Save blueprint")}</button></footer></section></div>;
}

function ConstellationImageSourcePicker({
  purpose,
  assets,
  loading,
  onRefresh,
  onChooseLocal,
  onChooseHistory,
  onPreview,
  onClose,
}: {
  purpose: ImageSourcePickerPurpose;
  assets: MediaAsset[];
  loading: boolean;
  onRefresh: () => void;
  onChooseLocal: () => void;
  onChooseHistory: (asset: MediaAsset) => void;
  onPreview: (asset: MediaAsset) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const completed = assets.filter((asset) => asset.kind === "image" && asset.status === "completed" && mediaAssetUrl(asset));
  return (
    <div className="constellation-source-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="constellation-source-picker-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="constellation-source-picker">
        <header>
          <div><span><ImagePlus size={16} /></span><div><strong id="constellation-source-picker-title">{purpose === "canvas" ? tr("选择画板源图", "Choose a canvas source") : tr("选择编辑源图", "Choose an edit source")}</strong><small>{tr("可以从创作历史或本地文件指定一张图片", "Choose one image from creation history or a local file")}</small></div></div>
          <button type="button" onClick={onClose} aria-label={tr("关闭", "Close")}><X size={17} /></button>
        </header>
        <div className="constellation-source-picker-actions">
          <button type="button" className="primary" autoFocus onClick={onChooseLocal}><FolderInput size={14} />{tr("从本地选择", "Choose local file")}</button>
          <button type="button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? "spin" : undefined} size={14} />{tr("刷新历史", "Refresh history")}</button>
        </div>
        <div className="constellation-source-picker-body">
          {loading && completed.length === 0 && <div className="constellation-source-picker-empty"><LoaderCircle className="spin" size={22} /><span>{tr("正在读取创作历史…", "Loading creation history…")}</span></div>}
          {!loading && completed.length === 0 && <div className="constellation-source-picker-empty"><ImagePlus size={24} /><strong>{tr("还没有可用的历史图片", "No history images are available")}</strong><span>{tr("可以先从本地选择一张图片", "Choose a local image to get started")}</span></div>}
          {completed.length > 0 && <div className="constellation-source-grid">{completed.map((asset) => <article className="constellation-source-card" key={asset.id}>
            <button type="button" className="constellation-source-image" onClick={() => onChooseHistory(asset)} title={tr("使用这张图片", "Use this image")}>
              <img src={mediaAssetUrl(asset)} alt={asset.revisedPrompt || asset.prompt} />
              <span>{tr("使用此图", "Use image")}</span>
            </button>
            <footer><span title={asset.prompt}>{asset.prompt || tr("未命名图片", "Untitled image")}</span><button type="button" onClick={() => onPreview(asset)} title={tr("预览图片", "Preview image")}><Maximize2 size={12} /></button></footer>
          </article>)}</div>}
        </div>
        <footer><span>{tr("选中的图片会作为明确源图传入后续编辑节点", "The selected image becomes the explicit source for the next edit node")}</span><button type="button" onClick={onClose}>{tr("取消", "Cancel")}</button></footer>
      </section>
    </div>
  );
}

function resolveMediaRoute(node: ConstellationNode, catalog: MediaCatalog, requiresMask = false) {
  const kind = mediaKindForConstellationNode(node.data.kind);
  if (!kind) throw new Error(tr("节点不是媒体能力", "This is not a media ability node"));
  const selected = node.data.modelRoute;
  const selectedModel = selected
    ? catalog.models.find((model) => model.kind === kind && model.profileId === selected.profileId && model.id === selected.model && model.protocol === selected.protocol)
    : undefined;
  if (selected && selectedModel) {
    if (requiresMask && !mediaModelSupportsExplicitImageMask(selectedModel)) {
      throw new Error(tr(
        `模型“${selectedModel.id}”不支持 PNG 蒙版编辑，请改为自动选择或选择支持 OpenAI Images Edit 的图像模型`,
        `Model “${selectedModel.id}” does not support PNG mask editing. Choose automatic routing or an image model with OpenAI Images Edit support`,
      ));
    }
    return selected;
  }
  const candidates = catalog.models.filter((model) => model.kind === kind && (!requiresMask || mediaModelSupportsExplicitImageMask(model)));
  const fallback = candidates.find((model) => model.recommended) ?? candidates[0];
  if (!fallback && requiresMask && catalog.models.some((model) => model.kind === kind)) {
    throw new Error(tr(
      "当前没有支持 PNG 蒙版编辑的图像模型，请先配置支持 OpenAI Images Edit 的模型",
      "No configured image model supports PNG mask editing. Configure a model with OpenAI Images Edit support",
    ));
  }
  if (!fallback) throw new Error(tr(`没有可用的${kind === "image" ? "图像" : kind === "video" ? "视频" : "语音"}模型`, `No ${kind} model is available`));
  return { profileId: fallback.profileId, profileName: fallback.profileName, model: fallback.id, protocol: fallback.protocol };
}

function resolveWritingRoute(node: ConstellationNode, models: ProviderModelInfo[], activeProfile: ProviderProfile) {
  const selected = node.data.modelRoute;
  if (selected && models.some((model) => model.profileId === selected.profileId && model.id === selected.model && model.protocol === selected.protocol)) return selected;
  const fallback = models.find((model) => model.profileId === activeProfile.id && model.id === activeProfile.model)
    ?? models.find((model) => model.profileId === activeProfile.id)
    ?? models[0];
  if (!fallback) return { profileId: activeProfile.id, profileName: activeProfile.name, model: activeProfile.model, protocol: activeProfile.protocol };
  return { profileId: fallback.profileId, profileName: fallback.profileName, model: fallback.id, protocol: fallback.protocol };
}

function loadConstellationGraph() {
  try {
    const raw = localStorage.getItem(CONSTELLATION_STORAGE_KEY);
    const parsed = raw ? normalizeConstellationGraph(JSON.parse(raw)) : null;
    return parsed ?? createDefaultConstellationGraph();
  } catch {
    return createDefaultConstellationGraph();
  }
}

function loadPersonalBlueprints() {
  try {
    const raw = localStorage.getItem(CONSTELLATION_BLUEPRINTS_KEY);
    const value = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(value)
      ? value.map(normalizeConstellationBlueprint).filter((item): item is ConstellationBlueprint => item !== null && !item.builtIn).slice(0, 120)
      : [];
  } catch {
    return [];
  }
}

function uniqueAttachments(values: ImageAttachment[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function mergeBlueprints(current: ConstellationBlueprint[], incoming: ConstellationBlueprint[]) {
  const values = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) values.set(item.id, item);
  return [...values.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 120);
}

function categoryLabel(category: "input" | "ability" | "tool" | "output") {
  return category === "input" ? tr("输入", "Input") : category === "ability" ? tr("四项标准能力", "Four core abilities") : category === "tool" ? tr("创作工具", "Creative tools") : tr("输出", "Output");
}

function safeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
