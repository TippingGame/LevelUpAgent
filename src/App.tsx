import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  AudioLines,
  Bot,
  BrainCircuit,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Code2,
  Command,
  Copy,
  Cpu,
  FileCode2,
  FileInput,
  ExternalLink,
  Flag,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitBranch,
  GitMerge,
  Hand,
  ImagePlus,
  KeyRound,
  Languages,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Network,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  Sparkles,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Timer,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { IconButton } from "./components/IconButton";
import { AttachmentChip } from "./components/AttachmentChip";
import { MediaAssetCard, MediaStudio } from "./components/MediaStudio";
import { DeclarativeLayout, type LayoutActions, type LayoutData } from "./components/DeclarativeLayout";
import packageMetadata from "../package.json";
import defaultLayoutJson from "../layouts/default.layout.json";
import {
  agentTurnStream,
  applyGitRollback,
  applyExternalConfigWrite,
  applyExternalPromptWrite,
  cancelAgentTurn,
  checkAppUpdate,
  changeGoalStatus,
  createGoal,
  deletePersistedThread,
  deleteApiKey,
  deleteImageAttachment,
  executeTool,
  fetchModels,
  getGitDiff,
  getGitStatus,
  getGoal,
  getDefaultWorkspace,
  getGatewayDiagnostics,
  getCustomInstructions,
  getProviderSettings,
  hasApiKey,
  importExternalConfig,
  importAttachments,
  installAppUpdate,
  isDesktop,
  deleteMcpServer,
  listMcpServers,
  listProviderHealth,
  listProviderRequests,
  previewExternalConfigWrite,
  previewExternalPromptWrite,
  previewGitRollback,
  listPersistedThreads,
  saveApiKey,
  saveCustomInstructions,
  savePersistedThread,
  saveProviderSettings,
  resetProviderHealth,
  rollbackExternalConfigWrite,
  rollbackExternalPromptWrite,
  scanExternalConfigs,
  scanSkills,
  selectWorkspace,
  setSkillEnabled,
  startMcpServer,
  stopMcpServer,
  upsertMcpServer,
  listThemes,
  loadTheme,
  loadThemeLayout,
  selectAndInstallTheme,
  uninstallTheme,
} from "./lib/bridge";
import {
  createThread,
  clearLegacyProfiles,
  clearLegacyThreads,
  loadActiveProfileId,
  loadActiveThreadId,
  loadHiddenProjectKeys,
  loadProfiles,
  loadActiveThemeId,
  loadPermissionLevel,
  loadPinnedThreadIds,
  loadThreads,
  message,
  saveProfiles,
  savePermissionLevel,
  savePinnedThreadIds,
  saveActiveProfileId,
  saveActiveThreadId,
  saveHiddenProjectKeys,
  saveThreads,
  saveActiveThemeId,
} from "./lib/storage";
import { getAppLocale, setAppLocale, tr, type AppLocale } from "./lib/i18n";
import { executeCallsWithParallelMedia } from "./lib/mediaConcurrency";
import { copyText } from "./lib/clipboard";
import type {
  AgentMessage,
  AgentMode,
  AgentThread,
  ConfigWritePreview,
  ConfigWriteResult,
  ExternalConfigCandidate,
  ExternalConfigTarget,
  GitDiff,
  GitFileChange,
  GitRollbackPreview,
  GitStatus,
  GoalState,
  GatewayDiagnostics,
  ImageAttachment,
  McpSecretValues,
  McpServerConfig,
  McpServerSnapshot,
  McpTransport,
  MediaAsset,
  ModelInfo,
  ModelProviderBrand,
  PendingApproval,
  PermissionLevel,
  ProviderProfile,
  ProviderHealth,
  ProviderRequestLog,
  ProviderProtocol,
  SkillInfo,
  ToolCall,
  ThemeManifest,
  LayoutDefinition,
  ResolvedLayout,
} from "./lib/types";
import "./App.css";

const READ_ONLY_TOOLS = new Set(["list_files", "read_file", "search_files", "read_skill", "get_goal", "update_goal", "check_media_jobs"]);
const RISKY_COMMAND_PATTERNS = [
  /\b(rm|rmdir|del|erase|remove-item|clear-content)\b/i,
  /\b(format|diskpart|shutdown|restart-computer|stop-computer|reboot|halt)\b/i,
  /\b(stop-process|taskkill|kill|pkill)\b/i,
  /\bgit\s+(reset\s+--hard|clean\b|restore\b|checkout\s+--|push\b|fetch\b|pull\b|clone\b|remote\b|submodule\b|rebase\b)/i,
  /\b(sudo|runas|invoke-expression|iex|start-process|reg(?:\.exe)?\s+(?:add|delete)|sc(?:\.exe)?\s+(?:create|delete|stop)|setx)\b/i,
  /\b(curl|wget|invoke-webrequest|invoke-restmethod|start-bitstransfer|certutil|ssh|scp|ftp|gh\b|az\b|aws\b|gcloud\b)/i,
  /\b(python|python3|node|ruby|perl|powershell|pwsh|cmd|bash|sh)\b[^\r\n]*(?:\s-c\b|\s-e\b|\/c\b|\/command\b)/i,
  /\b(npm|pnpm|yarn|bun|pip|pipx|cargo|gem|composer)\s+(install|add|remove|uninstall|publish|update)\b/i,
  /\b(docker|podman)\s+(system\s+prune|rm\b|rmi\b|volume\s+rm)\b/i,
  /(?:^|\s)(?:[a-z]:\\|\\\\|\/(?:etc|usr|var|home|root)\/|~\/)/i,
];
const MAX_TOOL_ROUNDS = 12;
const MAX_GOAL_ROUNDS = 48;
const LEVELUP_WEBSITE = "https://levelup.mom/";
const DEFAULT_LAYOUT: ResolvedLayout = {
  source: "default",
  definition: defaultLayoutJson as LayoutDefinition,
};

function commandNeedsAgentApproval(call: ToolCall) {
  const command = typeof call.arguments.command === "string" ? call.arguments.command.trim() : "";
  return !command || RISKY_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function toolNeedsApproval(call: ToolCall, level: PermissionLevel) {
  if (READ_ONLY_TOOLS.has(call.name) || level === "full") return false;
  if (level === "request") return true;
  if (call.name === "write_file" || call.name === "delegate_task") return false;
  if (call.name === "run_command") return commandNeedsAgentApproval(call);
  return true;
}

async function openLevelUpWebsite() {
  if (isDesktop()) {
    await openUrl(LEVELUP_WEBSITE);
    return;
  }
  window.open(LEVELUP_WEBSITE, "_blank", "noopener,noreferrer");
}

function useModalKeyboard(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )).filter((element) => element.offsetParent !== null);
    const frame = window.requestAnimationFrame(() => focusable()[0]?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
  return dialogRef;
}

