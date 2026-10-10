import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  useStoreApi,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type OnConnectStartParams,
} from "@xyflow/react";
import {
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
  listConstellationProjects,
  listMediaAssets,
  mediaAssetUrl,
  onMediaAssetUpdate,
  selectImageReferences,
  selectSingleImageReference,
  selectVideoReference,
  saveConstellationProject,
  deleteConstellationProject,
  executeTool,
  harnessCheckTool,
  selectLocalResourcePaths,
  importLocalResources,
  refreshMediaAsset,
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
  constellationRunPlan,
  constellationDescendants,
  staleConstellationNodes,
  findConstellationNodePort,
  portTypesCompatible,
  constellationExecutionLayers,
  constellationConnectionMembers,
  constellationPendingMediaIds,
  updateConstellationMediaAsset,
  syncConstellationPreviews,
  constellationCandidateSelection,
  constellationProjectReferenceValue,
  constellationValueReady,
  constellationInputAttachments,
  constellationFileOutputs,
  constellationConversationAttachments,
  DEFAULT_CONSTELLATION_TOOL_TEMPLATE,
  normalizeConstellationToolTemplate,
  renderConstellationTemplate,
  parseConstellationCommandOutput,
  createConstellationBlueprint,
  createConstellationEdge,
  createConstellationNode,
  createDefaultConstellationGraph,
  duplicateConstellationSelection,
  groupConstellationConnections,
  instantiateConstellationBlueprint,
  mediaKindForConstellationNode,
  normalizeConstellationBlueprint,
  normalizeConstellationGraph,
  resolveConstellationConnection,
  serializeConstellationGraph,
  type ConstellationBlueprint,
  type ConstellationEdge,
  type ConstellationGraph,
  type ConstellationNode,
  type ConstellationNodeData,
  type ConstellationNodeKind,
  type ConstellationPortType,
  type ConstellationValue,
  UNIVERSAL_INPUT_HANDLE,
  UNIVERSAL_OUTPUT_HANDLE,
} from "../lib/constellation";
import { tr } from "../lib/i18n";
import { imageGenerationSize, imageModelCapabilities, mediaModelSupportsExplicitImageMask, sortStudioMediaModels, videoOutputOptions } from "../lib/mediaCapabilities";
import { createMediaPoller } from "../lib/mediaPolling";
import { isTextGenerationModel, profileHasTextModel, reasoningEffortForProfile } from "../lib/modelSelection";
import type {
  AgentMessage,
  AgentThread,
  ImageAttachment,
  MediaAsset,
  MediaCatalog,
  MediaGenerationRequest,
  ProviderModelInfo,
  ProviderProfile,
  ReasoningEffort,
  ConstellationProjectRecord,
  ConstellationToolTemplate,
} from "../lib/types";
import { loadConstellationToolTemplates, saveConstellationToolTemplates } from "../lib/constellationStorage";
import { ConstellationOverview, overviewPositionFor, overviewPositionForRecords } from "./ConstellationOverview";
import { ConstellationConversationPicker, ConstellationProjectPicker } from "./ConstellationSources";
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
import { CreativeStudioHeader } from "./CreativeStudioHeader";
import { captureConstellationEntry, ConstellationEnterTransition, type ConstellationEntrySnapshot } from "./ConstellationEnterTransition";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isDesktop } from "../lib/bridge";

interface ConstellationStudioProps {
  active: boolean;
  locale: string;
  armorMode: boolean;
  armorModeLevel: ArmorModeLevel;
  armorModeSkills: ArmorSkillState;
  armorWritingIntensity: ArmorWritingIntensity;
  activeProfile: ProviderProfile;
  profiles: ProviderProfile[];
  reasoningEffort: ReasoningEffort;
  workspace?: string;
  threads: AgentThread[];
  onOpenConversation: (threadId: string) => void;
  onRunConversation: (request: { threadId?: string; command: string; context?: string; attachments?: ImageAttachment[]; workspace?: string; onThreadReady?: (thread: Pick<AgentThread, "id" | "title">) => void }) => Promise<{ threadId: string; title: string; text?: string }>;
  mediaCatalogRevision: number;
  onConfigureConnection: () => void;
  onSpine: () => void;
  onModel3d: () => void;
  onMusic: () => void;
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

const EXECUTABLE_NODE_KINDS = new Set<ConstellationNodeKind>(["conversation", "input", "localTool", "projectRef", "prompt", "writing", "image", "video", "audio", "canvas", "output"]);
const CONSTELLATION_DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep",
  interactionWidth: 28,
  reconnectable: true,
} as const;
const CONSTELLATION_CONNECTION_STYLE = { stroke: "var(--violet-text)", strokeWidth: 2.2 } as const;
const CONSTELLATION_MIGRATION_MARKER = "levelup-agent.constellation-projects.migrated.v1";
class ConstellationWaitingError extends Error {}

interface ConstellationProjectPayload {
  schemaVersion: 1;
  graph: ConstellationGraph;
  overviewPosition: { x: number; y: number };
  viewport?: { x: number; y: number; zoom: number };
}

