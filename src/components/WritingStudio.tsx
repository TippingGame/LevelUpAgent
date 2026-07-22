import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Download,
  FilePlus2,
  FileText,
  GitBranch,
  History,
  ImagePlus,
  Import,
  Link2,
  ListChecks,
  LoaderCircle,
  MapPinned,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";
import {
  agentTurnStream,
  cancelAgentTurn,
  deleteWritingProject,
  exportWritingFile,
  listWritingProjects,
  saveWritingProject,
} from "../lib/bridge";
import { tr } from "../lib/i18n";
import type { AgentMessage, ProviderProfile } from "../lib/types";
import {
  buildCompletionPrompt,
  buildWritingContext,
  applyTextCompletion,
  cleanCompletionText,
  createPlayState,
  createSnapshot,
  createStoryNode,
  createStoryVariable,
  createWritingDocument,
  createWritingEntity,
  createWritingProject,
  entityKindLabel,
  followStoryChoice,
  inlineCompletionSegments,
  nodeTypeLabel,
  parseChoiceSuggestion,
  parseImportedProject,
  projectFromRecord,
  projectToMarkdown,
  projectToRecord,
  projectToYarn,
  renameStoryVariableReferences,
  restoreSnapshot,
  trimCompletionPrefixOverlap,
  validateNarrative,
  visibleStoryChoices,
  writingStats,
  type CompletionIntent,
  type EntityRelation,
  type NarrativeIssue,
  type PlayState,
  type StoryChoice,
  type StoryNode,
  type StoryNodeType,
  type StoryVariable,
  type WritingContextBundle,
  type WritingDocument,
  type WritingDocumentKind,
  type WritingEntity,
  type WritingEntityKind,
  type WritingProject,
  type WritingProjectType,
} from "../lib/writing";
import "./WritingStudio.css";

type StudioSection = "write" | "entities" | "story";
type StoryInspectorTab = "node" | "variables" | "issues";

type CompletionTarget =
  | { kind: "document"; documentId: string; start: number; end: number }
  | { kind: "entity"; entityId: string }
  | { kind: "node"; nodeId: string }
  | { kind: "choices"; nodeId: string };

interface CompletionPreview {
  id: string;
  intent: CompletionIntent;
  target: CompletionTarget;
  text: string;
  status: "streaming" | "ready" | "error";
  error?: string;
  instruction: string;
}

interface WritingStudioProps {
  active: boolean;
  locale: string;
  activeProfile: ProviderProfile;
  profiles: ProviderProfile[];
  workspace?: string;
  connectionReady: boolean;
  onConfigureConnection: () => void;
  onMedia: () => void;
}

const ENTITY_KINDS: WritingEntityKind[] = ["character", "location", "faction", "item", "world", "plot", "rule", "quest", "custom"];
const NODE_TYPES: StoryNodeType[] = ["scene", "dialogue", "choice", "condition", "ending"];
const DOCUMENT_KINDS: WritingDocumentKind[] = ["chapter", "scene", "outline", "note"];
const MAX_WRITING_FILE_BYTES = 16 * 1024 * 1024;
const COMPLETION_ACTIONS: Array<{ intent: CompletionIntent; label: string; needsSelection?: boolean }> = [
  { intent: "continue", label: "续写" },
  { intent: "rewrite", label: "改写", needsSelection: true },
  { intent: "polish", label: "润色", needsSelection: true },
  { intent: "expand", label: "扩写", needsSelection: true },
  { intent: "shorten", label: "精简", needsSelection: true },
  { intent: "dialogue", label: "对白" },
  { intent: "describe", label: "描写" },
];