function App() {
  const [locale, setLocale] = useState<AppLocale>(getAppLocale);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(loadProfiles);
  const [activeProfileId, setActiveProfileId] = useState(() => {
    const stored = loadProfiles();
    return loadActiveProfileId(stored);
  });
  const [threads, setThreads] = useState<AgentThread[]>(() => {
    const stored = loadThreads();
    return stored.length > 0 ? stored : [createThread()];
  });
  const threadsRef = useRef(threads);
  const profilesRef = useRef(profiles);
  const activeProfileIdRef = useRef(activeProfileId);
  const [activeThreadId, setActiveThreadId] = useState(() => loadActiveThreadId(threads));
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(() => new Set());
  const [hiddenProjectKeys, setHiddenProjectKeys] = useState<Set<string>>(loadHiddenProjectKeys);
  const [pinnedThreadIds, setPinnedThreadIds] = useState<Set<string>>(loadPinnedThreadIds);
  const [projectMenuKey, setProjectMenuKey] = useState<string | null>(null);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [mode, setMode] = useState<AgentMode>("agent");
  const [workspaceView, setWorkspaceView] = useState<"chat" | "media">("chat");
  const [mediaPendingCount, setMediaPendingCount] = useState(0);
  const [defaultWorkspace, setDefaultWorkspace] = useState<string>();
  const [mediaReferenceDrop, setMediaReferenceDrop] = useState<{ id: string; paths: string[] } | null>(null);
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>(loadPermissionLevel);
  const [draft, setDraft] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<ImageAttachment[]>([]);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [runningThreadIds, setRunningThreadIds] = useState<Set<string>>(() => new Set());
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApproval>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themesOpen, setThemesOpen] = useState(false);
  const [themes, setThemes] = useState<ThemeManifest[]>([]);
  const [activeThemeId, setActiveThemeId] = useState(loadActiveThemeId);
  const [activeThemeCss, setActiveThemeCss] = useState("");
  const [activeLayout, setActiveLayout] = useState<ResolvedLayout>(DEFAULT_LAYOUT);
  const [qq2007RightTab, setQq2007RightTab] = useState<"environment" | "friends">("friends");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [threadPendingDelete, setThreadPendingDelete] = useState<AgentThread | null>(null);
  const [renamingThread, setRenamingThread] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [mcpOpen, setMcpOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keyStatusLoaded, setKeyStatusLoaded] = useState(false);
  const [balanceDiagnostics, setBalanceDiagnostics] = useState<GatewayDiagnostics | null>(null);
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiff | null>(null);
  const [goalState, setGoalState] = useState<GoalState | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const runningThreadIdsRef = useRef<Set<string>>(new Set());
  const pendingApprovalsRef = useRef<Record<string, PendingApproval>>({});
  const operationIdsRef = useRef<Map<string, string>>(new Map());
  const runModesRef = useRef<Map<string, AgentMode>>(new Map());
  const activeThreadIdRef = useRef(activeThreadId);
  const workspaceViewRef = useRef(workspaceView);
  const draftAttachmentsRef = useRef(draftAttachments);
  const databaseReadyRef = useRef(false);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());

  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const activeThread =
    threads.find((thread) => thread.id === activeThreadId) ?? threads[0];
  activeThreadIdRef.current = activeThread.id;
  workspaceViewRef.current = workspaceView;
  const running = runningThreadIds.has(activeThread.id);
  const pending = pendingApprovals[activeThread.id] ?? null;
  const projectGroups = groupThreadsByWorkspace(threads, pinnedThreadIds, defaultWorkspace);
  const displayedProjectGroups = projectGroups.filter((project) => !project.workspace || !hiddenProjectKeys.has(project.key));
  const activeProjectKey = workspaceKey(activeThread.workspace);
  const activeUsesDefaultWorkspace = isDefaultWorkspace(activeThread.workspace, defaultWorkspace);
  const connectionReady = keyStatusLoaded
    && (keyConfigured || activeProfile.allowUnauthenticated)
    && Boolean(activeProfile.model.trim());
  const connectionNeedsSetup = keyStatusLoaded && !connectionReady;
  const normalizedSidebarQuery = sidebarQuery.trim().toLocaleLowerCase(locale);
  const visibleProjectGroups = normalizedSidebarQuery
    ? displayedProjectGroups
        .map((project) => {
          if (project.name.toLocaleLowerCase(locale).includes(normalizedSidebarQuery)) return project;
          return {
            ...project,
            threads: project.threads.filter((thread) => localizedThreadTitle(thread.title).toLocaleLowerCase(locale).includes(normalizedSidebarQuery)),
          };
        })
        .filter((project) => project.threads.length > 0)
    : displayedProjectGroups;
  const lastMessageLength =
    activeThread.messages[activeThread.messages.length - 1]?.content.length ?? 0;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let disposed = false;
    const initializeThemes = async () => {
      if (!isDesktop()) {
        if (activeThemeId !== "default") {
          saveActiveThemeId("default");
          setActiveThemeId("default");
        }
        return;
      }
      try {
        const installed = await listThemes();
        if (disposed) return;
        setThemes(installed);
        const selectedId = activeThemeId !== "default" && installed.some((theme) => theme.id === activeThemeId)
          ? activeThemeId
          : "default";
        if (selectedId !== activeThemeId) {
          saveActiveThemeId("default");
          setActiveThemeId("default");
        }
        const [theme, resolvedLayout] = await Promise.all([
          selectedId === "default" ? Promise.resolve(null) : loadTheme(selectedId),
          loadThemeLayout(selectedId),
        ]);
        if (!disposed) {
          setActiveThemeCss(theme?.css ?? "");
          setActiveLayout(resolvedLayout);
          if (resolvedLayout.warning) setNotice(resolvedLayout.warning);
        }
      } catch (error) {
        if (!disposed) {
          saveActiveThemeId("default");
          setActiveThemeId("default");
          setActiveThemeCss("");
          setActiveLayout(DEFAULT_LAYOUT);
          setNotice(`${tr("主题加载失败", "Could not load theme")}: ${errorText(error)}`);
        }
      }
    };
    void initializeThemes();
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.levelupTheme = activeThemeId;
    let style = document.getElementById("levelup-active-theme") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "levelup-active-theme";
      document.head.appendChild(style);
    }
    style.textContent = activeThemeCss;
  }, [activeThemeCss, activeThemeId]);

  useEffect(() => {
    if (!isDesktop()) return;
    void getCurrentWindow().setDecorations(activeLayout.definition.window?.decorations ?? true).catch((error) => {
      console.error("Could not update window decorations", error);
    });
  }, [activeLayout.definition.window?.decorations]);

  const activateTheme = async (themeId: string) => {
    if (themeId === "default") {
      const resolvedLayout = isDesktop() ? await loadThemeLayout("default") : DEFAULT_LAYOUT;
      saveActiveThemeId("default");
      setActiveThemeId("default");
      setActiveThemeCss("");
      setActiveLayout(resolvedLayout);
      return;
    }
    const [theme, resolvedLayout] = await Promise.all([loadTheme(themeId), loadThemeLayout(themeId)]);
    saveActiveThemeId(theme.id);
    setActiveThemeId(theme.id);
    setActiveThemeCss(theme.css);
    setActiveLayout(resolvedLayout);
    if (resolvedLayout.warning) setNotice(resolvedLayout.warning);
  };

  const installSelectedTheme = async () => {
    const installed = await selectAndInstallTheme();
    if (!installed) return;
    setThemes(await listThemes());
    await activateTheme(installed.id);
    setNotice(`${tr("主题已安装并启用", "Theme installed and activated")}: ${installed.name}`);
  };

  const removeTheme = async (themeId: string) => {
    if (themeId === activeThemeId) await activateTheme("default");
    await uninstallTheme(themeId);
    setThemes(await listThemes());
  };

  useEffect(() => {
    savePermissionLevel(permissionLevel);
  }, [permissionLevel]);

  useEffect(() => {
    saveHiddenProjectKeys(hiddenProjectKeys);
  }, [hiddenProjectKeys]);

  useEffect(() => {
    savePinnedThreadIds(pinnedThreadIds);
  }, [pinnedThreadIds]);

  const toggleLocale = () => {
    const next = locale === "zh-CN" ? "en-US" : "zh-CN";
    setAppLocale(next);
    setLocale(next);
  };

  useEffect(() => {
    threadsRef.current = threads;
    if (!isDesktop() || !databaseReadyRef.current) saveThreads(threads);
  }, [threads]);

  useEffect(() => {
    draftAttachmentsRef.current = draftAttachments;
  }, [draftAttachments]);

  useEffect(() => {
    if (activeThreadId && (!isDesktop() || databaseReadyRef.current)) saveActiveThreadId(activeThreadId);
  }, [activeThreadId]);

  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);

  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    const initializeDatabase = async () => {
      try {
        const [resolvedDefaultWorkspace, persisted] = await Promise.all([
          getDefaultWorkspace(),
          listPersistedThreads(),
        ]);
        if (disposed) return;
        if (!resolvedDefaultWorkspace) throw new Error("The temporary workspace is unavailable");
        setDefaultWorkspace(resolvedDefaultWorkspace);
        const sourceThreads = persisted.length > 0 ? persisted : threadsRef.current;
        const migratedThreadIds = new Set(
          sourceThreads.filter((thread) => !thread.workspace?.trim()).map((thread) => thread.id),
        );
        const hydratedThreads = sourceThreads.map((thread) => thread.workspace?.trim()
          ? thread
          : { ...thread, workspace: resolvedDefaultWorkspace });
        threadsRef.current = hydratedThreads;
        setThreads(hydratedThreads);
        setActiveThreadId((current) =>
          hydratedThreads.some((thread) => thread.id === current) ? current : loadActiveThreadId(hydratedThreads),
        );
        const threadsToPersist = persisted.length > 0
          ? hydratedThreads.filter((thread) => migratedThreadIds.has(thread.id))
          : hydratedThreads;
        for (const thread of threadsToPersist) await savePersistedThread(thread);
        const providerSettings = await getProviderSettings();
        if (disposed) return;
        if (providerSettings?.profiles.length) {
          profilesRef.current = providerSettings.profiles;
          activeProfileIdRef.current = providerSettings.activeProfileId;
          setProfiles(providerSettings.profiles);
          setActiveProfileId(providerSettings.activeProfileId);
        } else {
          await saveProviderSettings({
            profiles: profilesRef.current,
            activeProfileId: activeProfileIdRef.current,
          });
        }
        clearLegacyProfiles();
        clearLegacyThreads();
        databaseReadyRef.current = true;
      } catch (error) {
        if (!disposed) {
          setNotice(`${tr("会话数据库不可用", "Conversation database unavailable")}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    void initializeDatabase();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    setKeyStatusLoaded(false);
    setKeyConfigured(false);
    setBalanceDiagnostics(null);
    setBalanceError(null);
    hasApiKey(activeProfile.id)
      .then((configured) => {
        if (!disposed) {
          setKeyConfigured(configured);
          setKeyStatusLoaded(true);
        }
      })
      .catch(() => {
        if (!disposed) {
          setKeyConfigured(false);
          setKeyStatusLoaded(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [activeProfile.id]);

  const refreshBalance = useCallback(async () => {
    if (!isDesktop() || !keyConfigured) return;
    const profileId = activeProfile.id;
    setBalanceBusy(true);
    try {
      const diagnostics = await getGatewayDiagnostics(activeProfile);
      if (activeProfileIdRef.current !== profileId) return;
      setBalanceDiagnostics(diagnostics);
      setBalanceError(null);
    } catch (error) {
      if (activeProfileIdRef.current === profileId) setBalanceError(errorText(error));
    } finally {
      if (activeProfileIdRef.current === profileId) setBalanceBusy(false);
    }
  }, [activeProfile, keyConfigured]);

  useEffect(() => {
    if (!keyConfigured || !isDesktop()) {
      setBalanceBusy(false);
      return;
    }
    void refreshBalance();
    const interval = window.setInterval(() => void refreshBalance(), 60_000);
    return () => window.clearInterval(interval);
  }, [keyConfigured, refreshBalance]);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest(".model-switcher")) return;
      setProfileMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeMenu);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeMenu);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!projectMenuKey) return;
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest(".project-menu-control")) return;
      setProjectMenuKey(null);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeMenu);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeMenu);
    };
  }, [projectMenuKey]);

  useEffect(() => {
    if (!threadMenuOpen) return;
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest(".thread-menu-control")) return;
      setThreadMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeMenu);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeMenu);
    };
  }, [threadMenuOpen]);

  useEffect(() => {
    setThreadMenuOpen(false);
    setRenamingThread(false);
    setRenameDraft("");
  }, [activeThread.id]);

  useEffect(() => {
    if (!isDesktop()) {
      setGoalState(null);
      return;
    }
    let disposed = false;
    getGoal(activeThread.id)
      .then((goal) => {
        if (!disposed) setGoalState(goal);
      })
      .catch(() => {
        if (!disposed) setGoalState(null);
      });
    return () => { disposed = true; };
  }, [activeThread.id, activeThread.messages.length, running]);

  useEffect(() => {
    const workspace = activeThread.workspace;
    if (!workspace) {
      setGitStatus(null);
      return;
    }
    if (running) return;
    let disposed = false;
    getGitStatus(workspace)
      .then((status) => {
        if (!disposed) setGitStatus(status);
      })
      .catch(() => {
        if (!disposed) setGitStatus(null);
      });
    return () => {
      disposed = true;
    };
  }, [activeThread.workspace, running]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeThread.messages.length, lastMessageLength, running, pending]);

  useLayoutEffect(() => {
    if (workspaceView !== "chat") return;
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [workspaceView, activeThread.id]);

  const enqueuePersistence = (operation: () => Promise<unknown>) => {
    persistenceQueueRef.current = persistenceQueueRef.current
      .then(async () => {
        await operation();
      })
      .catch((error) => {
        setNotice(`${tr("保存失败", "Save failed")}: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const commitThread = (next: AgentThread, persist = true) => {
    const current = threadsRef.current;
    const updated = current.some((thread) => thread.id === next.id)
      ? current.map((thread) => (thread.id === next.id ? next : thread))
      : [next, ...current];
    threadsRef.current = updated;
    setThreads(updated);
    if (persist && isDesktop() && databaseReadyRef.current) {
      enqueuePersistence(() => savePersistedThread(next));
    }
  };

  const setThreadRunning = (threadId: string, value: boolean) => {
    const next = new Set(runningThreadIdsRef.current);
    if (value) next.add(threadId);
    else next.delete(threadId);
    runningThreadIdsRef.current = next;
    setRunningThreadIds(next);
  };

  const setThreadPending = (threadId: string, value: PendingApproval | null) => {
    const next = { ...pendingApprovalsRef.current };
    if (value) next[threadId] = value;
    else delete next[threadId];
    pendingApprovalsRef.current = next;
    setPendingApprovals(next);
  };

  const finishThreadRun = (threadId: string) => {
    operationIdsRef.current.delete(threadId);
    runModesRef.current.delete(threadId);
    setThreadRunning(threadId, false);
  };

  const beginThreadRename = () => {
    setRenameDraft(localizedThreadTitle(activeThread.title));
    setThreadMenuOpen(false);
    setRenamingThread(true);
  };

  const finishThreadRename = () => {
    const title = renameDraft.trim().slice(0, 80);
    setRenamingThread(false);
    if (!title || title === localizedThreadTitle(activeThread.title)) return;
    commitThread({ ...activeThread, title, updatedAt: Date.now() });
  };

  const expandProject = (projectKey: string) => {
    setCollapsedProjectKeys((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  };

  const revealProject = (projectKey: string) => {
    setHiddenProjectKeys((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  };

  const toggleProject = (projectKey: string) => {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  };

  const activateThread = (threadId: string) => {
    const thread = threadsRef.current.find((item) => item.id === threadId);
    if (!thread) return;
    setActiveThreadId(threadId);
    expandProject(workspaceKey(thread.workspace));
    setProfileMenuOpen(false);
    setProjectMenuKey(null);
    setWorkspaceView("chat");
  };

  const newThread = (workspace = activeThread?.workspace ?? defaultWorkspace) => {
    const next = createThread(workspace);
    revealProject(workspaceKey(workspace));
    commitThread(next);
    setActiveThreadId(next.id);
    expandProject(workspaceKey(workspace));
    setDraft("");
    for (const attachment of draftAttachments) void deleteImageAttachment(attachment.id).catch(() => undefined);
    setDraftAttachments([]);
    setWorkspaceView("chat");
  };

  const openProject = async () => {
    if (!isDesktop()) {
      setNotice(tr("请在桌面应用中选择本地项目", "Choose a local project in the desktop app"));
      return;
    }
    const workspace = await selectWorkspace();
    if (!workspace) return;
    const key = workspaceKey(workspace);
    revealProject(key);
    const existing = threadsRef.current
      .filter((thread) => workspaceKey(thread.workspace) === key)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (existing) activateThread(existing.id);
    else newThread(workspace);
  };

  const chooseWorkspace = async () => {
    if (!isDesktop()) {
      setNotice(tr("请在桌面应用中选择本地项目", "Choose a local project in the desktop app"));
      return;
    }
    const workspace = await selectWorkspace();
    if (!workspace) return;
    revealProject(workspaceKey(workspace));
    if (workspaceKey(workspace) === workspaceKey(activeThread.workspace)) return;
    if (activeThread.messages.length === 0) {
      commitThread({ ...activeThread, workspace, updatedAt: Date.now() });
      expandProject(workspaceKey(workspace));
      return;
    }
    newThread(workspace);
  };

  const removeProjectFromList = (projectKey: string) => {
    if (projectKey === workspaceKey() || projectKey === workspaceKey(defaultWorkspace)) return;
    const nextHidden = new Set(hiddenProjectKeys);
    nextHidden.add(projectKey);
    setHiddenProjectKeys(nextHidden);
    setProjectMenuKey(null);
    if (activeProjectKey !== projectKey) return;
    const fallback = [...threadsRef.current]
      .filter((thread) => {
        const key = workspaceKey(thread.workspace);
        return key !== projectKey && (!thread.workspace || !nextHidden.has(key));
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (fallback) {
      setActiveThreadId(fallback.id);
      expandProject(workspaceKey(fallback.workspace));
      return;
    }
    const next = createThread(defaultWorkspace);
    commitThread(next);
    setActiveThreadId(next.id);
  };

  const activateProfile = async (profileId: string) => {
    try {
      if (isDesktop() && databaseReadyRef.current) {
        await saveProviderSettings({ profiles: profilesRef.current, activeProfileId: profileId });
      } else {
        saveActiveProfileId(profileId);
      }
    } catch (error) {
      setNotice(`${tr("无法保存当前连接", "Could not save active connection")}: ${errorText(error)}`);
      return;
    }
    activeProfileIdRef.current = profileId;
    setActiveProfileId(profileId);
    setProfileMenuOpen(false);
    setKeyStatusLoaded(false);
    setKeyConfigured(await hasApiKey(profileId).catch(() => false));
    setKeyStatusLoaded(true);
  };

  const runAgent = async (
    thread: AgentThread,
    history: AgentMessage[],
    round = 0,
    runMode: AgentMode = mode,
    runPermission: PermissionLevel = permissionLevel,
    runStartedAt = Date.now(),
    runProfile: ProviderProfile = activeProfile,
    runFallbackProfiles: ProviderProfile[] = profiles.filter((profile) => profile.id !== activeProfile.id),
  ): Promise<void> => {
    const threadId = thread.id;
    const roundLimit = runMode === "goal" ? MAX_GOAL_ROUNDS : MAX_TOOL_ROUNDS;
    if (round >= roundLimit) {
      if (runMode === "goal" && isDesktop()) {
        try {
          const paused = await changeGoalStatus(thread.id, "pause");
          if (activeThreadIdRef.current === threadId) setGoalState(paused);
        } catch {
          // The Goal may already have reached a terminal state.
        }
      }
      const stopped = finalizeConversationMessages([
        ...history,
        message("assistant", runMode === "goal" ? tr("已达到本次连续执行上限，Goal 已暂停。检查结果后可继续。", "The continuous-run limit was reached and the Goal is paused. Review the result before continuing.") : tr("已达到本轮工具调用上限，请确认结果后继续。", "The tool-call limit was reached. Review the result before continuing."), {
          isError: true,
          ...assistantMessageIdentity(runProfile),
        }),
      ], runStartedAt);
      commitThread({ ...thread, messages: stopped, updatedAt: Date.now() });
      finishThreadRun(threadId);
      return;
    }

    setThreadRunning(threadId, true);
    runModesRef.current.set(threadId, runMode);
    const operationId = crypto.randomUUID();
    operationIdsRef.current.set(threadId, operationId);
    const streamingAssistant = message("assistant", "", assistantMessageIdentity(runProfile));
    let streamedContent = "";
    let frameId: number | null = null;
    commitThread({
      ...thread,
      messages: [...history, streamingAssistant],
      updatedAt: Date.now(),
    }, false);
    try {
      const result = await agentTurnStream(
        runProfile,
        history,
        runMode,
        thread.workspace,
        operationId,
        (delta) => {
          streamedContent += delta;
          if (frameId !== null) return;
          frameId = window.requestAnimationFrame(() => {
            frameId = null;
            commitThread({
              ...thread,
              messages: [
                ...history,
                { ...streamingAssistant, content: streamedContent },
              ],
              updatedAt: Date.now(),
            }, false);
          });
        },
        thread.id,
        runFallbackProfiles,
      );
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      if (operationIdsRef.current.get(threadId) === operationId) operationIdsRef.current.delete(threadId);
      const respondingProfile = result.providerId
        ? [runProfile, ...runFallbackProfiles].find((profile) => profile.id === result.providerId) ?? runProfile
        : runProfile;
      const assistant: AgentMessage = {
        ...streamingAssistant,
        content: result.content || streamedContent,
        toolCalls: result.toolCalls,
        requestId: result.requestId,
        ...assistantMessageIdentity(respondingProfile),
      };
      if (result.providerId && result.providerId !== runProfile.id) {
        const providerName = runFallbackProfiles.find((profile) => profile.id === result.providerId)?.name ?? result.providerId;
        setNotice(`${tr("主连接不可用，已安全切换到", "Primary connection unavailable; safely failed over to")} ${providerName}`);
      }
      let nextHistory = [...history, assistant];
      let nextThread: AgentThread = {
        ...thread,
        messages: nextHistory,
        updatedAt: Date.now(),
        inputTokens: thread.inputTokens + (result.inputTokens ?? 0),
        outputTokens: thread.outputTokens + (result.outputTokens ?? 0),
      };
      commitThread(nextThread);

      const automatic = result.toolCalls.filter((call) => !toolNeedsApproval(call, runPermission));
      const approvalRequired = result.toolCalls.filter((call) => toolNeedsApproval(call, runPermission));

      const automaticResults = await executeCallsWithParallelMedia(automatic, async (call) => (
        executeTool(call, thread.workspace ?? "", thread.id, runProfile, runFallbackProfiles)
      ));
      for (const { call, result: toolResult } of automaticResults) {
        nextHistory = [
          ...nextHistory,
          message("tool", toolResult.output, {
            toolCallId: call.id,
            isError: toolResult.isError,
          }),
        ];
      }
      nextThread = { ...nextThread, messages: nextHistory, updatedAt: Date.now() };
      commitThread(nextThread);

      if (approvalRequired.length > 0) {
        setThreadPending(threadId, {
          calls: approvalRequired,
          history: nextHistory,
          mode: runMode,
          permissionLevel: runPermission,
          startedAt: runStartedAt,
          nextRound: round + 1,
          profileId: runProfile.id,
        });
        finishThreadRun(threadId);
        return;
      }
      const currentGoal = runMode === "goal" && isDesktop()
        ? await getGoal(thread.id)
        : null;
      if (runMode === "goal" && activeThreadIdRef.current === threadId) setGoalState(currentGoal);
      const goalContinues = currentGoal?.status === "active" || currentGoal?.status === "auditing";
      if (automatic.length > 0) {
        if (runMode !== "goal" || goalContinues) {
          await runAgent(nextThread, nextHistory, round + 1, runMode, runPermission, runStartedAt, runProfile, runFallbackProfiles);
        } else {
          const completedHistory = finalizeConversationMessages(nextHistory, runStartedAt);
          commitThread({ ...nextThread, messages: completedHistory, updatedAt: Date.now() });
          finishThreadRun(threadId);
        }
      } else if (runMode === "goal" && goalContinues) {
        const continuation = message(
          "user",
          currentGoal?.status === "auditing"
            ? "Continue the completion audit. Verify every requirement against authoritative current-state evidence."
            : "Continue working toward the active Goal. Inspect current state and take the next concrete action.",
          { internal: true },
        );
        nextHistory = [...nextHistory, continuation];
        nextThread = { ...nextThread, messages: nextHistory, updatedAt: Date.now() };
        commitThread(nextThread);
        await runAgent(nextThread, nextHistory, round + 1, runMode, runPermission, runStartedAt, runProfile, runFallbackProfiles);
      } else {
        const completedHistory = finalizeConversationMessages(nextHistory, runStartedAt);
        commitThread({ ...nextThread, messages: completedHistory, updatedAt: Date.now() });
        finishThreadRun(threadId);
      }
    } catch (error) {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      if (operationIdsRef.current.get(threadId) === operationId) operationIdsRef.current.delete(threadId);
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("REQUEST_CANCELLED")) {
        const cancelledHistory = finalizeConversationMessages(streamedContent
          ? [...history, { ...streamingAssistant, content: streamedContent }]
          : history, runStartedAt);
        commitThread({
          ...thread,
          messages: cancelledHistory,
          updatedAt: Date.now(),
        });
        finishThreadRun(threadId);
        return;
      }
      const failure = message(
        "assistant",
        friendlyAgentError(reason),
        { isError: true, ...assistantMessageIdentity(runProfile) },
      );
      const failedHistory = finalizeConversationMessages([...history, failure], runStartedAt);
      commitThread({
        ...thread,
        messages: failedHistory,
        updatedAt: Date.now(),
      });
      finishThreadRun(threadId);
    }
  };

  const stopAgent = async (pauseGoal = true) => {
    const threadId = activeThread.id;
    const operationId = operationIdsRef.current.get(threadId);
    if (!operationId) {
      setNotice(tr("正在完成本地工具操作", "Finishing a local tool operation"));
      return;
    }
    await cancelAgentTurn(operationId);
    if (pauseGoal && runModesRef.current.get(threadId) === "goal" && goalState && (goalState.status === "active" || goalState.status === "auditing")) {
      try {
        setGoalState(await changeGoalStatus(threadId, "pause"));
      } catch {
        // The Goal may have transitioned while cancellation was in flight.
      }
    }
  };

  const send = async () => {
    const value = draft.trim();
    const thread = activeThread;
    if ((!value && draftAttachments.length === 0)
      || runningThreadIdsRef.current.has(thread.id)
      || pendingApprovalsRef.current[thread.id]) return;
    if (!connectionReady) {
      setSettingsOpen(true);
      return;
    }
    if (mode === "goal" && isDesktop()) {
      try {
        let goal = await getGoal(thread.id);
        if (!goal || goal.status === "completed" || goal.status === "cancelled") {
          goal = await createGoal(thread.id, value || tr("分析附件并完成请求", "Analyze the attachments and complete the request"));
        } else if (goal.status === "paused" || goal.status === "blocked") {
          goal = await changeGoalStatus(thread.id, "resume");
        }
        if (activeThreadIdRef.current === thread.id) setGoalState(goal);
      } catch (error) {
        setNotice(`${tr("无法启动 Goal", "Could not start Goal")}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const user = message("user", value, { attachments: draftAttachments });
    const title = thread.messages.length === 0 && isDefaultThreadTitle(thread.title)
      ? (value || draftAttachments[0]?.name || tr("附件任务", "Attachment task")).slice(0, 42)
      : thread.title;
    const next = {
      ...thread,
      title,
      messages: [...thread.messages, user],
      updatedAt: Date.now(),
    };
    setDraft("");
    setDraftAttachments([]);
    commitThread(next);
    const runProfile = activeProfile;
    const runFallbackProfiles = profiles.filter((profile) => profile.id !== runProfile.id);
    await runAgent(next, next.messages, 0, mode, permissionLevel, Date.now(), runProfile, runFallbackProfiles);
  };

  const addDroppedAttachments = async (paths: string[]) => {
    setFileDragActive(false);
    if (running || pending) {
      setNotice(tr("当前任务运行中，暂时不能添加附件", "Attachments cannot be added while the task is running"));
      return;
    }
    const remaining = Math.max(0, 12 - draftAttachmentsRef.current.length);
    if (remaining === 0) {
      setNotice(tr("每条消息最多添加 12 个附件", "Each message supports up to 12 attachments"));
      return;
    }
    try {
      const selected = await importAttachments(paths.slice(0, remaining));
      setDraftAttachments((current) => [...current, ...selected].slice(0, 12));
    } catch (error) {
      setNotice(`${tr("无法添加附件", "Could not add attachment")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setFileDragActive(true);
        } else if (event.payload.type === "leave") {
          setFileDragActive(false);
        } else {
          setFileDragActive(false);
          if (workspaceViewRef.current === "media") {
            setMediaReferenceDrop({ id: crypto.randomUUID(), paths: event.payload.paths });
          } else {
            void addDroppedAttachments(event.payload.paths);
          }
        }
      }))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [running, pending]);

  const removeDraftImage = async (attachment: ImageAttachment) => {
    setDraftAttachments((current) => current.filter((item) => item.id !== attachment.id));
    await deleteImageAttachment(attachment.id).catch(() => undefined);
  };

  const resolvePending = async (approved: boolean) => {
    const thread = activeThread;
    const approval = pendingApprovalsRef.current[thread.id];
    if (!approval) return;
    const runProfile = profilesRef.current.find((profile) => profile.id === approval.profileId) ?? activeProfile;
    const runFallbackProfiles = profilesRef.current.filter((profile) => profile.id !== runProfile.id);
    setThreadRunning(thread.id, true);
    setThreadPending(thread.id, null);
    try {
      let history = approval.history;
      const resolved = approved
        ? await executeCallsWithParallelMedia(approval.calls, async (call) => (
            executeTool(call, thread.workspace ?? "", thread.id, runProfile, runFallbackProfiles)
          ))
        : approval.calls.map((call) => ({ call, result: { output: "User denied this tool call", isError: true } }));
      for (const { call, result } of resolved) {
        history = [
          ...history,
          message("tool", result.output, {
            toolCallId: call.id,
            isError: result.isError,
          }),
        ];
      }
      const next = { ...thread, messages: history, updatedAt: Date.now() };
      commitThread(next);
      await runAgent(
        next,
        history,
        approval.nextRound,
        approval.mode,
        approval.permissionLevel,
        approval.startedAt,
        runProfile,
        runFallbackProfiles,
      );
    } catch (error) {
      const failure = message("assistant", errorText(error), {
        isError: true,
        ...assistantMessageIdentity(runProfile),
      });
      const failedHistory = finalizeConversationMessages([...approval.history, failure], approval.startedAt);
      commitThread({ ...thread, messages: failedHistory, updatedAt: Date.now() });
      finishThreadRun(thread.id);
    }
  };

  const togglePinnedThread = (threadId: string) => {
    setPinnedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  const requestDeleteThread = (threadId: string) => {
    if (runningThreadIdsRef.current.has(threadId) || pendingApprovalsRef.current[threadId]) {
      setNotice(tr("请先停止该会话或处理待批准操作", "Stop the conversation or resolve its pending approval first"));
      return;
    }
    const thread = threadsRef.current.find((item) => item.id === threadId);
    if (thread) setThreadPendingDelete(thread);
  };

  const deleteThread = (threadId: string) => {
    if (runningThreadIdsRef.current.has(threadId) || pendingApprovalsRef.current[threadId]) return;
    const removed = threadsRef.current.find((thread) => thread.id === threadId);
    const remaining = threadsRef.current.filter((thread) => thread.id !== threadId);
    const nextThreads = remaining.length > 0 ? remaining : [createThread(defaultWorkspace)];
    threadsRef.current = nextThreads;
    setThreads(nextThreads);
    setThreadPendingDelete(null);
    setPinnedThreadIds((current) => {
      if (!current.has(threadId)) return current;
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
    if (threadId === activeThreadId) {
      const sameProject = removed
        ? [...remaining]
            .filter((thread) => workspaceKey(thread.workspace) === workspaceKey(removed.workspace))
            .sort((left, right) => right.updatedAt - left.updatedAt)[0]
        : undefined;
      setActiveThreadId((sameProject ?? [...nextThreads].sort((left, right) => right.updatedAt - left.updatedAt)[0]).id);
    }
    if (isDesktop() && databaseReadyRef.current) {
      enqueuePersistence(async () => {
        await deletePersistedThread(threadId);
        if (remaining.length === 0) await savePersistedThread(nextThreads[0]);
      });
    }
  };

  const saveProfile = async (profile: ProviderProfile, apiKey: string) => {
    if (apiKey.trim()) await saveApiKey(profile.id, apiKey);
    const updated = profiles.some((item) => item.id === profile.id)
      ? profiles.map((item) => (item.id === profile.id ? profile : item))
      : [...profiles, profile];
    if (isDesktop() && databaseReadyRef.current) {
      await saveProviderSettings({ profiles: updated, activeProfileId: profile.id });
    } else {
      saveProfiles(updated);
      saveActiveProfileId(profile.id);
    }
    profilesRef.current = updated;
    activeProfileIdRef.current = profile.id;
    setProfiles(updated);
    setActiveProfileId(profile.id);
    setKeyConfigured(await hasApiKey(profile.id));
    setKeyStatusLoaded(true);
    setSettingsOpen(false);
  };

  const removeProfile = async (profileId: string) => {
    if (profiles.length <= 1) return;
    const updated = profiles.filter((profile) => profile.id !== profileId);
    const nextActiveProfileId = activeProfileId === profileId ? updated[0].id : activeProfileId;
    if (isDesktop() && databaseReadyRef.current) {
      await saveProviderSettings({ profiles: updated, activeProfileId: nextActiveProfileId });
    } else {
      saveProfiles(updated);
      saveActiveProfileId(nextActiveProfileId);
    }
    profilesRef.current = updated;
    activeProfileIdRef.current = nextActiveProfileId;
    setProfiles(updated);
    if (activeProfileId === profileId) {
      setActiveProfileId(nextActiveProfileId);
      setKeyStatusLoaded(false);
      setKeyConfigured(await hasApiKey(updated[0].id));
      setKeyStatusLoaded(true);
    }
    await deleteApiKey(profileId).catch((error) => {
      setNotice(`${tr("连接已删除，但系统凭据清理失败", "Connection removed, but credential cleanup failed")}: ${errorText(error)}`);
    });
  };

  const controlGoal = async (action: "pause" | "resume" | "cancel") => {
    if (!goalState || !isDesktop()) return;
    try {
      if ((action === "pause" || action === "cancel") && running) {
        await stopAgent(false);
      }
      const nextGoal = await changeGoalStatus(activeThread.id, action);
      setGoalState(nextGoal);
      if (action === "resume") {
        setMode("goal");
        const continuation = message("user", "Resume the active Goal from persisted state and take the next concrete action.", { internal: true });
        const nextThread = {
          ...activeThread,
          messages: [...activeThread.messages, continuation],
          updatedAt: Date.now(),
        };
        commitThread(nextThread);
        await runAgent(nextThread, nextThread.messages, 0, "goal", permissionLevel);
      }
    } catch (error) {
      setNotice(`${tr("Goal 操作失败", "Goal action failed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const openGitDiff = async (change: GitFileChange) => {
    if (!activeThread.workspace) return;
    try {
      const staged = change.worktreeStatus === " " && change.indexStatus !== " ";
      setGitDiff(await getGitDiff(activeThread.workspace, change.path, staged));
    } catch (error) {
      setNotice(`${tr("无法读取变更", "Could not read changes")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const gitRollbackApplied = async (path: string) => {
    setGitDiff(null);
    if (activeThread.workspace) {
      setGitStatus(await getGitStatus(activeThread.workspace).catch(() => null));
    }
    setNotice(`${tr("已撤销本地变更", "Local change rolled back")}: ${path}`);
  };

  const coinBalance = gatewayBalance(balanceDiagnostics);
  const balanceLabel = coinBalance == null
    ? balanceBusy ? "···" : "—"
    : formatCoinBalance(coinBalance, locale);
  const balanceHint = balanceError
    ? `${tr("余额读取失败", "Balance unavailable")}: ${balanceError}`
    : !keyConfigured
      ? activeProfile.allowUnauthenticated
        ? tr("无密钥兼容连接不提供余额查询", "Balance lookup is unavailable for a keyless compatible connection")
        : tr("请先配置当前连接的 API Key", "Configure an API key for this connection")
      : tr("点击刷新，余额每 60 秒自动更新", "Click to refresh; updates automatically every 60 seconds");
  const qq2007Title = localizedThreadTitle(activeThread.title);

  const sidebarSlot = (
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="brand" type="button" title={tr("访问 LevelUpAPI 官网", "Visit LevelUpAPI")} onClick={() => void openLevelUpWebsite()}>
            <span className="brand-mark"><img src="/logo.png" alt="" /></span>
            <span className="brand-copy"><strong>LevelUpAgent</strong><small>v{packageMetadata.version}</small></span>
          </button>
          <IconButton
            className="sidebar-search-toggle"
            label={tr("搜索会话", "Search conversations")}
            aria-expanded={sidebarSearchOpen}
            onClick={() => {
              setSidebarSearchOpen((open) => !open);
              if (sidebarSearchOpen) setSidebarQuery("");
            }}
          >
            <Search size={16} />
          </IconButton>
        </div>

        <div className="sidebar-service-row">
          <button
            className={`balance-pill ${balanceBusy ? "loading" : ""} ${balanceError ? "error" : ""}`}
            type="button"
            aria-label={`${tr("LevelUpAPI 余额", "LevelUpAPI balance")}: ${balanceLabel} coins`}
            title={balanceHint}
            disabled={!keyConfigured || balanceBusy}
            onClick={() => void refreshBalance()}
          >
            <span className="coin-glyph" aria-hidden="true" />
            <strong>{balanceLabel}</strong>
            <span>coins</span>
          </button>
          <button className="levelup-quick-link" type="button" onClick={() => void openLevelUpWebsite()} title={LEVELUP_WEBSITE}>
            <ExternalLink size={12} />
            <span>levelup.mom</span>
          </button>
        </div>

        <div className="sidebar-primary-actions">
          <button className="new-task-button" onClick={() => newThread()}>
            <Plus size={16} />
            {tr("新会话", "New conversation")}
          </button>
          <IconButton className="open-project-button" label={tr("打开项目", "Open project")} onClick={() => void openProject()}>
            <FolderPlus size={17} />
          </IconButton>
        </div>

        <button
          className={`media-nav-button${workspaceView === "media" ? " active" : ""}`}
          type="button"
          aria-current={workspaceView === "media" ? "page" : undefined}
          onClick={() => {
            setWorkspaceView("media");
            setProfileMenuOpen(false);
            setProjectMenuKey(null);
          }}
        >
          <ImagePlus size={16} />
          <span><strong>{tr("创作空间", "Media Studio")}</strong><small>{mediaPendingCount > 0 ? tr(`${mediaPendingCount} 个结果正在后台生成`, `${mediaPendingCount} outputs generating`) : tr("图片 · 视频 · 语音", "Images · Video · Speech")}</small></span>
          {mediaPendingCount > 0 ? <span className="media-nav-progress" title={tr(`${mediaPendingCount} 个结果正在生成`, `${mediaPendingCount} outputs generating`)}><LoaderCircle className="spin" size={12} /><b>{mediaPendingCount}</b></span> : <Sparkles size={14} />}
        </button>

        {sidebarSearchOpen && (
          <div className="sidebar-search">
            <Search size={14} />
            <input
              autoFocus
              value={sidebarQuery}
              onChange={(event) => setSidebarQuery(event.target.value)}
              placeholder={tr("搜索项目或会话", "Search projects or conversations")}
            />
            {sidebarQuery && <button aria-label={tr("清除搜索", "Clear search")} onClick={() => setSidebarQuery("")}><X size={13} /></button>}
          </div>
        )}

        <div className="sidebar-section-heading">
          <span>{tr("项目", "Projects")}</span>
          <small>{displayedProjectGroups.filter((project) => project.workspace).length}</small>
        </div>
        <nav className="project-list" aria-label={tr("项目与会话", "Projects and conversations")}>
          {visibleProjectGroups.map((project) => {
            const collapsed = !normalizedSidebarQuery && collapsedProjectKeys.has(project.key);
            const active = project.key === activeProjectKey;
            return (
              <section className={`project-group ${active ? "active" : ""}`} key={project.key}>
                <div className="project-row">
                  <button
                    className="project-toggle"
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? tr("展开项目", "Expand project") : tr("折叠项目", "Collapse project")} ${project.name}`}
                    title={project.workspace ?? tr("尚未选择工作区", "No workspace selected")}
                    onClick={() => toggleProject(project.key)}
                  >
                    <ChevronRight className="project-chevron" size={14} />
                    {active ? <FolderOpen size={16} /> : <Folder size={16} />}
                    <span className="project-meta">
                      <strong>{project.name}</strong>
                      <small>{project.threads.length} {tr("个会话", "conversations")}</small>
                    </span>
                  </button>
                  {project.workspace && !isDefaultWorkspace(project.workspace, defaultWorkspace) && (
                    <div className="project-menu-control">
                      <IconButton
                        className="project-menu-trigger"
                        label={`${tr("项目操作", "Project actions")} ${project.name}`}
                        aria-expanded={projectMenuKey === project.key}
                        onClick={() => setProjectMenuKey((current) => current === project.key ? null : project.key)}
                      >
                        <MoreHorizontal size={15} />
                      </IconButton>
                      {projectMenuKey === project.key && (
                        <div className="project-menu-popover" role="menu" aria-label={`${tr("项目操作", "Project actions")} ${project.name}`}>
                          <button type="button" role="menuitem" onClick={() => removeProjectFromList(project.key)}>
                            <FolderMinus size={14} />
                            <span>{tr("从列表移除", "Remove from list")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <IconButton className="project-add-thread" label={`${tr("在项目中新建会话", "New conversation in")} ${project.name}`} onClick={() => newThread(project.workspace)}>
                    <Plus size={14} />
                  </IconButton>
                </div>
                {!collapsed && (
                  <div className="project-threads">
                    {project.threads.map((thread) => (
                      <div className={`thread-row ${thread.id === activeThread.id ? "active" : ""}`} key={thread.id}>
                        <button
                          aria-label={`${tr("打开任务", "Open task")} ${localizedThreadTitle(thread.title)}`}
                          title={localizedThreadTitle(thread.title)}
                          onClick={() => activateThread(thread.id)}
                        >
                          {pendingApprovals[thread.id]
                            ? <ShieldCheck size={14} />
                            : runningThreadIds.has(thread.id)
                              ? <Activity className="spin" size={14} />
                              : <MessageSquareText size={14} />}
                          <span>{localizedThreadTitle(thread.title)}</span>
                        </button>
                        <IconButton
                          className={`thread-pin-button${pinnedThreadIds.has(thread.id) ? " pinned" : ""}`}
                          label={pinnedThreadIds.has(thread.id) ? tr("取消置顶会话", "Unpin conversation") : tr("置顶会话", "Pin conversation")}
                          aria-pressed={pinnedThreadIds.has(thread.id)}
                          onClick={() => togglePinnedThread(thread.id)}
                        >
                          {pinnedThreadIds.has(thread.id) ? <PinOff size={13} /> : <Pin size={13} />}
                        </IconButton>
                        <IconButton
                          label={tr("删除会话", "Delete conversation")}
                          disabled={runningThreadIds.has(thread.id) || Boolean(pendingApprovals[thread.id])}
                          onClick={() => requestDeleteThread(thread.id)}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {visibleProjectGroups.length === 0 && (
            <div className="sidebar-empty-search">{tr("没有匹配的项目或会话", "No matching projects or conversations")}</div>
          )}
        </nav>

        <div className="sidebar-footer">
          <button className={`account-button${connectionNeedsSetup ? " needs-setup" : ""}`} aria-label={connectionNeedsSetup ? tr("新增模型连接", "Add a model connection") : `${tr("模型连接", "Model connection")}: ${activeProfile.name}, ${connectionReady ? tr("已连接", "connected") : tr("检查中", "checking")}`} onClick={() => setSettingsOpen(true)}>
            {connectionNeedsSetup ? <CircleAlert size={15} /> : <span className={`connection-dot${connectionReady ? " online" : ""}`} />}
            <span>
              <strong>{connectionNeedsSetup ? tr("新增模型连接", "Add model connection") : activeProfile.name}</strong>
              <small>{connectionNeedsSetup ? tr("点击配置 API Key 和模型", "Configure API key and model") : connectionReady ? tr("已连接", "Connected") : tr("检查中", "Checking")}</small>
            </span>
            <Settings2 size={15} />
          </button>
        </div>
      </aside>
  );

  const mediaStudioSlot = (
    <MediaStudio
        active={workspaceView === "media"}
        locale={locale}
        dropActive={workspaceView === "media" && fileDragActive}
        referenceDrop={mediaReferenceDrop}
        onReferenceDropHandled={(id) => setMediaReferenceDrop((current) => current?.id === id ? null : current)}
        onConfigureConnection={() => setSettingsOpen(true)}
        onPendingCountChange={setMediaPendingCount}
    />
  );

  const workspaceSlot = workspaceView === "chat" ? (
      <main
        className={`workspace-shell${fileDragActive ? " file-drag-active" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setFileDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setFileDragActive(false);
        }}
      >
        {fileDragActive && (
          <div className="file-drop-overlay" role="status" aria-live="polite">
            <span><FileInput size={28} /></span>
            <strong>{tr("松手即可添加", "Drop to add")}</strong>
            <small>{tr("支持图片、PDF、Office、文本和代码文件", "Images, PDF, Office, text, and code files are supported")}</small>
          </div>
        )}
        <header className="topbar" data-tauri-drag-region>
          <div className="task-heading">
            <Folder size={15} />
            {renamingThread ? (
              <input
                className="thread-title-input"
                autoFocus
                value={renameDraft}
                maxLength={80}
                aria-label={tr("会话名称", "Conversation name")}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={finishThreadRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setRenamingThread(false);
                    setRenameDraft("");
                  }
                }}
              />
            ) : (
              <strong>{localizedThreadTitle(activeThread.title)}</strong>
            )}
            <div className="thread-menu-control">
              <IconButton
                className="thread-menu-trigger"
                label={tr("会话操作", "Conversation actions")}
                aria-expanded={threadMenuOpen}
                onClick={() => setThreadMenuOpen((open) => !open)}
              >
                <MoreHorizontal size={17} />
              </IconButton>
              {threadMenuOpen && (
                <div className="thread-menu-popover" role="menu" aria-label={tr("会话操作", "Conversation actions")}>
                  <button role="menuitem" onClick={beginThreadRename}>
                    <Pencil size={14} />
                    <span>{tr("重命名会话", "Rename conversation")}</span>
                  </button>
                </div>
              )}
            </div>
            <span>{activeUsesDefaultWorkspace
              ? tr("临时工作区", "Temporary workspace")
              : activeThread.workspace ? shortPath(activeThread.workspace) : tr("无项目", "No project")}</span>
          </div>
          <div className="topbar-actions">
            <IconButton label={tr("切换到 English", "Switch to 中文")} onClick={toggleLocale}>
              <Languages size={17} />
            </IconButton>
            <IconButton
              label={rightPanelOpen ? tr("收起详情", "Hide details") : tr("展开详情", "Show details")}
              aria-expanded={rightPanelOpen}
              onClick={() => setRightPanelOpen((value) => !value)}
            >
              {rightPanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </IconButton>
          </div>
        </header>

        <section className="conversation">
          {activeThread.messages.length === 0 ? (
            <EmptyState
              workspace={activeThread.workspace}
              temporaryWorkspace={activeUsesDefaultWorkspace}
              connectionNeedsSetup={connectionNeedsSetup}
              onChooseWorkspace={chooseWorkspace}
              onConfigureConnection={() => setSettingsOpen(true)}
            />
          ) : (
            <div className="message-stream">
              {groupConversationMessages(activeThread.messages.filter((item) => !item.internal)).map((block) => block.kind === "user" ? (
                <MessageRow key={block.item.id} item={block.item} />
              ) : (
                <AssistantMessageGroup key={block.items[0]?.id ?? "assistant"} items={block.items} pending={pending} fallbackProfile={activeProfile} />
              ))}
              {running && <ThinkingRow />}
              <div ref={endRef} />
            </div>
          )}
        </section>

        {pending && (
          <div className="approval-bar">
            <div className="approval-icon"><ShieldCheck size={18} /></div>
            <div>
              <strong>{tr("等待批准", "Waiting for approval")}</strong>
              <span>{pending.calls.map(toolLabel).join("、")}</span>
            </div>
            <button className="secondary-button" onClick={() => resolvePending(false)}>{tr("拒绝", "Deny")}</button>
            <button className="primary-button" onClick={() => resolvePending(true)}>
              <Check size={15} /> {tr("批准并运行", "Approve and run")}
            </button>
          </div>
        )}

        <Composer
          draft={draft}
          attachments={draftAttachments}
          mode={mode}
          permissionLevel={permissionLevel}
          running={running}
          disabled={Boolean(pending)}
          modelMenuOpen={profileMenuOpen}
          modelControl={(
            <div className="model-switcher composer-model-switcher">
              <button
                className={`model-pill${connectionNeedsSetup ? " needs-setup" : ""}`}
                aria-label={connectionNeedsSetup ? tr("尚未配置模型，新增连接", "No model configured; add connection") : `${tr("当前模型", "Current model")} ${activeProfile.model}`}
                aria-expanded={!connectionNeedsSetup && profileMenuOpen}
                onClick={() => {
                  if (connectionNeedsSetup) setSettingsOpen(true);
                  else setProfileMenuOpen((open) => !open);
                }}
              >
                {connectionNeedsSetup ? <CircleAlert size={14} /> : <Cpu size={14} />}
                <span>{connectionNeedsSetup ? tr("新增连接", "Add connection") : activeProfile.model}</span>
                {connectionNeedsSetup ? <Plus size={13} /> : <ChevronDown size={13} />}
              </button>
              {!connectionNeedsSetup && profileMenuOpen && (
                <div className="model-menu" role="menu" aria-label={tr("快速切换模型连接", "Quick model connection switcher")}>
                  {[...profiles].sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name)).map((profile) => (
                    <button role="menuitemradio" aria-checked={profile.id === activeProfile.id} className={profile.id === activeProfile.id ? "active" : ""} key={profile.id} onClick={() => activateProfile(profile.id)}>
                      <span className="model-menu-check">{profile.id === activeProfile.id ? <Check size={13} /> : null}</span>
                      <span><strong>{profile.name}</strong><small>{profile.model} · P{profile.priority}</small></span>
                    </button>
                  ))}
                  <button className="model-menu-settings" role="menuitem" onClick={() => { setProfileMenuOpen(false); setSettingsOpen(true); }}><Settings2 size={13} /><span>{tr("管理模型连接", "Manage connections")}</span></button>
                </div>
              )}
            </div>
          )}
          onDraftChange={setDraft}
          onRemoveAttachment={removeDraftImage}
          onModeChange={setMode}
          onPermissionChange={setPermissionLevel}
          onSend={send}
          onStop={stopAgent}
        />
      </main>
  ) : null;

  const inspectorSlot = workspaceView === "chat" && rightPanelOpen ? (
    <Inspector
      profile={activeProfile}
      thread={activeThread}
      mode={mode}
      permissionLevel={permissionLevel}
      keyConfigured={connectionReady}
      gitStatus={gitStatus}
      goal={goalState}
      onWorkspace={chooseWorkspace}
      onSettings={() => setSettingsOpen(true)}
      onDiff={openGitDiff}
      onGoalAction={controlGoal}
    />
  ) : null;

  const qq2007RightPanelSlot = workspaceView === "chat" && rightPanelOpen ? (
    <QQ2007RightPanel
      activeTab={qq2007RightTab}
      modelName={activeProfile.model || activeProfile.name}
      onTabChange={setQq2007RightTab}
    >
      {inspectorSlot}
    </QQ2007RightPanel>
  ) : null;

  const overlays = (
    <>
      {settingsOpen && (
        <ConnectionDialog
          profiles={profiles}
          profile={activeProfile}
          keyConfigured={keyConfigured}
          onClose={() => setSettingsOpen(false)}
          onOpenMcp={() => {
            setSettingsOpen(false);
            setMcpOpen(true);
          }}
          onOpenSkills={() => {
            setSettingsOpen(false);
            setSkillsOpen(true);
          }}
          onOpenInstructions={() => {
            setSettingsOpen(false);
            setInstructionsOpen(true);
          }}
          onOpenLogs={() => {
            setSettingsOpen(false);
            setLogsOpen(true);
          }}
          onOpenThemes={() => {
            setSettingsOpen(false);
            setThemesOpen(true);
          }}
          onSave={saveProfile}
          onRemove={removeProfile}
          onDeleteKey={async (profileId) => {
            await deleteApiKey(profileId);
            if (profileId === activeProfile.id) {
              setKeyConfigured(false);
              setKeyStatusLoaded(true);
            }
          }}
        />
      )}

      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
      {skillsOpen && (
        <SkillsDialog
          workspace={activeThread.workspace}
          onClose={() => setSkillsOpen(false)}
        />
      )}
      {instructionsOpen && <InstructionsDialog onClose={() => setInstructionsOpen(false)} />}
      {logsOpen && <RequestLogsDialog profiles={profiles} onClose={() => setLogsOpen(false)} />}
      {themesOpen && (
        <ThemeDialog
          themes={themes}
          activeThemeId={activeThemeId}
          onActivate={activateTheme}
          onInstall={installSelectedTheme}
          onUninstall={removeTheme}
          onClose={() => setThemesOpen(false)}
        />
      )}

      {threadPendingDelete && (
        <DeleteThreadDialog
          thread={threadPendingDelete}
          onClose={() => setThreadPendingDelete(null)}
          onConfirm={() => deleteThread(threadPendingDelete.id)}
        />
      )}

      {gitDiff && activeThread.workspace && (
        <DiffDialog
          diff={gitDiff}
          workspace={activeThread.workspace}
          onApplied={gitRollbackApplied}
          onClose={() => setGitDiff(null)}
        />
      )}

      {notice && (
        <button className="toast" onClick={() => setNotice(null)}>
          {notice}<X size={14} />
        </button>
      )}
    </>
  );

  const layoutData: LayoutData = {
    app: { name: "LevelUpAgent", version: packageMetadata.version, locale },
    view: { current: workspaceView, detailsOpen: rightPanelOpen },
    thread: {
      id: activeThread.id,
      title: localizedThreadTitle(activeThread.title),
      workspace: activeThread.workspace ?? "",
      messageCount: activeThread.messages.filter((item) => !item.internal).length,
      running,
      pendingApproval: Boolean(pending),
    },
    profile: {
      id: activeProfile.id,
      name: activeProfile.name,
      model: activeProfile.model,
      connected: connectionReady,
    },
    agent: { mode, permission: permissionLevel },
    balance: { label: balanceLabel, loading: balanceBusy, error: balanceError ?? "" },
    workspace: { temporary: activeUsesDefaultWorkspace, path: activeThread.workspace ?? "" },
    projects: displayedProjectGroups.map((project) => ({
      id: project.key,
      name: project.name,
      workspace: project.workspace ?? "",
      threadCount: project.threads.length,
    })),
    threads: threads.map((thread) => ({
      id: thread.id,
      title: localizedThreadTitle(thread.title),
      workspace: thread.workspace ?? "",
      active: thread.id === activeThread.id,
      running: runningThreadIds.has(thread.id),
      pendingApproval: Boolean(pendingApprovals[thread.id]),
    })),
    git: { branch: gitStatus?.branch ?? "", changedFiles: gitStatus?.changes.length ?? 0 },
    goal: { status: goalState?.status ?? "none" },
  };

  const layoutActions: LayoutActions = {
    "thread.new": (args) => newThread(typeof args.workspace === "string" ? args.workspace : undefined),
    "thread.activate": (args) => {
      if (typeof args.threadId === "string" && threads.some((thread) => thread.id === args.threadId)) {
        activateThread(args.threadId);
      }
    },
    "project.open": () => { void openProject(); },
    "view.chat": () => setWorkspaceView("chat"),
    "view.media": () => setWorkspaceView("media"),
    "panel.toggle": () => setRightPanelOpen((value) => !value),
    "dialog.settings": () => setSettingsOpen(true),
    "dialog.themes": () => setThemesOpen(true),
    "dialog.extensions": () => setMcpOpen(true),
    "dialog.skills": () => setSkillsOpen(true),
    "dialog.logs": () => setLogsOpen(true),
    "app.website": () => { void openLevelUpWebsite(); },
    "app.locale.toggle": toggleLocale,
    "balance.refresh": () => { void refreshBalance(); },
    "window.minimize": () => { if (isDesktop()) void getCurrentWindow().minimize(); },
    "window.toggleMaximize": () => { if (isDesktop()) void getCurrentWindow().toggleMaximize(); },
    "window.close": () => { if (isDesktop()) void getCurrentWindow().close(); },
  };

  return (
    <DeclarativeLayout
      definition={activeLayout.definition}
      locale={locale}
      data={layoutData}
      actions={layoutActions}
      shellClassName={rightPanelOpen && workspaceView === "chat" ? undefined : "details-collapsed"}
      slots={{
        sidebar: sidebarSlot,
        workspace: workspaceSlot,
        mediaStudio: mediaStudioSlot,
        inspector: inspectorSlot,
        qq2007Titlebar: <QQ2007TitleBar title={qq2007Title} />,
        qq2007Toolbar: (
          <QQ2007Toolbar
            workspaceView={workspaceView}
            onNewThread={() => newThread()}
            onMedia={() => setWorkspaceView("media")}
            onExtensions={() => setMcpOpen(true)}
            onWebsite={() => void openLevelUpWebsite()}
            onReview={() => {
              setWorkspaceView("chat");
              setRightPanelOpen(true);
              setQq2007RightTab("environment");
            }}
            onChat={() => setWorkspaceView("chat")}
            onThemes={() => setThemesOpen(true)}
          />
        ),
        qq2007RightPanel: qq2007RightPanelSlot,
        qq2007Statusbar: <QQ2007StatusBar permissionLevel={permissionLevel} running={running} />,
      }}
      overlays={overlays}
    />
  );
}

function QQ2007TitleBar({ title }: { title: string }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let stopListening: (() => void) | undefined;
    const syncMaximized = async () => {
      const next = await appWindow.isMaximized();
      if (!disposed) setMaximized(next);
    };
    void syncMaximized();
    void appWindow.onResized(() => { void syncMaximized(); }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const toggleMaximize = async () => {
    const appWindow = getCurrentWindow();
    await appWindow.toggleMaximize();
    setMaximized(await appWindow.isMaximized());
  };

  return (
    <header
      className={`qq2007-titlebar${maximized ? " maximized" : ""}`}
      onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest("button")) void toggleMaximize();
      }}
    >
      <span className="qq2007-title-spacer" data-tauri-drag-region />
      <i className="qq2007-icon qq2007-icon-mascot" aria-hidden="true" data-tauri-drag-region />
      <strong data-tauri-drag-region>LevelUpAgent 2007 - {title}</strong>
      <span className="qq2007-title-spacer qq2007-title-spacer-right" data-tauri-drag-region />
      <span className="qq2007-window-controls">
        <button
          type="button"
          className="qq2007-window-minimize"
          aria-label={tr("最小化窗口", "Minimize window")}
          title={tr("最小化", "Minimize")}
          onClick={() => { void getCurrentWindow().minimize(); }}
        ><i aria-hidden="true" /></button>
        <button
          type="button"
          className="qq2007-window-maximize"
          aria-label={maximized ? tr("还原窗口", "Restore window") : tr("最大化窗口", "Maximize window")}
          title={maximized ? tr("还原", "Restore") : tr("最大化", "Maximize")}
          onClick={() => { void toggleMaximize(); }}
        ><i aria-hidden="true" /></button>
        <button
          type="button"
          className="qq2007-window-close"
          aria-label={tr("关闭窗口", "Close window")}
          title={tr("关闭", "Close")}
          onClick={() => { void getCurrentWindow().close(); }}
        ><i aria-hidden="true" /></button>
      </span>
    </header>
  );
}

function QQ2007Toolbar({
  workspaceView,
  onNewThread,
  onMedia,
  onExtensions,
  onWebsite,
  onReview,
  onChat,
  onThemes,
}: {
  workspaceView: "chat" | "media";
  onNewThread: () => void;
  onMedia: () => void;
  onExtensions: () => void;
  onWebsite: () => void;
  onReview: () => void;
  onChat: () => void;
  onThemes: () => void;
}) {
  const items = [
    ["new-task", tr("新建任务", "New task"), onNewThread, false],
    ["scheduled", tr("创作空间", "Studio"), onMedia, workspaceView === "media"],
    ["plugins", tr("插件", "Extensions"), onExtensions, false],
    ["sites", tr("站点", "Website"), onWebsite, false],
    ["pull-request", tr("审查", "Review"), onReview, false],
    ["chat", tr("聊天", "Chat"), onChat, workspaceView === "chat"],
    ["skin", tr("换肤", "Themes"), onThemes, false],
  ] as const;
  return (
    <nav className="qq2007-toolbar" aria-label={tr("QQ2007 工具栏", "QQ2007 toolbar")}>
      {items.map(([icon, label, action, active]) => (
        <button type="button" className={active ? "active" : ""} onClick={action} key={icon}>
          <i className={`qq2007-icon qq2007-icon-${icon}`} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function QQ2007RightPanel({
  activeTab,
  modelName,
  onTabChange,
  children,
}: {
  activeTab: "environment" | "friends";
  modelName: string;
  onTabChange: (tab: "environment" | "friends") => void;
  children: ReactNode;
}) {
  return (
    <aside className="qq2007-right-panel">
      <div className="qq2007-right-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === "environment"} onClick={() => onTabChange("environment")}>{tr("环境信息", "Environment")}</button>
        <button type="button" role="tab" aria-selected={activeTab === "friends"} onClick={() => onTabChange("friends")}>{tr("LevelUp 好友", "LevelUp friends")}</button>
        <span aria-hidden="true">—</span><span aria-hidden="true">×</span>
      </div>
      {activeTab === "environment" ? (
        <div className="qq2007-environment-panel">{children}</div>
      ) : (
        <div className="qq2007-friends-panel">
          <section className="qq2007-profile-card">
            <div className="qq2007-assistant-art" aria-hidden="true" />
            <div>
              <strong><i />LevelUp 小蓝 <em>LV07</em></strong>
              <p>{tr("代码有问题？找我！", "Code problem? Ask me!")}</p>
              <p>{tr("我是你的智能伙伴 LevelUp", "Your intelligent LevelUp partner")}</p>
              <small>{modelName}</small>
            </div>
          </section>
          <div className="qq2007-friend-actions">
            {[["mail", tr("消息", "Message")], ["star", tr("收藏", "Favorites")], ["groups", tr("群组", "Groups")], ["folder", tr("文件", "Files")]].map(([icon, label]) => (
              <button type="button" key={icon}><i className={`qq2007-icon qq2007-icon-${icon}`} />{label}</button>
            ))}
          </div>
          <section className="qq2007-friend-groups">
            <strong>⌄ {tr("我的好友 (1/1)", "My friends (1/1)")}</strong>
            <div><span className="qq2007-mini-avatar" /><p><b>LevelUp 小蓝</b><small>● {tr("在线 · 随时为你服务", "Online · Ready to help")}</small></p></div>
            <strong>› {tr("智能伙伴 (0/0)", "Partners (0/0)")}</strong>
            <strong>› {tr("离线好友 (0/0)", "Offline (0/0)")}</strong>
          </section>
          <section className="qq2007-show-card">
            <header><strong>QQ {tr("秀", "Show")}</strong><small>{tr("主题可替换", "Theme artwork")}</small></header>
            <div className="qq2007-show-art" aria-hidden="true" />
          </section>
          <label className="qq2007-friend-search"><i className="qq2007-icon qq2007-icon-search" /><input aria-label={tr("查找好友", "Find friends")} placeholder={tr("查找好友…", "Find friends…")} /></label>
        </div>
      )}
    </aside>
  );
}

function QQ2007StatusBar({ permissionLevel, running }: { permissionLevel: PermissionLevel; running: boolean }) {
  return (
    <footer className="qq2007-statusbar">
      <span><i className="qq2007-icon qq2007-icon-online" />LevelUp LV07</span>
      <span>● {running ? tr("忙碌", "Busy") : tr("在线", "Online")}</span>
      <span>{tr("别迷恋姐，姐只是个传说。", "Make something wonderful.")}</span>
      <span className="qq2007-status-security"><i className="qq2007-icon qq2007-icon-security" />{permissionLabel(permissionLevel)}</span>
    </footer>
  );
}

function EmptyState({
  workspace,
  temporaryWorkspace,
  connectionNeedsSetup,
  onChooseWorkspace,
  onConfigureConnection,
}: {
  workspace?: string;
  temporaryWorkspace: boolean;
  connectionNeedsSetup: boolean;
  onChooseWorkspace: () => void;
  onConfigureConnection: () => void;
}) {
  return (
    <div className={`empty-state${connectionNeedsSetup ? " connection-onboarding" : ""}`}>
      <button className="empty-brand empty-brand-link" type="button" title={tr("访问 LevelUpAPI 官网", "Visit LevelUpAPI")} onClick={() => void openLevelUpWebsite()}><img src="/logo.png" alt="" /></button>
      <h1>{connectionNeedsSetup ? tr("新增模型连接", "Add a model connection") : "LevelUpAgent"}</h1>
      <p>{connectionNeedsSetup
        ? tr("配置 API Key 并选择模型后，就可以开始使用 LevelUpAgent。", "Configure an API key and choose a model to start using LevelUpAgent.")
        : temporaryWorkspace ? tr("临时工作区", "Temporary workspace") : workspace ? shortPath(workspace) : tr("准备就绪", "Ready")}</p>
      {connectionNeedsSetup && (
        <button className="connection-setup-button" onClick={onConfigureConnection}>
          <Plus size={16} />
          {tr("新增连接", "Add connection")}
        </button>
      )}
      <button className="workspace-button" onClick={onChooseWorkspace}>
        <Folder size={16} />
        {temporaryWorkspace
          ? tr("选择正式项目", "Choose a project")
          : workspace ? tr("更换项目", "Change project") : tr("打开项目", "Open project")}
      </button>
    </div>
  );
}

function DeleteThreadDialog({
  thread,
  onClose,
  onConfirm,
}: {
  thread: AgentThread;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useModalKeyboard(onClose);
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="dialog delete-thread-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={tr("确认删除会话", "Confirm conversation deletion")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="delete-thread-heading">
          <span><Trash2 size={20} /></span>
          <div>
            <strong>{tr("删除这个会话？", "Delete this conversation?")}</strong>
            <small>{localizedThreadTitle(thread.title)}</small>
          </div>
        </div>
        <p>{tr(
          "删除后无法恢复，会话消息和任务记录会一起删除；项目文件不会受到影响。",
          "This cannot be undone. Conversation messages and task records will be deleted; project files will not be affected.",
        )}</p>
        <div className="delete-thread-actions">
          <button className="secondary-button" type="button" onClick={onClose}>{tr("取消", "Cancel")}</button>
          <button className="primary-button danger-button" type="button" onClick={onConfirm}><Trash2 size={14} />{tr("删除会话", "Delete conversation")}</button>
        </div>
      </div>
    </div>
  );
}

type ConversationBlock =
  | { kind: "user"; item: AgentMessage }
  | { kind: "assistant"; items: AgentMessage[] };

function groupConversationMessages(messages: AgentMessage[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  for (const item of messages) {
    if (item.role === "user") {
      blocks.push({ kind: "user", item });
      continue;
    }
    const previous = blocks[blocks.length - 1];
    if (previous?.kind === "assistant") previous.items.push(item);
    else blocks.push({ kind: "assistant", items: [item] });
  }
  return blocks;
}

function MessageRow({ item }: { item: AgentMessage }) {
  return (
    <article className={`message user ${item.isError ? "error" : ""}`}>
      <div className="message-avatar"><span>{tr("你", "You")}</span></div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{tr("你", "You")}</strong>
          <span>{formatTime(item.createdAt)}</span>
        </div>
        <MessageAttachments item={item} />
        {item.content && (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
          </div>
        )}
        <MessageCopyButton content={item.content} />
      </div>
    </article>
  );
}

function AssistantMessageGroup({
  items,
  pending,
  fallbackProfile,
}: {
  items: AgentMessage[];
  pending: PendingApproval | null;
  fallbackProfile: ProviderProfile;
}) {
  const identity = items.find((item) => item.role === "assistant" && item.modelName);
  const modelName = identity?.modelName || fallbackProfile.model || fallbackProfile.name || "LevelUpAgent";
  const providerBrand = identity?.providerBrand ?? modelProviderBrand(fallbackProfile);
  const requestIds = items.flatMap((item) => item.requestId ? [item.requestId] : []);
  const copyContent = items
    .filter((item) => item.role === "assistant" && item.content.trim())
    .map((item) => item.content.trim())
    .join("\n\n");
  let durationMs: number | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].durationMs != null) {
      durationMs = items[index].durationMs;
      break;
    }
  }
  return (
    <article className="message assistant assistant-message-group">
      <AssistantAvatar brand={providerBrand} modelName={modelName} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{modelName}</strong>
          <span>{formatTime(items[0]?.createdAt ?? Date.now())}</span>
          {requestIds.length > 1 && <span title={requestIds.join("\n")}>{requestIds.length} {tr("次请求", "requests")}</span>}
        </div>
        <div className="assistant-message-content">
          {items.map((item) => <AssistantMessageSegment item={item} pending={pending} key={item.id} />)}
        </div>
        <MessageCopyButton content={copyContent} />
        {durationMs != null && (
          <div className="message-duration"><Timer size={13} />{tr("处理总时长", "Total processing time")} {formatDuration(durationMs)}</div>
        )}
      </div>
    </article>
  );
}

function AssistantAvatar({ brand, modelName }: { brand: ModelProviderBrand; modelName: string }) {
  const [useFallback, setUseFallback] = useState(false);
  const source = useFallback || brand === "levelup" ? "/logo.png" : `/avatars/${brand}.png`;
  return (
    <div className={`message-avatar assistant-avatar assistant-avatar-${brand}`} title={`${modelName} · ${providerBrandLabel(brand)}`}>
      <img src={source} alt="" onError={() => setUseFallback(true)} />
    </div>
  );
}

function MessageCopyButton({ content }: { content: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  if (!content.trim()) return null;
  const copy = async () => {
    try {
      await copyText(content);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 1_500);
    } catch {
      setStatus("error");
    }
  };
  return (
    <div className="message-copy-action">
      <button type="button" onClick={() => void copy()} title={tr("复制这段内容", "Copy this message")}>
        {status === "copied" ? <Check size={13} /> : <Copy size={13} />}
        {status === "copied" ? tr("已复制", "Copied") : status === "error" ? tr("复制失败", "Copy failed") : tr("复制", "Copy")}
      </button>
    </div>
  );
}

function MessageAttachments({ item }: { item: AgentMessage }) {
  if (item.attachments.length === 0) return null;
  return (
    <div className="message-attachments" aria-label={tr("消息附件", "Message attachments")}>
      {item.attachments.map((attachment) => (
        <AttachmentChip attachment={attachment} detailed key={attachment.id} />
      ))}
    </div>
  );
}

function AssistantMessageSegment({ item, pending }: { item: AgentMessage; pending: PendingApproval | null }) {
  if (item.role === "tool") {
    const firstLine = item.content.split("\n")[0] || tr("工具已完成", "Tool completed");
    if (item.content.startsWith("Sub-Agent completed in an isolated worktree.")) {
      const runId = item.content.match(/Run ID: ([0-9a-f]{32})/)?.[1];
      return (
        <details className="subagent-result">
          <summary>
            <span className="tool-kind"><GitMerge size={15} /></span>
            <span><strong>{tr("子 Agent 补丁待审查", "Sub-Agent patch awaiting review")}</strong><small>{runId ? `Run ${runId.slice(0, 10)}` : tr("隔离工作树已清理", "Isolated worktree cleaned")}</small></span>
            <ChevronDown size={15} />
          </summary>
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
          </div>
        </details>
      );
    }
    const mediaAssets = parseMediaToolAssets(item.content);
    if (mediaAssets) {
      return (
        <div className={`tool-media-result ${item.isError ? "error" : ""}`}>
          <div>
            {item.isError ? <CircleAlert size={14} /> : <Check size={14} />}
            <strong>{mediaAssets.length > 0 ? tr(`${mediaAssets.length} 个媒体结果`, `${mediaAssets.length} media results`) : tr("媒体任务已检查", "Media jobs checked")}</strong>
          </div>
          {mediaAssets.length > 0 && <div className="tool-media-grid">{mediaAssets.map((asset) => <MediaAssetCard asset={asset} locale={getAppLocale()} key={asset.id} />)}</div>}
        </div>
      );
    }
    return (
      <div className={`tool-result ${item.isError ? "error" : ""}`}>
        {item.isError ? <X size={14} /> : <Check size={14} />}
        <span>{firstLine}</span>
      </div>
    );
  }
  return (
    <section className={`assistant-message-segment ${item.isError ? "error" : ""}`}>
        <MessageAttachments item={item} />
        {item.content && (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
          </div>
        )}
        {item.toolCalls.length > 0 && (
          <div className="tool-call-list">
            {item.toolCalls.map((call) => (
              <div className={`tool-call${typeof call.arguments.prompt === "string" ? " prompt-tool-call" : ""}`} key={call.id}>
                <span className="tool-kind">{toolIcon(call)}</span>
                <span>
                  <strong>{toolLabel(call)}</strong>
                  <small title={toolFullSummary(call)}>{toolSummary(call)}</small>
                </span>
                <span className={`tool-status ${pending?.calls.some((item) => item.id === call.id) ? "waiting" : ""}`}>
                  {pending?.calls.some((item) => item.id === call.id) ? tr("待批准", "Awaiting approval") : tr("已提交", "Submitted")}
                </span>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

function ThinkingRow() {
  return (
    <div className="thinking-row">
      <span className="thinking-mark"><BrainCircuit size={16} /></span>
      <span>{tr("正在处理", "Working")}</span>
      <i /><i /><i />
    </div>
  );
}

function Composer({
  draft,
  attachments,
  mode,
  permissionLevel,
  running,
  disabled,
  modelMenuOpen,
  modelControl,
  onDraftChange,
  onRemoveAttachment,
  onModeChange,
  onPermissionChange,
  onSend,
  onStop,
}: {
  draft: string;
  attachments: ImageAttachment[];
  mode: AgentMode;
  permissionLevel: PermissionLevel;
  running: boolean;
  disabled: boolean;
  modelMenuOpen: boolean;
  modelControl: ReactNode;
  onDraftChange: (value: string) => void;
  onRemoveAttachment: (attachment: ImageAttachment) => void;
  onModeChange: (value: AgentMode) => void;
  onPermissionChange: (value: PermissionLevel) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const permissionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!permissionMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!permissionMenuRef.current?.contains(event.target as Node)) setPermissionMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPermissionMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [permissionMenuOpen]);

  return (
    <div className="composer-wrap">
      <div className={`composer${modelMenuOpen || permissionMenuOpen ? " menu-open" : ""}`}>
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label={tr("待发送附件", "Attachments to send")}>
            {attachments.map((attachment) => (
              <AttachmentChip attachment={attachment} onRemove={onRemoveAttachment} key={attachment.id} />
            ))}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={tr("交给 LevelUpAgent…", "Ask LevelUpAgent…")}
          rows={2}
          disabled={disabled}
        />
        <div className="composer-toolbar">
          <div className="mode-switch" aria-label={tr("运行模式", "Run mode")}>
            {(["agent", "plan", "goal", "chat"] as AgentMode[]).map((value) => (
              <button
                aria-pressed={mode === value}
                className={mode === value ? "active" : ""}
                disabled={disabled || running}
                key={value}
                title={modeDescription(value)}
                onClick={() => onModeChange(value)}
              >
                {modeLabel(value)}
              </button>
            ))}
          </div>
          <div className="permission-picker" ref={permissionMenuRef}>
            <button
              className={`permission-button permission-${permissionLevel}`}
              type="button"
              aria-label={`${tr("权限等级", "Permission level")}: ${permissionLabel(permissionLevel)}`}
              aria-expanded={permissionMenuOpen}
              disabled={disabled || running}
              onClick={() => setPermissionMenuOpen((open) => !open)}
            >
              {permissionIcon(permissionLevel, 14)}
              <span>{permissionLabel(permissionLevel)}</span>
              <ChevronDown size={12} />
            </button>
            {permissionMenuOpen && (
              <div className="permission-menu" role="menu" aria-label={tr("选择权限等级", "Choose permission level")}>
                {(["request", "agent", "full"] as PermissionLevel[]).map((level) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={permissionLevel === level}
                    className={permissionLevel === level ? "active" : ""}
                    key={level}
                    onClick={() => {
                      onPermissionChange(level);
                      setPermissionMenuOpen(false);
                    }}
                  >
                    <span className={`permission-option-icon permission-${level}`}>{permissionIcon(level, 17)}</span>
                    <span><strong>{permissionLabel(level)}</strong><small>{permissionDescription(level)}</small></span>
                    <span className="permission-option-check">{permissionLevel === level ? <Check size={14} /> : null}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="composer-spacer" />
          {modelControl}
          <IconButton label={running ? tr("停止", "Stop") : tr("发送", "Send")} className="send-button" disabled={disabled || (!running && !draft.trim() && attachments.length === 0)} onClick={running ? onStop : onSend}>
            {running ? <CircleStop size={18} /> : <Send size={18} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function Inspector({
  profile,
  thread,
  mode,
  permissionLevel,
  keyConfigured,
  gitStatus,
  goal,
  onWorkspace,
  onSettings,
  onDiff,
  onGoalAction,
}: {
  profile: ProviderProfile;
  thread: AgentThread;
  mode: AgentMode;
  permissionLevel: PermissionLevel;
  keyConfigured: boolean;
  gitStatus: GitStatus | null;
  goal: GoalState | null;
  onWorkspace: () => void;
  onSettings: () => void;
  onDiff: (change: GitFileChange) => void;
  onGoalAction: (action: "pause" | "resume" | "cancel") => void;
}) {
  const gitUnavailable = gitStatus?.isAvailable === false;
  return (
    <aside className="inspector">
      <div className="inspector-title" data-tauri-drag-region>
        <strong>{tr("任务详情", "Task details")}</strong>
        <Activity size={16} />
      </div>
      <section>
        <div className="section-heading"><Folder size={15} /><span>{tr("项目", "Project")}</span></div>
        <button className="detail-row clickable" onClick={onWorkspace}>
          <span>{thread.workspace ? shortPath(thread.workspace) : tr("未选择", "Not selected")}</span>
          <ChevronDown size={14} />
        </button>
        {thread.workspace && <div className="path-detail">{thread.workspace}</div>}
        <div className="detail-row" title={gitUnavailable ? tr("Git 是可选功能，不影响聊天、模型调用和文件操作", "Git is optional and does not affect chat, model calls, or file operations") : undefined}>
          <GitBranch size={14} />
          <span>{gitUnavailable
            ? tr("未安装 Git（可选）", "Git not installed (optional)")
            : !gitStatus
              ? tr("正在检查版本控制", "Checking version control")
              : gitStatus.isRepository
                ? gitStatus.branch ?? tr("Git 仓库", "Git repository")
                : tr("未启用版本控制", "Version control not enabled")}</span>
          <small>{gitUnavailable ? tr("正常可用", "Agent ready") : gitStatus?.isRepository ? "Git" : tr("本地", "Local")}</small>
        </div>
      </section>
      {gitStatus?.isRepository && (
        <section>
          <div className="section-heading"><FileCode2 size={15} /><span>{tr("变更", "Changes")}</span><small>{gitStatus.changes.length}</small></div>
          <div className="change-list">
            {gitStatus.changes.slice(0, 10).map((change) => (
              <button className="change-row" key={`${change.indexStatus}${change.worktreeStatus}:${change.path}`} onClick={() => onDiff(change)}>
                <span className="change-status">{change.indexStatus}{change.worktreeStatus}</span>
                <span>{change.path}</span>
              </button>
            ))}
            {gitStatus.changes.length === 0 && <div className="clean-state"><Check size={13} />{tr("无本地变更", "No local changes")}</div>}
            {gitStatus.changes.length > 10 && <div className="more-changes">{tr("还有", "Plus")} {gitStatus.changes.length - 10} {tr("项", "more")}</div>}
          </div>
        </section>
      )}
      <section>
        <div className="section-heading"><Cpu size={15} /><span>{tr("模型", "Model")}</span></div>
        <button className="detail-row clickable" onClick={onSettings}>
          <span>{profile.model}</span><ChevronDown size={14} />
        </button>
        <div className="detail-row"><span>{tr("协议", "Protocol")}</span><small>{protocolLabel(profile.protocol)}</small></div>
        <div className="detail-row"><span>{tr("状态", "Status")}</span><small className={keyConfigured ? "positive" : "negative"}>{keyConfigured ? tr("可用", "Available") : tr("未配置", "Not configured")}</small></div>
        <button className="detail-row clickable levelup-detail-link" type="button" title={LEVELUP_WEBSITE} onClick={() => void openLevelUpWebsite()}>
          <span>LevelUpAPI</span><small>levelup.mom</small><ExternalLink size={12} />
        </button>
      </section>
      <section>
        <div className="section-heading"><Gauge size={15} /><span>{tr("本次任务", "This task")}</span></div>
        <div className="metric-grid">
          <div><strong>{formatTokens(thread.inputTokens)}</strong><span>{tr("输入", "Input")}</span></div>
          <div><strong>{formatTokens(thread.outputTokens)}</strong><span>{tr("输出", "Output")}</span></div>
        </div>
      </section>
      {(goal || mode === "goal") && (
        <section>
          <div className="section-heading"><Flag size={15} /><span>Goal</span><small>{goal ? goalStatusLabel(goal.status) : tr("未创建", "Not created")}</small></div>
          {goal ? (
            <>
              <div className="goal-objective" title={goal.objective}>{goal.objective}</div>
              <div className="goal-meta">
                <span>{formatTokens(goal.inputTokens + goal.outputTokens)} tokens</span>
                <span>{goal.turns} {tr("回合", "turns")}</span>
              </div>
              <div className="goal-actions">
                {(goal.status === "active" || goal.status === "auditing") && <button onClick={() => onGoalAction("pause")}><Pause size={12} />{tr("暂停", "Pause")}</button>}
                {(goal.status === "paused" || goal.status === "blocked") && <button onClick={() => onGoalAction("resume")}><Play size={12} />{tr("继续", "Resume")}</button>}
                {!(["completed", "cancelled"] as string[]).includes(goal.status) && <button className="danger" onClick={() => onGoalAction("cancel")}><X size={12} />{tr("取消", "Cancel")}</button>}
              </div>
            </>
          ) : (
            <div className="goal-empty">{tr("发送首条目标消息后创建并持续执行。", "Created after the first Goal message and runs continuously.")}</div>
          )}
        </section>
      )}
      <section>
        <div className="section-heading"><ShieldCheck size={15} /><span>{tr("权限", "Permissions")}</span></div>
        <div className="permission-line"><Check size={13} /><span>{tr("读取与搜索", "Read and search")}</span><small>{tr("自动", "Automatic")}</small></div>
        <div className="permission-line"><KeyRound size={13} /><span>{tr("写入与命令", "Writes and commands")}</span><small>{permissionBehaviorLabel(permissionLevel, mode)}</small></div>
        <div className="permission-line"><ShieldCheck size={13} /><span>{tr("权限等级", "Permission level")}</span><small>{permissionLabel(permissionLevel)}</small></div>
        <div className="permission-line"><Command size={13} /><span>{tr("当前模式", "Current mode")}</span><small>{modeLabel(mode)}</small></div>
      </section>
    </aside>
  );
}

function DiffDialog({
  diff,
  workspace,
  onApplied,
  onClose,
}: {
  diff: GitDiff;
  workspace: string;
  onApplied: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useModalKeyboard(onClose);
  const [preview, setPreview] = useState<GitRollbackPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownDiff = preview?.diff ?? diff.content;
  const lines = shownDiff.split("\n").slice(0, 4000);
  const truncated = preview?.truncated ?? diff.truncated;

  const prepareRollback = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewGitRollback(workspace, diff.path));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirmRollback = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyGitRollback(preview.confirmationToken);
      await onApplied(result.path);
    } catch (reason) {
      setError(errorText(reason));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="diff-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={tr("文件变更", "File changes")}>
        <div className="dialog-header">
          <div>
            <strong>{diff.path}</strong>
            <span>{truncated ? tr("大型 diff · 已截断", "Large diff · truncated") : `${lines.length} ${tr("行", "lines")}`}</span>
          </div>
          <IconButton label={tr("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="diff-content">
          {lines.map((line, index) => {
            const kind = line.startsWith("+") && !line.startsWith("+++")
              ? "addition"
              : line.startsWith("-") && !line.startsWith("---")
                ? "deletion"
                : line.startsWith("@@")
                  ? "hunk"
                  : "context";
            return (
              <div className={`diff-line ${kind}`} key={`${index}:${line}`}>
                <span>{index + 1}</span>
                <code>{line || " "}</code>
              </div>
            );
          })}
          {lines.length === 0 && <div className="diff-empty">{tr("没有可显示的文本变更", "No text changes to display")}</div>}
        </div>
        <div className="diff-actions">
          <div>
            {preview ? (
              <strong>
                {preview.action === "delete_untracked"
                  ? tr("将永久删除这个未跟踪文件", "This untracked file will be permanently deleted")
                  : tr("将把暂存区和工作树恢复到 HEAD", "The index and worktree will be restored to HEAD")}
              </strong>
            ) : (
              <span>{tr("撤销前会重新生成完整预览，并在应用时再次核对文件。", "A fresh full preview is generated before rollback and rechecked at apply time.")}</span>
            )}
            {preview && <span>{preview.status} · {tr("确认令牌 10 分钟有效", "confirmation expires in 10 minutes")}</span>}
            {error && <span className="negative">{error}</span>}
          </div>
          {!preview ? (
            <button className="secondary-button danger-button" disabled={busy} onClick={prepareRollback}>
              <Trash2 size={14} />{busy ? tr("正在检查", "Checking") : tr("准备撤销", "Prepare rollback")}
            </button>
          ) : (
            <button className="primary-button danger-button" disabled={busy} onClick={confirmRollback}>
              <Trash2 size={14} />{busy ? tr("正在撤销", "Rolling back") : tr("确认永久撤销", "Confirm permanent rollback")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type ProtocolPlatform = "anthropic" | "openai" | "antigravity" | "gemini" | "grok";

const PROTOCOL_OPTIONS: Array<{
  value: ProviderProtocol;
  label: string;
  platforms: ProtocolPlatform[];
  recommended?: boolean;
}> = [
  {
    value: "openai_responses",
    label: "Responses",
    platforms: ["openai", "anthropic", "grok"],
    recommended: true,
  },
  {
    value: "openai_chat",
    label: "Chat Completions",
    platforms: ["openai", "anthropic", "grok"],
  },
  {
    value: "anthropic_messages",
    label: "Anthropic Messages",
    platforms: ["anthropic", "openai", "gemini", "antigravity", "grok"],
  },
  {
    value: "gemini_generate_content",
    label: "Gemini GenerateContent",
    platforms: ["gemini", "antigravity"],
  },
];

function protocolPlatformLabel(platform: ProtocolPlatform) {
  if (platform === "anthropic") return "Anthropic";
  if (platform === "openai") return "OpenAI";
  if (platform === "antigravity") return "Antigravity";
  if (platform === "gemini") return "Gemini";
  return "Grok";
}

function ThemeDialog({
  themes,
  activeThemeId,
  onActivate,
  onInstall,
  onUninstall,
  onClose,
}: {
  themes: ThemeManifest[];
  activeThemeId: string;
  onActivate: (themeId: string) => Promise<void>;
  onInstall: () => Promise<void>;
  onUninstall: (themeId: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useModalKeyboard(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="dialog themes-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={tr("主题管理", "Theme manager")}>
        <div className="dialog-header">
          <div><strong>{tr("主题管理", "Theme manager")}</strong><span>{tr("安装、切换或卸载第三方外观包", "Install, switch, or uninstall third-party appearance packages")}</span></div>
          <IconButton label={tr("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="themes-body">
          <div className={`theme-card default-theme-card${activeThemeId === "default" ? " active" : ""}`}>
            <span className="theme-swatch" aria-hidden="true"><i /><i /><i /></span>
            <span className="theme-copy"><strong>{tr("LevelUpAgent 默认主题", "LevelUpAgent default")}</strong><small>{tr("内置暖色视觉系统", "Built-in warm visual system")}</small></span>
            <button className={activeThemeId === "default" ? "theme-active-button" : "secondary-button"} disabled={busy || activeThemeId === "default"} onClick={() => void act(() => onActivate("default"))}>
              {activeThemeId === "default" ? tr("使用中", "Active") : tr("启用", "Activate")}
            </button>
          </div>
          {themes.map((theme) => (
            <div className={`theme-card${activeThemeId === theme.id ? " active" : ""}`} key={theme.id}>
              <span className="theme-package-icon" aria-hidden="true"><Palette size={22} /></span>
              <span className="theme-copy">
                <strong>{theme.name}<em>v{theme.version}</em></strong>
                <small>{theme.description}</small>
                <small>{theme.author}{theme.license ? ` · ${theme.license}` : ""}</small>
              </span>
              <button className={activeThemeId === theme.id ? "theme-active-button" : "secondary-button"} disabled={busy || activeThemeId === theme.id} onClick={() => void act(() => onActivate(theme.id))}>
                {activeThemeId === theme.id ? tr("使用中", "Active") : tr("启用", "Activate")}
              </button>
              <IconButton className="theme-remove-button" label={`${tr("卸载", "Uninstall")} ${theme.name}`} disabled={busy} onClick={() => void act(() => onUninstall(theme.id))}><Trash2 size={16} /></IconButton>
            </div>
          ))}
          {themes.length === 0 && <p className="theme-empty">{tr("尚未安装第三方主题。请选择一个 .levelup-theme 文件。", "No third-party themes are installed. Select a .levelup-theme file to begin.")}</p>}
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer themes-footer">
          <small>{tr("主题可携带声明式布局并读取受控界面数据，但不能访问 API Key、消息正文或任意本地文件。", "Themes may include declarative layouts and controlled UI data, but cannot access API keys, message bodies, or arbitrary local files.")}</small>
          <button className="primary-button" disabled={busy || !isDesktop()} onClick={() => void act(onInstall)}><Plus size={15} /> {tr("安装主题包", "Install theme package")}</button>
        </div>
      </div>
    </div>
  );
}

function ConnectionDialog({
  profiles,
  profile,
  keyConfigured,
  onClose,
  onOpenMcp,
  onOpenSkills,
  onOpenInstructions,
  onOpenLogs,
  onOpenThemes,
  onSave,
  onRemove,
  onDeleteKey,
}: {
  profiles: ProviderProfile[];
  profile: ProviderProfile;
  keyConfigured: boolean;
  onClose: () => void;
  onOpenMcp: () => void;
  onOpenSkills: () => void;
  onOpenInstructions: () => void;
  onOpenLogs: () => void;
  onOpenThemes: () => void;
  onSave: (profile: ProviderProfile, key: string) => Promise<void>;
  onRemove: (profileId: string) => Promise<void>;
  onDeleteKey: (profileId: string) => Promise<void>;
}) {
  const dialogRef = useModalKeyboard(onClose);
  const [draftProfile, setDraftProfile] = useState(profile);
  const [apiKey, setApiKey] = useState("");
  const [localKeyConfigured, setLocalKeyConfigured] = useState(keyConfigured);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [candidates, setCandidates] = useState<ExternalConfigCandidate[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [diagnostics, setDiagnostics] = useState<GatewayDiagnostics | null>(null);

  const refreshHealth = async () => {
    setHealth(await listProviderHealth());
  };

  useEffect(() => {
    void refreshHealth().catch(() => undefined);
  }, []);

  const update = <K extends keyof ProviderProfile>(key: K, value: ProviderProfile[K]) => {
    setDraftProfile((current) => ({ ...current, [key]: value }));
  };

  const selectProfile = async (profileId: string) => {
    const selected = profiles.find((item) => item.id === profileId);
    if (!selected) return;
    setDraftProfile(selected);
    setApiKey("");
    setModels([]);
    setDiagnostics(null);
    setError(null);
    setLocalKeyConfigured(await hasApiKey(selected.id));
  };

  const addProfile = () => {
    setDraftProfile({
      id: `provider-${crypto.randomUUID()}`,
      name: tr("新连接", "New connection"),
      baseUrl: profile.baseUrl,
      model: profile.model,
      protocol: profile.protocol,
      allowUnauthenticated: false,
      priority: Math.max(10, ...profiles.map((item) => item.priority + 10)),
      failoverEnabled: true,
    });
    setApiKey("");
    setModels([]);
    setError(null);
    setLocalKeyConfigured(false);
  };

  const duplicateProfile = () => {
    setDraftProfile({
      ...draftProfile,
      id: `provider-${crypto.randomUUID()}`,
      name: `${draftProfile.name} ${tr("副本", "copy")}`,
      priority: draftProfile.priority + 10,
    });
    setApiKey("");
    setModels([]);
    setDiagnostics(null);
    setError(null);
    setLocalKeyConfigured(false);
  };

  const runDiagnostics = async () => {
    setBusy(true);
    setError(null);
    try {
      setDiagnostics(await getGatewayDiagnostics(draftProfile));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const clearHealth = async () => {
    setBusy(true);
    try {
      await resetProviderHealth(draftProfile.id);
      await refreshHealth();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const testModels = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await fetchModels(draftProfile, apiKey);
      setModels(result);
      if (result.length > 0 && !result.some((item) => item.id === draftProfile.model)) {
        update("model", result[0].id);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveConnection = async () => {
    setBusy(true);
    setError(null);
    try {
      validateProviderBaseUrl(draftProfile.baseUrl);
      await onSave(draftProfile, apiKey);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const scanConfigs = async () => {
    setScanning(true);
    setError(null);
    try {
      setCandidates(await scanExternalConfigs());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScanning(false);
    }
  };

  const importCandidate = async (candidate: ExternalConfigCandidate) => {
    setBusy(true);
    setError(null);
    try {
      const imported = await importExternalConfig(candidate.id);
      await onSave(imported, "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="dialog connection-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={tr("模型连接", "Model connections")}>
        <div className="dialog-header">
          <div><strong>{tr("模型连接", "Model connections")}</strong><span>{tr("LevelUpAPI 与兼容服务", "LevelUpAPI and compatible services")}</span></div>
          <IconButton label={tr("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="dialog-body">
          <button className="levelup-connection-card" type="button" title={LEVELUP_WEBSITE} onClick={() => void openLevelUpWebsite()}>
            <span className="levelup-connection-logo"><img src="/logo.png" alt="" /></span>
            <span className="levelup-connection-copy">
              <strong>{tr("访问 LevelUpAPI", "Visit LevelUpAPI")}</strong>
              <small>{tr("获取 API Key、查看服务状态与管理账户", "Get an API key, check service status, and manage your account")}</small>
            </span>
            <ExternalLink size={16} />
          </button>
          <div className="connection-picker wide">
            <select
              aria-label={tr("当前连接", "Current connection")}
              value={profiles.some((item) => item.id === draftProfile.id) ? draftProfile.id : ""}
              onChange={(event) => selectProfile(event.target.value)}
            >
              {!profiles.some((item) => item.id === draftProfile.id) && <option value="">{tr("新连接", "New connection")}</option>}
              {profiles.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
            <IconButton label={tr("扫描外部配置", "Scan external configs")} onClick={scanConfigs} disabled={scanning}>
              <FileInput size={17} className={scanning ? "spin" : ""} />
            </IconButton>
            <IconButton label={tr("添加连接", "Add connection")} onClick={addProfile}><Plus size={17} /></IconButton>
            <IconButton label={tr("复制当前连接（不复制密钥）", "Duplicate connection without API key")} onClick={duplicateProfile}><Copy size={16} /></IconButton>
            <IconButton
              label={tr("删除连接", "Delete connection")}
              disabled={profiles.length <= 1 || !profiles.some((item) => item.id === draftProfile.id)}
              onClick={async () => {
                const removedId = draftProfile.id;
                const fallback = profiles.find((item) => item.id !== removedId);
                if (!fallback) return;
                await onRemove(removedId);
                setDraftProfile(fallback);
                setLocalKeyConfigured(await hasApiKey(fallback.id));
              }}
            ><Trash2 size={16} /></IconButton>
          </div>
          {candidates && (
            <div className="migration-results wide">
              <div className="migration-heading">
                <span>{tr("本机配置", "Local configurations")}</span>
                <small>{candidates.length > 0 ? `${candidates.length} ${tr("个可识别连接", "recognized connections")}` : tr("未发现", "None found")}</small>
              </div>
              {candidates.map((candidate) => (
                <div className="migration-row" key={candidate.id}>
                  <span className="migration-source">{candidate.source}</span>
                  <span className="migration-detail">
                    <strong>{candidate.name}</strong>
                    <small>{candidate.model} · {candidate.baseUrl}</small>
                  </span>
                  <span className={candidate.hasSecret ? "migration-ready" : "migration-warning"}>
                    {candidate.hasSecret ? tr("可导入", "Ready to import") : tr("缺少密钥", "Missing key")}
                  </span>
                  <button
                    className="secondary-button"
                    disabled={!candidate.hasSecret || busy}
                    onClick={() => importCandidate(candidate)}
                  >
                    {tr("导入", "Import")}
                  </button>
                </div>
              ))}
            </div>
          )}
          <label className="field">
            <span>{tr("名称", "Name")}</span>
            <input value={draftProfile.name} onChange={(event) => update("name", event.target.value)} />
          </label>
          <label className="field">
            <span>{tr("故障转移优先级", "Failover priority")} <small>{tr("数字越小越优先", "Lower numbers run first")}</small></span>
            <input type="number" min="0" max="10000" value={draftProfile.priority} onChange={(event) => update("priority", Number(event.target.value) || 0)} />
          </label>
          <label className="field wide">
            <span>Base URL</span>
            <input value={draftProfile.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" />
            <small className="endpoint-preview" title={providerEndpointPreview(draftProfile)}>
              {tr("最终请求", "Resolved endpoint")}: {providerEndpointPreview(draftProfile) || tr("等待有效地址和模型", "Enter a valid URL and model")}
            </small>
          </label>
          <div className="field wide">
            <span>
              {tr("协议", "Protocol")}
              <small>{tr("标签为 LevelUpAPI 主要适配平台", "Badges show primary LevelUpAPI platforms")}</small>
            </span>
            <div className="protocol-switch protocol-options" role="radiogroup" aria-label={tr("连接协议", "Connection protocol")}>
              {PROTOCOL_OPTIONS.map((option) => (
                <button
                  type="button"
                  className={`protocol-option${draftProfile.protocol === option.value ? " active" : ""}`}
                  key={option.value}
                  role="radio"
                  aria-checked={draftProfile.protocol === option.value}
                  onClick={() => update("protocol", option.value)}
                >
                  <span className="protocol-option-heading">
                    <strong>{option.label}</strong>
                    {option.recommended && <em>{tr("推荐", "Recommended")}</em>}
                  </span>
                  <span className="protocol-platforms" aria-label={tr("支持平台", "Supported platforms")}>
                    {option.platforms.map((platform) => (
                      <span className={`platform-pill platform-pill-${platform}`} key={platform}>
                        {protocolPlatformLabel(platform)}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
            <small className="protocol-help">
              {tr(
                "Grok/xAI 已由 LevelUpAPI 原生适配：推荐 Responses，也支持 Chat Completions 与 Anthropic Messages。直连其他服务时以服务商实际接口为准。",
                "Grok/xAI is natively integrated by LevelUpAPI: Responses is recommended, with Chat Completions and Anthropic Messages also supported. Direct providers may expose a different subset."
              )}
            </small>
          </div>
          <label className="field wide">
            <span>API Key <small>{localKeyConfigured
              ? tr("已存入系统凭据库", "Stored in OS credential vault")
              : draftProfile.allowUnauthenticated ? tr("可留空", "Optional") : tr("未保存", "Not saved")}</small></span>
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={localKeyConfigured ? "••••••••••••••••" : draftProfile.allowUnauthenticated ? tr("本地服务可留空", "Optional for local services") : "sk-…"} autoComplete="off" />
          </label>
          <label className="failover-toggle wide">
            <input type="checkbox" checked={draftProfile.allowUnauthenticated} onChange={(event) => update("allowUnauthenticated", event.target.checked)} />
            <span><strong>{tr("允许无 API Key", "Allow connection without an API key")}</strong><small>{tr("仅用于你信任的本机或局域网服务；如果已保存密钥，仍会优先发送密钥。", "Use only with a trusted local or LAN service. A saved key is still sent when present.")}</small></span>
          </label>
          <div className="field">
            <span>{tr("模型", "Model")}</span>
            <div className="model-id-control">
              <input
                aria-label={tr("模型 ID", "Model ID")}
                list={`provider-models-${draftProfile.id}`}
                value={draftProfile.model}
                onChange={(event) => update("model", event.target.value)}
                placeholder={tr("可手动输入模型 ID", "Enter a model ID")}
              />
              <IconButton
                className="model-id-clear"
                label={tr("清空模型 ID", "Clear model ID")}
                disabled={!draftProfile.model}
                onClick={() => update("model", "")}
              >
                <X size={16} />
              </IconButton>
            </div>
            <datalist id={`provider-models-${draftProfile.id}`}>
              {models.map((item) => <option value={item.id} key={item.id} />)}
            </datalist>
          </div>
          <div className="field connection-test">
            <span>{tr("连接检查", "Connection check")}</span>
            <button className="secondary-button" onClick={testModels} disabled={busy}>
              <RefreshCw size={14} className={busy ? "spin" : ""} />
              {models.length > 0 ? `${models.length} ${tr("个模型", "models")}` : tr("检测", "Check")}
            </button>
          </div>
          <label className="failover-toggle wide">
            <input type="checkbox" checked={draftProfile.failoverEnabled} onChange={(event) => update("failoverEnabled", event.target.checked)} />
            <span><strong>{tr("允许作为备用连接", "Allow as failover connection")}</strong><small>{tr("主连接出现超时、限流、鉴权或服务端错误时自动接管；流式内容开始后绝不切换。", "Takes over on primary timeouts, rate limits, authentication, or server errors; never switches after streaming begins.")}</small></span>
          </label>
          <ProviderHealthPanel
            profile={draftProfile}
            health={health.find((item) => item.profileId === draftProfile.id)}
            diagnostics={diagnostics}
            busy={busy}
            canDiagnose={localKeyConfigured || draftProfile.allowUnauthenticated}
            onDiagnose={runDiagnostics}
            onReset={clearHealth}
          />
          <ConfigWritebackPanel profile={draftProfile} keyConfigured={localKeyConfigured} />
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer">
          <div className="dialog-footer-actions">
            <button className="secondary-button" onClick={onOpenMcp}><Network size={14} /> {tr("MCP 服务器", "MCP servers")}</button>
            <button className="secondary-button" onClick={onOpenSkills}><BookOpen size={14} /> Skills</button>
            <button className="secondary-button" onClick={onOpenInstructions}><BrainCircuit size={14} /> Instructions</button>
            <button className="secondary-button" onClick={onOpenLogs}><Activity size={14} /> {tr("请求日志", "Request logs")}</button>
            <button className="secondary-button" onClick={onOpenThemes}><Palette size={14} /> {tr("主题", "Themes")}</button>
            <UpdateButton key={getAppLocale()} />
            {localKeyConfigured && <button className="danger-text-button" onClick={async () => { await onDeleteKey(draftProfile.id); setLocalKeyConfigured(false); }}>{tr("移除密钥", "Remove key")}</button>}
          </div>
          <span />
          <button className="secondary-button" onClick={onClose}>{tr("取消", "Cancel")}</button>
          <button className="primary-button" onClick={saveConnection} disabled={!draftProfile.name.trim() || !draftProfile.baseUrl || !draftProfile.model || busy}>
            {tr("保存连接", "Save connection")}
          </button>
        </div>
      </div>
    </div>
  );
}

function UpdateButton() {
  const [status, setStatus] = useState<"idle" | "checking" | "available" | "current" | "installing" | "error">("idle");
  const [version, setVersion] = useState("");
  const [detail, setDetail] = useState(tr("检查已签名更新", "Check for signed updates"));
  const act = async () => {
    if (status === "checking" || status === "installing") return;
    try {
      if (status === "available") {
        setStatus("installing");
        setDetail(`${tr("正在安装", "Installing")} ${version}`);
        await installAppUpdate();
        return;
      }
      setStatus("checking");
      const update = await checkAppUpdate();
      if (update) {
        setVersion(update.version);
        setDetail(update.body || `${tr("已验证更新签名", "Verified update signature for")} ${update.version}`);
        setStatus("available");
      } else {
        setDetail(tr("当前已是最新版本", "You are up to date"));
        setStatus("current");
      }
    } catch (error) {
      setDetail(errorText(error));
      setStatus("error");
    }
  };
  const label = status === "checking"
    ? tr("检查更新…", "Checking…")
    : status === "installing"
      ? tr("安装并重启…", "Installing and restarting…")
      : status === "available"
        ? `${tr("安装", "Install")} ${version}`
        : status === "current"
          ? tr("已是最新版", "Up to date")
          : status === "error"
            ? tr("更新未配置", "Updater not configured")
            : tr("检查更新", "Check for updates");
  return (
    <button className="secondary-button" onClick={act} disabled={status === "checking" || status === "installing"} title={detail}>
      <RefreshCw size={14} className={status === "checking" || status === "installing" ? "spin" : ""} /> {label}
    </button>
  );
}

function ProviderHealthPanel({
  profile,
  health,
  diagnostics,
  busy,
  canDiagnose,
  onDiagnose,
  onReset,
}: {
  profile: ProviderProfile;
  health?: ProviderHealth;
  diagnostics: GatewayDiagnostics | null;
  busy: boolean;
  canDiagnose: boolean;
  onDiagnose: () => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const coolingDown = Boolean(health?.cooldownUntil && health.cooldownUntil > Date.now());
  const quota = objectValue(diagnostics?.usage.quota);
  const remaining = displayValue(diagnostics?.usage.remaining) ?? displayValue(quota?.remaining);
  const balance = displayValue(diagnostics?.usage.balance);
  const mode = displayValue(diagnostics?.usage.mode) ?? displayValue(diagnostics?.usage.status);
  return (
    <section className="provider-health wide" aria-label={`${profile.name} ${tr("连接健康", "connection health")}`}>
      <div className="provider-health-heading">
        <div>
          <Activity size={15} />
          <span><strong>{tr("连接健康", "Connection health")}</strong><small>{coolingDown ? tr("冷却中", "Cooling down") : health?.consecutiveFailures ? tr("需要关注", "Needs attention") : tr("可用", "Available")}</small></span>
        </div>
        <div>
          <button className="secondary-button" disabled={busy || !canDiagnose} onClick={onDiagnose}>{tr("LevelUpAPI 诊断", "LevelUpAPI diagnostics")}</button>
          <button className="secondary-button" disabled={busy || !health?.totalRequests} onClick={onReset}>{tr("重置", "Reset")}</button>
        </div>
      </div>
      <div className="provider-health-metrics">
        <span><small>{tr("平均延迟", "Average latency")}</small><strong>{health?.averageLatencyMs != null ? `${health.averageLatencyMs} ms` : "—"}</strong></span>
        <span><small>{tr("请求", "Requests")}</small><strong>{health?.totalRequests ?? 0}</strong></span>
        <span><small>{tr("接管", "Failovers")}</small><strong>{health?.totalFailovers ?? 0}</strong></span>
        <span><small>{tr("连续失败", "Consecutive failures")}</small><strong>{health?.consecutiveFailures ?? 0}</strong></span>
      </div>
      {coolingDown && <p>{tr("备用连接将在", "Failover connection will rejoin after")} {new Date(health!.cooldownUntil!).toLocaleTimeString(getAppLocale())}.</p>}
      {health?.lastError && <p className="provider-last-error" title={health.lastError}>{health.lastError}</p>}
      {diagnostics && (
        <div className="gateway-diagnostics">
          <span className={diagnostics.healthOk ? "gateway-ok" : "gateway-warn"}>{diagnostics.healthOk ? tr("服务健康", "Service healthy") : tr("健康探针异常", "Health probe failed")}</span>
          <span>{tr("诊断", "Diagnostics")} {diagnostics.latencyMs} ms</span>
          {mode && <span>{tr("模式", "Mode")} {mode}</span>}
          {remaining && <span>{tr("剩余", "Remaining")} {remaining}</span>}
          {balance && <span>{tr("余额", "Balance")} {balance}</span>}
          {diagnostics.requestId && <span title={diagnostics.requestId}>ID {diagnostics.requestId.slice(0, 12)}</span>}
        </div>
      )}
      {!canDiagnose && <p>{tr("保存 API Key 后可读取 LevelUpAPI 的真实用量与余额。", "Save an API key to read real LevelUpAPI usage and balance.")}</p>}
    </section>
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function displayValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;
}

function gatewayBalance(diagnostics: GatewayDiagnostics | null): number | null {
  if (!diagnostics) return null;
  const quota = objectValue(diagnostics.usage.quota);
  for (const candidate of [diagnostics.usage.balance, diagnostics.usage.remaining, quota?.remaining]) {
    const value = typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && candidate.trim() ? Number(candidate) : Number.NaN;
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return null;
}

function formatCoinBalance(value: number, locale: AppLocale) {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function ConfigWritebackPanel({ profile, keyConfigured }: { profile: ProviderProfile; keyConfigured: boolean }) {
  const [target, setTarget] = useState<ExternalConfigTarget>(() => targetForProtocol(profile.protocol));
  const [preview, setPreview] = useState<ConfigWritePreview | null>(null);
  const [result, setResult] = useState<ConfigWriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTarget(targetForProtocol(profile.protocol));
    setPreview(null);
    setResult(null);
    setError(null);
  }, [profile.id, profile.protocol]);

  const inspect = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await previewExternalConfigWrite(profile, target));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await applyExternalConfigWrite(profile, target, preview.confirmationToken));
      setPreview(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      await rollbackExternalConfigWrite(result.target, result.backupId);
      setResult(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="config-writeback wide" aria-label={tr("外部 CLI 配置同步", "External CLI configuration sync")}>
      <div className="config-writeback-heading">
        <span><Save size={15} /><span><strong>{tr("同步到外部 CLI", "Sync to external CLI")}</strong><small>{tr("预览 → 时间戳备份 → 原子写入 → 可回滚", "Preview → timestamped backup → atomic write → rollback")}</small></span></span>
        <div>
          <select value={target} onChange={(event) => { setTarget(event.target.value as ExternalConfigTarget); setPreview(null); setResult(null); }} aria-label={tr("外部 CLI", "External CLI")}>
            <option value="codex" disabled={profile.protocol !== "openai_responses" && profile.protocol !== "openai_chat"}>Codex</option>
            <option value="claude" disabled={profile.protocol !== "anthropic_messages"}>Claude Code</option>
            <option value="gemini" disabled={profile.protocol !== "gemini_generate_content"}>Gemini CLI</option>
            <option value="opencode">OpenCode</option>
          </select>
          <button className="secondary-button" onClick={inspect} disabled={busy || !keyConfigured}>{tr("预览变更", "Preview changes")}</button>
        </div>
      </div>
      {!keyConfigured && <p>{tr("先保存此连接与 API Key，再生成不含明文密钥的安全预览。", "Save this connection and API key before generating a redacted preview.")}</p>}
      {preview && (
        <div className="config-preview">
          {preview.files.map((file) => (
            <div key={file.path}>
              <span title={file.path}>{file.exists ? tr("更新", "Update") : tr("新建", "Create")} · {file.path}</span>
              <pre>{file.diff}</pre>
            </div>
          ))}
          <button className="primary-button" disabled={busy} onClick={apply}>{tr("确认写入并创建备份", "Confirm write and create backup")}</button>
        </div>
      )}
      {result && (
        <div className="config-write-result">
          <span><Check size={14} /> {tr("已安全写入", "Safely wrote")} {result.changedFiles.length} {tr("个文件", "files")}</span>
          <button className="secondary-button" disabled={busy} onClick={rollback}>{tr("回滚本次写入", "Roll back this write")}</button>
        </div>
      )}
      {error && <button className="config-write-error" onClick={() => setError(null)}>{error}<X size={12} /></button>}
    </section>
  );
}

function targetForProtocol(protocol: ProviderProtocol): ExternalConfigTarget {
  if (protocol === "anthropic_messages") return "claude";
  if (protocol === "gemini_generate_content") return "gemini";
  return "codex";
}

function RequestLogsDialog({ profiles, onClose }: { profiles: ProviderProfile[]; onClose: () => void }) {
  const dialogRef = useModalKeyboard(onClose);
  const [logs, setLogs] = useState<ProviderRequestLog[]>([]);
  const [model, setModel] = useState("all");
  const [loading, setLoading] = useState(isDesktop());
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setLogs(await listProviderRequests());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);
  const models = [...new Set(logs.map((item) => item.model))].sort();
  const visible = model === "all" ? logs : logs.filter((item) => item.model === model);
  const success = visible.filter((item) => item.status === "success").length;
  const averageLatency = visible.length > 0
    ? Math.round(visible.reduce((sum, item) => sum + item.latencyMs, 0) / visible.length)
    : 0;
  const tokens = visible.reduce((sum, item) => sum + (item.inputTokens ?? 0) + (item.outputTokens ?? 0), 0);
  const profileName = (id: string) => profiles.find((item) => item.id === id)?.name ?? id;

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="request-logs-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={tr("请求日志", "Request logs")}>
        <div className="dialog-header">
          <div><strong>{tr("请求日志", "Request logs")}</strong><span>{tr("仅保存模型、用量、延迟和错误元数据，不保存消息正文", "Stores only model, usage, latency, and error metadata—never message content")}</span></div>
          <div className="dialog-header-actions">
            <IconButton label={tr("刷新请求日志", "Refresh request logs")} onClick={refresh} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : ""} /></IconButton>
            <IconButton label={tr("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
          </div>
        </div>
        <div className="request-log-toolbar">
          <label>{tr("模型", "Model")}<select value={model} onChange={(event) => setModel(event.target.value)}><option value="all">{tr("全部模型", "All models")}</option>{models.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
          <div className="request-log-metrics">
            <span><small>{tr("请求", "Requests")}</small><strong>{visible.length}</strong></span>
            <span><small>{tr("成功率", "Success rate")}</small><strong>{visible.length ? `${Math.round(success / visible.length * 100)}%` : "—"}</strong></span>
            <span><small>{tr("平均延迟", "Average latency")}</small><strong>{visible.length ? `${averageLatency} ms` : "—"}</strong></span>
            <span><small>Tokens</small><strong>{formatTokens(tokens)}</strong></span>
          </div>
        </div>
        <div className="request-log-list">
          {visible.map((item) => (
            <article className={`request-log-row ${item.status}`} key={item.id}>
              <span className="request-log-status" title={requestStatusLabel(item.status)} />
              <div className="request-log-main">
                <div><strong>{item.model}</strong><span>{profileName(item.profileId)}</span>{item.failoverIndex > 0 && <em>{tr("接管", "Failover")} #{item.failoverIndex}</em>}</div>
                <small>{item.protocol} · {new Date(item.startedAt).toLocaleString()}</small>
                {item.error && <p title={item.error}>{item.error}</p>}
              </div>
              <div className="request-log-numbers">
                <strong>{item.latencyMs} ms</strong>
                <span>{formatTokens((item.inputTokens ?? 0) + (item.outputTokens ?? 0))} tokens</span>
                {item.requestId && <small title={item.requestId}>Req {item.requestId.slice(0, 12)}</small>}
              </div>
            </article>
          ))}
          {!loading && visible.length === 0 && <div className="request-log-empty"><Activity size={24} /><strong>{tr("还没有请求记录", "No request records yet")}</strong><span>{tr("完成一次模型请求后，这里会显示不含正文的诊断元数据。", "After a model request, redacted diagnostic metadata appears here.")}</span></div>}
        </div>
        {error && <button className="skills-error" onClick={() => setError(null)}>{error}<X size={13} /></button>}
      </div>
    </div>
  );
}

function requestStatusLabel(status: ProviderRequestLog["status"]) {
  if (status === "success") return tr("成功", "Success");
  if (status === "cancelled") return tr("已取消", "Cancelled");
  if (status === "configuration_error") return tr("配置错误", "Configuration error");
  return tr("失败", "Failed");
}

function InstructionsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalKeyboard(onClose);
  const [content, setContent] = useState("");
  const [target, setTarget] = useState<ExternalConfigTarget>("codex");
  const [preview, setPreview] = useState<ConfigWritePreview | null>(null);
  const [result, setResult] = useState<ConfigWriteResult | null>(null);
  const [loading, setLoading] = useState(isDesktop());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCustomInstructions()
      .then(setContent)
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveCustomInstructions(content);
      setSaved(true);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await previewExternalPromptWrite(target, content));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await applyExternalPromptWrite(target, preview.confirmationToken));
      setPreview(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      await rollbackExternalPromptWrite(result.target, result.backupId);
      setResult(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="instructions-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Instructions">
        <div className="dialog-header">
          <div><strong>Instructions</strong><span>{tr("LevelUpAgent 与外部 CLI 共用的行为约束", "Shared behavior rules for LevelUpAgent and external CLIs")}</span></div>
          <IconButton label={tr("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="instructions-body">
          <label className="field instructions-editor">
            <span>{tr("自定义指令", "Custom instructions")} <small>{content.length.toLocaleString(getAppLocale())} / 32,000</small></span>
            <textarea
              value={content}
              maxLength={32_000}
              disabled={loading}
              onChange={(event) => { setContent(event.target.value); setSaved(false); setPreview(null); }}
              placeholder={tr("例如：优先复用现有架构；修改后运行相关测试；涉及破坏性操作时先说明影响。", "Example: Reuse the existing architecture; run relevant tests after changes; explain destructive actions first.")}
            />
          </label>
          <section className="prompt-sync" aria-label={tr("同步 Instructions", "Sync Instructions")}>
            <div className="prompt-sync-heading">
              <span><Save size={15} /><span><strong>{tr("同步到 CLI", "Sync to CLI")}</strong><small>{tr("写入标准指令文件，原文件会先备份", "Writes the standard instruction file after backing up the original")}</small></span></span>
              <div>
                <select value={target} onChange={(event) => { setTarget(event.target.value as ExternalConfigTarget); setPreview(null); setResult(null); }} aria-label={tr("Instructions 同步目标", "Instructions sync target")}>
                  <option value="codex">Codex · AGENTS.md</option>
                  <option value="claude">Claude · CLAUDE.md</option>
                  <option value="gemini">Gemini · GEMINI.md</option>
                  <option value="opencode">OpenCode · AGENTS.md</option>
                </select>
                <button className="secondary-button" disabled={busy || loading} onClick={inspect}>{tr("预览同步", "Preview sync")}</button>
              </div>
            </div>
            {preview && (
              <div className="config-preview">
                {preview.files.map((file) => (
                  <div key={file.path}>
                    <span title={file.path}>{file.exists ? tr("覆盖并备份", "Replace with backup") : tr("新建", "Create")} · {file.path}</span>
                    <pre>{file.diff}</pre>
                  </div>
                ))}
                <button className="primary-button" disabled={busy} onClick={apply}>{tr("确认同步并创建备份", "Confirm sync and create backup")}</button>
              </div>
            )}
            {result && (
              <div className="config-write-result">
                <span><Check size={14} /> {tr("已同步到", "Synced to")} {result.changedFiles[0]}</span>
                <button className="secondary-button" disabled={busy} onClick={rollback}>{tr("回滚本次同步", "Roll back this sync")}</button>
              </div>
            )}
          </section>
          {error && <button className="config-write-error" onClick={() => setError(null)}>{error}<X size={12} /></button>}
        </div>
        <div className="instructions-footer">
          <span>{saved ? tr("已保存，下一轮请求生效", "Saved; effective on the next request") : tr("保存后自动注入所有协议的系统提示词", "Saved instructions are injected into every protocol")}</span>
          <button className="secondary-button" onClick={onClose}>{tr("取消", "Cancel")}</button>
          <button className="primary-button" disabled={busy || loading} onClick={save}>{tr("保存 Instructions", "Save Instructions")}</button>
        </div>
      </div>
    </div>
  );
}

function SkillsDialog({
  workspace,
  onClose,
}: {
  workspace?: string;
  onClose: () => void;
}) {
  const dialogRef = useModalKeyboard(onClose);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [filter, setFilter] = useState<"all" | "enabled" | "issues">("all");
  const [loading, setLoading] = useState(isDesktop());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setSkills(await scanSkills(workspace));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [workspace]);

  const toggle = async (skill: SkillInfo, enabled: boolean) => {
    setBusyId(skill.id);
    setError(null);
    try {
      const updated = await setSkillEnabled(skill.id, enabled, workspace);
      setSkills((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusyId(null);
    }
  };

  const visible = skills.filter((skill) => {
    if (filter === "enabled") return skill.enabled;
    if (filter === "issues") return !skill.valid;
    return true;
  });
  const enabledCount = skills.filter((skill) => skill.enabled).length;
  const issueCount = skills.filter((skill) => !skill.valid).length;

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="skills-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Skills">
        <div className="dialog-header">
          <div><strong>Skills</strong><span>{tr("发现、校验与按需加载", "Discover, validate, and load on demand")}</span></div>
          <div className="dialog-header-actions">
            <IconButton label={tr("重新扫描 Skills", "Rescan Skills")} onClick={refresh} disabled={loading}>
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </IconButton>
            <IconButton label={tr("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
          </div>
        </div>
        <div className="skills-toolbar">
          <div className="protocol-switch skill-filter" aria-label={tr("Skill 筛选", "Skill filter")}>
            <button aria-pressed={filter === "all"} className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>{tr("全部", "All")} {skills.length}</button>
            <button aria-pressed={filter === "enabled"} className={filter === "enabled" ? "active" : ""} onClick={() => setFilter("enabled")}>{tr("已启用", "Enabled")} {enabledCount}</button>
            <button aria-pressed={filter === "issues"} className={filter === "issues" ? "active" : ""} onClick={() => setFilter("issues")}>{tr("问题", "Issues")} {issueCount}</button>
          </div>
          <span>{workspace ? `${tr("包含", "Including")} ${shortPath(workspace)} ${tr("的工作区 Skills", "workspace Skills")}` : tr("全局 Skills", "Global Skills")}</span>
        </div>
        <div className="skills-list">
          {visible.map((skill) => (
            <div className={`skill-row ${!skill.valid ? "invalid" : ""}`} key={skill.id}>
              <div className="skill-glyph"><BookOpen size={16} /></div>
              <div className="skill-detail">
                <div><strong>{skill.name}</strong><span>{skill.source}</span></div>
                <p>{skill.valid ? skill.description : skill.warning}</p>
                <small title={skill.path}>{skill.path}</small>
              </div>
              <label className="skill-toggle">
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  disabled={!skill.valid || busyId === skill.id}
                  onChange={(event) => toggle(skill, event.target.checked)}
                />
                <span>{skill.valid ? (skill.enabled ? tr("已启用", "Enabled") : tr("启用", "Enable")) : tr("无效", "Invalid")}</span>
              </label>
            </div>
          ))}
          {!loading && visible.length === 0 && (
            <div className="skills-empty">
              <BookOpen size={24} strokeWidth={1.5} />
              <strong>{skills.length === 0 ? tr("尚未发现 Skills", "No Skills discovered") : tr("此筛选下没有 Skills", "No Skills match this filter")}</strong>
              <span>{tr("支持 ~/.codex/skills、~/.claude/skills、~/.agents/skills 与项目内 .levelup/skills", "Supports ~/.codex/skills, ~/.claude/skills, ~/.agents/skills, and project .levelup/skills")}</span>
            </div>
          )}
          {loading && <div className="skills-empty"><RefreshCw size={22} className="spin" /><span>{tr("正在扫描本机 Skills…", "Scanning local Skills…")}</span></div>}
        </div>
        <div className="skills-footer">
          <span>{tr("只有显式启用且校验通过的 Skill 才会进入 Agent 上下文", "Only explicitly enabled and valid Skills enter Agent context")}</span>
          <button className="primary-button" onClick={onClose}>{tr("完成", "Done")}</button>
        </div>
        {error && <button className="skills-error" onClick={() => setError(null)}>{error}<X size={13} /></button>}
      </div>
    </div>
  );
}

function McpDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalKeyboard(onClose);
  const [servers, setServers] = useState<McpServerSnapshot[]>([]);
  const [draft, setDraft] = useState<McpServerConfig>(() => emptyMcpServer());
  const [argsText, setArgsText] = useState("");
  const [environmentText, setEnvironmentText] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [secretEnvironmentText, setSecretEnvironmentText] = useState("");
  const [secretHeadersText, setSecretHeadersText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectServer = (server: McpServerConfig) => {
    setDraft({ ...server });
    setArgsText(server.args.join("\n"));
    setEnvironmentText(recordLines(server.environment));
    setHeadersText(recordLines(server.headers));
    setSecretEnvironmentText(secretLines(server.secretEnvironmentKeys));
    setSecretHeadersText(secretLines(server.secretHeaderKeys));
    setError(null);
  };

  const refreshServers = async (preferredId?: string) => {
    const next = await listMcpServers();
    setServers(next);
    const selected = next.find((item) => item.server.id === preferredId);
    if (selected) selectServer(selected.server);
    return next;
  };

  useEffect(() => {
    if (!isDesktop()) return;
    refreshServers().catch((reason) => setError(errorText(reason)));
  }, []);

  const update = <K extends keyof McpServerConfig>(key: K, value: McpServerConfig[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const materialize = (): { server: McpServerConfig; secrets: McpSecretValues } => {
    const secretEnvironment = parsePairs(secretEnvironmentText, true);
    const secretHeaders = parsePairs(secretHeadersText, true);
    return {
      server: {
        ...draft,
        command: draft.transport === "stdio" ? draft.command?.trim() : undefined,
        args: argsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        url: draft.transport === "streamable_http" ? draft.url?.trim() : undefined,
        environment: parsePairs(environmentText).values,
        headers: parsePairs(headersText).values,
        secretEnvironmentKeys: secretEnvironment.keys,
        secretHeaderKeys: secretHeaders.keys,
      },
      secrets: {
        environment: secretEnvironment.values,
        headers: secretHeaders.values,
      },
    };
  };

  const save = async (connect = false) => {
    if (!isDesktop()) {
      setError(tr("请在桌面应用中管理 MCP 服务器", "Manage MCP servers in the desktop app"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = materialize();
      await upsertMcpServer(input.server, input.secrets);
      if (connect) await startMcpServer(input.server.id);
      const next = await refreshServers(input.server.id);
      const selected = next.find((item) => item.server.id === input.server.id);
      if (selected) selectServer(selected.server);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectedSnapshot = servers.find((item) => item.server.id === draft.id);
  const isPersisted = Boolean(selectedSnapshot);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="mcp-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={tr("MCP 服务器", "MCP servers")}>
        <div className="dialog-header">
          <div><strong>{tr("MCP 服务器", "MCP servers")}</strong><span>{tr("外部工具与上下文服务", "External tools and context services")}</span></div>
          <IconButton label={tr("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="mcp-layout">
          <aside className="mcp-server-list">
            <div className="mcp-list-heading">
              <span>{tr("服务器", "Servers")}</span>
              <IconButton label={tr("添加服务器", "Add server")} onClick={() => selectServer(emptyMcpServer())}><Plus size={16} /></IconButton>
            </div>
            <div className="mcp-server-rows">
              {servers.map((item) => (
                <button className={`mcp-server-row ${item.server.id === draft.id ? "active" : ""}`} key={item.server.id} onClick={() => selectServer(item.server)}>
                  <span className={`mcp-status ${item.status}`} />
                  <span><strong>{item.server.name}</strong><small>{mcpStatusLabel(item)}</small></span>
                </button>
              ))}
              {servers.length === 0 && <div className="mcp-list-empty">{tr("尚未添加服务器", "No servers added")}</div>}
            </div>
          </aside>
          <div className="mcp-editor">
            <div className="mcp-editor-heading">
              <label className="field">
                <span>{tr("名称", "Name")}</span>
                <input value={draft.name} onChange={(event) => update("name", event.target.value)} />
              </label>
              <label className="mcp-enabled">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} />
                <span>{tr("随 Agent 启用", "Enable with Agent")}</span>
              </label>
            </div>
            <div className="field">
              <span>{tr("传输方式", "Transport")}</span>
              <div className="protocol-switch mcp-transport-switch">
                {([["stdio", tr("本地 stdio", "Local stdio")], ["streamable_http", "Streamable HTTP"]] as [McpTransport, string][]).map(([value, label]) => (
                  <button aria-pressed={draft.transport === value} className={draft.transport === value ? "active" : ""} key={value} onClick={() => update("transport", value)}>{label}</button>
                ))}
              </div>
            </div>
            {draft.transport === "stdio" ? (
              <>
                <label className="field"><span>{tr("命令", "Command")}</span><input value={draft.command ?? ""} onChange={(event) => update("command", event.target.value)} placeholder="npx" /></label>
                <label className="field"><span>{tr("参数", "Arguments")} <small>{tr("每行一个", "One per line")}</small></span><textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={"-y\n@modelcontextprotocol/server-filesystem"} /></label>
              </>
            ) : (
              <label className="field"><span>{tr("服务器 URL", "Server URL")}</span><input value={draft.url ?? ""} onChange={(event) => update("url", event.target.value)} placeholder="https://example.com/mcp" /></label>
            )}
            <div className="mcp-pair-grid">
              <label className="field"><span>{draft.transport === "stdio" ? tr("环境变量", "Environment variables") : tr("请求头", "Headers")} <small>KEY=value</small></span><textarea value={draft.transport === "stdio" ? environmentText : headersText} onChange={(event) => draft.transport === "stdio" ? setEnvironmentText(event.target.value) : setHeadersText(event.target.value)} placeholder={draft.transport === "stdio" ? "LOG_LEVEL=warn" : "X-Client=LevelUpAgent"} /></label>
              <label className="field"><span>{tr("敏感", "Secret ")}{draft.transport === "stdio" ? tr("变量", "variables") : tr("请求头", "headers")} <small>{tr("存入系统凭据库", "Stored in OS credential vault")}</small></span><textarea value={draft.transport === "stdio" ? secretEnvironmentText : secretHeadersText} onChange={(event) => draft.transport === "stdio" ? setSecretEnvironmentText(event.target.value) : setSecretHeadersText(event.target.value)} placeholder={draft.transport === "stdio" ? "API_TOKEN=" : "Authorization=Bearer …"} autoComplete="off" /></label>
            </div>
            {selectedSnapshot?.lastError && <div className="dialog-error">{selectedSnapshot.lastError}</div>}
            {error && <div className="dialog-error">{error}</div>}
          </div>
        </div>
        <div className="mcp-footer">
          <div>
            {isPersisted && <button className="danger-text-button" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await deleteMcpServer(draft.id);
                const next = await refreshServers();
                selectServer(next[0]?.server ?? emptyMcpServer());
              } catch (reason) { setError(errorText(reason)); }
              finally { setBusy(false); }
            }}><Trash2 size={14} /> {tr("删除", "Delete")}</button>}
          </div>
          <span />
          {selectedSnapshot?.status === "connected" && <button className="secondary-button" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await stopMcpServer(draft.id); await refreshServers(draft.id); }
            catch (reason) { setError(errorText(reason)); }
            finally { setBusy(false); }
          }}><Power size={14} /> {tr("停止", "Stop")}</button>}
          <button className="secondary-button" onClick={() => save(false)} disabled={busy || !draft.name.trim()}><Save size={14} /> {tr("保存", "Save")}</button>
          <button className="primary-button" onClick={() => save(true)} disabled={busy || !draft.name.trim()}><Play size={14} /> {tr("保存并测试", "Save and test")}</button>
        </div>
      </div>
    </div>
  );
}

function emptyMcpServer(): McpServerConfig {
  return {
    id: `mcp-${crypto.randomUUID()}`,
    name: tr("新服务器", "New server"),
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: [],
    environment: {},
    headers: {},
    secretEnvironmentKeys: [],
    secretHeaderKeys: [],
  };
}

function parsePairs(text: string, keepEmpty = false) {
  const values: Record<string, string> = {};
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    const key = (separator >= 0 ? line.slice(0, separator) : line).trim();
    if (!key) continue;
    const value = separator >= 0 ? line.slice(separator + 1) : "";
    keys.push(key);
    if (keepEmpty ? value.length > 0 : true) values[key] = value;
  }
  return { values, keys: [...new Set(keys)] };
}

function recordLines(values: Record<string, string>) {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
}

function secretLines(keys: string[]) {
  return keys.map((key) => `${key}=`).join("\n");
}

function mcpStatusLabel(item: McpServerSnapshot) {
  if (item.status === "connected") return `${item.toolCount} ${tr("个工具", "tools")}`;
  if (item.status === "error") return tr("连接错误", "Connection error");
  if (item.status === "disabled") return tr("已停用", "Disabled");
  return item.server.transport === "stdio" ? tr("本地进程", "Local process") : tr("远程服务", "Remote service");
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function friendlyAgentError(reason: string) {
  const marker = "[LEVELUP_TOOL_CALLING_UNSUPPORTED]";
  if (!reason.includes(marker)) return reason;
  const detail = reason.replace(marker, "").trim();
  return `${detail}\n\n${tr(
    "该模型或兼容接口不支持工具调用。请切换到“问答”模式，或选择支持 Function/Tool Calling 的模型。",
    "This model or compatible endpoint does not support tool calling. Switch to Ask mode or choose a model with Function/Tool Calling support.",
  )}`;
}

function parseMediaToolAssets(content: string): MediaAsset[] | null {
  if (!content.trimStart().startsWith("{")) return null;
  try {
    const value = JSON.parse(content) as { assets?: unknown };
    if (!Array.isArray(value.assets)) return null;
    const assets = value.assets.filter((item): item is MediaAsset => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<MediaAsset>;
      return typeof candidate.id === "string"
        && (candidate.kind === "image" || candidate.kind === "video" || candidate.kind === "audio")
        && (candidate.status === "queued" || candidate.status === "in_progress" || candidate.status === "completed" || candidate.status === "failed");
    });
    return assets;
  } catch {
    return null;
  }
}

function toolIcon(call: ToolCall) {
  if (call.name === "generate_images") return <ImagePlus size={15} />;
  if (call.name === "generate_videos") return <Video size={15} />;
  if (call.name === "generate_speech") return <AudioLines size={15} />;
  if (call.name === "check_media_jobs") return <RefreshCw size={15} />;
  if (call.name === "get_goal" || call.name === "update_goal") return <Flag size={15} />;
  if (call.name === "delegate_task" || call.name === "apply_subagent_patch") return <GitMerge size={15} />;
  if (call.name === "read_skill") return <BookOpen size={15} />;
  if (call.name.startsWith("mcp_")) return <Network size={15} />;
  if (call.name === "run_command") return <TerminalSquare size={15} />;
  if (call.name === "write_file") return <FileCode2 size={15} />;
  if (call.name === "delete_file") return <Trash2 size={15} />;
  if (call.name === "read_file") return <Code2 size={15} />;
  return <Folder size={15} />;
}

function toolLabel(call: ToolCall) {
  const labels: Record<string, string> = {
    list_files: tr("浏览文件", "Browse files"),
    read_file: tr("读取文件", "Read file"),
    search_files: tr("搜索项目", "Search project"),
    write_file: tr("写入文件", "Write file"),
    delete_file: tr("删除文件", "Delete file"),
    run_command: tr("运行命令", "Run command"),
    read_skill: tr("读取 Skill", "Read Skill"),
    get_goal: tr("读取 Goal", "Read Goal"),
    update_goal: tr("更新 Goal", "Update Goal"),
    generate_images: tr("生成图片", "Generate images"),
    generate_videos: tr("生成视频", "Generate videos"),
    generate_speech: tr("生成语音", "Generate speech"),
    check_media_jobs: tr("检查媒体任务", "Check media jobs"),
    delegate_task: tr("子 Agent · 隔离执行", "Sub-Agent · Isolated run"),
    apply_subagent_patch: tr("子 Agent · 应用补丁", "Sub-Agent · Apply patch"),
  };
  if (call.name.startsWith("mcp_")) {
    const parts = call.name.split("_");
    const stem = parts.slice(2, -1).join("_");
    return `MCP · ${stem || tr("工具", "Tool")}`;
  }
  return labels[call.name] ?? call.name;
}

function toolSummary(call: ToolCall) {
  if (typeof call.arguments.prompt === "string") return call.arguments.prompt;
  const value = call.arguments.path ?? call.arguments.command ?? call.arguments.query ?? call.arguments.task ?? call.arguments.runId;
  if (value !== undefined) return String(value).slice(0, 100);
  return JSON.stringify(call.arguments).slice(0, 100);
}

function toolFullSummary(call: ToolCall) {
  if (typeof call.arguments.prompt === "string") return call.arguments.prompt;
  return JSON.stringify(call.arguments, null, 2);
}

function shortPath(path: string) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

interface ThreadProjectGroup {
  key: string;
  name: string;
  workspace?: string;
  threads: AgentThread[];
  updatedAt: number;
}

function workspaceKey(workspace?: string) {
  if (!workspace) return "__no_project__";
  const normalized = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isDefaultWorkspace(workspace?: string, defaultWorkspace?: string) {
  return Boolean(workspace && defaultWorkspace && workspaceKey(workspace) === workspaceKey(defaultWorkspace));
}

function groupThreadsByWorkspace(threads: AgentThread[], pinnedThreadIds: Set<string>, defaultWorkspace?: string): ThreadProjectGroup[] {
  const projects = new Map<string, ThreadProjectGroup>();
  for (const thread of [...threads].sort((left, right) => {
    const pinnedOrder = Number(pinnedThreadIds.has(right.id)) - Number(pinnedThreadIds.has(left.id));
    return pinnedOrder || right.updatedAt - left.updatedAt;
  })) {
    const key = workspaceKey(thread.workspace);
    const project = projects.get(key);
    if (project) {
      project.threads.push(thread);
      project.updatedAt = Math.max(project.updatedAt, thread.updatedAt);
      continue;
    }
    projects.set(key, {
      key,
      name: isDefaultWorkspace(thread.workspace, defaultWorkspace)
        ? tr("临时工作区", "Temporary workspace")
        : thread.workspace ? shortPath(thread.workspace) : tr("未选择项目", "No project"),
      workspace: thread.workspace,
      threads: [thread],
      updatedAt: thread.updatedAt,
    });
  }
  return [...projects.values()].sort((left, right) => {
    if (!left.workspace) return 1;
    if (!right.workspace) return -1;
    return right.updatedAt - left.updatedAt || left.name.localeCompare(right.name);
  });
}

function localizedThreadTitle(title: string) {
  return isDefaultThreadTitle(title) ? tr("新会话", "New conversation") : title;
}

function isDefaultThreadTitle(title: string) {
  return title === "新任务" || title === "New task" || title === "新会话" || title === "New conversation";
}

function protocolLabel(protocol: ProviderProtocol) {
  if (protocol === "openai_responses") return "Responses";
  if (protocol === "openai_chat") return "Chat Completions";
  if (protocol === "anthropic_messages") return "Messages";
  return "GenerateContent";
}

function providerEndpointPreview(profile: ProviderProfile) {
  const model = profile.model.trim().replace(/^models\//, "") || "MODEL_ID";
  const path = profile.protocol === "openai_responses"
    ? "/v1/responses"
    : profile.protocol === "openai_chat"
      ? "/v1/chat/completions"
      : profile.protocol === "anthropic_messages"
        ? "/v1/messages"
        : `/v1beta/models/${model}:generateContent`;
  try {
    const base = new URL(profile.baseUrl.trim());
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const requested = path.replace(/^\/+/, "").split("/");
    const baseSegments = base.pathname.split("/").filter(Boolean);
    const requestedVersion = requested[0] ?? "";
    const baseVersion = baseSegments[baseSegments.length - 1] ?? "";
    if (isApiVersionSegment(requestedVersion) && isApiVersionSegment(baseVersion)) requested.shift();
    return new URL(requested.join("/"), base).toString();
  } catch {
    return "";
  }
}

function isApiVersionSegment(value: string) {
  return /^v\d+[a-z0-9_-]*$/i.test(value);
}

function validateProviderBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(tr("Base URL 无效", "Base URL is invalid"));
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || Boolean(url.username)
    || Boolean(url.password)
    || Boolean(url.search)
    || Boolean(url.hash)
  ) {
    throw new Error(tr(
      "Base URL 必须使用 HTTP(S)，且不能包含账号、密码、查询参数或片段",
      "Base URL must use HTTP(S) and cannot contain credentials, a query, or a fragment",
    ));
  }
}

function goalStatusLabel(status: GoalState["status"]) {
  const labels: Record<GoalState["status"], string> = {
    active: tr("执行中", "Active"),
    paused: tr("已暂停", "Paused"),
    auditing: tr("审计中", "Auditing"),
    completed: tr("已完成", "Completed"),
    blocked: tr("已阻塞", "Blocked"),
    cancelled: tr("已取消", "Cancelled"),
  };
  return labels[status];
}

function formatTokens(value: number) {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
}

function modeLabel(mode: AgentMode) {
  if (mode === "agent") return tr("默认", "Default");
  if (mode === "plan") return tr("规划", "Plan");
  if (mode === "goal") return tr("目标", "Goal");
  return tr("问答", "Chat");
}

function assistantMessageIdentity(profile: ProviderProfile) {
  return {
    modelName: profile.model.trim() || profile.name.trim() || "LevelUpAgent",
    providerBrand: modelProviderBrand(profile),
  } satisfies Pick<AgentMessage, "modelName" | "providerBrand">;
}

function modelProviderBrand(profile: ProviderProfile): ModelProviderBrand {
  const identity = `${profile.name} ${profile.model} ${profile.baseUrl}`.toLocaleLowerCase();
  if (identity.includes("antigravity")) return "antigravity";
  if (/\b(grok|xai|x\.ai)\b/.test(identity)) return "grok";
  if (/\b(claude|anthropic)\b/.test(identity)) return "anthropic";
  if (/\b(gemini|google|generativelanguage)\b/.test(identity)) return "gemini";
  if (/\b(gpt|openai|o1|o3|o4)\b/.test(identity)) return "openai";
  return "levelup";
}

function providerBrandLabel(brand: ModelProviderBrand) {
  if (brand === "openai") return "OpenAI";
  if (brand === "anthropic") return "Anthropic";
  if (brand === "gemini") return "Gemini";
  if (brand === "antigravity") return "Antigravity";
  if (brand === "grok") return "Grok / xAI";
  return "LevelUpAgent";
}

function finalizeConversationMessages(messages: AgentMessage[], startedAt: number) {
  const completedAt = Date.now();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "assistant") continue;
    const next = [...messages];
    next[index] = { ...messages[index], durationMs: Math.max(0, completedAt - startedAt) };
    return next;
  }
  return messages;
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${Math.max(0.1, durationMs / 1_000).toFixed(1)} ${tr("秒", "s")}`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} ${tr("秒", "s")}`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} ${tr("分", "m")} ${seconds} ${tr("秒", "s")}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${tr("小时", "h")} ${minutes % 60} ${tr("分", "m")}`;
}

function modeDescription(mode: AgentMode) {
  if (mode === "agent") return tr("可读取、修改文件并运行命令，是否询问由权限等级决定", "Read and edit files and run commands according to the selected permission level");
  if (mode === "plan") return tr("只读取和分析项目，不允许写文件或运行命令", "Read and analyze the project without writing files or running commands");
  if (mode === "goal") return tr("围绕持久目标连续执行，直到完成或暂停", "Continue working on a persistent goal until completion or pause");
  return tr("纯对话，不向模型提供本地工具", "Conversation only; no local tools are provided to the model");
}

function permissionLabel(level: PermissionLevel) {
  if (level === "request") return tr("请求批准", "Request approval");
  if (level === "agent") return tr("Agent 审批", "Agent approval");
  return tr("完全访问", "Full access");
}

function permissionDescription(level: PermissionLevel) {
  if (level === "request") return tr("编辑文件和运行命令时始终询问", "Always ask before editing files or running commands");
  if (level === "agent") return tr("仅对检测到的风险操作请求批准", "Ask only for operations detected as risky");
  return tr("无需批准即可运行工具和访问您的电脑", "Run tools and access your computer without approval");
}

function permissionBehaviorLabel(level: PermissionLevel, mode: AgentMode) {
  if (mode === "plan" || mode === "chat") return tr("已禁用", "Disabled");
  if (level === "request") return tr("每次询问", "Always ask");
  if (level === "agent") return tr("风险时询问", "Ask if risky");
  return tr("自动", "Automatic");
}

function permissionIcon(level: PermissionLevel, size: number) {
  if (level === "request") return <Hand size={size} />;
  if (level === "agent") return <Bot size={size} />;
  return <ShieldAlert size={size} />;
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(getAppLocale(), { hour: "2-digit", minute: "2-digit" }).format(value);
}

export default App;