export function ConstellationStudio(props: ConstellationStudioProps) {
  const armorClassName = props.armorMode ? ` armor-mode armor-level-${props.armorModeLevel}` : "";
  return (
    <main className={`constellation-studio creative-studio${armorClassName}`} data-armor-level={props.armorMode ? props.armorModeLevel : undefined} hidden={!props.active}>
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
  reasoningEffort,
  workspace,
  threads,
  onOpenConversation,
  onRunConversation,
  mediaCatalogRevision,
  onConfigureConnection,
  onMedia,
  onSpine,
  onModel3d, onMusic,
  onWriting,
  onPendingCountChange,
}: ConstellationStudioProps) {
  const [initialGraph] = useState<ConstellationGraph>(() => loadConstellationGraph());
  const initialGraphRef = useRef(initialGraph);
  const [nodes, setNodes] = useState<ConstellationNode[]>(initialGraphRef.current.nodes);
  const contentNodesRef = useRef(nodes);
  // Position/selection changes must not invalidate previews or grouped connections.
  const contentNodes = useMemo(() => {
    const previous = contentNodesRef.current;
    if (previous.length !== nodes.length || nodes.some((node, index) => node.id !== previous[index].id || node.data !== previous[index].data)) {
      contentNodesRef.current = nodes;
    }
    return contentNodesRef.current;
  }, [nodes]);
  const [edges, setEdges] = useState<ConstellationEdge[]>(initialGraphRef.current.edges);
  const [graphTitle, setGraphTitle] = useState(initialGraphRef.current.title);
  const [projectRecords, setProjectRecords] = useState<ConstellationProjectRecord[]>([]);
  const [projectHydrated, setProjectHydrated] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [entrySnapshot, setEntrySnapshot] = useState<ConstellationEntrySnapshot>();
  const [initialViewportReady, setInitialViewportReady] = useState(true);
  const finishEntry = useCallback(() => setEntrySnapshot(undefined), []);
  const [templateId, setTemplateId] = useState(BUILT_IN_CONSTELLATION_BLUEPRINTS[0]?.id ?? "");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectError, setProjectError] = useState<string>();
  const [projectLoadRevision, setProjectLoadRevision] = useState(0);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [projectBusy, setProjectBusy] = useState(false);
  const overviewOpenRef = useRef(true);
  const [blueprints, setBlueprints] = useState<ConstellationBlueprint[]>(loadPersonalBlueprints);
  const [toolTemplates, setToolTemplates] = useState<ConstellationToolTemplate[]>(() => [structuredClone(DEFAULT_CONSTELLATION_TOOL_TEMPLATE), ...loadConstellationToolTemplates(() => localStorage).filter((item) => item.id !== DEFAULT_CONSTELLATION_TOOL_TEMPLATE.id)]);
  const [mediaCatalog, setMediaCatalog] = useState<MediaCatalog>({ models: [], errors: [] });
  const [writingModels, setWritingModels] = useState<ProviderModelInfo[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [mediaPending, setMediaPending] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [libraryQuery, setLibraryQuery] = useState("");
  const [blueprintQuery, setBlueprintQuery] = useState("");
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [blueprintDialog, setBlueprintDialog] = useState<BlueprintDraft>();
  const [editorNodeId, setEditorNodeId] = useState<string>();
  const [historyRevision, setHistoryRevision] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [canvasInteracting, setCanvasInteracting] = useState(false);
  const [connectionType, setConnectionType] = useState<ConstellationPortType>();
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [sourcePicker, setSourcePicker] = useState<ImageSourcePickerState>();
  const [integrationPicker, setIntegrationPicker] = useState<{ nodeId: string; kind: "conversation" | "projectRef" }>();
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
  const projectRecordsRef = useRef(projectRecords);
  const projectBusyRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const projectSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const hydrationRef = useRef<Promise<ConstellationProjectRecord[]> | null>(null);
  const saveSequenceRef = useRef(0);
  const saveStateRef = useRef(saveState);
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  const restoredViewportRef = useRef(false);
  const storageReadyRef = useRef(false);
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
  const refreshingSourcesRef = useRef(new Set<string>());
  const imageHistoryRequestRef = useRef(0);
  const imageHistoryLoadingRef = useRef(false);
  const spacePanRef = useRef(false);
  const reconnectingEdgeRef = useRef<string | undefined>(undefined);
  const connectionValidityCacheRef = useRef(new Map<string, boolean>());
  const marqueeRef = useRef<HTMLDivElement>(null);
  const marqueeGestureRef = useRef<{ pointerId: number; left: number; top: number; width: number; height: number; flowStart: { x: number; y: number }; startX: number; startY: number; x: number; y: number; active: boolean; additive: boolean } | null>(null);
  const marqueeFrameRef = useRef<number | null>(null);
  const suppressMarqueeClickRef = useRef(false);
  const { fitView, screenToFlowPosition, flowToScreenPosition, getIntersectingNodes } = useReactFlow<ConstellationNode, ConstellationEdge>();
  const flowStore = useStoreApi<ConstellationNode, ConstellationEdge>();
  const nodesInitialized = useNodesInitialized();

  useEffect(() => {
    if (!active || overviewOpen || initialViewportReady || !nodesInitialized) return;
    let cancelled = false;
    // Measure every node before fitting a project that has no saved viewport.
    void fitView({ padding: .18, maxZoom: 1 }).then(() => {
      if (!cancelled) setInitialViewportReady(true);
    });
    return () => { cancelled = true; };
  }, [active, overviewOpen, initialViewportReady, nodesInitialized, fitView]);

  useEffect(() => { connectionValidityCacheRef.current.clear(); }, [contentNodes, edges]);

  useEffect(() => {
    if (overviewOpen) return;
    const { updateConnection, cancelConnection } = flowStore.getState();
    let frame: number | null = null;
    let pending: Parameters<typeof updateConnection>[0] | null = null;
    const clear = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      pending = null;
    };
    // Keep XYFlow's hit testing and final connection; notify renderers once per frame.
    const update = (connection: Parameters<typeof updateConnection>[0]) => {
      if (!flowStore.getState().connection.inProgress) {
        updateConnection(connection);
        return;
      }
      pending = connection;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const next = pending;
        pending = null;
        if (next) updateConnection(next);
      });
    };
    const cancel = () => { clear(); cancelConnection(); };
    flowStore.setState({ updateConnection: update, cancelConnection: cancel });
    return () => {
      clear();
      if (flowStore.getState().updateConnection === update) flowStore.setState({ updateConnection, cancelConnection });
    };
  }, [flowStore, overviewOpen]);

  graphRef.current = { nodes, edges };
  graphTitleRef.current = graphTitle;
  overviewOpenRef.current = overviewOpen;
  saveStateRef.current = saveState;


  const projectPayload = useCallback((graph: ConstellationGraph, overviewPosition?: { x: number; y: number }, viewport = viewportRef.current): ConstellationProjectPayload => ({
    schemaVersion: 1,
    graph,
    overviewPosition: overviewPosition ?? { x: 0, y: 0 },
    viewport,
  }), []);

  const queueProjectSave = useCallback((change: ConstellationProjectRecord | ((records: ConstellationProjectRecord[]) => ConstellationProjectRecord)) => {
    const operation = projectSaveQueueRef.current.then(async () => {
      const record = typeof change === "function" ? change(projectRecordsRef.current) : change;
      await saveConstellationProject(record);
      const found = projectRecordsRef.current.some((item) => item.id === record.id);
      const next = found ? projectRecordsRef.current.map((item) => item.id === record.id ? record : item) : [...projectRecordsRef.current, record];
      projectRecordsRef.current = next;
      setProjectRecords(next);
    });
    projectSaveQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, []);

  const saveCurrentProject = useCallback(async () => {
    if (!storageReadyRef.current || overviewOpenRef.current) return;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const sequence = ++saveSequenceRef.current;
    const current = graphRef.current;
    const graph = serializeConstellationGraph({
      schemaVersion: 1, id: graphMetaRef.current.id,
      title: graphTitleRef.current.trim() || tr("未命名星图", "Untitled Constellation"),
      nodes: current.nodes, edges: current.edges,
      createdAt: graphMetaRef.current.createdAt, updatedAt: Date.now(),
    });
    const viewport = { ...viewportRef.current };
    setSaveState("saving");
    try {
      await queueProjectSave((records) => {
        const previous = records.find((record) => record.id === graph.id);
        const metadata = isRecord(previous?.payload) ? previous.payload : {};
        return {
          id: graph.id,
          title: graph.title,
          payload: { ...metadata, ...projectPayload(graph, metadata.overviewPosition as { x: number; y: number } | undefined, viewport) },
          createdAt: previous?.createdAt ?? graph.createdAt,
          updatedAt: graph.updatedAt,
        };
      });
      if (sequence === saveSequenceRef.current) { setSaveState("saved"); setProjectError(undefined); }
    } catch (reason) {
      setSaveState("error");
      setProjectError(errorText(reason));
      throw reason;
    }
  }, [projectPayload, queueProjectSave]);
  const saveCurrentProjectRef = useRef(saveCurrentProject);
  saveCurrentProjectRef.current = saveCurrentProject;

  useEffect(() => {
    let disposed = false;
    setProjectHydrated(false);
    storageReadyRef.current = false;
    hydrationRef.current ??= (async () => {
      let records = await listConstellationProjects();
      if (localStorage.getItem(CONSTELLATION_MIGRATION_MARKER) !== "1") {
        const raw = localStorage.getItem(CONSTELLATION_STORAGE_KEY);
        if (records.length === 0 && raw) {
          const legacy = normalizeConstellationGraph(JSON.parse(raw));
          if (!legacy) throw new Error(tr("旧星图无法读取，原始数据已保留", "Legacy constellation could not be read; the original is preserved"));
          const migrated = { id: legacy.id, title: legacy.title, payload: { schemaVersion: 1, graph: legacy, overviewPosition: { x: 0, y: 0 } }, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt };
          await queueProjectSave(migrated);
          records = [migrated];
        }
        localStorage.setItem(CONSTELLATION_MIGRATION_MARKER, "1");
      }
      const stabilized = records
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map((record, index) => {
          const payload = isRecord(record.payload) ? record.payload : {};
          if (payload.overviewLayoutVersion === 2 && isRecord(payload.overviewPosition) && Number.isFinite(payload.overviewPosition.x) && Number.isFinite(payload.overviewPosition.y)) return record;
          return { ...record, payload: { ...payload, overviewPosition: overviewPositionFor(index), overviewLayoutVersion: 2 } };
        });
      for (const record of stabilized) {
        if (record !== records.find((item) => item.id === record.id)) await queueProjectSave(record);
      }
      return stabilized;
    })();
    void hydrationRef.current.then((records) => {
      if (disposed) return;
      projectRecordsRef.current = records;
      setProjectRecords(records);
      storageReadyRef.current = true;
      setProjectError(undefined);
      setProjectHydrated(true);
    }).catch((reason) => {
      if (!disposed) { setProjectError(errorText(reason)); setProjectHydrated(true); }
    });
    return () => { disposed = true; };
  }, [projectLoadRevision, queueProjectSave]);

  useEffect(() => {
    if (!active || overviewOpen || !workbenchRef.current) return;
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
  }, [active, overviewOpen]);

  const refreshCatalogs = useCallback(async (showSpinner = true) => {
    if (showSpinner) setCatalogLoading(true);
    setCatalogError(undefined);
    try {
      const [nextMedia, nextModels] = await Promise.all([getMediaCatalog(), getModelCatalog()]);
      setMediaCatalog({ ...nextMedia, models: sortStudioMediaModels(nextMedia.models) });
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
    if (!projectHydrated || !storageReadyRef.current || overviewOpen) return;
    ++saveSequenceRef.current;
    setSaveState("dirty");
    if (canvasInteracting) return;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void saveCurrentProjectRef.current().catch((reason) => setProjectError(errorText(reason)));
    }, 450);
    return () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    };
  }, [edges, graphTitle, nodes, projectHydrated, overviewOpen, canvasInteracting]);

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    void saveCurrentProjectRef.current().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!active) void saveCurrentProjectRef.current().catch(() => undefined);
  }, [active]);

  useEffect(() => {
    const flush = () => { void saveCurrentProjectRef.current().catch(() => undefined); };
    const visibility = () => { if (document.visibilityState === "hidden") flush(); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!overviewOpenRef.current && saveStateRef.current !== "saved") {
        flush(); event.preventDefault(); event.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("beforeunload", beforeUnload);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isDesktop()) void getCurrentWindow().onCloseRequested(async (event) => {
      try { await saveCurrentProjectRef.current(); await projectSaveQueueRef.current; }
      catch { event.preventDefault(); }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch((reason) => setProjectError(errorText(reason)));
    return () => { disposed = true; unlisten?.(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("beforeunload", beforeUnload); };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CONSTELLATION_BLUEPRINTS_KEY, JSON.stringify(blueprints));
    } catch {
      setNotice(tr("蓝图库保存失败：本地存储空间不足", "Blueprint library could not be saved"));
    }
  }, [blueprints]);

  useEffect(() => {
    try { saveConstellationToolTemplates(() => localStorage, toolTemplates); }
    catch { setNotice(tr("工具模板保存失败：本地存储空间不足", "Tool templates could not be saved")); }
  }, [toolTemplates]);

  useEffect(() => {
    if (!active || overviewOpen || entrySnapshot || commandOpen || editorNodeId || sourcePicker || integrationPicker || blueprintDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if (event.code === "Space") {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        spacePanRef.current = true;
        // Buttons retain focus after a click; that must not disable canvas panning.
        if (!editing) {
          event.preventDefault();
          setSpacePanActive(true);
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
    const resetSpacePan = () => {
      spacePanRef.current = false;
      setSpacePanActive(false);
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === "Space") resetSpacePan(); };
    const onVisibilityChange = () => { if (document.hidden) resetSpacePan(); };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", resetSpacePan);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", resetSpacePan);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resetSpacePan();
    };
  }, [active, fitView, overviewOpen, entrySnapshot, commandOpen, editorNodeId, sourcePicker, integrationPicker, blueprintDialog]);

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
    if (runningRef.current) return;
    runtimeValuesRef.current.clear();
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
    if (runningRef.current && changes.some((change) => change.type === "remove")) return;
    if (changes.some((change) => change.type === "remove")) checkpoint();
    const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
    if (removed.length) runtimeValuesRef.current.clear();
    setNodes((current) => applyNodeChanges(changes, removed.length ? staleConstellationNodes(current, graphRef.current.edges, removed) : current));
    if (removed.length) setEdges((current) => current.filter((edge) => !removed.includes(edge.source) && !removed.includes(edge.target)));
  }, [checkpoint]);

  const onEdgesChange = useCallback((changes: EdgeChange<ConstellationEdge>[]) => {
    if (runningRef.current && changes.some((change) => change.type === "remove")) return;
    if (changes.some((change) => change.type === "remove")) checkpoint();
    const targets = changes.filter((change) => change.type === "remove").flatMap((change) => constellationConnectionMembers(graphRef.current.edges, change.id).map((edge) => edge.target));
    if (targets.length) { runtimeValuesRef.current.clear(); setNodes((current) => staleConstellationNodes(current, graphRef.current.edges, targets)); }
    setEdges((current) => applyEdgeChanges(changes.flatMap((change) => {
      if (change.type !== "remove" && change.type !== "select") return [];
      return constellationConnectionMembers(current, change.id).map((edge) => ({ ...change, id: edge.id }));
    }), current));
  }, [checkpoint]);

  const commitAutomaticConnection = useCallback((connection: Connection, replacingEdgeId?: string) => {
    if (runningRef.current) return false;
    const replaced = new Set(replacingEdgeId ? constellationConnectionMembers(graphRef.current.edges, replacingEdgeId).map((edge) => edge.id) : []);
    const remaining = replacingEdgeId
      ? graphRef.current.edges.filter((edge) => !replaced.has(edge.id))
      : graphRef.current.edges;
    const resolution = resolveConstellationConnection(graphRef.current.nodes, remaining, {
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle === UNIVERSAL_OUTPUT_HANDLE ? undefined : connection.sourceHandle,
      targetHandle: connection.targetHandle === UNIVERSAL_INPUT_HANDLE ? undefined : connection.targetHandle,
    });
    if (!resolution.valid) {
      setNotice(tr(resolution.reason, resolution.reasonEn));
      return false;
    }
    checkpoint();
    runtimeValuesRef.current.clear();
    const targets = [connection.target, ...graphRef.current.edges.filter((edge) => replaced.has(edge.id)).map((edge) => edge.target)];
    setNodes((current) => staleConstellationNodes(current, graphRef.current.edges, targets));
    setEdges((current) => [
      ...current.filter((edge) => !replaced.has(edge.id)),
      ...resolution.mappings.map((mapping) => createConstellationEdge(
        connection.source,
        mapping.sourceHandle,
        connection.target,
        mapping.targetHandle,
        mapping.valueType,
      )),
    ]);
    return true;
  }, [checkpoint]);

  const onConnect = useCallback((connection: Connection) => {
    commitAutomaticConnection(connection);
  }, [commitAutomaticConnection]);

  const isValidConnection = useCallback((connection: Connection | ConstellationEdge) => {
    const key = JSON.stringify([connection.source, connection.sourceHandle, connection.target, connection.targetHandle, reconnectingEdgeRef.current]);
    const cached = connectionValidityCacheRef.current.get(key);
    if (cached !== undefined) return cached;
    const excluded = new Set(reconnectingEdgeRef.current ? constellationConnectionMembers(graphRef.current.edges, reconnectingEdgeRef.current).map((edge) => edge.id) : []);
    const resolution = resolveConstellationConnection(graphRef.current.nodes, graphRef.current.edges.filter((edge) => !excluded.has(edge.id)), {
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle === UNIVERSAL_OUTPUT_HANDLE ? undefined : connection.sourceHandle,
      targetHandle: connection.targetHandle === UNIVERSAL_INPUT_HANDLE ? undefined : connection.targetHandle,
    });
    connectionValidityCacheRef.current.set(key, resolution.valid);
    return resolution.valid;
  }, []);

  const onReconnect = useCallback((oldEdge: ConstellationEdge, connection: Connection) => {
    commitAutomaticConnection(connection, oldEdge.id);
  }, [commitAutomaticConnection]);

  const beginCanvasInteraction = useCallback(() => setCanvasInteracting(true), []);
  const endCanvasInteraction = useCallback(() => setCanvasInteracting(false), []);
  const onConnectionStart = useCallback((_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    connectionValidityCacheRef.current.clear();
    setCanvasInteracting(true);
    if (params.handleType !== "source" || !params.nodeId) {
      setConnectionType(undefined);
      return;
    }
    const node = graphRef.current.nodes.find((item) => item.id === params.nodeId);
    setConnectionType(node ? findConstellationNodePort(node, "output", params.handleId)?.type : undefined);
  }, []);
  const onConnectionEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    connectionValidityCacheRef.current.clear();
    setCanvasInteracting(false);
    setConnectionType(undefined);
    if (state.isValid || !state.fromHandle || reconnectingEdgeRef.current) return;
    if (event.type === "touchcancel" || event.type === "pointercancel") return;
    if (!state.toHandle) {
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      const hit = point ? document.elementFromPoint(point.clientX, point.clientY)?.closest(".react-flow__node") : null;
      const targetId = hit?.getAttribute("data-id") ?? state.toNode?.id;
      if (targetId && targetId !== state.fromHandle.nodeId) {
        const fromSource = state.fromHandle.type === "source";
        commitAutomaticConnection({
          source: fromSource ? state.fromHandle.nodeId : targetId,
          sourceHandle: fromSource ? state.fromHandle.id ?? null : UNIVERSAL_OUTPUT_HANDLE,
          target: fromSource ? targetId : state.fromHandle.nodeId,
          targetHandle: fromSource ? UNIVERSAL_INPUT_HANDLE : state.fromHandle.id ?? null,
        });
      }
      return;
    }
    if (state.fromHandle.type === state.toHandle.type) return;
    const fromSource = state.fromHandle.type === "source";
    const connection: Connection = {
      source: fromSource ? state.fromHandle.nodeId : state.toHandle.nodeId,
      sourceHandle: fromSource ? state.fromHandle.id ?? null : state.toHandle.id ?? null,
      target: fromSource ? state.toHandle.nodeId : state.fromHandle.nodeId,
      targetHandle: fromSource ? state.toHandle.id ?? null : state.fromHandle.id ?? null,
    };
    commitAutomaticConnection(connection);
  }, [commitAutomaticConnection]);

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
  const onCanvasMoveEnd = useCallback((event: MouseEvent | TouchEvent | null, viewport: { x: number; y: number; zoom: number }) => {
    viewportRef.current = viewport;
    if (event) {
      setCanvasInteracting(false);
      void saveCurrentProjectRef.current().catch(() => undefined);
    }
  }, []);

  const paintMarquee = useCallback(() => {
    marqueeFrameRef.current = null;
    const gesture = marqueeGestureRef.current;
    const element = marqueeRef.current;
    if (!gesture?.active || !element) return;
    const start = flowToScreenPosition(gesture.flowStart);
    gesture.startX = start.x - gesture.left;
    gesture.startY = start.y - gesture.top;
    element.style.transform = `translate(${Math.min(gesture.startX, gesture.x)}px, ${Math.min(gesture.startY, gesture.y)}px)`;
    element.style.width = `${Math.abs(gesture.x - gesture.startX)}px`;
    element.style.height = `${Math.abs(gesture.y - gesture.startY)}px`;
    const dx = gesture.x < 30 ? 10 : gesture.x > gesture.width - 30 ? -10 : 0;
    const dy = gesture.y < 30 ? 10 : gesture.y > gesture.height - 30 ? -10 : 0;
    if (dx || dy) {
      void flowStore.getState().panBy({ x: dx, y: dy });
      marqueeFrameRef.current = window.requestAnimationFrame(paintMarquee);
    }
  }, [flowStore, flowToScreenPosition]);

  const finishMarquee = useCallback((event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const gesture = marqueeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    marqueeGestureRef.current = null;
    if (marqueeFrameRef.current !== null) window.cancelAnimationFrame(marqueeFrameRef.current);
    marqueeFrameRef.current = null;
    if (marqueeRef.current) marqueeRef.current.hidden = true;
    if (!gesture.active) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    suppressMarqueeClickRef.current = true;
    window.setTimeout(() => { suppressMarqueeClickRef.current = false; }, 0);
    setCanvasInteracting(false);
    if (!commit) return;
    const end = screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
    const selected = new Set(getIntersectingNodes({
      x: Math.min(gesture.flowStart.x, end.x),
      y: Math.min(gesture.flowStart.y, end.y),
      width: Math.abs(end.x - gesture.flowStart.x),
      height: Math.abs(end.y - gesture.flowStart.y),
    }, true).filter((node) => !node.hidden && node.selectable !== false).map((node) => node.id));
    if (gesture.additive) {
      for (const node of graphRef.current.nodes) if (node.selected) selected.add(node.id);
    }
    setNodes((current) => current.map((node) => node.selected === selected.has(node.id) ? node : { ...node, selected: selected.has(node.id) }));
    setEdges((current) => current.map((edge) => {
      const nextSelected = selected.has(edge.source) || selected.has(edge.target) || gesture.additive && !!edge.selected;
      return edge.selected === nextSelected ? edge : { ...edge, selected: nextSelected };
    }));
  }, [getIntersectingNodes, screenToFlowPosition]);

  useEffect(() => () => {
    if (marqueeFrameRef.current !== null) window.cancelAnimationFrame(marqueeFrameRef.current);
  }, []);

  const updateNode = useCallback((nodeId: string, patch: Partial<ConstellationNodeData>) => {
    const semantic = Object.keys(patch).some((key) => !["title", "collapsed", "noteColor", "status", "error"].includes(key));
    if (semantic && runningRef.current) return;
    if (semantic) { checkpoint(); runtimeValuesRef.current.clear(); }
    setNodes((current) => {
      const modified = current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node);
      if (!semantic) return modified;
      return staleConstellationNodes(modified, graphRef.current.edges, [nodeId]).map((node) => node.id === nodeId && (patch.status === "success" || patch.status === "waiting" || patch.status === "error") ? { ...node, data: { ...node.data, status: patch.status, error: patch.error } } : node);
    });
    if (semantic) {
      const old = graphRef.current.nodes.find((node) => node.id === nodeId);
      if (old) {
        const next = { ...old, data: { ...old.data, ...patch } };
        setEdges((current) => current.filter((edge) => {
          const source = edge.source === nodeId ? next : graphRef.current.nodes.find((node) => node.id === edge.source);
          const target = edge.target === nodeId ? next : graphRef.current.nodes.find((node) => node.id === edge.target);
          const output = source && findConstellationNodePort(source, "output", edge.sourceHandle);
          const input = target && findConstellationNodePort(target, "input", edge.targetHandle);
          return Boolean(output && input && portTypesCompatible(output.type, input.type));
        }));
      }
    }
  }, [checkpoint]);

  const removeNode = useCallback((nodeId: string) => {
    if (runningRef.current) return;
    checkpoint();
    runtimeValuesRef.current.clear();
    setNodes((current) => staleConstellationNodes(current, graphRef.current.edges, [nodeId]).filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
  }, [checkpoint]);

  const addNode = useCallback((kind: ConstellationNodeKind, position?: { x: number; y: number }) => {
    if (runningRef.current) return;
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
      const node = graphRef.current.nodes.find((item) => item.id === nodeId);
      if (node) updateNode(nodeId, { references: uniqueAttachments([...(node.data.references ?? []), ...selected]).slice(0, 8) });
    } catch (reason) {
      setNotice(errorText(reason));
    }
  }, [updateNode]);

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

  const getInputValue = useCallback((nodeId: string, handle: string) => inputValues(nodeId, handle)[0], [inputValues, contentNodes]);

  useEffect(() => {
    if (running) return;
    setNodes((current) => runningRef.current ? current : syncConstellationPreviews(current, graphRef.current.edges));
  }, [contentNodes, edges, running]);

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
    for (const node of contentNodes) {
      for (const value of Object.values(node.data.outputs ?? {})) {
        if (value?.type === "image" && value.asset?.status === "completed" && value.asset.filePath) {
          byId.set(value.asset.id, value.asset);
        }
      }
    }
    return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt);
  }, [imageHistory, contentNodes]);

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

  const chooseInputFile = useCallback(async (nodeId: string) => {
    const projectId = graphMetaRef.current.id;
    try {
      const paths = await selectLocalResourcePaths(false);
      if (!paths.length) return;
      const attachments = await importLocalResources(paths, []);
      if (!attachments.length) throw new Error(tr("文件无法导入", "The files could not be imported"));
      const values = constellationFileOutputs(attachments);
      if (graphMetaRef.current.id === projectId) updateNode(nodeId, { inputMode: "file", inputPath: paths.length === 1 ? paths[0] : undefined, inputAttachment: attachments.length === 1 ? attachments[0] : undefined, inputAttachments: attachments, inputText: undefined, outputs: values, status: "success" });
    } catch (reason) { setNotice(errorText(reason)); }
  }, [updateNode]);

  const openIntegrationSource = useCallback((nodeId: string, kind: "conversation" | "input" | "projectRef") => {
    if (runningRef.current) return;
    if (kind === "input") { void chooseInputFile(nodeId); return; }
    setIntegrationPicker({ nodeId, kind });
  }, [chooseInputFile]);

  const selectCandidate = useCallback((nodeId: string, handle: string, index: number) => {
    const node = graphRef.current.nodes.find((item) => item.id === nodeId);
    const value = node && constellationCandidateSelection(node.data, handle, index);
    if (runningRef.current || !value) return;
    updateNode(nodeId, { outputs: { ...node?.data.outputs, [handle]: value }, status: "success", error: undefined });
  }, [updateNode]);

  const applyMediaAsset = useCallback((asset: MediaAsset, projectId: string) => {
    if (graphMetaRef.current.id !== projectId) return;
    setNodes((current) => graphMetaRef.current.id === projectId ? updateConstellationMediaAsset(current, asset) : current);
  }, []);

  const refreshCandidates = useCallback(async (nodeId: string) => {
    if (runningRef.current) return;
    const node = graphRef.current.nodes.find((item) => item.id === nodeId);
    const projectId = graphMetaRef.current.id;
    if (!node) return;
    const refreshKey = `${projectId}:${nodeId}`;
    if (refreshingSourcesRef.current.has(refreshKey)) return;
    refreshingSourcesRef.current.add(refreshKey);
    try {
      if (node.data.kind === "projectRef") {
        const reference = node.data.projectReference;
        if (!reference) throw new Error(tr("请先选择项目作品", "Choose a project output first"));
        const records = await listConstellationProjects();
        const value = constellationProjectReferenceValue(records, projectId, reference);
        if (!value) {
          throw new Error(tr("来源项目的作品已不可用；已保留本地快照", "The source output is unavailable; the local snapshot was retained"));
        }
        const latest = graphRef.current.nodes.find((item) => item.id === nodeId);
        if (graphMetaRef.current.id === projectId && !runningRef.current && latest?.data.projectReference === reference) {
          updateNode(nodeId, { projectReference: { ...reference, capturedAt: Date.now() }, projectValue: structuredClone(value), outputs: { output: structuredClone(value) }, status: "success", error: undefined });
        }
        return;
      }
      const errors: string[] = [];
      await Promise.all(constellationPendingMediaIds([node]).map(async (id) => {
        try { applyMediaAsset(await refreshMediaAsset(id), projectId); }
        catch (reason) { errors.push(errorText(reason)); }
      }));
      if (graphMetaRef.current.id === projectId && errors.length) setNotice(errors.join(" · "));
    } catch (reason) { setNotice(errorText(reason)); }
    finally { refreshingSourcesRef.current.delete(refreshKey); }
  }, [applyMediaAsset, updateNode]);

  const pendingMediaIds = useMemo(() => constellationPendingMediaIds(contentNodes), [contentNodes]);
  const currentProjectId = graphMetaRef.current.id;

  useEffect(() => onPendingCountChange(mediaPending + pendingMediaIds.length), [mediaPending, pendingMediaIds.length, onPendingCountChange]);

  useEffect(() => {
    if (!active || overviewOpen || pendingMediaIds.length === 0) return;
    const poller = createMediaPoller(refreshMediaAsset, (asset) => applyMediaAsset(asset, currentProjectId), () => {
      // Transient failures remain pending and retry on the next tick.
    });
    const refreshPending = () => poller.poll(pendingMediaIds);
    const timer = window.setInterval(refreshPending, 5_000);
    window.addEventListener("focus", refreshPending);
    document.addEventListener("visibilitychange", refreshPending);
    refreshPending();
    return () => {
      poller.stop();
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshPending);
      document.removeEventListener("visibilitychange", refreshPending);
    };
  }, [active, overviewOpen, currentProjectId, JSON.stringify(pendingMediaIds), applyMediaAsset]);

  useEffect(() => {
    if (!active || overviewOpen) return;
    return onMediaAssetUpdate((asset) => applyMediaAsset(asset, currentProjectId));
  }, [active, overviewOpen, currentProjectId, applyMediaAsset]);

  const saveToolTemplate = useCallback((nodeId: string) => {
    if (runningRef.current) return;
    const node = graphRef.current.nodes.find((item) => item.id === nodeId);
    const draft = node?.data.toolTemplate;
    if (!node || !draft) return;
    const now = Date.now();
    const editingBuiltIn = node.data.toolTemplateId === DEFAULT_CONSTELLATION_TOOL_TEMPLATE.id;
    const existing = editingBuiltIn ? undefined : toolTemplates.find((item) => item.id === node.data.toolTemplateId);
    const requestedName = draft.name?.trim() || node.data.title || tr("自定义工具", "Custom tool");
    const baseName = editingBuiltIn && requestedName === DEFAULT_CONSTELLATION_TOOL_TEMPLATE.name
      ? `${requestedName}${tr("（副本）", " (copy)")}` : requestedName;
    const otherNames = new Set(toolTemplates.filter((item) => item.id !== existing?.id).map((item) => item.name));
    let name = baseName.slice(0, 120);
    for (let suffix = 2; otherNames.has(name); suffix++) name = `${baseName.slice(0, 110)} (${suffix})`;
    const normalized = normalizeConstellationToolTemplate({
      ...draft,
      id: existing?.id ?? (editingBuiltIn ? `tool-${crypto.randomUUID()}` : node.data.toolTemplateId ?? `tool-${crypto.randomUUID()}`),
      name,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (!normalized) {
      setNotice(tr("工具模板配置无效，请检查命令和字段", "The tool template is invalid; check its command and fields"));
      return;
    }
    setToolTemplates((current) => [normalized, ...current.filter((item) => item.id !== normalized.id)]);
    updateNode(nodeId, { toolTemplateId: normalized.id, toolTemplate: normalized, status: "idle", outputs: undefined });
    setNotice(tr(`已保存工具模板“${normalized.name}”`, `Saved tool template “${normalized.name}”`));
  }, [toolTemplates, updateNode]);

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
    getInputValues: inputValues,
    openSourcePicker: openIntegrationSource,
    openConversation: onOpenConversation,
    selectCandidate,
    refreshCandidates: (nodeId) => { void refreshCandidates(nodeId); },
    toolTemplates,
    saveToolTemplate,
  }), [chooseReferences, downloadValue, edges, getInputValue, inputValues, locale, mediaCatalog.models, openCanvas, openImageSourcePicker, openValuePreview, removeNode, running, updateNode, writingModels, openIntegrationSource, onOpenConversation, selectCandidate, refreshCandidates, saveToolTemplate, toolTemplates]);

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
    if (runningRef.current || overviewOpenRef.current || projectBusyRef.current || !storageReadyRef.current) return;
    runningRef.current = true;
    const snapshot = graphRef.current;
    const epoch = ++runEpochRef.current;
    const plan = constellationRunPlan(snapshot.nodes, snapshot.edges, targetIds);
    const included = plan.required;
    let layers: ConstellationNode[][];
    try {
      layers = constellationExecutionLayers(snapshot.nodes, snapshot.edges, included);
    } catch (reason) {
      setNotice(errorText(reason));
      runningRef.current = false;
      return;
    }
    runtimeValuesRef.current = new Map(snapshot.nodes.filter((node) => !plan.execute.has(node.id) && node.data.status === "success").map((node) => [node.id, { ...(node.data.outputs ?? {}) }]));
    const failed = new Set<string>();
    const waiting = new Set<string>();
    const changed = constellationDescendants(plan.execute, snapshot.edges);
    setRunning(true);
    setNotice(undefined);
    setNodes((current) => staleConstellationNodes(current, snapshot.edges, changed).map((node) => plan.execute.has(node.id) && EXECUTABLE_NODE_KINDS.has(node.data.kind)
      ? { ...node, data: { ...node.data, status: "queued", error: undefined } }
      : node));
    try {
      for (const layer of layers) {
        if (runEpochRef.current !== epoch) break;
        await Promise.all(layer.map(async (node) => {
          if (!EXECUTABLE_NODE_KINDS.has(node.data.kind) || !plan.execute.has(node.id)) return;
          const blockedBy = snapshot.edges.find((edge) => edge.target === node.id && (failed.has(edge.source) || waiting.has(edge.source)));
          if (blockedBy) {
            if (waiting.has(blockedBy.source)) { waiting.add(node.id); updateNode(node.id, { status: "stale", error: tr("上游结果尚未选定，请选择后再运行", "Select the upstream result, then run again") }); }
            else { failed.add(node.id); updateNode(node.id, { status: "error", error: tr("上游节点执行失败", "An upstream node failed") }); }
            return;
          }
          updateNode(node.id, { status: "running", error: undefined });
          try {
            const upstreamRerun = snapshot.edges.some((edge) => edge.target === node.id && plan.execute.has(edge.source));
            const outputs = await executeNode(upstreamRerun && node.data.status === "waiting" ? { ...node, data: { ...node.data, status: "stale" } } : node, snapshot, epoch);
            if (runEpochRef.current === epoch) updateRuntimeOutput(node.id, outputs);
          } catch (reason) {
            if (runEpochRef.current !== epoch) return;
            if (reason instanceof ConstellationWaitingError) { waiting.add(node.id); updateNode(node.id, { status: "waiting", error: reason.message }); return; }
            failed.add(node.id);
            updateNode(node.id, { status: "error", error: errorText(reason) });
          }
        }));
      }
      if (runEpochRef.current === epoch) {
        setNotice(waiting.size > 0 ? tr("已保留候选结果；选定作品后再运行下游", "Candidates are saved; select an output before running downstream") : failed.size > 0
          ? tr(`${failed.size} 个节点需要处理，其余分支已继续完成`, `${failed.size} node(s) need attention; other branches completed`)
          : plan.execute.size ? tr("星图执行完成", "Constellation run complete") : tr("所有结果均为最新，无需重复运行", "All results are current; nothing needed to run"));
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
    if (node.data.kind === "conversation") {
      const inputs = [...incoming("context"), ...incoming("files")];
      const upstream = inputs.map((value) => value.text).filter(Boolean).join("\n\n");
      const command = incoming("command").map((value) => value.text).filter(Boolean).join("\n\n") || node.data.sessionCommand?.trim() || "";
      if (!command) throw new Error(tr("会话执行节点需要一条命令", "The session step needs a command"));
      const attachments = await constellationConversationAttachments([...inputs, ...incoming("command")], importLocalResources);
      if (runEpochRef.current !== epoch) throw new Error(tr("执行已停止", "Run stopped"));
      const result = await onRunConversation({
        threadId: node.data.conversationThreadId, command, context: upstream, attachments, workspace,
        onThreadReady: (thread) => updateNode(node.id, { conversationThreadId: thread.id, conversationThreadTitle: thread.title, conversationSnapshot: undefined }),
      });
      if (result.threadId !== node.data.conversationThreadId || result.title !== node.data.conversationThreadTitle) {
        updateNode(node.id, { conversationThreadId: result.threadId, conversationThreadTitle: result.title, conversationSnapshot: undefined });
      }
      const text = result.text?.trim();
      if (!text) throw new Error(tr("会话尚未返回可用结果，请在会话中处理待批准操作后继续", "The conversation has no result yet; resolve any pending approval in the conversation, then continue"));
      return { text: { type: "text", text, createdAt: Date.now() } };
    }
    if (node.data.kind === "projectRef") {
      if (!node.data.projectReference || !constellationValueReady(node.data.projectValue)) throw new Error(tr("请先选择项目作品", "Choose a project output first"));
      return { output: structuredClone(node.data.projectValue) };
    }
    if (node.data.kind === "input") {
      if (node.data.inputMode === "file") {
        let attachments = constellationInputAttachments(node.data);
        if (!attachments.length && node.data.inputPath?.trim()) attachments = await importLocalResources([node.data.inputPath.trim()], []);
        if (!attachments.length) throw new Error(tr("请选择文件或填写有效的文件路径", "Choose files or enter a valid file path"));
        return constellationFileOutputs(attachments, node.data.inputText);
      }
      const text = node.data.inputMode === "url"
        ? await executeReadOnlyTool("web_fetch", { url: node.data.inputUrl?.trim(), maxChars: 80_000 })
        : node.data.inputText?.trim();
      if (!text) throw new Error(tr("输入内容为空，请填写文本或选择文件", "Input is empty; enter text or choose a file"));
      return { text: { type: "text", text: text.slice(0, 80_000), createdAt: Date.now() } };
    }
    if (node.data.kind === "localTool") {
      const upstreamInput = incoming("input").map((value) => value.text ?? "").join("\n\n");
      const template = node.data.toolTemplate;
      if (node.data.legacyToolName) {
        const argumentsValue: unknown = JSON.parse(node.data.toolArguments || "{}");
        if (!isRecord(argumentsValue)) throw new Error(tr("工具参数必须为 JSON 对象", "Tool arguments must be a JSON object"));
        const substitute = (value: unknown): unknown => typeof value === "string" ? value.split("{{input}}").join(upstreamInput) : Array.isArray(value) ? value.map(substitute) : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)])) : value;
        const text = await executeReadOnlyTool(node.data.legacyToolName, substitute(argumentsValue) as Record<string, unknown>);
        return { text: { type: "text", text: text.slice(0, 80_000), createdAt: Date.now() } };
      }
      if (template?.command?.trim()) {
        const values = Object.fromEntries((template.inputSchema ?? []).map((field) => {
          const connected = incoming(field.id).map((value) => value.text ?? "").filter(Boolean).join("\n\n");
          return [field.id, connected || (node.data.toolInputs?.[field.id] ?? field.defaultValue ?? "")];
        }));
        for (const field of template.inputSchema ?? []) {
          if (field.required && !String(values[field.id] ?? "").trim()) {
            throw new Error(tr(`请填写工具输入：${field.name}`, `Fill tool input: ${field.name}`));
          }
        }
        if (template.inputSchema.some((field) => field.id === "input")) values.input ||= upstreamInput;
        const argumentTemplate = renderConstellationTemplate(template.argumentTemplate || "{{input}}", values, upstreamInput);
        const command = renderConstellationTemplate(template.command, values, upstreamInput).split("{{args}}").join(argumentTemplate);
        const stdout = await executeLocalCommand(command, template.workdirMode === "custom" ? template.workdir : undefined);
        const outputs: Partial<Record<string, ConstellationValue>> = {
          text: { type: "text", text: stdout.slice(0, 120_000), createdAt: Date.now() },
        };
        let parsed: unknown;
        try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
        const readJsonPath = (value: unknown, path: string): unknown => path.split(".").filter(Boolean).reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
        for (const field of template.outputSchema ?? []) {
          const handle = field.id === "stdout" ? "text" : field.id;
          if (!handle || handle === "text" && field.id !== "stdout") continue;
          const source = field.source?.trim() || "{{stdout}}";
          const match = source.match(/^\{\{json(?::([^}]+))?\}\}$/);
          const fieldMatch = source.match(/^\{\{field:([^}]+)\}\}$/);
          let value: unknown = source === "{{stdout}}" ? stdout : match ? (match[1] ? readJsonPath(parsed, match[1]) : parsed) : fieldMatch ? values[fieldMatch[1]] : source;
          if (value === undefined || value === null) continue;
          if (field.type === "json" && typeof value === "string") {
            try { value = JSON.parse(value); } catch { /* Keep non-JSON output readable. */ }
          }
          const text = typeof value === "string" ? value : JSON.stringify(value);
          outputs[handle] = { type: "text", text: text.slice(0, 120_000), createdAt: Date.now() };
        }
        return outputs;
      }
      const argumentsValue: unknown = JSON.parse(node.data.toolArguments || "{}");
      if (!isRecord(argumentsValue)) throw new Error(tr("工具参数必须为 JSON 对象", "Tool arguments must be a JSON object"));
      const substitute = (value: unknown): unknown => typeof value === "string" ? value.split("{{input}}").join(upstreamInput) : Array.isArray(value) ? value.map(substitute) : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)])) : value;
      const text = await executeReadOnlyTool(node.data.toolName ?? "read_file", substitute(argumentsValue) as Record<string, unknown>);
      return { text: { type: "text", text: text.slice(0, 80_000), createdAt: Date.now() } };
    }
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
          profiles.filter((item) => item.id !== profile.id && item.failoverEnabled && profileHasTextModel(item)),
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
          reasoningEffortForProfile(profile, reasoningEffort),
          () => {
            if (runEpochRef.current !== epoch) return;
            streamed = "";
            updateRuntimeOutput(node.id, { text: { type: "text", text: "", createdAt: Date.now() } }, "running");
          },
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
    if (node.data.status === "waiting" && Object.values(node.data.outputCandidates ?? {}).some((values) => values?.length)) throw new ConstellationWaitingError(tr("请刷新或选择已保存的候选结果", "Refresh or select a saved candidate"));
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
    const imageCapabilities = imageModelCapabilities(route.model);
    const videoMode = mediaKind === "video"
      ? attachments.length > 1 ? "reference" : attachments.length === 1 ? "image" : "text"
      : "text";
    const videoOptions = videoOutputOptions(route.model, videoMode, node.data);
    const videoHasOutputControls = mediaKind === "video" && videoOptions.hasControls;
    if (videoHasOutputControls && !videoOptions.capabilities.modes.includes(videoMode)) {
      throw new Error(tr("当前模型不支持此参考图数量对应的生成方式，请调整参考图或更换模型", "This model does not support the generation mode for these references. Adjust references or choose another model"));
    }
    if (videoHasOutputControls && attachments.length > videoOptions.capabilities.referenceLimit) {
      throw new Error(tr(`此模型当前最多支持 ${videoOptions.capabilities.referenceLimit} 张参考图`, `This model supports at most ${videoOptions.capabilities.referenceLimit} reference images in this mode`));
    }
    const imageSize = imageGenerationSize(route.model, node.data.size);
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
        ? imageSize !== "auto" ? imageSize : undefined
        : mediaKind === "video" && !videoHasOutputControls ? videoOptions.size : undefined,
      quality: mediaKind === "image" && !imageCapabilities.minimax && node.data.quality !== "auto" ? node.data.quality : undefined,
      outputFormat: mediaKind === "video" || mediaKind === "image" && imageCapabilities.minimax ? undefined : node.data.outputFormat,
      background: mediaKind === "image" && !imageCapabilities.minimax && node.data.background !== "auto" ? node.data.background : undefined,
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
      seconds: mediaKind === "video" ? videoOptions.seconds : undefined,
      videoMode: mediaKind === "video" && videoHasOutputControls ? videoMode : "text",
      videoResolution: videoHasOutputControls ? videoOptions.resolution : undefined,
      videoAspectRatio: videoHasOutputControls ? videoOptions.aspectRatio : undefined,
      referenceAttachmentIds: attachments.map((attachment) => attachment.id),
      maskAttachmentId: mediaKind === "image" ? maskAttachment?.id : undefined,
    };
    setMediaPending((value) => value + request.count);
    try {
      const result = await generateMedia(request);
      if (result.assets.length === 0) throw new Error(result.errors.join(" · ") || tr("模型没有返回可用结果", "The model returned no usable output"));
      const candidates: ConstellationValue[] = result.assets.map((asset) => ({ type: mediaKind, asset, createdAt: Date.now() }));
      if (runEpochRef.current !== epoch) throw new Error(tr("执行已停止", "Run stopped"));
      setNodes((current) => current.map((item) => item.id === node.id ? { ...item, data: { ...item.data, outputCandidates: { [mediaKind]: candidates }, outputs: {} } } : item));
      if (candidates.every((value) => value.asset?.status === "failed")) throw new Error(tr("所有候选结果均失败，请重新运行", "All candidates failed; run again"));
      if (candidates.length !== 1 || candidates[0].asset?.status !== "completed") {
        runtimeValuesRef.current.set(node.id, {});
        throw new ConstellationWaitingError(tr("候选结果已保存，进度会自动更新；完成后可选择结果", "Candidates saved; progress updates automatically. Choose an output when ready"));
      }
      return { [mediaKind]: candidates[0] };
    } finally {
      setMediaPending((value) => Math.max(0, value - request.count));
    }
  }

  async function executeReadOnlyTool(name: string, argumentsValue: Record<string, unknown>) {
    if (!isDesktop()) throw new Error(tr("本地工具和 HTTP 输入需要桌面应用", "Local tools and HTTP input require the desktop app"));
    if (!["read_file", "list_files", "search_files", "web_fetch"].includes(name)) throw new Error(tr("此节点仅允许列出的只读工具", "This node only permits its listed read-only tools"));
    const call = { id: crypto.randomUUID(), name, arguments: argumentsValue };
    const decision = await harnessCheckTool({ mode: "agent", permissionLevel: "request", call });
    if (decision !== "allow") throw new Error(tr("应用权限策略未允许此工具", "The app permission policy did not allow this tool"));
    const response = await executeTool(call, workspace ?? "", undefined, undefined, [], false, false, false, "agent", "request");
    if (response.isError) throw new Error(response.output);
    return response.output;
  }

  async function executeLocalCommand(command: string, workdir?: string, renderedArguments?: string) {
    if (!isDesktop()) throw new Error(tr("自定义工具需要桌面应用", "Custom tools require the desktop app"));
    const fullCommand = renderedArguments && command.includes("{{args}}") ? command.split("{{args}}").join(renderedArguments) : command;
    const call = { id: crypto.randomUUID(), name: "run_command", arguments: { command: fullCommand, ...(workdir?.trim() ? { workdir: workdir.trim() } : {}) } };
    const decision = await harnessCheckTool({ mode: "agent", permissionLevel: "agent", call });
    if (decision !== "allow") throw new Error(decision === "needs_approval"
      ? tr("此命令需要审批，请改用“会话执行”节点运行并处理审批", "This command needs approval; use a Conversation node to run it and handle approval")
      : tr("应用权限策略拒绝了此脚本", "The app permission policy denied this script"));
    const response = await executeTool(call, workspace ?? "", undefined, undefined, [], false, false, false, "agent", "agent");
    if (response.isError) throw new Error(response.output);
    const result = parseConstellationCommandOutput(response.output);
    if (!result) throw new Error(tr("无法读取命令执行结果", "Could not read the command result"));
    if (result.exitCode !== 0) throw new Error(`${tr("命令执行失败，退出码", "Command failed with exit code")} ${result.exitCode}\n${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
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
    if (runningRef.current) return;
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
    if (runningRef.current) return;
    checkpoint();
    const origin = screenToFlowPosition({ x: window.innerWidth * .52, y: window.innerHeight * .45 });
    const instance = instantiateConstellationBlueprint(blueprint, origin);
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...instance.nodes]);
    setEdges((current) => current.concat(instance.edges));
    setNotice(tr(`已放入“${blueprint.name}”`, `Inserted “${blueprint.name}”`));
    window.setTimeout(() => void fitView({ nodes: instance.nodes.map((node) => ({ id: node.id })), padding: .24, duration: 280 }), 30);
  };

  const newGraph = () => { void createProject(); };

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
    if (!file || projectBusyRef.current || !storageReadyRef.current) return;
    projectBusyRef.current = true; setProjectBusy(true);
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error(tr("星图文件不能超过 16 MiB", "Constellation files may not exceed 16 MiB"));
      const value = JSON.parse(await file.text()) as unknown;
      const record = isRecord(value) ? value : {};
      const graph = normalizeConstellationGraph(record.graph ?? value);
      if (!graph) throw new Error(tr("文件中没有有效星图", "The file does not contain a valid constellation"));
      if (runningRef.current) throw new Error(tr("请先停止当前运行", "Stop the current run first"));
      await saveCurrentProject();
      graph.id = crypto.randomUUID();
      graph.createdAt = Date.now();
      graph.updatedAt = Date.now();
      const imported = { id: graph.id, title: graph.title, payload: { schemaVersion: 1, graph, overviewPosition: overviewPositionForRecords(projectRecordsRef.current), overviewLayoutVersion: 2 }, createdAt: graph.createdAt, updatedAt: graph.updatedAt };
      await queueProjectSave(imported);
      loadProjectIntoEditor(imported);
      if (Array.isArray(record.blueprints)) {
        const incoming = record.blueprints.map(normalizeConstellationBlueprint).filter((item): item is ConstellationBlueprint => item !== null && !item.builtIn);
        setBlueprints((current) => mergeBlueprints(current, incoming));
      }
      setNotice(tr("星图导入完成", "Constellation imported"));
      window.setTimeout(() => void fitView({ padding: .18, duration: 320 }), 30);
    } catch (reason) {
      setProjectError(errorText(reason));
    } finally { projectBusyRef.current = false; setProjectBusy(false); }
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
    const runningSources = new Set(contentNodes.filter((node) => node.data.status === "running").map((node) => node.id));
    return groupConstellationConnections(edges).map((edge) => ({ ...edge, animated: running && runningSources.has(edge.source) }));
  }, [edges, contentNodes, running]);
  const selectedConnection = displayEdges.find((edge) => edge.selected);
  const selectedMappings = selectedConnection ? constellationConnectionMembers(edges, selectedConnection.id) : [];
  const editorNode = editorNodeId ? nodes.find((node) => node.id === editorNodeId) : undefined;
  const editorSource = editorNode?.data.canvasResult ?? editorNode?.data.canvasSource;
  keyboardActionsRef.current = {
    undo: undoGraph,
    redo: redoGraph,
    duplicate: duplicateSelection,
    run: runGraph,
    stop: stopRun,
  };

  const loadProjectIntoEditor = (record: ConstellationProjectRecord) => {
    const graph = graphFromProjectRecord(record);
    if (!graph) throw new Error(tr("项目数据无效", "Invalid project data"));
    ++runEpochRef.current;
    graphMetaRef.current = { id: graph.id, createdAt: graph.createdAt };
    graphRef.current = { nodes: graph.nodes, edges: graph.edges };
    graphTitleRef.current = graph.title;
    setGraphTitle(graph.title);
    setNodes(graph.nodes.map((node) => ({ ...node, selected: false })));
    setEdges(graph.edges.map((edge) => ({ ...edge, selected: false })));
    historyRef.current = { undo: [], redo: [] };
    runtimeValuesRef.current.clear();
    const payload = isRecord(record.payload) ? record.payload : {};
    const viewport = payload.viewport;
    restoredViewportRef.current = Boolean(isRecord(viewport) && Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.zoom) && Number(viewport.zoom) > 0);
    setInitialViewportReady(restoredViewportRef.current || graph.nodes.length === 0);
    viewportRef.current = restoredViewportRef.current ? { ...(viewport as { x: number; y: number; zoom: number }), zoom: Math.max(.18, Math.min(2.2, Number((viewport as { zoom: number }).zoom))) } : { x: 0, y: 0, zoom: 1 };
    setHistoryRevision((value) => value + 1);
    setEditorNodeId(undefined); setSourcePicker(undefined); setIntegrationPicker(undefined); setPreviewAsset(undefined); setNotice(undefined);
    setCommandOpen(false); setBlueprintDialog(undefined); setProjectError(undefined);
    setLeftPanelOpen(false); setRightPanelOpen(false);
    overviewOpenRef.current = false;
    setOverviewOpen(false);
  };

  const openProject = async (record: ConstellationProjectRecord, cover: HTMLElement) => {
    if (!storageReadyRef.current || runningRef.current || projectBusyRef.current) return;
    projectBusyRef.current = true;
    setProjectBusy(true);
    const snapshot = captureConstellationEntry(cover);
    try {
      await saveCurrentProject();
      await projectSaveQueueRef.current;
      const latest = projectRecordsRef.current.find((item) => item.id === record.id);
      if (!latest) throw new Error(tr("项目已删除", "Project was deleted"));
      loadProjectIntoEditor(latest);
      setEntrySnapshot(snapshot);
    }
    catch (reason) { setProjectError(errorText(reason)); }
    finally { projectBusyRef.current = false; setProjectBusy(false); }
  };

  const createProject = async (blueprint?: ConstellationBlueprint) => {
    if (!storageReadyRef.current || runningRef.current || projectBusyRef.current) return;
    projectBusyRef.current = true;
    setProjectBusy(true);
    try {
      await saveCurrentProject();
      const graph = createDefaultConstellationGraph();
      graph.title = blueprint?.name ?? tr("未命名星图", "Untitled Constellation");
      if (blueprint) {
        const instance = instantiateConstellationBlueprint(blueprint, { x: 0, y: 0 });
        graph.nodes = instance.nodes; graph.edges = instance.edges;
      } else { graph.nodes = []; graph.edges = []; }
      const record = { id: graph.id, title: graph.title, payload: { schemaVersion: 1, graph, overviewPosition: overviewPositionForRecords(projectRecordsRef.current), overviewLayoutVersion: 2 }, createdAt: graph.createdAt, updatedAt: graph.updatedAt };
      await queueProjectSave(record);
      loadProjectIntoEditor(record);
      if (!blueprint) setCommandOpen(true);
    } catch (reason) { setProjectError(errorText(reason)); }
    finally { projectBusyRef.current = false; setProjectBusy(false); }
  };

  const returnToOverview = async () => {
    if (runningRef.current || projectBusyRef.current) return;
    projectBusyRef.current = true;
    setProjectBusy(true);
    try { await saveCurrentProject(); setEntrySnapshot(undefined); overviewOpenRef.current = true; setOverviewOpen(true); }
    catch (reason) { setProjectError(errorText(reason)); }
    finally { projectBusyRef.current = false; setProjectBusy(false); }
  };

  const updateProjectRecord = useCallback(async (record: ConstellationProjectRecord, position: { x: number; y: number }) => {
    try {
      await queueProjectSave((records) => {
        const latest = records.find((item) => item.id === record.id);
        if (!latest) throw new Error(tr("项目已删除", "Project was deleted"));
        return { ...latest, payload: { ...(isRecord(latest.payload) ? latest.payload : {}), overviewPosition: position, overviewLayoutVersion: 2 }, updatedAt: Date.now() };
      });
    } catch (reason) { setProjectError(errorText(reason)); }
  }, [queueProjectSave]);

  const renameProject = useCallback(async (record: ConstellationProjectRecord, title: string) => {
    const nextTitle = Array.from(title.trim()).slice(0, 200).join("");
    if (!nextTitle) return;
    try {
      await queueProjectSave((records) => {
        const latest = records.find((item) => item.id === record.id);
        if (!latest) throw new Error(tr("项目已删除", "Project was deleted"));
        return { ...latest, title: nextTitle, payload: isRecord(latest.payload) ? { ...latest.payload, graph: isRecord(latest.payload.graph) ? { ...latest.payload.graph, title: nextTitle } : latest.payload.graph } : latest.payload, updatedAt: Date.now() };
      });
    } catch (reason) { setProjectError(errorText(reason)); }
  }, [queueProjectSave]);

  const duplicateProject = useCallback(async (record: ConstellationProjectRecord) => {
    try {
      await queueProjectSave((records) => {
        const latest = records.find((item) => item.id === record.id);
        const graph = latest && graphFromProjectRecord(latest);
        if (!graph || !latest) throw new Error(tr("项目无法读取", "Project could not be read"));
        const copyGraph = { ...graph, id: crypto.randomUUID(), title: `${Array.from(latest.title).slice(0, 190).join("")} ${tr("副本", "Copy")}`, createdAt: Date.now(), updatedAt: Date.now() };
        return { id: copyGraph.id, title: copyGraph.title, payload: { ...(isRecord(latest.payload) ? latest.payload : {}), graph: copyGraph, overviewPosition: overviewPositionForRecords(records), overviewLayoutVersion: 2 }, createdAt: copyGraph.createdAt, updatedAt: copyGraph.updatedAt };
      });
    } catch (reason) { setProjectError(errorText(reason)); }
  }, [queueProjectSave]);

  const removeProject = useCallback(async (record: ConstellationProjectRecord) => {
    const operation = projectSaveQueueRef.current.then(async () => {
      await deleteConstellationProject(record.id);
      const next = projectRecordsRef.current.filter((item) => item.id !== record.id);
      projectRecordsRef.current = next; setProjectRecords(next);
    });
    projectSaveQueueRef.current = operation.catch(() => undefined);
    try { await operation; } catch (reason) { setProjectError(errorText(reason)); }
  }, []);

  const overviewReady = projectHydrated && storageReadyRef.current && !projectBusy;
  const overviewTemplates = [...BUILT_IN_CONSTELLATION_BLUEPRINTS, ...blueprints];
  const selectedTemplate = overviewTemplates.find((template) => template.id === templateId);
  return (
    <>
      <CreativeStudioHeader mode="constellation" onModel3d={onModel3d} onMusic={onMusic} onSpine={onSpine} className="constellation-topbar" subtitle={tr("把灵感连成作品", "Connect ideas into finished work")}
        onMedia={onMedia} onWriting={onWriting} onBrandClick={() => { if (!overviewOpen) void returnToOverview(); }} brandDisabled={running || projectBusy || Boolean(entrySnapshot)}
        context={!overviewOpen && <input className="constellation-title-input nodrag nopan" value={graphTitle} maxLength={120} aria-label={tr("星图名称", "Constellation name")} onFocus={() => setSpacePanActive(false)} onChange={(event) => setGraphTitle(event.target.value)} />}
        actions={<div className="constellation-topbar-actions">
          {overviewOpen ? <>
            <button type="button" className="primary" disabled={!overviewReady} onClick={() => void createProject()} title={tr("新建项目", "New project")} aria-label={tr("新建项目", "New project")}><Plus size={14} />{tr("新建项目", "New project")}</button>
            <select className="constellation-template-picker" aria-label={tr("选择模板", "Choose template")} value={templateId} onChange={(event) => setTemplateId(event.target.value)}><option value="">{tr("模板", "Template")}</option>{overviewTemplates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select>
            <button type="button" className="icon-only" disabled={!overviewReady || !selectedTemplate} onClick={() => selectedTemplate && void createProject(selectedTemplate)} title={tr("从模板创建", "Create from template")} aria-label={tr("从模板创建", "Create from template")}><Sparkles size={14} /></button>
            <button type="button" className="icon-only" disabled={!overviewReady} onClick={() => importInputRef.current?.click()} title={tr("导入项目", "Import project")} aria-label={tr("导入项目", "Import project")}><FolderInput size={14} /></button>
          </> : <>
            <button type="button" disabled={running || projectBusy || Boolean(entrySnapshot)} onClick={() => void returnToOverview()} title={tr("返回总览", "Back to overview")}><ChevronLeft size={14} />{tr("返回总览", "Back to overview")}</button>
            {running ? <button type="button" className="danger" onClick={stopRun} title={tr("停止", "Stop")} aria-label={tr("停止", "Stop")}><Square size={13} />{tr("停止", "Stop")}</button>
              : <button type="button" className="primary" disabled={Boolean(entrySnapshot)} onClick={() => void runGraph()} title={tr("运行星图", "Run constellation")} aria-label={tr("运行星图", "Run constellation")}><Play size={13} />{tr("运行星图", "Run")}</button>}
            <button type="button" className="icon-only" onClick={saveBlueprint} disabled={selectedCount === 0} title={tr("框选节点后保存为蓝图", "Save selected nodes as a blueprint")} aria-label={tr("存为蓝图", "Save blueprint")}><Save size={14} /></button>
          </>}
          <button type="button" className="icon-only" onClick={onConfigureConnection} title={tr("模型连接", "Model connections")} aria-label={tr("模型连接", "Model connections")}><Settings2 size={15} /></button>
        </div>} />
      {overviewOpen ? <ConstellationOverview
    ready={projectHydrated && storageReadyRef.current && !projectBusy}
    loading={!projectHydrated}
    onRetry={() => { hydrationRef.current = null; setProjectLoadRevision((value) => value + 1); }}
    records={projectRecords}
    query={projectQuery}
    error={projectError}
    onQuery={setProjectQuery}
    onOpen={(record, cover) => void openProject(record, cover)}
    onCreate={() => void createProject()}
    onPosition={(record, position) => void updateProjectRecord(record, position)}
    onRename={(record, title) => void renameProject(record, title)}
    onDuplicate={(record) => void duplicateProject(record)}
    onDelete={(record) => void removeProject(record)}
    onDismissError={() => setProjectError(undefined)}
  /> : <>
      {projectError && <div className="constellation-save-error" role="alert"><span>{tr("保存失败，当前编辑仍在内存中：", "Save failed; your edits are still in memory: ")}{projectError}</span><button type="button" onClick={() => void saveCurrentProject().catch(() => undefined)}>{tr("重试保存", "Retry save")}</button></div>}
      <div className="constellation-save-status" role="status">{saveState === "saving" ? tr("保存中…", "Saving…") : saveState === "dirty" ? tr("待保存", "Unsaved changes") : saveState === "error" ? tr("保存失败", "Save failed") : tr("已保存", "Saved")}</div>
      <div ref={workbenchRef} inert={Boolean(entrySnapshot)} className={`constellation-workbench${leftPanelOpen ? " left-open" : ""}${rightPanelOpen ? " right-open" : ""}`}>
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

        <section tabIndex={-1} className={`constellation-canvas-shell${canvasInteracting ? " interacting" : ""}${spacePanActive ? " space-panning" : ""}${connectionType ? ` connecting-type-${connectionType}` : ""}`} onPointerDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("input, textarea, select, button, a, [contenteditable='true']")) return;
          event.currentTarget.focus({ preventScroll: true });
          // Commit before React Flow handles this same gesture's mouse-down.
          if (spacePanRef.current) flushSync(() => setSpacePanActive(true));
          if (spacePanRef.current || event.button !== 0 || !event.isPrimary || !target.classList.contains("react-flow__pane")) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          marqueeGestureRef.current = {
            pointerId: event.pointerId,
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            flowStart: screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }),
            startX: event.clientX - bounds.left,
            startY: event.clientY - bounds.top,
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
            active: false,
            additive: event.shiftKey || event.ctrlKey || event.metaKey,
          };
        }} onPointerMoveCapture={(event) => {
          const gesture = marqueeGestureRef.current;
          if (!gesture || gesture.pointerId !== event.pointerId) return;
          if ((event.buttons & 1) === 0) { finishMarquee(event, false); return; }
          gesture.x = event.clientX - gesture.left;
          gesture.y = event.clientY - gesture.top;
          if (!gesture.active) {
            if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 3) return;
            gesture.active = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            if (marqueeRef.current) marqueeRef.current.hidden = false;
            setCanvasInteracting(true);
          }
          if (marqueeFrameRef.current === null) marqueeFrameRef.current = window.requestAnimationFrame(paintMarquee);
        }} onPointerUpCapture={(event) => finishMarquee(event, true)} onPointerCancelCapture={(event) => finishMarquee(event, false)} onLostPointerCapture={(event) => finishMarquee(event, false)} onClickCapture={(event) => {
          if (!suppressMarqueeClickRef.current) return;
          suppressMarqueeClickRef.current = false;
          event.stopPropagation();
          event.preventDefault();
        }} onFocusCapture={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest("input, textarea, select, [contenteditable='true']")) {
            setSpacePanActive(false);
          }
        }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={onCanvasDrop}>
          <ConstellationNodeActionsProvider value={nodeActions}>
            <ReactFlow<ConstellationNode, ConstellationEdge>
              key={graphMetaRef.current.id}
              defaultViewport={viewportRef.current}
              nodes={nodes}
              edges={displayEdges}
              nodeTypes={CONSTELLATION_NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onReconnect={onReconnect}
              onReconnectStart={(_event, edge) => { reconnectingEdgeRef.current = edge.id; connectionValidityCacheRef.current.clear(); }}
              onReconnectEnd={() => { reconnectingEdgeRef.current = undefined; connectionValidityCacheRef.current.clear(); }}
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
              selectionOnDrag={false}
              selectionKeyCode={null}
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
              onlyRenderVisibleElements={initialViewportReady}
              multiSelectionKeyCode={["Control", "Meta", "Shift"]}
              deleteKeyCode={["Backspace", "Delete"]}
              colorMode="light"
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
              {!canvasInteracting && <MiniMap nodeColor={constellationMiniMapColor} pannable zoomable />}
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
                <button type="button" onClick={newGraph} disabled={running || projectBusy} title={tr("新建星图", "New constellation")}><Plus size={14} /></button>
                <button type="button" onClick={() => importInputRef.current?.click()} title={tr("导入", "Import")}><FolderInput size={14} /></button>
                <button type="button" onClick={() => void exportGraph()} title={tr("导出", "Export")}><Download size={14} /></button>
              </Panel>
              <Panel position="bottom-left" className="constellation-selection-status">
                {selectedCount > 0 ? <><Check size={12} /><strong>{selectedCount}</strong><span>{tr("个节点已选中", "nodes selected")}</span><button type="button" onClick={saveBlueprint}><Save size={11} />{tr("存为蓝图", "Save")}</button></>
                  : <><Maximize2 size={12} /><span>{tr("点击或拖动端口连线 · 拖动框选 · Ctrl+K 搜索", "Click or drag ports to connect · drag to select · Ctrl+K search")}</span></>}
              </Panel>
              {selectedConnection && <Panel position="top-right" className="constellation-connection-inspector">
                <strong>{tr("连接传递", "Connection mappings")}</strong>
                {selectedMappings.map((edge) => {
                  const source = nodes.find((node) => node.id === edge.source);
                  const target = nodes.find((node) => node.id === edge.target);
                  const from = source && findConstellationNodePort(source, "output", edge.sourceHandle);
                  const to = target && findConstellationNodePort(target, "input", edge.targetHandle);
                  return <div key={edge.id}>{from ? tr(from.label, from.labelEn) : edge.sourceHandle} → {to ? tr(to.label, to.labelEn) : edge.targetHandle}</div>;
                })}
                <button type="button" onClick={() => onEdgesChange([{ type: "remove", id: selectedConnection.id }])}><Trash2 size={12} />{tr("断开连接", "Disconnect")}</button>
              </Panel>}
              {commandOpen && <Panel position="top-center" className="constellation-command-panel"><CommandPalette query={commandQuery} onQuery={setCommandQuery} items={commandNodes} onChoose={addNode} onClose={() => setCommandOpen(false)} /></Panel>}
            </ReactFlow>
          </ConstellationNodeActionsProvider>
          <div ref={marqueeRef} className="constellation-marquee" hidden aria-hidden="true" />
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
      </>}
      {entrySnapshot && !overviewOpen && <ConstellationEnterTransition snapshot={entrySnapshot} workbenchRef={workbenchRef} onComplete={finishEntry} />}

      <input ref={importInputRef} type="file" accept=".json,.levelup-constellation.json" hidden onChange={(event) => void importGraph(event)} />

      {blueprintDialog && <BlueprintDialog value={blueprintDialog} nodeCount={selectedCount} onChange={setBlueprintDialog} onCancel={() => setBlueprintDialog(undefined)} onSave={confirmBlueprint} />}
      {integrationPicker?.kind === "conversation" && <ConstellationConversationPicker
        threads={threads}
        selectedThreadId={nodes.find((node) => node.id === integrationPicker.nodeId)?.data.conversationThreadId}
        onClose={() => setIntegrationPicker(undefined)}
        onCreate={() => {
          updateNode(integrationPicker.nodeId, { conversationThreadId: undefined, conversationThreadTitle: undefined, conversationSnapshot: undefined, outputs: undefined, status: "idle" });
          setIntegrationPicker(undefined);
        }}
        onChoose={(thread) => {
          updateNode(integrationPicker.nodeId, { conversationThreadId: thread.id, conversationThreadTitle: thread.title, conversationSnapshot: undefined, outputs: undefined, status: "idle" });
          setIntegrationPicker(undefined);
        }}
      />}
      {integrationPicker?.kind === "projectRef" && <ConstellationProjectPicker records={projectRecords} currentProjectId={graphMetaRef.current.id} onClose={() => setIntegrationPicker(undefined)} onChoose={(reference, value) => {
        updateNode(integrationPicker.nodeId, { projectReference: reference, projectValue: value, outputs: { output: value }, status: "success" });
        setIntegrationPicker(undefined);
      }} />}
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
  const fallback = candidates[0];
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

function graphFromProjectRecord(record: ConstellationProjectRecord) {
  const payload = isRecord(record.payload) ? record.payload : {};
  const graph = normalizeConstellationGraph(payload.graph ?? record.payload);
  return graph ? { ...graph, id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt } : null;
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