export function WritingStudio({
  active,
  locale: _locale,
  activeProfile,
  profiles,
  workspace,
  connectionReady,
  onConfigureConnection,
  onMedia,
}: WritingStudioProps) {
  const [projects, setProjects] = useState<WritingProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [section, setSection] = useState<StudioSection>("write");
  const [selectedEntityId, setSelectedEntityId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedContextIds, setSelectedContextIds] = useState<Set<string>>(() => new Set());
  const [entityFilter, setEntityFilter] = useState("");
  const [entityKind, setEntityKind] = useState<WritingEntityKind | "all">("all");
  const [newProjectType, setNewProjectType] = useState<WritingProjectType>("novel");
  const [newEntityKind, setNewEntityKind] = useState<WritingEntityKind>("character");
  const [newNodeType, setNewNodeType] = useState<StoryNodeType>("scene");
  const [storyInspectorTab, setStoryInspectorTab] = useState<StoryInspectorTab>("node");
  const [completion, setCompletion] = useState<CompletionPreview>();
  const [instruction, setInstruction] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [contextOpen, setContextOpen] = useState(() => !isCompactWritingViewport());
  const [navigatorOpen, setNavigatorOpen] = useState(() => !isCompactWritingViewport());
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [savedAt, setSavedAt] = useState<number>();
  const [saving, setSaving] = useState(false);
  const [playState, setPlayState] = useState<PlayState>();
  const [userEditRevision, setUserEditRevision] = useState(0);
  const [lastTypedAt, setLastTypedAt] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<string | undefined>(undefined);
  const completionEpochRef = useRef(0);
  const hydrationRef = useRef(false);
  const savedSignaturesRef = useRef(new Map<string, string>());
  const queuedSignaturesRef = useRef(new Map<string, string>());
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveCountRef = useRef(0);
  const composingRef = useRef(false);
  const lastAutoRevisionRef = useRef(0);
  const projectsRef = useRef<WritingProject[]>([]);
  const keyboardActionsRef = useRef<{
    active: boolean;
    completion?: CompletionPreview;
    section: StudioSection;
    stopCompletion: () => Promise<void>;
    acceptCompletion: () => void;
    runCompletion: (intent: CompletionIntent) => Promise<void>;
    saveNow: () => Promise<void>;
  } | undefined>(undefined);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const activeDocument = activeProject?.documents.find((document) => document.id === activeProject.activeDocumentId)
    ?? activeProject?.documents[0];
  const selectedEntity = activeProject?.entities.find((entity) => entity.id === selectedEntityId);
  const selectedNode = activeProject?.storyNodes.find((node) => node.id === selectedNodeId);
  projectsRef.current = projects;
  const issues = useMemo(() => activeProject ? validateNarrative(activeProject) : [], [activeProject]);
  const context = useMemo(() => activeProject
    ? buildWritingContext(activeProject, activeDocument, selection.start, selectedContextIds, selectedNodeId)
    : emptyContext(), [activeDocument, activeProject, selectedContextIds, selectedNodeId, selection.start]);

  const updateProject = useCallback((updater: (project: WritingProject) => WritingProject) => {
    setProjects((current) => current.map((project) => project.id === activeProjectId
      ? { ...updater(project), updatedAt: Date.now() }
      : project));
  }, [activeProjectId]);

  const enqueueProjectSaves = useCallback((pendingProjects: WritingProject[]) => {
    const entries = pendingProjects.flatMap((project) => {
      const signature = projectSignature(project);
      return savedSignaturesRef.current.get(project.id) === signature || queuedSignaturesRef.current.get(project.id) === signature
        ? []
        : [{ project, signature }];
    });
    if (entries.length === 0) return saveQueueRef.current;
    for (const entry of entries) queuedSignaturesRef.current.set(entry.project.id, entry.signature);
    pendingSaveCountRef.current += 1;
    setSaving(true);
    const queued = saveQueueRef.current.catch(() => undefined).then(async () => {
      for (const entry of entries) {
        await saveWritingProject(projectToRecord(entry.project));
        savedSignaturesRef.current.set(entry.project.id, entry.signature);
      }
    });
    saveQueueRef.current = queued;
    return queued.finally(() => {
      for (const entry of entries) {
        if (queuedSignaturesRef.current.get(entry.project.id) === entry.signature) queuedSignaturesRef.current.delete(entry.project.id);
      }
      pendingSaveCountRef.current = Math.max(0, pendingSaveCountRef.current - 1);
      if (pendingSaveCountRef.current === 0) setSaving(false);
    });
  }, []);

  const stopCompletion = useCallback(async (clear = true) => {
    completionEpochRef.current += 1;
    const operationId = operationRef.current;
    operationRef.current = undefined;
    if (clear) setCompletion(undefined);
    if (operationId) await cancelAgentTurn(operationId).catch(() => false);
  }, []);

  useEffect(() => {
    let disposed = false;
    void listWritingProjects().then((records) => {
      if (disposed) return;
      const restored = records.map(projectFromRecord).filter((project): project is WritingProject => Boolean(project));
      const next = restored.length > 0 ? restored : [createWritingProject()];
      setProjects(next);
      setActiveProjectId(next[0].id);
      setSelectedNodeId(next[0].storyNodes[0]?.id);
      for (const project of restored) savedSignaturesRef.current.set(project.id, projectSignature(project));
      hydrationRef.current = true;
      setLoading(false);
    }).catch((reason) => {
      if (disposed) return;
      const project = createWritingProject();
      setProjects([project]);
      setActiveProjectId(project.id);
      hydrationRef.current = true;
      setLoading(false);
      setError(errorText(reason));
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 600px)");
    const sync = () => {
      setNavigatorOpen(!query.matches);
      setContextOpen(!query.matches && section !== "story");
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [section]);

  useEffect(() => {
    if (!hydrationRef.current || projects.length === 0) return;
    const timer = window.setTimeout(() => {
      const dirty = projects.filter((project) => savedSignaturesRef.current.get(project.id) !== projectSignature(project));
      if (dirty.length === 0) return;
      void enqueueProjectSaves(dirty).then(() => {
        setSavedAt(Date.now());
        setError(undefined);
      }).catch((reason) => setError(errorText(reason)));
    }, 550);
    return () => window.clearTimeout(timer);
  }, [enqueueProjectSaves, projects]);

  useEffect(() => {
    if (active || !hydrationRef.current) return;
    const dirty = projectsRef.current.filter((project) => savedSignaturesRef.current.get(project.id) !== projectSignature(project));
    if (dirty.length > 0) void enqueueProjectSaves(dirty).catch((reason) => setError(errorText(reason)));
  }, [active, enqueueProjectSaves]);

  useEffect(() => {
    const persistLatest = () => {
      if (!hydrationRef.current) return;
      const dirty = projectsRef.current.filter((project) => savedSignaturesRef.current.get(project.id) !== projectSignature(project));
      if (dirty.length > 0) void enqueueProjectSaves(dirty).catch(() => undefined);
    };
    const handleVisibility = () => { if (document.visibilityState === "hidden") persistLatest(); };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", persistLatest);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", persistLatest);
    };
  }, [enqueueProjectSaves]);

  useEffect(() => {
    if (!activeProject) return;
    if (!activeProject.documents.some((document) => document.id === activeProject.activeDocumentId)) {
      updateProject((project) => ({ ...project, activeDocumentId: project.documents[0]?.id }));
    }
    if (selectedEntityId && !activeProject.entities.some((entity) => entity.id === selectedEntityId)) setSelectedEntityId(undefined);
    if (selectedNodeId && !activeProject.storyNodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId(activeProject.storyNodes[0]?.id);
  }, [activeProject, selectedEntityId, selectedNodeId, updateProject]);

  useEffect(() => {
    if (!completion) return;
    const target = completion.target;
    const targetIsVisible = active && (
      (target.kind === "document" && section === "write" && activeDocument?.id === target.documentId)
      || (target.kind === "entity" && section === "entities" && selectedEntityId === target.entityId)
      || ((target.kind === "node" || target.kind === "choices") && section === "story" && selectedNodeId === target.nodeId)
    );
    if (!targetIsVisible) void stopCompletion();
  }, [active, activeDocument?.id, completion, section, selectedEntityId, selectedNodeId, stopCompletion]);

  useEffect(() => {
    if (!active || !activeProject || !activeDocument || section !== "write") return;
    if (!activeProject.settings.autoComplete || !connectionReady || completion || composingRef.current) return;
    if (lastTypedAt === 0 || userEditRevision === lastAutoRevisionRef.current || activeDocument.content.trim().length < 12) return;
    if (selection.start !== selection.end) return;
    const timer = window.setTimeout(() => {
      if (Date.now() - lastTypedAt < activeProject.settings.autoCompleteDelayMs - 50) return;
      lastAutoRevisionRef.current = userEditRevision;
      void runCompletion("autocomplete");
    }, activeProject.settings.autoCompleteDelayMs);
    return () => window.clearTimeout(timer);
  // runCompletion intentionally uses current editor state; its dependencies would restart this debounce.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeDocument?.content, activeProject?.settings.autoComplete, activeProject?.settings.autoCompleteDelayMs, completion, connectionReady, lastTypedAt, section, selection.end, selection.start, userEditRevision]);

  const saveNow = async () => {
    if (!activeProject) return;
    try {
      await enqueueProjectSaves([activeProject]);
      setSavedAt(Date.now());
      setError(undefined);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const runCompletion = async (intent: CompletionIntent, requestedTarget?: CompletionTarget, requestedInstruction = instruction) => {
    if (!activeProject) return;
    if (!connectionReady) {
      setError(tr("请先配置可用的文字模型", "Configure a text model first"));
      onConfigureConnection();
      return;
    }
    const epoch = completionEpochRef.current + 1;
    completionEpochRef.current = epoch;
    const previousOperationId = operationRef.current;
    operationRef.current = undefined;
    setCompletion(undefined);
    if (previousOperationId) await cancelAgentTurn(previousOperationId).catch(() => false);
    if (completionEpochRef.current !== epoch) return;
    const liveSelection = section === "write" && textareaRef.current
      ? { start: textareaRef.current.selectionStart, end: textareaRef.current.selectionEnd }
      : selection;
    const replacesSelection = intent === "rewrite" || intent === "polish" || intent === "expand" || intent === "shorten";
    const insertionPoint = liveSelection.end;
    const target: CompletionTarget = requestedTarget
      ?? (section === "entities" && selectedEntity
        ? { kind: "entity", entityId: selectedEntity.id }
        : section === "story" && selectedNode
          ? { kind: intent === "choices" ? "choices" : "node", nodeId: selectedNode.id }
          : {
              kind: "document",
              documentId: activeDocument?.id ?? "",
              start: replacesSelection ? liveSelection.start : insertionPoint,
              end: replacesSelection ? liveSelection.end : insertionPoint,
            });
    if (target.kind === "document" && !activeDocument) return;
    const entity = target.kind === "entity" ? activeProject.entities.find((item) => item.id === target.entityId) : undefined;
    const node = target.kind === "node" || target.kind === "choices" ? activeProject.storyNodes.find((item) => item.id === target.nodeId) : undefined;
    const document = target.kind === "document" ? activeProject.documents.find((item) => item.id === target.documentId) : activeDocument;
    const start = target.kind === "document" ? target.start : selection.start;
    const end = target.kind === "document" ? target.end : selection.end;
    const cursor = target.kind === "document" ? target.start : selection.start;
    const liveContext = buildWritingContext(activeProject, document, cursor, selectedContextIds, node?.id);
    const prompt = buildCompletionPrompt({
      project: activeProject,
      document,
      cursor,
      selectionStart: start,
      selectionEnd: end,
      intent,
      instruction: requestedInstruction,
      context: liveContext,
      targetText: target.kind === "entity" ? entity?.details : target.kind === "node" ? node?.content : undefined,
      entity,
      node,
    });
    const operationId = crypto.randomUUID();
    operationRef.current = operationId;
    const previewId = crypto.randomUUID();
    setCompletion({ id: previewId, intent, target, text: "", status: "streaming", instruction: requestedInstruction });
    setError(undefined);
    const messages: AgentMessage[] = [{
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      toolCalls: [],
      createdAt: Date.now(),
      attachments: [],
    }];
    const fallbackProfiles = profiles
      .filter((profile) => profile.id !== activeProfile.id && profile.failoverEnabled)
      .sort((left, right) => left.priority - right.priority);
    try {
      const response = await agentTurnStream(
        activeProfile,
        messages,
        "chat",
        workspace,
        operationId,
        (delta) => setCompletion((current) => completionEpochRef.current === epoch && current?.id === previewId
          ? { ...current, text: current.text + delta }
          : current),
        undefined,
        fallbackProfiles,
      );
      if (completionEpochRef.current !== epoch || operationRef.current !== operationId) return;
      operationRef.current = undefined;
      setCompletion((current) => {
        if (current?.id !== previewId) return current;
        const cleaned = cleanCompletionText(current.text || response.content);
        const text = target.kind === "document" && document && target.start === target.end
          ? trimCompletionPrefixOverlap(document.content.slice(0, target.start), cleaned)
          : cleaned;
        return text.trim()
          ? { ...current, text, status: "ready" }
          : { ...current, status: "error", error: tr("模型没有返回可用文本", "The model returned no usable text") };
      });
    } catch (reason) {
      if (completionEpochRef.current !== epoch || operationRef.current !== operationId) return;
      operationRef.current = undefined;
      setCompletion((current) => current?.id === previewId
        ? { ...current, status: "error", error: errorText(reason) }
        : current);
    }
  };

  const acceptCompletion = () => {
    if (!activeProject || !completion || completion.status !== "ready") return;
    const target = completion.target;
    const cleaned = cleanCompletionText(completion.text);
    const sourceDocument = target.kind === "document"
      ? activeProject.documents.find((document) => document.id === target.documentId)
      : undefined;
    const targetExists = target.kind === "document"
      ? Boolean(sourceDocument)
      : target.kind === "entity"
        ? activeProject.entities.some((entity) => entity.id === target.entityId)
        : activeProject.storyNodes.some((node) => node.id === target.nodeId);
    if (!targetExists) {
      setCompletion(undefined);
      setError(tr("补全目标已经改变，请重新生成", "The completion target changed; generate again"));
      return;
    }
    const text = target.kind === "document" && sourceDocument && target.start === target.end
      ? trimCompletionPrefixOverlap(sourceDocument.content.slice(0, target.start), cleaned)
      : cleaned;
    if (!text.trim()) {
      setCompletion((current) => current ? { ...current, status: "error", error: tr("模型没有返回可用文本", "The model returned no usable text") } : current);
      return;
    }
    const labels = target.kind === "choices" ? parseChoiceSuggestion(text) : [];
    if (target.kind === "choices" && labels.length === 0) {
      setCompletion((current) => current ? { ...current, status: "error", error: tr("模型没有返回可用选项", "The model returned no usable choices") } : current);
      return;
    }
    const snapshotLabel = `AI ${completionLabel(completion.intent)}前`;
    updateProject((project) => {
      const snapshot = createSnapshot(project, snapshotLabel);
      const snapshots = [snapshot, ...project.snapshots].slice(0, 30);
      if (target.kind === "document") {
        return {
          ...project,
          snapshots,
          documents: project.documents.map((document) => document.id === target.documentId ? {
            ...document,
            content: applyTextCompletion(document.content, target.start, target.end, text),
            updatedAt: Date.now(),
          } : document),
        };
      }
      if (target.kind === "entity") return {
        ...project,
        snapshots,
        entities: project.entities.map((entity) => entity.id === target.entityId
          ? { ...entity, details: text, updatedAt: Date.now() }
          : entity),
      };
      if (target.kind === "node") return {
        ...project,
        snapshots,
        storyNodes: project.storyNodes.map((node) => node.id === target.nodeId
          ? { ...node, content: text, updatedAt: Date.now() }
          : node),
      };
      return {
        ...project,
        snapshots,
        storyNodes: project.storyNodes.map((node) => node.id === target.nodeId
          ? {
            ...node,
            type: "choice",
            choices: [...node.choices, ...labels.map((label) => ({ id: `choice-${crypto.randomUUID()}`, label, condition: "", effects: "" }))],
            updatedAt: Date.now(),
          }
          : node),
      };
    });
    completionEpochRef.current += 1;
    if (target.kind === "document") {
      const caret = target.start + text.length;
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(caret, caret);
        setSelection({ start: caret, end: caret });
      });
    }
    setCompletion(undefined);
    setInstruction("");
    setLastTypedAt(0);
  };

  const regenerate = () => {
    if (!completion) return;
    const { intent, target, instruction: previousInstruction } = completion;
    setInstruction(previousInstruction);
    void runCompletion(intent, target, previousInstruction);
  };

  const changeDocumentContent = (content: string) => {
    if (!activeDocument) return;
    if (completion) void stopCompletion();
    updateProject((project) => ({
      ...project,
      documents: project.documents.map((document) => document.id === activeDocument.id
        ? { ...document, content, updatedAt: Date.now() }
        : document),
    }));
    setUserEditRevision((value) => value + 1);
    setLastTypedAt(Date.now());
  };

  const addProject = () => {
    void stopCompletion();
    const project = createWritingProject(newProjectType);
    setProjects((current) => [project, ...current]);
    setActiveProjectId(project.id);
    setSelectedEntityId(undefined);
    setSelectedNodeId(project.storyNodes[0]?.id);
    setSelectedContextIds(new Set());
    setSection("write");
    setContextOpen(!isCompactWritingViewport());
  };

  const removeProject = async () => {
    if (!activeProject || projects.length <= 1) return;
    if (!window.confirm(tr(`删除写作项目“${activeProject.title}”？此操作无法撤销。`, `Delete writing project “${activeProject.title}”? This cannot be undone.`))) return;
    try {
      await stopCompletion();
      await saveQueueRef.current.catch(() => undefined);
      await deleteWritingProject(activeProject.id);
      savedSignaturesRef.current.delete(activeProject.id);
      const next = projects.filter((project) => project.id !== activeProject.id);
      setProjects(next);
      setActiveProjectId(next[0]?.id ?? "");
      setSelectedEntityId(undefined);
      setSelectedNodeId(next[0]?.storyNodes[0]?.id);
      setSelectedContextIds(new Set());
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const addDocument = () => {
    const document = createWritingDocument(
      activeProject?.projectType === "screenplay" ? "新场景" : "新文稿",
      activeProject?.projectType === "screenplay" ? "scene" : "chapter",
    );
    updateProject((project) => ({ ...project, documents: [...project.documents, document], activeDocumentId: document.id }));
    setSection("write");
    setContextOpen(!isCompactWritingViewport());
    setNavigatorOpen(false);
    setSelection({ start: 0, end: 0 });
  };

  const removeDocument = (documentId: string) => {
    if (!activeProject || activeProject.documents.length <= 1) return;
    const document = activeProject.documents.find((item) => item.id === documentId);
    if (!document || !window.confirm(tr(`删除文稿“${document.title}”？`, `Delete document “${document.title}”?`))) return;
    const removedIndex = activeProject.documents.findIndex((item) => item.id === documentId);
    const removingActiveDocument = activeProject.activeDocumentId === documentId;
    if (removingActiveDocument) {
      void stopCompletion();
      setSelection({ start: 0, end: 0 });
    }
    updateProject((project) => {
      const documents = project.documents.filter((item) => item.id !== documentId);
      const activeDocumentId = project.activeDocumentId === documentId
        ? documents[Math.min(Math.max(0, removedIndex), documents.length - 1)]?.id
        : project.activeDocumentId;
      return { ...project, documents, activeDocumentId };
    });
  };

  const addEntity = () => {
    const entity = createWritingEntity(newEntityKind);
    updateProject((project) => ({ ...project, entities: [...project.entities, entity] }));
    setSelectedEntityId(entity.id);
    setSection("entities");
    setContextOpen(!isCompactWritingViewport());
    setNavigatorOpen(false);
  };

  const addNode = () => {
    const offset = (activeProject?.storyNodes.length ?? 0) * 28;
    const node = createStoryNode(newNodeType, undefined, 80 + offset % 420, 80 + offset % 300);
    updateProject((project) => ({
      ...project,
      storyNodes: [...project.storyNodes, node],
      startNodeId: project.startNodeId ?? node.id,
    }));
    setSelectedNodeId(node.id);
    setStoryInspectorTab("node");
    setSection("story");
    setContextOpen(false);
    setNavigatorOpen(false);
  };

  const takeSnapshot = () => {
    if (!activeProject) return;
    const snapshot = createSnapshot(activeProject, tr("手动快照", "Manual snapshot"));
    updateProject((project) => ({ ...project, snapshots: [snapshot, ...project.snapshots].slice(0, 30) }));
    setSnapshotsOpen(true);
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeProject) return;
    try {
      if (file.size > MAX_WRITING_FILE_BYTES) throw new Error(tr("导入文件不能超过 16 MiB", "Writing imports may not exceed 16 MiB"));
      const text = await file.text();
      if (/\.json$/i.test(file.name)) {
        const imported = parseImportedProject(JSON.parse(text));
        if (!imported) throw new Error(tr("不是有效的 LevelUpAgent 写作项目", "Not a valid LevelUpAgent writing project"));
        const project = projects.some((item) => item.id === imported.id)
          ? { ...imported, id: `writing-${crypto.randomUUID()}`, title: `${imported.title} · ${tr("导入", "Imported")}`, updatedAt: Date.now() }
          : imported;
        setProjects((current) => [project, ...current]);
        setActiveProjectId(project.id);
        setSelectedNodeId(project.storyNodes[0]?.id);
        setSelectedEntityId(undefined);
        setSelectedContextIds(new Set());
      } else {
        const document = createWritingDocument(file.name.replace(/\.[^.]+$/, ""), /\.yarn$/i.test(file.name) ? "scene" : "note");
        document.content = text;
        document.updatedAt = Date.now();
        const entities = parseMarkdownEntities(text);
        updateProject((project) => ({
          ...project,
          documents: [...project.documents, document],
          entities: mergeImportedEntities(project.entities, entities),
          activeDocumentId: document.id,
        }));
        setSection("write");
        setContextOpen(!isCompactWritingViewport());
      }
      setError(undefined);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const exportProject = async (format: "json" | "md" | "yarn") => {
    if (!activeProject) return;
    setExportOpen(false);
    const stem = fileStem(activeProject.title);
    try {
      if (format === "json") await exportWritingFile(`${stem}.json`, JSON.stringify(projectToRecord(activeProject), null, 2), "json");
      else if (format === "md") await exportWritingFile(`${stem}.md`, projectToMarkdown(activeProject), "md");
      else await exportWritingFile(`${stem}.yarn`, projectToYarn(activeProject), "yarn");
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  keyboardActionsRef.current = { active, completion, section, stopCompletion, acceptCompletion, runCompletion, saveNow };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const actions = keyboardActionsRef.current;
      if (!actions?.active) return;
      if (event.key === "Escape" && actions.completion) {
        event.preventDefault();
        void actions.stopCompletion();
        return;
      }
      if (event.key === "Tab" && actions.completion?.status === "ready") {
        if (actions.completion.target.kind === "document" && event.target !== textareaRef.current) return;
        event.preventDefault();
        actions.acceptCompletion();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "j" && actions.section === "write" && event.target === textareaRef.current) {
        event.preventDefault();
        void actions.runCompletion("continue");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        void actions.saveNow();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => () => {
    completionEpochRef.current += 1;
    const operationId = operationRef.current;
    operationRef.current = undefined;
    if (operationId) void cancelAgentTurn(operationId).catch(() => false);
  }, []);

  if (!active) return <main className="writing-studio" hidden />;
  if (loading || !activeProject) return (
    <main className="writing-studio writing-loading">
      <LoaderCircle className="spin" size={24} />
      <span>{tr("正在打开写作空间…", "Opening writing studio…")}</span>
    </main>
  );

  const stats = writingStats(activeDocument?.content ?? "");
  const selectedTextLength = Math.max(0, selection.end - selection.start);

  return (
    <main className="writing-studio">
      <header className="writing-topbar" data-tauri-drag-region>
        <div className="writing-brand">
          <span><BookOpen size={17} /></span>
          <div><strong>{tr("创作空间", "Creative Studio")}</strong><small>{saving ? tr("正在保存…", "Saving…") : savedAt ? tr("已自动保存", "Autosaved") : tr("本地写作项目", "Local writing projects")}</small></div>
          <button
            type="button"
            className="writing-navigator-toggle"
            aria-label={navigatorOpen ? tr("关闭写作导航", "Close writing navigation") : tr("打开写作导航", "Open writing navigation")}
            aria-expanded={navigatorOpen}
            title={navigatorOpen ? tr("关闭写作导航", "Close writing navigation") : tr("打开写作导航", "Open writing navigation")}
            onClick={() => setNavigatorOpen((value) => !value)}
          >{navigatorOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
        </div>
        <div className="creation-mode-switch" role="tablist" aria-label={tr("创作类型", "Creation mode")}>
          <button type="button" role="tab" aria-selected="false" onClick={onMedia}><ImagePlus size={14} />{tr("图片 · 视频 · 语音", "Image · Video · Speech")}</button>
          <button type="button" role="tab" aria-selected="true" className="active"><FileText size={14} />{tr("写作", "Writing")}</button>
        </div>
        <div className="writing-topbar-actions">
          <button type="button" onClick={() => importRef.current?.click()} title={tr("导入 JSON、Markdown、文本或 Yarn", "Import JSON, Markdown, text, or Yarn")}><Import size={15} /></button>
          <div className="writing-menu-wrap">
            <button type="button" aria-expanded={exportOpen} onClick={() => setExportOpen((value) => !value)} title={tr("导出", "Export")}><Download size={15} /><ChevronDown size={12} /></button>
            {exportOpen && <div className="writing-popover writing-export-menu">
              <button type="button" onClick={() => void exportProject("json")}>{tr("完整项目 JSON", "Full project JSON")}</button>
              <button type="button" onClick={() => void exportProject("md")}>Markdown</button>
              <button type="button" disabled={activeProject.storyNodes.length === 0} onClick={() => void exportProject("yarn")}>Yarn Spinner</button>
            </div>}
          </div>
          <button type="button" onClick={takeSnapshot} title={tr("创建版本快照", "Create version snapshot")}><History size={15} /></button>
          <button type="button" onClick={() => setSettingsOpen((value) => !value)} title={tr("写作设置", "Writing settings")}><Settings2 size={15} /></button>
          <button type="button" onClick={() => void saveNow()} title={tr("立即保存", "Save now")}><Save size={15} /></button>
          <button type="button" className={connectionReady ? "writing-model ready" : "writing-model"} onClick={onConfigureConnection}><Bot size={15} /><span>{activeProfile.model || tr("配置模型", "Configure model")}</span></button>
        </div>
        <input ref={importRef} type="file" hidden accept=".json,.md,.markdown,.txt,.yarn" onChange={(event) => void handleImport(event)} />
      </header>

      <div className={`writing-layout${contextOpen ? " context-open" : ""}${navigatorOpen ? " navigator-open" : ""}`}>
        {navigatorOpen && <button type="button" className="writing-navigator-backdrop" aria-label={tr("关闭写作导航", "Close writing navigation")} onClick={() => setNavigatorOpen(false)} />}
        <aside className="writing-navigator">
          <div className="writing-project-picker">
            <select value={activeProject.id} onChange={(event) => {
              setActiveProjectId(event.target.value);
              const project = projects.find((item) => item.id === event.target.value);
              setSelectedEntityId(undefined);
              setSelectedNodeId(project?.storyNodes[0]?.id);
              setSelectedContextIds(new Set());
              void stopCompletion();
            }} aria-label={tr("写作项目", "Writing project")}>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}
            </select>
            <input
              className="writing-project-title"
              value={activeProject.title}
              maxLength={200}
              onChange={(event) => updateProject((project) => ({ ...project, title: event.target.value }))}
              aria-label={tr("项目名称", "Project title")}
              placeholder={tr("项目名称", "Project title")}
            />
            <div>
              <select value={newProjectType} onChange={(event) => setNewProjectType(event.target.value as WritingProjectType)} aria-label={tr("新项目类型", "New project type")}>
                <option value="novel">{tr("小说", "Novel")}</option>
                <option value="screenplay">{tr("剧本", "Screenplay")}</option>
                <option value="game">{tr("游戏剧情", "Game narrative")}</option>
              </select>
              <button type="button" onClick={addProject} title={tr("新建写作项目", "New writing project")}><Plus size={14} /></button>
              <button type="button" disabled={projects.length <= 1} onClick={() => void removeProject()} title={tr("删除项目", "Delete project")}><Trash2 size={14} /></button>
            </div>
          </div>

          <nav className="writing-section-tabs" aria-label={tr("写作视图", "Writing views")}>
            <button className={section === "write" ? "active" : ""} onClick={() => { setSection("write"); setContextOpen(!isCompactWritingViewport()); setNavigatorOpen(false); }}><FileText size={15} />{tr("文稿", "Manuscript")}</button>
            <button className={section === "entities" ? "active" : ""} onClick={() => { setSection("entities"); setContextOpen(!isCompactWritingViewport()); setNavigatorOpen(false); }}><UserRound size={15} />{tr("设定", "Codex")}</button>
            <button className={section === "story" ? "active" : ""} onClick={() => { setSection("story"); setContextOpen(false); setNavigatorOpen(false); }}><GitBranch size={15} />{tr("剧情图", "Story graph")}</button>
          </nav>

          {section === "write" && <DocumentNavigator
            documents={activeProject.documents}
            activeId={activeDocument?.id}
            onActivate={(id) => {
              updateProject((project) => ({ ...project, activeDocumentId: id }));
              setSelection({ start: 0, end: 0 });
              void stopCompletion();
              setNavigatorOpen(false);
            }}
            onAdd={addDocument}
            onRemove={removeDocument}
          />}
          {section === "entities" && <EntityNavigator
            entities={activeProject.entities}
            selectedId={selectedEntityId}
            filter={entityFilter}
            kind={entityKind}
            newKind={newEntityKind}
            onFilter={setEntityFilter}
            onKind={setEntityKind}
            onNewKind={setNewEntityKind}
            onSelect={(id) => { setSelectedEntityId(id); setNavigatorOpen(false); }}
            onAdd={addEntity}
          />}
          {section === "story" && <StoryNavigator
            nodes={activeProject.storyNodes}
            selectedId={selectedNodeId}
            startNodeId={activeProject.startNodeId}
            newType={newNodeType}
            onNewType={setNewNodeType}
            onSelect={(id) => { setSelectedNodeId(id); setStoryInspectorTab("node"); setNavigatorOpen(false); }}
            onAdd={addNode}
          />}
        </aside>

        <section className="writing-workarea">
          {section === "write" && activeDocument && <ManuscriptEditor
            project={activeProject}
            document={activeDocument}
            textareaRef={textareaRef}
            selection={selection}
            instruction={instruction}
            selectedTextLength={selectedTextLength}
            stats={stats}
            completion={completion}
            connectionReady={connectionReady}
            onInstruction={setInstruction}
            onSelection={(start, end) => {
              setSelection({ start, end });
              if (completion?.target.kind === "document"
                && completion.target.documentId === activeDocument.id
                && (start !== completion.target.start || end !== completion.target.end)) void stopCompletion();
            }}
            onContent={changeDocumentContent}
            onDocument={(patch) => {
              if (completion?.target.kind === "document" && completion.target.documentId === activeDocument.id) void stopCompletion();
              updateProject((project) => ({
                ...project,
                documents: project.documents.map((document) => document.id === activeDocument.id
                  ? { ...document, ...patch, updatedAt: Date.now() }
                  : document),
              }));
            }}
            onComplete={(intent) => void runCompletion(intent)}
            onStop={() => void stopCompletion()}
            onAccept={acceptCompletion}
            onRegenerate={regenerate}
            onCompose={(composing) => {
              composingRef.current = composing;
              if (!composing) setLastTypedAt(Date.now());
            }}
          />}
          {section === "entities" && <EntityEditor
            project={activeProject}
            entity={selectedEntity}
            completion={completion}
            onSelectFirst={() => setSelectedEntityId(activeProject.entities[0]?.id)}
            onChange={(patch) => {
              if (!selectedEntity) return;
              if (completion?.target.kind === "entity" && completion.target.entityId === selectedEntity.id) void stopCompletion();
              updateProject((project) => ({
                ...project,
                entities: project.entities.map((entity) => entity.id === selectedEntity.id ? { ...entity, ...patch, updatedAt: Date.now() } : entity),
              }));
            }}
            onDelete={() => {
              if (!selectedEntity || !window.confirm(tr(`删除设定“${selectedEntity.name}”？`, `Delete codex entry “${selectedEntity.name}”?`))) return;
              const removedIndex = activeProject.entities.findIndex((entity) => entity.id === selectedEntity.id);
              const remaining = activeProject.entities.filter((entity) => entity.id !== selectedEntity.id);
              updateProject((project) => ({
                ...project,
                entities: project.entities.filter((entity) => entity.id !== selectedEntity.id).map((entity) => ({
                  ...entity,
                  relations: entity.relations.filter((relation) => relation.targetId !== selectedEntity.id),
                })),
                documents: project.documents.map((document) => ({ ...document, linkedEntityIds: document.linkedEntityIds.filter((id) => id !== selectedEntity.id) })),
                storyNodes: project.storyNodes.map((node) => ({ ...node, linkedEntityIds: node.linkedEntityIds.filter((id) => id !== selectedEntity.id), speakerEntityId: node.speakerEntityId === selectedEntity.id ? undefined : node.speakerEntityId })),
              }));
              setSelectedEntityId(remaining[Math.min(Math.max(0, removedIndex), remaining.length - 1)]?.id);
              setSelectedContextIds((current) => {
                const next = new Set(current);
                next.delete(selectedEntity.id);
                return next;
              });
            }}
            onComplete={() => void runCompletion("entity")}
            onStop={() => void stopCompletion()}
            onAccept={acceptCompletion}
            onRegenerate={regenerate}
          />}
          {section === "story" && <StoryWorkspace
            project={activeProject}
            selectedNode={selectedNode}
            selectedNodeId={selectedNodeId}
            inspectorTab={storyInspectorTab}
            issues={issues}
            completion={completion}
            onInspectorTab={setStoryInspectorTab}
            onSelect={setSelectedNodeId}
            onMove={(id, x, y) => updateProject((project) => ({
              ...project,
              storyNodes: project.storyNodes.map((node) => node.id === id ? { ...node, x, y, updatedAt: Date.now() } : node),
            }))}
            onNode={(patch) => {
              if (!selectedNode) return;
              if ((completion?.target.kind === "node" || completion?.target.kind === "choices") && completion.target.nodeId === selectedNode.id) void stopCompletion();
              updateProject((project) => ({
                ...project,
                storyNodes: project.storyNodes.map((node) => node.id === selectedNode.id ? { ...node, ...patch, updatedAt: Date.now() } : node),
              }));
            }}
            onProject={(patch) => {
              if (completion?.target.kind === "node" || completion?.target.kind === "choices") void stopCompletion();
              updateProject((project) => ({ ...project, ...patch }));
            }}
            onDeleteNode={() => {
              if (!selectedNode || !window.confirm(tr(`删除节点“${selectedNode.title}”？`, `Delete node “${selectedNode.title}”?`))) return;
              const removedIndex = activeProject.storyNodes.findIndex((node) => node.id === selectedNode.id);
              const remaining = activeProject.storyNodes.filter((node) => node.id !== selectedNode.id);
              updateProject((project) => {
                const storyNodes = project.storyNodes.filter((node) => node.id !== selectedNode.id).map((node) => ({
                  ...node,
                  nextNodeId: node.nextNodeId === selectedNode.id ? undefined : node.nextNodeId,
                  choices: node.choices.map((choice) => choice.targetNodeId === selectedNode.id ? { ...choice, targetNodeId: undefined } : choice),
                }));
                return { ...project, storyNodes, startNodeId: project.startNodeId === selectedNode.id ? storyNodes[0]?.id : project.startNodeId };
              });
              setSelectedNodeId(remaining[Math.min(Math.max(0, removedIndex), remaining.length - 1)]?.id);
            }}
            onComplete={(intent) => void runCompletion(intent)}
            onStop={() => void stopCompletion()}
            onAccept={acceptCompletion}
            onRegenerate={regenerate}
            onPlay={() => setPlayState(createPlayState(activeProject))}
          />}
        </section>

        {contextOpen && <WritingContextPanel
          project={activeProject}
          document={activeDocument}
          context={context}
          selectedIds={selectedContextIds}
          onSelectedIds={setSelectedContextIds}
          onProject={(patch) => {
            if (completion) void stopCompletion();
            updateProject((project) => ({ ...project, ...patch }));
          }}
          onDocument={(patch) => {
            if (!activeDocument) return;
            if (completion?.target.kind === "document" && completion.target.documentId === activeDocument.id) void stopCompletion();
            updateProject((project) => ({
              ...project,
              documents: project.documents.map((document) => document.id === activeDocument.id ? { ...document, ...patch, updatedAt: Date.now() } : document),
            }));
          }}
          onClose={() => setContextOpen(false)}
        />}
        {!contextOpen && <button className="writing-context-reopen" onClick={() => setContextOpen(true)} title={tr("打开上下文", "Open context")}><Network size={16} /></button>}
      </div>

      {snapshotsOpen && <SnapshotPanel
        project={activeProject}
        onClose={() => setSnapshotsOpen(false)}
        onCreate={takeSnapshot}
        onRestore={(snapshotId) => {
          const snapshot = activeProject.snapshots.find((item) => item.id === snapshotId);
          if (!snapshot || !window.confirm(tr("恢复这个快照？当前版本会先自动保留。", "Restore this snapshot? The current version will be preserved first."))) return;
          const currentSnapshot = createSnapshot(activeProject, tr("恢复前自动快照", "Automatic snapshot before restore"));
          const restored = restoreSnapshot(activeProject, snapshot);
          updateProject(() => ({ ...restored, snapshots: [currentSnapshot, ...activeProject.snapshots].slice(0, 30) }));
        }}
      />}
      {settingsOpen && <WritingSettingsPanel
        project={activeProject}
        onClose={() => setSettingsOpen(false)}
        onChange={(settings) => updateProject((project) => ({ ...project, settings: { ...project.settings, ...settings } }))}
      />}
      {playState && <NarrativePlaytest
        project={activeProject}
        state={playState}
        onState={setPlayState}
        onClose={() => setPlayState(undefined)}
      />}
      {error && <button type="button" className="writing-toast" onClick={() => setError(undefined)}><CircleAlert size={15} /><span>{error}</span><X size={13} /></button>}
    </main>
  );
}

function DocumentNavigator({ documents, activeId, onActivate, onAdd, onRemove }: {
  documents: WritingDocument[];
  activeId?: string;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return <div className="writing-nav-content">
    <div className="writing-nav-heading"><span>{tr("文稿", "Documents")}<small>{documents.length}</small></span><button type="button" onClick={onAdd} title={tr("新建文稿", "New document")}><FilePlus2 size={14} /></button></div>
    <div className="document-list">
      {documents.map((document, index) => <div className={`document-row${document.id === activeId ? " active" : ""}${documents.length === 1 ? " single" : ""}`} key={document.id}>
        <button type="button" className="document-entry-button" onClick={() => onActivate(document.id)}>
          <span className="document-index">{index + 1}</span><div className="document-copy"><strong>{document.title}</strong><small><span>{documentKindLabel(document.kind)}</span><span>{writingStats(document.content).words.toLocaleString()} {tr("字", "words")}</span></small></div>
        </button>
        {documents.length > 1 && <button type="button" className="document-delete-button" onClick={() => onRemove(document.id)} title={tr("删除文稿", "Delete document")}><Trash2 size={12} /></button>}
      </div>)}
    </div>
  </div>;
}

function EntityNavigator({ entities, selectedId, filter, kind, newKind, onFilter, onKind, onNewKind, onSelect, onAdd }: {
  entities: WritingEntity[];
  selectedId?: string;
  filter: string;
  kind: WritingEntityKind | "all";
  newKind: WritingEntityKind;
  onFilter: (value: string) => void;
  onKind: (value: WritingEntityKind | "all") => void;
  onNewKind: (value: WritingEntityKind) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const query = filter.trim().toLocaleLowerCase();
  const visible = entities.filter((entity) => (kind === "all" || entity.kind === kind)
    && (!query || `${entity.name} ${entity.summary} ${entity.tags.join(" ")}`.toLocaleLowerCase().includes(query)));
  return <div className="writing-nav-content entity-nav">
    <div className="writing-nav-heading"><span>{tr("设定集", "Codex")}<small>{entities.length}</small></span></div>
    <label className="writing-nav-search"><Search size={13} /><input value={filter} onChange={(event) => onFilter(event.target.value)} placeholder={tr("搜索设定", "Search codex")} /></label>
    <select value={kind} onChange={(event) => onKind(event.target.value as WritingEntityKind | "all")}>
      <option value="all">{tr("全部类型", "All types")}</option>
      {ENTITY_KINDS.map((value) => <option value={value} key={value}>{entityKindLabel(value)}</option>)}
    </select>
    <div className="entity-list">
      {visible.map((entity) => <button type="button" className={entity.id === selectedId ? "active" : ""} onClick={() => onSelect(entity.id)} key={entity.id}>
        <EntityIcon kind={entity.kind} /><span><strong>{entity.name}</strong><small>{entityKindLabel(entity.kind)}{entity.tags[0] ? ` · ${entity.tags[0]}` : ""}</small></span>
      </button>)}
      {visible.length === 0 && <p>{tr("没有匹配的设定", "No matching entries")}</p>}
    </div>
    <div className="writing-nav-add">
      <select value={newKind} onChange={(event) => onNewKind(event.target.value as WritingEntityKind)}>{ENTITY_KINDS.map((value) => <option value={value} key={value}>{entityKindLabel(value)}</option>)}</select>
      <button type="button" onClick={onAdd}><Plus size={14} />{tr("添加", "Add")}</button>
    </div>
  </div>;
}

function StoryNavigator({ nodes, selectedId, startNodeId, newType, onNewType, onSelect, onAdd }: {
  nodes: StoryNode[];
  selectedId?: string;
  startNodeId?: string;
  newType: StoryNodeType;
  onNewType: (value: StoryNodeType) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return <div className="writing-nav-content story-nav">
    <div className="writing-nav-heading"><span>{tr("剧情节点", "Story nodes")}<small>{nodes.length}</small></span></div>
    <div className="story-node-list">
      {nodes.map((node) => <button type="button" className={node.id === selectedId ? "active" : ""} onClick={() => onSelect(node.id)} key={node.id}>
        <i className={`node-type-dot ${node.type}`} /><span><strong>{node.title}</strong><small>{nodeTypeLabel(node.type)}{node.id === startNodeId ? tr(" · 开始", " · Start") : ""}</small></span>
      </button>)}
      {nodes.length === 0 && <p>{tr("从一个场景节点开始", "Start with a scene node")}</p>}
    </div>
    <div className="writing-nav-add">
      <select value={newType} onChange={(event) => onNewType(event.target.value as StoryNodeType)}>{NODE_TYPES.map((value) => <option value={value} key={value}>{nodeTypeLabel(value)}</option>)}</select>
      <button type="button" onClick={onAdd}><Plus size={14} />{tr("节点", "Node")}</button>
    </div>
  </div>;
}

function ManuscriptEditor({ project, document, textareaRef, selection, instruction, selectedTextLength, stats, completion, connectionReady, onInstruction, onSelection, onContent, onDocument, onComplete, onStop, onAccept, onRegenerate, onCompose }: {
  project: WritingProject;
  document: WritingDocument;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selection: { start: number; end: number };
  instruction: string;
  selectedTextLength: number;
  stats: ReturnType<typeof writingStats>;
  completion?: CompletionPreview;
  connectionReady: boolean;
  onInstruction: (value: string) => void;
  onSelection: (start: number, end: number) => void;
  onContent: (value: string) => void;
  onDocument: (patch: Partial<WritingDocument>) => void;
  onComplete: (intent: CompletionIntent) => void;
  onStop: () => void;
  onAccept: () => void;
  onRegenerate: () => void;
  onCompose: (composing: boolean) => void;
}) {
  const inlineCompletion = completion
    && completion.target.kind === "document"
    && completion.target.documentId === document.id
    && completion.target.start === completion.target.end
    && completion.status !== "error"
    ? completion
    : undefined;
  const inlineTarget = inlineCompletion?.target.kind === "document" ? inlineCompletion.target : undefined;
  const rawInlineSuggestion = inlineCompletion?.status === "ready"
    ? cleanCompletionText(inlineCompletion.text)
    : inlineCompletion?.text ?? "";
  const inlineSuggestion = inlineTarget
    ? trimCompletionPrefixOverlap(document.content.slice(0, inlineTarget.start), rawInlineSuggestion)
    : "";
  const inlineParts = inlineTarget
    ? inlineCompletionSegments(document.content, inlineTarget.start, inlineTarget.end, inlineSuggestion || "…")
    : undefined;
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const ghostMirrorRef = useRef<HTMLDivElement>(null);
  const ghostContentRef = useRef<HTMLDivElement>(null);
  const ghostEndRef = useRef<HTMLSpanElement>(null);
  const autoFollowRef = useRef(true);
  const [pageExtent, setPageExtent] = useState<{ documentId: string; height: number }>();
  const pageHeight = pageExtent?.documentId === document.id ? pageExtent.height : undefined;
  const [mirrorMetrics, setMirrorMetrics] = useState({ scrollTop: 0, scrollLeft: 0, scrollbarWidth: 0 });
  const syncMirror = useCallback(() => {
    const editor = textareaRef.current;
    if (!editor) return;
    const styles = window.getComputedStyle(editor);
    const borders = (Number.parseFloat(styles.borderLeftWidth) || 0) + (Number.parseFloat(styles.borderRightWidth) || 0);
    const next = {
      scrollTop: editor.scrollTop,
      scrollLeft: editor.scrollLeft,
      scrollbarWidth: Math.max(0, editor.offsetWidth - editor.clientWidth - borders),
    };
    setMirrorMetrics((current) => current.scrollTop === next.scrollTop
      && current.scrollLeft === next.scrollLeft
      && current.scrollbarWidth === next.scrollbarWidth
      ? current
      : next);
  }, [textareaRef]);
  useEffect(() => {
    if (!inlineCompletion) return;
    syncMirror();
    const editor = textareaRef.current;
    if (!editor || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncMirror);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [inlineCompletion?.id, syncMirror, textareaRef]);
  const measurePage = useCallback(() => {
    const viewport = pageWrapRef.current;
    const shell = shellRef.current;
    const mirror = ghostMirrorRef.current;
    const mirrorContent = ghostContentRef.current;
    if (!viewport || !shell || !mirror || !mirrorContent) return;
    const viewportStyles = window.getComputedStyle(viewport);
    const shellStyles = window.getComputedStyle(shell);
    const mirrorStyles = window.getComputedStyle(mirror);
    const availableHeight = viewport.clientHeight
      - (Number.parseFloat(viewportStyles.paddingTop) || 0)
      - (Number.parseFloat(viewportStyles.paddingBottom) || 0);
    const minimumHeight = Number.parseFloat(shellStyles.minHeight) || 0;
    const mirrorInsets = (Number.parseFloat(mirrorStyles.paddingTop) || 0)
      + (Number.parseFloat(mirrorStyles.paddingBottom) || 0)
      + (Number.parseFloat(mirrorStyles.borderTopWidth) || 0)
      + (Number.parseFloat(mirrorStyles.borderBottomWidth) || 0);
    const contentHeight = mirrorContent.scrollHeight + mirrorInsets;
    const requiredHeight = Math.ceil(Math.max(1, availableHeight, minimumHeight, contentHeight));
    setPageExtent((current) => current?.documentId === document.id && current.height === requiredHeight
      ? current
      : { documentId: document.id, height: requiredHeight });
  }, [document.id, textareaRef]);
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      measurePage();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [document.content, inlineCompletion?.id, inlineCompletion?.status, inlineCompletion?.text, measurePage, mirrorMetrics.scrollbarWidth]);
  useEffect(() => {
    const viewport = pageWrapRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measurePage);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [measurePage]);
  useEffect(() => {
    if (inlineCompletion) autoFollowRef.current = true;
  }, [inlineCompletion?.id]);
  useEffect(() => {
    if (!inlineCompletion || !autoFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = pageWrapRef.current;
      const ghostEnd = ghostEndRef.current;
      if (!viewport || !ghostEnd) return;
      const viewportRect = viewport.getBoundingClientRect();
      const ghostRect = ghostEnd.getBoundingClientRect();
      const visibleBottom = viewportRect.bottom - 52;
      if (ghostRect.bottom > visibleBottom) {
        viewport.scrollTop += ghostRect.bottom - visibleBottom;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inlineCompletion?.id, inlineCompletion?.text, pageHeight]);
  const updateSelection = () => {
    const editor = textareaRef.current;
    if (editor) onSelection(editor.selectionStart, editor.selectionEnd);
  };
  return <div className="manuscript-editor">
    <header className="document-heading">
      <input value={document.title} maxLength={120} onChange={(event) => onDocument({ title: event.target.value })} aria-label={tr("文稿标题", "Document title")} />
      <div>
        <select value={document.kind} onChange={(event) => onDocument({ kind: event.target.value as WritingDocumentKind })}>{DOCUMENT_KINDS.map((kind) => <option value={kind} key={kind}>{documentKindLabel(kind)}</option>)}</select>
        <select value={document.status} onChange={(event) => onDocument({ status: event.target.value as WritingDocument["status"] })}>
          <option value="draft">{tr("草稿", "Draft")}</option><option value="revised">{tr("已修订", "Revised")}</option><option value="final">{tr("定稿", "Final")}</option>
        </select>
      </div>
    </header>
    <div className="writing-ai-toolbar" role="toolbar" aria-label={tr("AI 写作操作", "AI writing actions")}>
      <span><WandSparkles size={14} />AI</span>
      {COMPLETION_ACTIONS.map((action) => <button
        type="button"
        disabled={!connectionReady || Boolean(completion) || (action.needsSelection && selectedTextLength === 0)}
        title={action.needsSelection && selectedTextLength === 0 ? tr("请先选择文字", "Select text first") : action.label}
        onClick={() => onComplete(action.intent)}
        key={action.intent}
      >{tr(action.label, completionLabelEn(action.intent))}</button>)}
      <div className="writing-ai-instruction"><Sparkles size={13} /><input value={instruction} onChange={(event) => onInstruction(event.target.value)} placeholder={tr("补充指示，例如：保持克制，让冲突通过动作体现", "Optional instruction, e.g. keep it restrained and show conflict through action")} /></div>
      <small>{selectedTextLength > 0 ? tr(`已选 ${selectedTextLength} 字`, `${selectedTextLength} selected`) : tr("Ctrl+J 补全", "Ctrl+J complete")}</small>
    </div>
    <div
      className="manuscript-page-wrap"
      ref={pageWrapRef}
      onWheel={() => { if (inlineCompletion) autoFollowRef.current = false; }}
      onTouchMove={() => { if (inlineCompletion) autoFollowRef.current = false; }}
      onPointerDown={() => { if (inlineCompletion) autoFollowRef.current = false; }}
    >
      <div className={`manuscript-input-shell${inlineCompletion ? " has-inline-completion" : ""}`} ref={shellRef} style={pageHeight ? { height: pageHeight } : undefined}>
      <div
          ref={ghostMirrorRef}
          className={`manuscript-ghost-mirror${project.projectType === "screenplay" ? " screenplay" : ""}`}
          style={{ right: mirrorMetrics.scrollbarWidth }}
          aria-hidden="true"
        ><div ref={ghostContentRef} className="manuscript-ghost-content" style={inlineCompletion ? { transform: `translate(${-mirrorMetrics.scrollLeft}px, ${-mirrorMetrics.scrollTop}px)` } : undefined}>{inlineCompletion && inlineParts ? <><span>{inlineParts.before}</span><span className={`manuscript-ghost-suggestion ${inlineCompletion.status}`}>{inlineParts.suggestion}{inlineCompletion.status === "streaming" && <i />}</span><span className="manuscript-ghost-end" ref={ghostEndRef}>{"\u200b"}</span><span>{inlineParts.after}</span></> : <span>{document.content}</span>}<span>{"\u200b"}</span></div></div>
      <textarea
        ref={textareaRef}
        className={project.projectType === "screenplay" ? "screenplay" : ""}
        value={document.content}
        spellCheck
        placeholder={project.projectType === "screenplay" ? tr("场景标题、动作与对白…", "Scene heading, action, and dialogue…") : tr("从这里开始写作…", "Start writing here…")}
        onChange={(event) => onContent(event.target.value)}
        onSelect={updateSelection}
        onClick={updateSelection}
        onKeyUp={updateSelection}
        onCompositionStart={() => onCompose(true)}
        onCompositionEnd={() => onCompose(false)}
        onScroll={syncMirror}
      />
      {inlineCompletion && <div className={`inline-completion-controls ${inlineCompletion.status}`} role="status" aria-live="polite">
        {inlineCompletion.status === "streaming" ? <><LoaderCircle className="spin" size={13} /><span>{tr("AI 补全中", "AI completing")}</span><button type="button" onClick={onStop} title={tr("停止补全", "Stop completion")} aria-label={tr("停止补全", "Stop completion")}><Square size={11} /></button></> : <><Sparkles size={13} /><kbd>Tab</kbd><button type="button" onClick={onAccept} title={tr("接受建议", "Accept suggestion")} aria-label={tr("接受建议", "Accept suggestion")}><Check size={12} /></button><button type="button" onClick={onStop} title={tr("拒绝建议", "Reject suggestion")} aria-label={tr("拒绝建议", "Reject suggestion")}><X size={12} /></button><button type="button" onClick={onRegenerate} title={tr("重新生成", "Regenerate")} aria-label={tr("重新生成", "Regenerate")}><RefreshCw size={12} /></button></>}
      </div>}
      </div>
      {completion && completion.target.kind === "document" && !inlineCompletion && <CompletionCard preview={completion} onStop={onStop} onAccept={onAccept} onReject={onStop} onRegenerate={onRegenerate} />}
    </div>
    <footer className="manuscript-status">
      <span>{stats.words.toLocaleString()} {tr("字", "words")} · {stats.characters.toLocaleString()} {tr("字符", "characters")} · {stats.paragraphs} {tr("段", "paragraphs")}</span>
      <span>{document.linkedEntityIds.length} {tr("个绑定设定", "linked entries")} · {selection.start === selection.end ? tr(`光标 ${selection.start}`, `Cursor ${selection.start}`) : tr(`选区 ${selection.end - selection.start}`, `Selection ${selection.end - selection.start}`)}</span>
    </footer>
  </div>;
}

function CompletionCard({ preview, onStop, onAccept, onReject, onRegenerate }: {
  preview: CompletionPreview;
  onStop: () => void;
  onAccept: () => void;
  onReject: () => void;
  onRegenerate: () => void;
}) {
  return <aside className={`completion-card ${preview.status}`} aria-live="polite">
    <header><span>{preview.status === "streaming" ? <LoaderCircle className="spin" size={14} /> : preview.status === "ready" ? <Sparkles size={14} /> : <CircleAlert size={14} />}<strong>{preview.status === "streaming" ? tr("AI 正在补全", "AI is completing") : preview.status === "ready" ? tr("AI 建议", "AI suggestion") : tr("补全失败", "Completion failed")}</strong></span>
      {preview.status === "streaming" ? <button type="button" onClick={onStop}><Square size={12} />{tr("停止", "Stop")}</button> : <button type="button" onClick={onReject} aria-label={tr("关闭", "Close")}><X size={13} /></button>}
    </header>
    {preview.error ? <p className="completion-error">{preview.error}</p> : <div className="completion-text">{preview.text || tr("正在建立上下文…", "Building context…")} {preview.status === "streaming" && <i />}</div>}
    {preview.status === "ready" && <footer>
      <button type="button" className="accept" onClick={onAccept}><Check size={13} />{tr("接受", "Accept")}<kbd>Tab</kbd></button>
      <button type="button" onClick={onReject}><X size={13} />{tr("拒绝", "Reject")}<kbd>Esc</kbd></button>
      <button type="button" onClick={onRegenerate}><RefreshCw size={13} />{tr("重新生成", "Regenerate")}</button>
    </footer>}
  </aside>;
}

function EntityEditor({ project, entity, completion, onSelectFirst, onChange, onDelete, onComplete, onStop, onAccept, onRegenerate }: {
  project: WritingProject;
  entity?: WritingEntity;
  completion?: CompletionPreview;
  onSelectFirst: () => void;
  onChange: (patch: Partial<WritingEntity>) => void;
  onDelete: () => void;
  onComplete: () => void;
  onStop: () => void;
  onAccept: () => void;
  onRegenerate: () => void;
}) {
  if (!entity) return <EmptyWritingState icon={<UserRound size={28} />} title={tr("建立你的设定集", "Build your story codex")} detail={tr("人物、地点、阵营、物品、剧情和规则都会自动参与 AI 补全。", "Characters, places, factions, items, plots, and rules can all feed AI completion.")} action={project.entities.length > 0 ? tr("打开第一个设定", "Open first entry") : undefined} onAction={project.entities.length > 0 ? onSelectFirst : undefined} />;
  const updateRelation = (relationId: string, patch: Partial<EntityRelation>) => onChange({ relations: entity.relations.map((relation) => relation.id === relationId ? { ...relation, ...patch } : relation) });
  return <div className="entity-editor">
    <header>
      <div><EntityIcon kind={entity.kind} /><span><strong>{entity.name}</strong><small>{entityKindLabel(entity.kind)} · {entity.relations.length} {tr("条关系", "relations")}</small></span></div>
      <div><button type="button" className="entity-ai-button" onClick={onComplete} disabled={completion?.status === "streaming"}><WandSparkles size={14} />{tr("AI 补全设定", "AI complete entry")}</button><button type="button" onClick={onDelete} title={tr("删除设定", "Delete entry")}><Trash2 size={14} /></button></div>
    </header>
    <div className="entity-form">
      <div className="entity-form-grid">
        <label><span>{tr("名称", "Name")}</span><input value={entity.name} maxLength={120} onChange={(event) => onChange({ name: event.target.value })} /></label>
        <label><span>{tr("类型", "Type")}</span><select value={entity.kind} onChange={(event) => onChange({ kind: event.target.value as WritingEntityKind })}>{ENTITY_KINDS.map((kind) => <option value={kind} key={kind}>{entityKindLabel(kind)}</option>)}</select></label>
        <label><span>{tr("别名", "Aliases")}</span><input value={entity.aliases.join("，")} onChange={(event) => onChange({ aliases: splitList(event.target.value) })} placeholder={tr("用于正文自动召回，逗号分隔", "Used for automatic mentions, comma separated")} /></label>
        <label><span>{tr("标签", "Tags")}</span><input value={entity.tags.join("，")} onChange={(event) => onChange({ tags: splitList(event.target.value) })} placeholder={tr("主角，第一幕，在场…", "protagonist, act one, present…")} /></label>
      </div>
      <label className="entity-wide"><span>{tr("一句话摘要", "One-line summary")}</span><textarea value={entity.summary} maxLength={1_000} onChange={(event) => onChange({ summary: event.target.value })} placeholder={entitySummaryPlaceholder(entity.kind)} /></label>
      <label className="entity-wide details"><span>{tr("详细设定", "Details")}</span><textarea value={entity.details} maxLength={60_000} onChange={(event) => onChange({ details: event.target.value })} placeholder={entityDetailsPlaceholder(entity.kind)} /></label>
      {completion && completion.target.kind === "entity" && completion.target.entityId === entity.id && <CompletionCard preview={completion} onStop={onStop} onAccept={onAccept} onReject={onStop} onRegenerate={onRegenerate} />}
      <section className="entity-relations">
        <div><span><Link2 size={14} />{tr("关系", "Relations")}</span><button type="button" disabled={project.entities.length < 2} onClick={() => {
          const target = project.entities.find((item) => item.id !== entity.id);
          if (!target) return;
          onChange({ relations: [...entity.relations, { id: `relation-${crypto.randomUUID()}`, targetId: target.id, type: tr("关联", "related to"), note: "" }] });
        }}><Plus size={13} />{tr("添加关系", "Add relation")}</button></div>
        {entity.relations.map((relation) => <div className="relation-row" key={relation.id}>
          <select value={relation.targetId} onChange={(event) => updateRelation(relation.id, { targetId: event.target.value })}>{project.entities.filter((item) => item.id !== entity.id).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
          <input value={relation.type} onChange={(event) => updateRelation(relation.id, { type: event.target.value })} placeholder={tr("关系类型", "Relation type")} />
          <input value={relation.note} onChange={(event) => updateRelation(relation.id, { note: event.target.value })} placeholder={tr("关系变化或秘密", "Change or secret")} />
          <button type="button" onClick={() => onChange({ relations: entity.relations.filter((item) => item.id !== relation.id) })} title={tr("删除关系", "Delete relation")}><X size={13} /></button>
        </div>)}
        {entity.relations.length === 0 && <p>{tr("关系会让关联人物、地点和物品自动进入补全上下文。", "Relations automatically pull connected characters, places, and items into completion context.")}</p>}
      </section>
    </div>
  </div>;
}

function WritingContextPanel({ project, document, context, selectedIds, onSelectedIds, onProject, onDocument, onClose }: {
  project: WritingProject;
  document?: WritingDocument;
  context: WritingContextBundle;
  selectedIds: Set<string>;
  onSelectedIds: (value: Set<string>) => void;
  onProject: (patch: Partial<WritingProject>) => void;
  onDocument: (patch: Partial<WritingDocument>) => void;
  onClose: () => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelectedIds(next);
  };
  return <aside className="writing-context-panel">
    <header><span><Network size={15} />{tr("智能上下文", "Smart context")}</span><button type="button" onClick={onClose} aria-label={tr("关闭上下文", "Close context")}><X size={13} /></button></header>
    <div className="context-budget">
      <div><span>{tr("本次自动召回", "Automatic recall")}</span><strong>~{context.estimatedTokens.toLocaleString()} tokens</strong></div>
      <div><i style={{ width: `${Math.min(100, context.usedChars / context.budgetChars * 100)}%` }} /></div>
      <small>{context.items.length} {tr("项内容参与补全", "items included in completion")}</small>
    </div>
    <details open>
      <summary>{tr("作品方向", "Project direction")}</summary>
      <label><span>{tr("核心设定 / 故事前提", "Premise")}</span><textarea value={project.premise} onChange={(event) => onProject({ premise: event.target.value })} placeholder={tr("主冲突、主人公欲望、代价与独特规则", "Central conflict, desire, stakes, and defining rules")} /></label>
      <label><span>{tr("文风与硬性规则", "Style and hard rules")}</span><textarea value={project.styleGuide} onChange={(event) => onProject({ styleGuide: event.target.value })} placeholder={tr("视角、时态、禁用表达、节奏、分级…", "POV, tense, banned phrasing, pacing, rating…")} /></label>
      {document && <label><span>{tr("当前文稿摘要", "Document summary")}</span><textarea value={document.summary} onChange={(event) => onDocument({ summary: event.target.value })} placeholder={tr("用于跨章节保持连贯", "Used for continuity across documents")} /></label>}
    </details>
    <details open className="context-entities">
      <summary>{tr("设定联动", "Linked codex")}</summary>
      {project.entities.map((entity) => {
        const included = context.entityIds.includes(entity.id);
        const item = context.items.find((candidate) => candidate.id === entity.id);
        return <label className={included ? "included" : ""} key={entity.id}>
          <input type="checkbox" checked={selectedIds.has(entity.id)} onChange={() => toggle(entity.id)} />
          <EntityIcon kind={entity.kind} /><span><strong>{entity.name}</strong><small>{item ? contextReasonLabel(item.reason) : entityKindLabel(entity.kind)}</small></span>{included && <CircleCheck size={13} />}
        </label>;
      })}
      {project.entities.length === 0 && <p>{tr("添加人物、地点或规则后，AI 会根据正文提及和关系自动召回。", "Add characters, places, or rules and AI will recall them from mentions and relations.")}</p>}
    </details>
  </aside>;
}

function StoryWorkspace({ project, selectedNode, selectedNodeId, inspectorTab, issues, completion, onInspectorTab, onSelect, onMove, onNode, onProject, onDeleteNode, onComplete, onStop, onAccept, onRegenerate, onPlay }: {
  project: WritingProject;
  selectedNode?: StoryNode;
  selectedNodeId?: string;
  inspectorTab: StoryInspectorTab;
  issues: NarrativeIssue[];
  completion?: CompletionPreview;
  onInspectorTab: (tab: StoryInspectorTab) => void;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onNode: (patch: Partial<StoryNode>) => void;
  onProject: (patch: Partial<WritingProject>) => void;
  onDeleteNode: () => void;
  onComplete: (intent: CompletionIntent) => void;
  onStop: () => void;
  onAccept: () => void;
  onRegenerate: () => void;
  onPlay: () => void;
}) {
  return <div className="story-workspace">
    <header className="story-toolbar">
      <div><GitBranch size={15} /><strong>{tr("互动剧情图", "Interactive story graph")}</strong><span>{project.storyNodes.length} {tr("个节点", "nodes")}</span></div>
      <div>
        <button type="button" onClick={() => onInspectorTab("issues")} className={issues.some((issue) => issue.severity === "error") ? "has-errors" : ""}><ListChecks size={14} />{tr("检查", "Validate")}<b>{issues.filter((issue) => issue.severity !== "info").length}</b></button>
        <button type="button" onClick={onPlay} disabled={project.storyNodes.length === 0}><Play size={14} />{tr("试玩", "Playtest")}</button>
      </div>
    </header>
    <div className="story-main">
      <StoryCanvas project={project} selectedId={selectedNodeId} onSelect={onSelect} onMove={onMove} />
      <aside className="story-inspector">
        <nav><button className={inspectorTab === "node" ? "active" : ""} onClick={() => onInspectorTab("node")}>{tr("节点", "Node")}</button><button className={inspectorTab === "variables" ? "active" : ""} onClick={() => onInspectorTab("variables")}>{tr("变量", "Variables")}</button><button className={inspectorTab === "issues" ? "active" : ""} onClick={() => onInspectorTab("issues")}>{tr("检查", "Checks")}</button></nav>
        {inspectorTab === "node" && <NodeInspector project={project} node={selectedNode} completion={completion} onNode={onNode} onProject={onProject} onDelete={onDeleteNode} onComplete={onComplete} onStop={onStop} onAccept={onAccept} onRegenerate={onRegenerate} />}
        {inspectorTab === "variables" && <VariableInspector project={project} onProject={onProject} />}
        {inspectorTab === "issues" && <IssueInspector issues={issues} onSelect={(nodeId) => { if (nodeId) onSelect(nodeId); onInspectorTab("node"); }} />}
      </aside>
    </div>
  </div>;
}

function StoryCanvas({ project, selectedId, onSelect, onMove }: {
  project: WritingProject;
  selectedId?: string;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; x: number; y: number } | undefined>(undefined);
  const [dragPosition, setDragPosition] = useState<{ id: string; x: number; y: number }>();
  const positions = new Map(project.storyNodes.map((node) => [node.id, dragPosition?.id === node.id ? { x: dragPosition.x, y: dragPosition.y } : { x: node.x, y: node.y }]));
  const edges = project.storyNodes.flatMap((node) => {
    const source = positions.get(node.id);
    if (!source) return [];
    return [node.nextNodeId, ...node.choices.map((choice) => choice.targetNodeId)].flatMap((targetId, index) => {
      const target = targetId ? positions.get(targetId) : undefined;
      return target ? [{ id: `${node.id}-${targetId}-${index}`, source, target, choice: index > 0 || node.choices.length > 0 }] : [];
    });
  });
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const x = Math.max(12, Math.min(3_720, drag.x + event.clientX - drag.startX));
    const y = Math.max(12, Math.min(3_720, drag.y + event.clientY - drag.startY));
    setDragPosition({ id: drag.id, x, y });
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const x = Math.max(12, Math.min(3_720, drag.x + event.clientX - drag.startX));
    const y = Math.max(12, Math.min(3_720, drag.y + event.clientY - drag.startY));
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (Math.round(x) !== Math.round(drag.x) || Math.round(y) !== Math.round(drag.y)) onMove(drag.id, Math.round(x), Math.round(y));
    setDragPosition(undefined);
  };
  return <div className="story-canvas-shell">
    <div className="story-canvas" ref={canvasRef} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
      <svg width="4000" height="4000" aria-hidden="true">
        {edges.map((edge) => {
          const x1 = edge.source.x + 210;
          const y1 = edge.source.y + 55;
          const x2 = edge.target.x;
          const y2 = edge.target.y + 55;
          const bend = Math.max(55, Math.abs(x2 - x1) * .45);
          return <path d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} className={edge.choice ? "choice" : ""} key={edge.id} />;
        })}
      </svg>
      {project.storyNodes.map((node) => {
        const position = positions.get(node.id)!;
        return <article
          className={`story-node ${node.type}${node.id === selectedId ? " selected" : ""}${node.id === project.startNodeId ? " start" : ""}`}
          style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
            dragRef.current = { id: node.id, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y };
            setDragPosition({ id: node.id, x: position.x, y: position.y });
            onSelect(node.id);
          }}
          onClick={() => onSelect(node.id)}
          key={node.id}
        >
          <header><i /><span>{nodeTypeLabel(node.type)}</span>{node.id === project.startNodeId && <b>{tr("开始", "START")}</b>}</header>
          <strong>{node.title}</strong>
          <p>{node.content || tr("尚未填写内容", "No content yet")}</p>
          <footer>{node.choices.length > 0 ? tr(`${node.choices.length} 个选项`, `${node.choices.length} choices`) : node.nextNodeId ? tr("顺序连接", "Sequential") : tr("未连接", "Unlinked")}</footer>
        </article>;
      })}
      {project.storyNodes.length === 0 && <div className="story-canvas-empty"><GitBranch size={30} /><strong>{tr("添加第一个剧情节点", "Add your first story node")}</strong></div>}
    </div>
  </div>;
}

function NodeInspector({ project, node, completion, onNode, onProject, onDelete, onComplete, onStop, onAccept, onRegenerate }: {
  project: WritingProject;
  node?: StoryNode;
  completion?: CompletionPreview;
  onNode: (patch: Partial<StoryNode>) => void;
  onProject: (patch: Partial<WritingProject>) => void;
  onDelete: () => void;
  onComplete: (intent: CompletionIntent) => void;
  onStop: () => void;
  onAccept: () => void;
  onRegenerate: () => void;
}) {
  if (!node) return <p className="story-inspector-empty">{tr("选择一个节点查看和编辑", "Select a node to inspect and edit")}</p>;
  const characters = project.entities.filter((entity) => entity.kind === "character");
  const updateChoice = (choiceId: string, patch: Partial<StoryChoice>) => onNode({ choices: node.choices.map((choice) => choice.id === choiceId ? { ...choice, ...patch } : choice) });
  return <div className="node-inspector-form">
    <div className="node-inspector-actions"><button type="button" onClick={() => onComplete("node")}><WandSparkles size={13} />{tr("AI 补全", "AI complete")}</button><button type="button" onClick={onDelete} aria-label={tr("删除节点", "Delete node")} title={tr("删除节点", "Delete node")}><Trash2 size={13} /></button></div>
    <label><span>{tr("节点标题", "Node title")}</span><input value={node.title} onChange={(event) => onNode({ title: event.target.value })} /></label>
    <div className="node-two-fields"><label><span>{tr("类型", "Type")}</span><select value={node.type} onChange={(event) => onNode({ type: event.target.value as StoryNodeType })}>{NODE_TYPES.map((type) => <option value={type} key={type}>{nodeTypeLabel(type)}</option>)}</select></label><label><span>{tr("开始节点", "Start node")}</span><button type="button" className={node.id === project.startNodeId ? "set-start active" : "set-start"} onClick={() => onProject({ startNodeId: node.id })}>{node.id === project.startNodeId ? <CircleCheck size={13} /> : <Play size={13} />}{node.id === project.startNodeId ? tr("当前开始", "Current start") : tr("设为开始", "Set start")}</button></label></div>
    <label><span>{tr("说话者", "Speaker")}</span><select value={node.speakerEntityId ?? ""} onChange={(event) => onNode({ speakerEntityId: event.target.value || undefined })}><option value="">{tr("无 / 旁白", "None / Narrator")}</option>{characters.map((entity) => <option value={entity.id} key={entity.id}>{entity.name}</option>)}</select></label>
    <label className="node-content"><span>{tr("节点内容", "Node content")}</span><textarea value={node.content} onChange={(event) => onNode({ content: event.target.value })} placeholder={tr("对白、动作、场景说明或叙事文本", "Dialogue, action, scene direction, or narrative text")} /></label>
    {completion && (completion.target.kind === "node" || completion.target.kind === "choices") && completion.target.nodeId === node.id && <CompletionCard preview={completion} onStop={onStop} onAccept={onAccept} onReject={onStop} onRegenerate={onRegenerate} />}
    <label><span>{tr("顺序后继", "Default next")}</span><select value={node.nextNodeId ?? ""} onChange={(event) => onNode({ nextNodeId: event.target.value || undefined })}><option value="">{tr("无", "None")}</option>{project.storyNodes.filter((item) => item.id !== node.id).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
    <fieldset className="node-linked-entities"><legend>{tr("节点设定", "Node codex")}</legend>{project.entities.map((entity) => <label key={entity.id}><input type="checkbox" checked={node.linkedEntityIds.includes(entity.id)} onChange={() => onNode({ linkedEntityIds: toggleId(node.linkedEntityIds, entity.id) })} /><span>{entity.name}</span></label>)}</fieldset>
    <section className="choice-editor">
      <header><span>{tr("玩家选项", "Player choices")}</span><div><button type="button" onClick={() => onComplete("choices")}><Sparkles size={12} />AI</button><button type="button" onClick={() => onNode({ type: "choice", choices: [...node.choices, { id: `choice-${crypto.randomUUID()}`, label: tr("新选项", "New choice"), condition: "", effects: "" }] })} aria-label={tr("添加玩家选项", "Add player choice")} title={tr("添加玩家选项", "Add player choice")}><Plus size={12} /></button></div></header>
      {node.choices.map((choice, index) => <article key={choice.id}>
        <div><span>{index + 1}</span><input value={choice.label} onChange={(event) => updateChoice(choice.id, { label: event.target.value })} placeholder={tr("玩家看到的选项", "Choice shown to player")} /><button type="button" onClick={() => onNode({ choices: node.choices.filter((item) => item.id !== choice.id) })} aria-label={tr(`删除选项 ${index + 1}`, `Delete choice ${index + 1}`)} title={tr("删除选项", "Delete choice")}><X size={12} /></button></div>
        <select value={choice.targetNodeId ?? ""} onChange={(event) => updateChoice(choice.id, { targetNodeId: event.target.value || undefined })}><option value="">{tr("选择目标节点", "Choose target node")}</option>{project.storyNodes.filter((item) => item.id !== node.id).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select>
        <input value={choice.condition} onChange={(event) => updateChoice(choice.id, { condition: event.target.value })} placeholder={tr("条件，如 trust >= 3 && has_key", "Condition, e.g. trust >= 3 && has_key")} />
        <input value={choice.effects} onChange={(event) => updateChoice(choice.id, { effects: event.target.value })} placeholder={tr("效果，如 trust += 1; has_key = false", "Effects, e.g. trust += 1; has_key = false")} />
      </article>)}
      {node.choices.length === 0 && <p>{tr("为分支节点添加选项，条件和效果会在试玩时执行。", "Add choices to branch; conditions and effects run during playtest.")}</p>}
    </section>
  </div>;
}

function VariableInspector({ project, onProject }: { project: WritingProject; onProject: (patch: Partial<WritingProject>) => void }) {
  const variables = project.variables;
  const update = (id: string, patch: Partial<StoryVariable>) => onProject({ variables: variables.map((variable) => variable.id === id ? { ...variable, ...patch } : variable) });
  const rename = (variable: StoryVariable, value: string) => {
    const name = sanitizeVariableName(value) || variable.name;
    if (name === variable.name) return;
    onProject({
      variables: variables.map((item) => item.id === variable.id ? { ...item, name } : item),
      storyNodes: project.storyNodes.map((node) => ({
        ...node,
        choices: node.choices.map((choice) => ({
          ...choice,
          condition: renameStoryVariableReferences(choice.condition, variable.name, name),
          effects: renameStoryVariableReferences(choice.effects, variable.name, name),
        })),
      })),
    });
  };
  return <div className="variable-inspector">
    <header><span>{tr("剧情变量", "Story variables")}</span><button type="button" onClick={() => onProject({ variables: [...variables, createStoryVariable()] })}><Plus size={13} />{tr("变量", "Variable")}</button></header>
    <p>{tr("条件支持 ==、!=、>、>=、<、<= 和 &&；效果支持 =、+=、-=、toggle。", "Conditions support ==, !=, >, >=, <, <= and &&; effects support =, +=, -=, and toggle.")}</p>
    {variables.map((variable) => <article key={variable.id}>
      <div><input value={variable.name} onChange={(event) => rename(variable, event.target.value)} aria-label={tr("变量名", "Variable name")} /><select value={variable.type} onChange={(event) => {
        const type = event.target.value as StoryVariable["type"];
        update(variable.id, { type, initialValue: type === "boolean" ? false : type === "number" ? 0 : "" });
      }} aria-label={tr("变量类型", "Variable type")}><option value="boolean">Boolean</option><option value="number">Number</option><option value="string">String</option></select><button type="button" onClick={() => onProject({ variables: variables.filter((item) => item.id !== variable.id) })} aria-label={tr(`删除变量 ${variable.name}`, `Delete variable ${variable.name}`)} title={tr("删除变量", "Delete variable")}><Trash2 size={12} /></button></div>
      {variable.type === "boolean" ? <label><input type="checkbox" checked={Boolean(variable.initialValue)} onChange={(event) => update(variable.id, { initialValue: event.target.checked })} />{tr("初始为真", "Initially true")}</label> : <input value={String(variable.initialValue)} type={variable.type === "number" ? "number" : "text"} onChange={(event) => update(variable.id, { initialValue: variable.type === "number" ? Number(event.target.value) : event.target.value })} placeholder={tr("初始值", "Initial value")} />}
      <input value={variable.description} onChange={(event) => update(variable.id, { description: event.target.value })} placeholder={tr("用途说明", "Purpose")} />
    </article>)}
    {variables.length === 0 && <p className="variable-empty">{tr("添加变量后，可以控制选项显示和剧情状态。", "Add variables to control choice visibility and story state.")}</p>}
  </div>;
}

function IssueInspector({ issues, onSelect }: { issues: NarrativeIssue[]; onSelect: (nodeId?: string) => void }) {
  return <div className="issue-inspector">
    <header><ListChecks size={15} /><span>{tr("剧情完整性检查", "Narrative validation")}</span></header>
    {issues.map((issue) => <button type="button" className={issue.severity} onClick={() => onSelect(issue.nodeId)} disabled={!issue.nodeId} key={issue.id}>{issue.severity === "error" ? <CircleAlert size={14} /> : issue.severity === "warning" ? <Clock3 size={14} /> : <CircleCheck size={14} />}<span>{issue.message}</span></button>)}
  </div>;
}

function SnapshotPanel({ project, onClose, onCreate, onRestore }: { project: WritingProject; onClose: () => void; onCreate: () => void; onRestore: (id: string) => void }) {
  return <div className="writing-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="snapshot-panel" role="dialog" aria-modal="true" aria-label={tr("版本快照", "Version snapshots")}>
    <header><div><History size={17} /><span><strong>{tr("版本快照", "Version snapshots")}</strong><small>{tr("接受 AI 建议前会自动保留版本", "A version is kept before accepting AI suggestions")}</small></span></div><button type="button" onClick={onClose} aria-label={tr("关闭版本快照", "Close version snapshots")} title={tr("关闭", "Close")}><X size={15} /></button></header>
    <div className="snapshot-actions"><button type="button" onClick={onCreate}><Plus size={14} />{tr("创建当前快照", "Snapshot current version")}</button><span>{project.snapshots.length}/30</span></div>
    <div className="snapshot-list">{project.snapshots.map((snapshot) => <article key={snapshot.id}><div><strong>{snapshot.label}</strong><small>{new Date(snapshot.createdAt).toLocaleString()}</small><span>{snapshot.state.documents.length} {tr("篇文稿", "documents")} · {snapshot.state.entities.length} {tr("项设定", "entries")}</span></div><button type="button" onClick={() => onRestore(snapshot.id)}>{tr("恢复", "Restore")}</button></article>)}{project.snapshots.length === 0 && <p>{tr("还没有快照", "No snapshots yet")}</p>}</div>
  </section></div>;
}

function WritingSettingsPanel({ project, onClose, onChange }: { project: WritingProject; onClose: () => void; onChange: (patch: Partial<WritingProject["settings"]>) => void }) {
  return <div className="writing-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="writing-settings-panel" role="dialog" aria-modal="true" aria-label={tr("写作设置", "Writing settings")}>
    <header><div><Settings2 size={17} /><strong>{tr("AI 补全设置", "AI completion settings")}</strong></div><button type="button" onClick={onClose} aria-label={tr("关闭写作设置", "Close writing settings")} title={tr("关闭", "Close")}><X size={15} /></button></header>
    <label className="writing-toggle"><span><strong>{tr("停笔后自动补全", "Complete after typing pause")}</strong><small>{tr("正文达到 12 字后生效；灰字建议可用 Tab 接受，继续输入会自动取消", "Starts after 12 characters; press Tab to accept gray text, or keep typing to dismiss it")}</small></span><input type="checkbox" checked={project.settings.autoComplete} onChange={(event) => onChange({ autoComplete: event.target.checked })} /></label>
    <label><span>{tr("触发延迟", "Trigger delay")}<output>{(project.settings.autoCompleteDelayMs / 1_000).toFixed(1)}s</output></span><input type="range" min="700" max="5000" step="100" value={project.settings.autoCompleteDelayMs} onChange={(event) => onChange({ autoCompleteDelayMs: Number(event.target.value) })} /></label>
    <label><span>{tr("建议长度", "Suggestion length")}<output>{project.settings.completionLength} {tr("字", "chars")}</output></span><input type="range" min="80" max="1200" step="20" value={project.settings.completionLength} onChange={(event) => onChange({ completionLength: Number(event.target.value) })} /></label>
    <label><span>{tr("设定上下文预算", "Codex context budget")}<output>{Math.round(project.settings.contextBudget / 1_000)}k {tr("字符", "chars")}</output></span><input type="range" min="4000" max="60000" step="2000" value={project.settings.contextBudget} onChange={(event) => onChange({ contextBudget: Number(event.target.value) })} /></label>
  </section></div>;
}

function NarrativePlaytest({ project, state, onState, onClose }: { project: WritingProject; state: PlayState; onState: (state: PlayState) => void; onClose: () => void }) {
  const node = project.storyNodes.find((item) => item.id === state.nodeId);
  const choices = node ? visibleStoryChoices(node, state) : [];
  const speaker = project.entities.find((entity) => entity.id === node?.speakerEntityId)?.name;
  return <div className="writing-overlay playtest-overlay"><section className="playtest-panel" role="dialog" aria-modal="true" aria-label={tr("剧情试玩", "Narrative playtest")}>
    <header><div><Play size={17} /><span><strong>{tr("剧情试玩", "Narrative playtest")}</strong><small>{state.history.length} {tr("步", "steps")}</small></span></div><div><button type="button" onClick={() => onState(createPlayState(project))}><RefreshCw size={14} />{tr("重开", "Restart")}</button><button type="button" onClick={onClose} aria-label={tr("关闭剧情试玩", "Close narrative playtest")} title={tr("关闭", "Close")}><X size={15} /></button></div></header>
    <div className="playtest-body">
      <main>{node ? <>
        <span className={`playtest-node-type ${node.type}`}>{nodeTypeLabel(node.type)}</span><h2>{node.title}</h2>{speaker && <strong className="playtest-speaker">{speaker}</strong>}<div className="playtest-copy">{node.content || tr("这个节点没有正文。", "This node has no text.")}</div>
        <div className="playtest-choices">{choices.map((choice) => <button type="button" onClick={() => onState(followStoryChoice(state, node, choice))} key={choice.id}>{choice.label}</button>)}{choices.length === 0 && node.nextNodeId && <button type="button" onClick={() => onState(followStoryChoice(state, node))}>{tr("继续", "Continue")}</button>}{choices.length === 0 && !node.nextNodeId && <p>{node.type === "ending" ? tr("剧情结束", "The story ends here") : tr("没有可用路径", "No available path")}</p>}</div>
      </> : <div className="playtest-missing"><CircleAlert size={24} /><strong>{tr("目标节点不存在", "Target node is missing")}</strong></div>}</main>
      <aside><strong>{tr("变量监视器", "Variable monitor")}</strong>{Object.entries(state.variables).map(([name, value]) => <div key={name}><span>{name}</span><code>{String(value)}</code></div>)}{Object.keys(state.variables).length === 0 && <p>{tr("没有变量", "No variables")}</p>}</aside>
    </div>
  </section></div>;
}

function EmptyWritingState({ icon, title, detail, action, onAction }: { icon: React.ReactNode; title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div className="writing-empty-state"><span>{icon}</span><h2>{title}</h2><p>{detail}</p>{action && onAction && <button type="button" onClick={onAction}>{action}</button>}</div>;
}

function EntityIcon({ kind }: { kind: WritingEntityKind }) {
  if (kind === "character") return <UserRound size={14} />;
  if (kind === "location") return <MapPinned size={14} />;
  if (kind === "plot" || kind === "quest") return <GitBranch size={14} />;
  if (kind === "rule" || kind === "world") return <BookOpen size={14} />;
  if (kind === "faction") return <Network size={14} />;
  return <FileText size={14} />;
}

function parseMarkdownEntities(text: string): WritingEntity[] {
  const lines = text.split(/\r?\n/);
  const result: WritingEntity[] = [];
  let currentKind: WritingEntityKind | undefined;
  let currentName = "";
  let body: string[] = [];
  const flush = () => {
    if (!currentKind || !currentName) return;
    const entity = createWritingEntity(currentKind, currentName);
    entity.details = body.join("\n").trim();
    const summary = body.find((line) => /^(?:描述|摘要|性格|定位|核心)[:：]/.test(line.trim()));
    entity.summary = summary?.replace(/^[^:：]+[:：]\s*/, "") ?? "";
    result.push(entity);
  };
  for (const line of lines) {
    const group = line.match(/^##\s+(.+)/);
    if (group) {
      flush(); currentName = ""; body = []; currentKind = headingEntityKind(group[1]);
      continue;
    }
    const item = line.match(/^###\s+(.+)/);
    if (item && currentKind) {
      flush(); currentName = item[1].trim(); body = [];
      continue;
    }
    if (currentName) body.push(line);
  }
  flush();
  return result;
}

function mergeImportedEntities(current: WritingEntity[], incoming: WritingEntity[]) {
  const names = new Set(current.map((entity) => entity.name.toLocaleLowerCase()));
  const result = [...current];
  for (const entity of incoming) {
    const name = entity.name.toLocaleLowerCase();
    if (names.has(name)) continue;
    names.add(name);
    result.push(entity);
  }
  return result;
}

function headingEntityKind(value: string): WritingEntityKind | undefined {
  if (/人物|角色|character/i.test(value)) return "character";
  if (/地点|场景|空间|location/i.test(value)) return "location";
  if (/阵营|组织|faction/i.test(value)) return "faction";
  if (/物品|道具|item|object/i.test(value)) return "item";
  if (/世界|设定|world/i.test(value)) return "world";
  if (/剧情|大纲|plot|outline/i.test(value)) return "plot";
  if (/规则|文风|rule|style/i.test(value)) return "rule";
  if (/任务|quest/i.test(value)) return "quest";
  return undefined;
}

function entitySummaryPlaceholder(kind: WritingEntityKind) {
  if (kind === "character") return tr("欲望、矛盾、当前处境与辨识度", "Desire, contradiction, current situation, and distinctiveness");
  if (kind === "location") return tr("这里如何影响人物与事件", "How this place shapes characters and events");
  if (kind === "plot" || kind === "quest") return tr("目标、阻力、转折与代价", "Goal, resistance, turn, and cost");
  return tr("最重要、最容易被写错的一句话", "The one sentence that must stay consistent");
}

function entityDetailsPlaceholder(kind: WritingEntityKind) {
  if (kind === "character") return tr("外在行为、说话方式、秘密、关系、成长弧线、绝不会做的事…", "Behavior, voice, secrets, relationships, arc, and what they would never do…");
  if (kind === "location") return tr("空间结构、感官线索、社会用途、危险、可触发事件…", "Layout, sensory anchors, social function, dangers, and possible events…");
  if (kind === "rule") return tr("必须遵守的写作规则、例外和反例…", "Required writing rules, exceptions, and counterexamples…");
  return tr("写下事实、限制、变化条件和与其他设定的联系…", "Record facts, limits, change conditions, and links to other entries…");
}

function completionLabel(intent: CompletionIntent) {
  return ({ autocomplete: "补全", continue: "续写", rewrite: "改写", polish: "润色", expand: "扩写", shorten: "精简", dialogue: "对白", describe: "描写", entity: "设定补全", node: "节点补全", choices: "选项生成" } as const)[intent];
}

function completionLabelEn(intent: CompletionIntent) {
  return ({ autocomplete: "Complete", continue: "Continue", rewrite: "Rewrite", polish: "Polish", expand: "Expand", shorten: "Shorten", dialogue: "Dialogue", describe: "Describe", entity: "Complete entry", node: "Complete node", choices: "Generate choices" } as const)[intent];
}

function contextReasonLabel(reason: WritingContextBundle["items"][number]["reason"]) {
  return ({ selected: tr("手动选择", "Selected"), linked: tr("当前内容绑定", "Linked"), mentioned: tr("正文提及", "Mentioned"), related: tr("关系联动", "Related"), global: tr("全局规则", "Global"), neighbor: tr("相邻文稿", "Neighbor") } as const)[reason];
}

function documentKindLabel(kind: WritingDocumentKind) {
  return ({ chapter: tr("章节", "Chapter"), scene: tr("场景", "Scene"), outline: tr("大纲", "Outline"), note: tr("笔记", "Note") } as const)[kind];
}

function splitList(value: string) {
  return value.split(/[,，;；\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 40);
}

function toggleId(values: string[], id: string) {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}

function sanitizeVariableName(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z_]+/, "").slice(0, 80);
}

function fileStem(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 80) || "writing-project";
}

function projectSignature(project: WritingProject) {
  return JSON.stringify(project);
}

function emptyContext(): WritingContextBundle {
  return { text: "", items: [], entityIds: [], estimatedTokens: 0, usedChars: 0, budgetChars: 1 };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isCompactWritingViewport() {
  return window.matchMedia("(max-width: 600px)").matches;
}
