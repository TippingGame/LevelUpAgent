import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AgentMessage,
  AgentMode,
  AgentStreamEvent,
  AgentThread,
  AgentTurnResponse,
  AppUpdateInfo,
  ConfigWritePreview,
  ConfigWriteResult,
  ExternalConfigCandidate,
  ExternalConfigTarget,
  GitDiff,
  GitWorkspaceSnapshot,
  GitRollbackPreview,
  GitRollbackResult,
  GitStatus,
  GoalState,
  GatewayDiagnostics,
  HarnessDraftRequest,
  HarnessSubmission,
  HarnessOperationState,
  HarnessPreflightReport,
  HarnessPolicyDecision,
  HarnessToolPolicyRequest,
  HarnessRunRequest,
  HarnessRunOutcome,
  HarnessRuntimeEvent,
  HarnessApprovalRecord,
  HarnessPendingApproval,
  HarnessApprovalResolution,
  HarnessRecoveryItem,
  HarnessQueueItem,
  HarnessSessionNode,
  HarnessForkSessionRequest,
  ImageAttachment,
  AttachmentPreview,
  ModelInfo,
  McpSecretValues,
  McpServerConfig,
  McpServerSnapshot,
  MediaAsset,
  MediaAssetPage,
  MediaBatchResult,
  MediaCatalog,
  MediaGenerationRequest,
  MediaKind,
  HatchEnvironment,
  PetActivity,
  PetDashboard,
  PetBackupResult,
  PetLifeSettings,
  PetMemory,
  PetProfile,
  PetProgress,
  PetRuntimeSnapshot,
  ProviderProfile,
  ProviderModelCatalog,
  ProviderSettings,
  ProviderHealth,
  ProviderRequestLog,
  ReasoningEffort,
  SkillInfo,
  SkillInstallResult,
  SkillLocation,
  SkillMutationResult,
  ToolCall,
  ToolExecutionResponse,
  ThemeManifest,
  ThemePackage,
  ThemeGenerationBackgroundInput,
  ThemeGenerationTarget,
  ResolvedLayout,
  WritingProjectRecord,
  PermissionLevel,
} from "./types";
import { localDateKey } from "./petAutonomy";
import {
  createHatchBootstrapToolRequest,
  createToolExecutionRequest,
  type HatchBootstrapToolOptions,
} from "./toolExecutionRequest";

export const isDesktop = () => "__TAURI_INTERNALS__" in window;

const browserPetDashboard: PetDashboard = {
  pets: [{
    id: "yui",
    displayName: "Yui",
    description: "A tiny Codex digital pet inspired by Yui from Sword Art Online.",
    spritesheetPath: "/pets/yui/spritesheet.webp",
    removable: false,
  }],
  activePetId: "yui",
  progress: {
    petId: "yui",
    level: 1,
    totalXp: 0,
    currentXp: 0,
    requiredXp: 100,
    progress: 0,
    totalTokens: 0,
    requests: 0,
  },
  memories: [],
  overlayVisible: true,
  scale: 0.75,
  life: {
    version: 6,
    needs: { energy: 86, focus: 68, curiosity: 64, social: 72, mood: 82 },
    behavior: { state: "idle", reason: "browser-preview", message: "I am here, taking in the day.", since: Date.now(), nextDecisionAt: Date.now() + 120_000 },
    settings: { autonomyEnabled: true, learningEnabled: true, movementEnabled: true, dailyPlanEnabled: true, remindersEnabled: true, launchAtLogin: false, studyGoalMinutes: 120, knowledgeGoal: 2, quietStartMinute: 1320, quietEndMinute: 480, patrolSpeed: 1 },
    today: { date: localDateKey(), planGeneratedAt: Date.now(), planReason: "Browser preview", schedule: [], checkIns: {}, reflection: "", taskReminders: {}, chatterSlots: {}, studyLaunches: {} },
    tasks: [],
    knowledge: [],
    learningQuests: [],
    recentObservations: [],
    rewards: [],
    activityLog: [],
    history: [],
    stats: { todayStudyMs: 0, totalStudyMs: 0, knowledgeCount: 0, todayKnowledgeCount: 0, completedTasks: 0, checkedIn: 0, missedCheckIns: 0, rewardCount: 0, streakDays: 0 },
    bornAt: Date.now(),
    lastTickAt: Date.now(),
  },
};

export async function getPetRuntime(): Promise<PetRuntimeSnapshot> {
  if (!isDesktop()) return { dashboard: browserPetDashboard, activities: [] };
  return invoke<PetRuntimeSnapshot>("get_pet_runtime");
}

export async function selectPet(petId: string): Promise<PetDashboard> {
  if (!isDesktop()) return { ...browserPetDashboard, activePetId: petId };
  return invoke<PetDashboard>("select_pet", { petId });
}

export async function setPetOverlayVisible(visible: boolean): Promise<PetDashboard> {
  if (!isDesktop()) return { ...browserPetDashboard, overlayVisible: visible };
  return invoke<PetDashboard>("set_pet_overlay_visible", { visible });
}

export async function setPetScale(petId: string, scale: number): Promise<PetDashboard> {
  if (!isDesktop()) return { ...browserPetDashboard, activePetId: petId, scale };
  return invoke<PetDashboard>("set_pet_scale", { petId, scale });
}

export async function selectAndInstallPet(): Promise<PetProfile | null> {
  if (!isDesktop()) return null;
  const sourcePath = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Codex pet package", extensions: ["json"] }],
  });
  if (typeof sourcePath !== "string") return null;
  return installPet(sourcePath);
}

export async function installPet(sourcePath: string): Promise<PetProfile> {
  return invoke<PetProfile>("install_pet", { sourcePath });
}

export async function removePet(petId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke<boolean>("remove_pet", { petId });
}

export async function recordPetUsage(
  petId: string,
  usageId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<PetProgress> {
  if (!isDesktop()) return browserPetDashboard.progress;
  return invoke<PetProgress>("record_pet_usage", {
    petId,
    usageId,
    inputTokens: Math.max(0, Math.floor(inputTokens)),
    outputTokens: Math.max(0, Math.floor(outputTokens)),
  });
}

export async function learnPetMemory(petId: string, text: string): Promise<PetMemory[]> {
  if (!isDesktop()) return [];
  return invoke<PetMemory[]>("learn_pet_memory", { petId, text });
}

export async function deletePetMemory(petId: string, memoryId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke<boolean>("delete_pet_memory", { petId, memoryId });
}

export async function getPetHatchEnvironment(): Promise<HatchEnvironment> {
  if (!isDesktop()) {
    return {
      configured: false,
      bundled: true,
      codexHome: "",
      workDirectory: "",
      packageDirectory: "",
      missing: [{ id: "desktop", detail: "LevelUpAgent desktop app" }],
    };
  }
  return invoke<HatchEnvironment>("get_pet_hatch_environment");
}

export async function configurePetHatch(): Promise<HatchEnvironment> {
  if (!isDesktop()) return getPetHatchEnvironment();
  return invoke<HatchEnvironment>("configure_pet_hatch");
}

export async function importHatchedPets(afterMs = 0): Promise<PetProfile[]> {
  if (!isDesktop()) return [];
  return invoke<PetProfile[]>("import_hatched_pets", { afterMs });
}

export async function updatePetActivities(activities: PetActivity[]): Promise<PetActivity[]> {
  if (!isDesktop()) return activities;
  return invoke<PetActivity[]>("update_pet_activities", { activities });
}

export async function openPetChat(petId: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("open_pet_chat", { petId });
}

export async function openCompletedTask(threadId: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("open_completed_task", { threadId });
}

export type PetWorkspaceView = "life" | "plan" | "knowledge";

export async function openPetWorkspace(petId: string, view: PetWorkspaceView = "life"): Promise<void> {
  if (!isDesktop()) return;
  await invoke("open_pet_workspace", { petId, view });
}

export function petAssetUrl(path: string): string {
  if (!path || path.startsWith("/") || /^(?:https?:|data:|blob:|asset:)/i.test(path)) return path;
  return isDesktop() ? convertFileSrc(path) : "/pets/yui/spritesheet.webp";
}

export async function listThemes(): Promise<ThemeManifest[]> {
  if (!isDesktop()) return [];
  return invoke<ThemeManifest[]>("list_themes");
}

export async function loadTheme(themeId: string): Promise<ThemePackage> {
  return invoke<ThemePackage>("load_theme", { themeId });
}

export async function loadThemeLayout(themeId: string): Promise<ResolvedLayout> {
  return invoke<ResolvedLayout>("load_theme_layout", { themeId });
}

export async function selectAndInstallTheme(): Promise<ThemeManifest | null> {
  if (!isDesktop()) return null;
  const sourcePath = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "LevelUpAgent theme", extensions: ["levelup-theme"] }],
  });
  if (typeof sourcePath !== "string") return null;
  return installTheme(sourcePath);
}

export async function installTheme(sourcePath: string): Promise<ThemeManifest> {
  if (!isDesktop()) throw new Error("Theme installation is available only in the desktop app");
  return invoke<ThemeManifest>("install_theme", { sourcePath });
}

export async function prepareThemeGeneration(
  workspace: string,
  background?: ThemeGenerationBackgroundInput,
): Promise<ThemeGenerationTarget> {
  if (!isDesktop()) throw new Error("Theme generation is available only in the desktop app");
  return invoke<ThemeGenerationTarget>("prepare_theme_generation", { workspace, background: background ?? null });
}

export async function loadThemeGenerationGuidance(): Promise<string> {
  if (!isDesktop()) return "";
  return invoke<string>("load_theme_generation_guidance");
}

export async function installThemeFile(file: File, companion?: File): Promise<ThemeManifest> {
  if (!isDesktop()) throw new Error("Theme installation is available only in the desktop app");
  const sourcePath = (file as File & { path?: string }).path;
  if (sourcePath?.trim() && /\.levelup-theme$/i.test(sourcePath.trim())) return installTheme(sourcePath);
  const dataBase64 = await readFileAsBase64(file);
  const layoutDataBase64 = companion ? await readFileAsBase64(companion) : undefined;
  return invoke<ThemeManifest>("install_theme_data", {
    payload: {
      name: clipboardThemePackageName(file.name),
      dataBase64,
      layoutName: companion?.name,
      layoutDataBase64,
    },
  });
}

export async function installThemeText(text: string): Promise<ThemeManifest> {
  const file = new File([text], "pasted.levelup-theme", { type: "application/json" });
  return installThemeFile(file);
}

export async function uninstallTheme(themeId: string): Promise<boolean> {
  return invoke<boolean>("uninstall_theme", { themeId });
}

export async function getDefaultWorkspace(): Promise<string | null> {
  if (!isDesktop()) return null;
  return invoke<string>("get_default_workspace");
}

export async function selectWorkspace(): Promise<string | null> {
  if (!isDesktop()) return null;
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function selectAttachments(): Promise<ImageAttachment[]> {
  if (!isDesktop()) return [];
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{
      name: "Images, PDF, Office, text, and code",
      extensions: ["png", "jpg", "jpeg", "webp", "gif", "pdf", "docx", "xlsx", "pptx", "txt", "log", "md", "markdown", "json", "jsonc", "toml", "yaml", "yml", "xml", "csv", "tsv", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "rb", "php", "sh", "ps1", "sql", "html", "css", "scss", "vue", "svelte"],
    }],
  });
  const paths = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : [];
  return importAttachments(paths);
}

export async function importAttachments(sourcePaths: string[]): Promise<ImageAttachment[]> {
  if (!isDesktop() || sourcePaths.length === 0) return [];
  return invoke<ImageAttachment[]>("import_image_attachments", { sourcePaths: sourcePaths.slice(0, 12) });
}

export async function importClipboardImages(files: File[]): Promise<ImageAttachment[]> {
  const images = files.filter((file) => file.type.startsWith("image/")).slice(0, 8);
  if (!isDesktop() || images.length === 0) return [];
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const payloads = await Promise.all(images.map(async (file, index) => ({
    name: file.name || `clipboard-${timestamp}-${index + 1}.${imageExtension(file.type)}`,
    dataBase64: await readFileAsBase64(file),
  })));
  return invoke<ImageAttachment[]>("import_clipboard_images", { images: payloads });
}

export async function importMediaReferences(sourcePaths: string[]): Promise<ImageAttachment[]> {
  if (!isDesktop() || sourcePaths.length === 0) return [];
  return invoke<ImageAttachment[]>("import_media_references", { sourcePaths: sourcePaths.slice(0, 7) });
}

export async function importClipboardAttachments(files: File[]): Promise<ImageAttachment[]> {
  const selected = files.slice(0, 12);
  if (!isDesktop() || selected.length === 0) return [];
  const sourcePaths = selected.map((file) => (file as File & { path?: string }).path?.trim() ?? "");
  if (sourcePaths.every(Boolean)) return importAttachments(sourcePaths);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const attachments = await Promise.all(selected.map(async (file, index) => ({
    name: clipboardAttachmentName(file, timestamp, index),
    dataBase64: await readFileAsBase64(file),
  })));
  return invoke<ImageAttachment[]>("import_clipboard_attachments", { attachments });
}

export async function deleteImageAttachment(attachmentId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke<boolean>("delete_image_attachment", { attachmentId });
}

export async function previewAttachment(attachment: ImageAttachment): Promise<AttachmentPreview> {
  return invoke<AttachmentPreview>("preview_attachment", {
    attachmentId: attachment.id,
    name: attachment.name,
  });
}

export async function selectImageReferences(): Promise<ImageAttachment[]> {
  if (!isDesktop()) return [];
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  const paths = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : [];
  return importAttachments(paths.slice(0, 8));
}

export async function regeneratePetDailyPlan(petId: string): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("regenerate_pet_daily_plan", { petId });
}

export async function togglePetStudy(petId: string, source = "manual"): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("toggle_pet_study", { petId, source });
}

export async function addPetTask(input: {
  petId: string;
  title: string;
  notes?: string;
  dueDate?: string;
  recurrence?: "daily" | "weekdays" | "weekly";
  priority?: number;
}): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("add_pet_task", {
    petId: input.petId,
    title: input.title,
    notes: input.notes ?? "",
    dueDate: input.dueDate || null,
    recurrence: input.recurrence || null,
    priority: input.priority ?? 2,
  });
}

export async function setPetTaskCompleted(petId: string, taskId: string, completed: boolean): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("set_pet_task_completed", { petId, taskId, completed });
}

export async function deletePetTask(petId: string, taskId: string): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("delete_pet_task", { petId, taskId });
}

export async function completePetScheduleItem(petId: string, itemId: string, completed: boolean): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("complete_pet_schedule_item", { petId, itemId, completed });
}

export async function checkInPet(petId: string): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("check_in_pet", { petId });
}

export async function bondWithPet(petId: string): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("bond_with_pet", { petId });
}

export async function respondToPetPrompt(petId: string, promptId: string, action: string): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("respond_to_pet_prompt", { petId, promptId, action });
}

export async function recordPetKnowledge(input: {
  petId: string;
  title: string;
  summary: string;
  source?: string;
  sourceKind?: string;
  sourceRef?: string;
  tags?: string[];
  confidence?: number;
}): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("record_pet_knowledge", {
    petId: input.petId,
    title: input.title,
    summary: input.summary,
    source: input.source ?? "Manual note",
    sourceKind: input.sourceKind ?? "other",
    sourceRef: input.sourceRef ?? null,
    tags: input.tags ?? [],
    confidence: input.confidence ?? 0.85,
  });
}

export async function deletePetKnowledge(petId: string, knowledgeId: string): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("delete_pet_knowledge", { petId, knowledgeId });
}

export async function settlePetDay(petId: string, reflection: string): Promise<PetDashboard> {
  if (!isDesktop()) return browserPetDashboard;
  return invoke<PetDashboard>("settle_pet_day", { petId, reflection });
}

export async function updatePetLifeSettings(petId: string, settings: PetLifeSettings): Promise<PetDashboard> {
  if (!isDesktop()) return { ...browserPetDashboard, life: { ...browserPetDashboard.life, settings } };
  return invoke<PetDashboard>("update_pet_life_settings", { petId, settings });
}

export async function setPetWindowPosition(petId: string, x: number, y: number): Promise<void> {
  if (!isDesktop()) return;
  await invoke("set_pet_window_position", { petId, x, y });
}

export async function exportPetBackup(petId: string, displayName: string): Promise<PetBackupResult | null> {
  if (!isDesktop()) return null;
  const destination = await save({
    defaultPath: `${displayName.replace(/[\\/:*?\"<>|]/g, "-") || petId}.levelup-echo`,
    filters: [{ name: "LevelUpAgent Starlight Echo", extensions: ["levelup-echo"] }],
  });
  if (typeof destination !== "string") return null;
  return invoke<PetBackupResult>("export_pet_backup", { petId, destination });
}

export async function selectAndImportPetBackup(): Promise<PetProfile | null> {
  if (!isDesktop()) return null;
  const source = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "LevelUpAgent Starlight Echo", extensions: ["levelup-echo"] }],
  });
  if (typeof source !== "string") return null;
  return invoke<PetProfile>("import_pet_backup", { source });
}

export async function selectSingleImageReference(): Promise<ImageAttachment | undefined> {
  if (!isDesktop()) return undefined;
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  const paths = typeof selected === "string" ? [selected] : [];
  return (await importAttachments(paths))[0];
}

export async function selectVideoReference(): Promise<ImageAttachment[]> {
  if (!isDesktop()) return [];
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });
  const paths = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : [];
  return importMediaReferences(paths.slice(0, 1));
}

export async function getMediaCatalog(): Promise<MediaCatalog> {
  if (!isDesktop()) return { models: [], errors: [] };
  return invoke<MediaCatalog>("get_media_catalog");
}

export async function getModelCatalog(): Promise<ProviderModelCatalog> {
  if (!isDesktop()) return { models: [], errors: [] };
  return invoke<ProviderModelCatalog>("get_model_catalog");
}

export async function generateMedia(
  request: MediaGenerationRequest,
  threadId?: string,
): Promise<MediaBatchResult> {
  return invoke<MediaBatchResult>("generate_media", { request, threadId: threadId || null });
}

export async function listMediaAssets(kind: MediaKind, limit = 24, offset = 0): Promise<MediaAssetPage> {
  if (!isDesktop()) return { assets: [], hasMore: false };
  return invoke<MediaAssetPage>("list_media_assets", { kind, limit, offset });
}

export async function refreshMediaAsset(assetId: string): Promise<MediaAsset> {
  return invoke<MediaAsset>("refresh_media_asset", { assetId });
}

export async function exportMediaAsset(asset: MediaAsset): Promise<string | null> {
  if (!isDesktop() || asset.status !== "completed" || !asset.fileName) return null;
  const extension = asset.fileName.split(".").pop()?.toLowerCase();
  const timestamp = new Date(asset.createdAt).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const defaultPath = `LevelUpAgent-${asset.kind}-${timestamp}${extension ? `.${extension}` : ""}`;
  const destination = await save({
    defaultPath,
    filters: extension ? [{ name: `${asset.kind} output`, extensions: [extension] }] : undefined,
  });
  if (!destination) return null;
  return invoke<string>("export_media_asset", { assetId: asset.id, destinationPath: destination });
}

export async function deleteMediaAsset(assetId: string): Promise<boolean> {
  return invoke<boolean>("delete_media_asset", { assetId });
}

export function mediaAssetUrl(asset: MediaAsset): string | undefined {
  if (!asset.filePath || !isDesktop()) return undefined;
  return convertFileSrc(asset.filePath);
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the pasted file"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read the pasted file"));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("The pasted file data is invalid"));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function clipboardAttachmentName(file: File, timestamp: string, index: number) {
  if (file.name.trim()) return file.name;
  const extension = file.type.startsWith("image/")
    ? imageExtension(file.type)
    : file.type === "application/pdf"
      ? "pdf"
      : file.type === "application/json"
        ? "json"
        : "txt";
  return `clipboard-${timestamp}-${index + 1}.${extension}`;
}

function clipboardThemePackageName(name: string) {
  const trimmed = name.trim();
  if (/\.levelup-theme$/i.test(trimmed)) return trimmed;
  const stem = trimmed.replace(/\.[^.\\/]*$/, "").trim() || "pasted";
  return `${stem}.levelup-theme`;
}

function imageExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

export async function saveApiKey(profileId: string, apiKey: string) {
  await invoke("save_api_key", { profileId, apiKey });
}

export async function deleteApiKey(profileId: string) {
  await invoke("delete_api_key", { profileId });
}

export async function hasApiKey(profileId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke<boolean>("has_api_key", { profileId });
}

export async function getProviderSettings(): Promise<ProviderSettings | null> {
  if (!isDesktop()) return null;
  return invoke<ProviderSettings | null>("get_provider_settings");
}

export async function saveProviderSettings(settings: ProviderSettings): Promise<void> {
  await invoke("save_provider_settings", { settings });
}

const BROWSER_WRITING_PROJECTS_KEY = "levelup-agent.writing-projects.v1";
const MAX_WRITING_BYTES = 16 * 1024 * 1024;

export async function listWritingProjects(): Promise<WritingProjectRecord[]> {
  if (isDesktop()) return invoke<WritingProjectRecord[]>("list_writing_projects");
  try {
    const value = localStorage.getItem(BROWSER_WRITING_PROJECTS_KEY);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is WritingProjectRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
  } catch {
    return [];
  }
}

export async function saveWritingProject(project: WritingProjectRecord): Promise<void> {
  if (isDesktop()) {
    await invoke("save_writing_project", { project });
    return;
  }
  const payload = JSON.stringify(project.payload);
  if (new TextEncoder().encode(payload).byteLength > MAX_WRITING_BYTES) throw new Error("Writing project data may not exceed 16 MiB");
  const current = await listWritingProjects();
  const next = [project, ...current.filter((item) => item.id !== project.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 100);
  localStorage.setItem(BROWSER_WRITING_PROJECTS_KEY, JSON.stringify(next));
}

export async function deleteWritingProject(projectId: string): Promise<boolean> {
  if (isDesktop()) return invoke<boolean>("delete_writing_project", { projectId });
  const current = await listWritingProjects();
  const next = current.filter((item) => item.id !== projectId);
  localStorage.setItem(BROWSER_WRITING_PROJECTS_KEY, JSON.stringify(next));
  return next.length !== current.length;
}

export async function exportWritingFile(
  suggestedName: string,
  content: string,
  extension: "json" | "md" | "yarn" | "txt",
): Promise<string | null> {
  if (new TextEncoder().encode(content).byteLength > MAX_WRITING_BYTES) throw new Error("Writing export may not exceed 16 MiB");
  if (!isDesktop()) {
    const blob = new Blob([content], { type: extension === "json" ? "application/json" : "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return suggestedName;
  }
  const destination = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Writing export", extensions: [extension] }],
  });
  if (typeof destination !== "string") return null;
  return invoke<string>("export_writing_file", { destination, content });
}

export async function fetchModels(profile: ProviderProfile, apiKey?: string): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("fetch_models", { profile, apiKey: apiKey || null });
}

export async function agentTurn(
  profile: ProviderProfile,
  messages: AgentMessage[],
  mode: AgentMode,
  workspace?: string,
  threadId?: string,
  fallbackProfiles: ProviderProfile[] = [],
  hatch = false,
  hatchSkillLoaded = false,
  customInstructions?: string,
  reasoningEffort: ReasoningEffort = "auto",
): Promise<AgentTurnResponse> {
  const cleanMessages = messages.filter((message) => !message.status).map(({ role, content, toolCalls, toolCallId, internal, attachments }) => ({
    role,
    content,
    toolCalls,
    toolCallId,
    internal: Boolean(internal),
    attachments,
  }));
  return invoke<AgentTurnResponse>("agent_turn", {
    request: { profile, messages: cleanMessages, mode, workspace, threadId, fallbackProfiles, hatch, hatchSkillLoaded, customInstructions, reasoningEffort },
  });
}

export async function agentTurnStream(
  profile: ProviderProfile,
  messages: AgentMessage[],
  mode: AgentMode,
  workspace: string | undefined,
  operationId: string,
  onDelta: (delta: string) => void,
  threadId?: string,
  fallbackProfiles: ProviderProfile[] = [],
  hatch = false,
  hatchSkillLoaded = false,
  onReconnect?: (retryAttempt: number, maxRetryAttempts: number) => void,
  onReconnected?: (retryAttempt?: number) => void,
  customInstructions?: string,
  reasoningEffort: ReasoningEffort = "auto",
): Promise<AgentTurnResponse> {
  const cleanMessages = messages.filter((message) => !message.status).map(({ role, content, toolCalls, toolCallId, internal, attachments }) => ({
    role,
    content,
    toolCalls,
    toolCallId,
    internal: Boolean(internal),
    attachments,
  }));
  const onEvent = new Channel<AgentStreamEvent>();
  onEvent.onmessage = (event) => {
    if (event.kind === "content_delta" && event.delta) onDelta(event.delta);
    if (event.kind === "provider_reconnecting") {
      onReconnect?.(event.retryAttempt ?? 1, event.maxRetryAttempts ?? 5);
    }
    if (event.kind === "provider_reconnected") onReconnected?.(event.retryAttempt);
  };
  return invoke<AgentTurnResponse>("agent_turn_stream", {
    request: { profile, messages: cleanMessages, mode, workspace, threadId, fallbackProfiles, hatch, hatchSkillLoaded, customInstructions, reasoningEffort },
    operationId,
    onEvent,
  });
}

export async function listProviderHealth(): Promise<ProviderHealth[]> {
  if (!isDesktop()) return [];
  return invoke<ProviderHealth[]>("list_provider_health");
}

export async function listProviderRequests(): Promise<ProviderRequestLog[]> {
  if (!isDesktop()) return [];
  return invoke<ProviderRequestLog[]>("list_provider_requests");
}

export async function resetProviderHealth(profileId: string): Promise<void> {
  await invoke("reset_provider_health", { profileId });
}

export async function getGatewayDiagnostics(profile: ProviderProfile): Promise<GatewayDiagnostics> {
  return invoke<GatewayDiagnostics>("get_gateway_diagnostics", { profile });
}

export async function previewExternalConfigWrite(
  profile: ProviderProfile,
  target: ExternalConfigTarget,
): Promise<ConfigWritePreview> {
  return invoke<ConfigWritePreview>("preview_external_config_write", { profile, target });
}

export async function applyExternalConfigWrite(
  profile: ProviderProfile,
  target: ExternalConfigTarget,
  confirmationToken: string,
): Promise<ConfigWriteResult> {
  return invoke<ConfigWriteResult>("apply_external_config_write", { profile, target, confirmationToken });
}

export async function rollbackExternalConfigWrite(
  target: ExternalConfigTarget,
  backupId: string,
): Promise<string[]> {
  return invoke<string[]>("rollback_external_config_write", { target, backupId });
}

export async function getCustomInstructions(): Promise<string> {
  if (!isDesktop()) return "";
  return invoke<string>("get_custom_instructions");
}

export async function saveCustomInstructions(content: string): Promise<void> {
  await invoke("save_custom_instructions", { content });
}

export async function previewExternalPromptWrite(
  target: ExternalConfigTarget,
  content: string,
): Promise<ConfigWritePreview> {
  return invoke<ConfigWritePreview>("preview_external_prompt_write", { target, content });
}

export async function applyExternalPromptWrite(
  target: ExternalConfigTarget,
  confirmationToken: string,
): Promise<ConfigWriteResult> {
  return invoke<ConfigWriteResult>("apply_external_prompt_write", { target, confirmationToken });
}

export async function rollbackExternalPromptWrite(
  target: ExternalConfigTarget,
  backupId: string,
): Promise<string[]> {
  return invoke<string[]>("rollback_external_prompt_write", { target, backupId });
}

export async function cancelAgentTurn(operationId: string): Promise<boolean> {
  return invoke<boolean>("cancel_agent_turn", { operationId });
}

type PendingAppUpdate = Awaited<ReturnType<(typeof import("@tauri-apps/plugin-updater"))["check"]>>;
let pendingAppUpdate: PendingAppUpdate = null;
let startupAppUpdateCheck: Promise<AppUpdateInfo | null> | null = null;
const STARTUP_APP_UPDATE_TIMEOUT_MS = 8_000;

async function performAppUpdateCheck(timeout?: number): Promise<AppUpdateInfo | null> {
  if (!isDesktop()) throw new Error("Updates are available only in the desktop app");
  const { check } = await import("@tauri-apps/plugin-updater");
  pendingAppUpdate = await check(timeout === undefined ? undefined : { timeout });
  if (!pendingAppUpdate) return null;
  return {
    currentVersion: pendingAppUpdate.currentVersion,
    version: pendingAppUpdate.version,
    date: pendingAppUpdate.date,
    body: pendingAppUpdate.body,
  };
}

export async function checkAppUpdate(): Promise<AppUpdateInfo | null> {
  return performAppUpdateCheck();
}

export function checkAppUpdateOnStartup(): Promise<AppUpdateInfo | null> {
  if (!startupAppUpdateCheck) {
    startupAppUpdateCheck = performAppUpdateCheck(STARTUP_APP_UPDATE_TIMEOUT_MS);
  }
  return startupAppUpdateCheck;
}

export async function installAppUpdate(): Promise<void> {
  if (!isDesktop()) throw new Error("Updates are available only in the desktop app");
  if (!pendingAppUpdate) {
    const { check } = await import("@tauri-apps/plugin-updater");
    pendingAppUpdate = await check();
  }
  if (!pendingAppUpdate) throw new Error("No update is available");
  await pendingAppUpdate.downloadAndInstall();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export async function executeTool(
  call: ToolCall,
  workspace: string,
  threadId?: string,
  profile?: ProviderProfile,
  fallbackProfiles: ProviderProfile[] = [],
  hatch = false,
  hatchSkillLoaded = false,
  hatchBootstrap = false,
  mode: AgentMode = "agent",
  permissionLevel: PermissionLevel = "request",
  operationId?: string,
  approvalGranted = false,
): Promise<ToolExecutionResponse> {
  return invoke<ToolExecutionResponse>("execute_tool", {
    request: createToolExecutionRequest({
      call,
      workspace,
      threadId,
      profile,
      fallbackProfiles,
      hatch,
      hatchSkillLoaded,
      hatchBootstrap,
      mode,
      permissionLevel,
      operationId,
      approvalGranted,
    }),
  });
}

export async function executeHatchBootstrapTool(
  options: HatchBootstrapToolOptions,
): Promise<ToolExecutionResponse> {
  return invoke<ToolExecutionResponse>("execute_tool", {
    request: createHatchBootstrapToolRequest(options),
  });
}

export async function harnessPreflight(
  request: HarnessDraftRequest,
): Promise<HarnessPreflightReport> {
  return invoke<HarnessPreflightReport>("harness_preflight", { request });
}

export async function harnessStart(
  request: HarnessDraftRequest,
): Promise<HarnessSubmission> {
  return invoke<HarnessSubmission>("harness_start", { request });
}

export async function harnessLatestHatchRunDir(threadId: string): Promise<string | null> {
  return invoke<string | null>("harness_latest_hatch_run_dir", { threadId });
}

export async function harnessCheckTool(
  request: HarnessToolPolicyRequest,
): Promise<HarnessPolicyDecision> {
  return invoke<HarnessPolicyDecision>("harness_check_tool", { request });
}

export async function harnessUpdateState(
  operationId: string,
  state: HarnessOperationState,
): Promise<void> {
  return invoke("harness_update_state", {
    request: { operationId, state },
  });
}

export async function harnessResolveApproval(
  request: HarnessApprovalResolution,
): Promise<HarnessApprovalRecord> {
  return invoke<HarnessApprovalRecord>("harness_resolve_approval", { request });
}

export async function harnessListPendingApprovals(): Promise<HarnessPendingApproval[]> {
  return invoke<HarnessPendingApproval[]>("harness_list_pending_approvals");
}

export async function harnessReissueApproval(approvalId: string): Promise<string> {
  return invoke<string>("harness_reissue_approval", { approvalId });
}

export async function harnessListRecovery(): Promise<HarnessRecoveryItem[]> {
  return invoke<HarnessRecoveryItem[]>("harness_list_recovery");
}

export async function harnessResolveUnknown(
  operationId: string,
  toolExecutionId: string,
  decision: "mark_completed" | "mark_not_executed" | "cancel",
): Promise<void> {
  return invoke("harness_resolve_unknown", {
    request: { operationId, toolExecutionId, decision },
  });
}

export async function harnessEnqueue(
  operationId: string,
  kind: HarnessQueueItem["kind"],
  body: string,
): Promise<HarnessQueueItem> {
  return invoke<HarnessQueueItem>("harness_enqueue", {
    request: { operationId, kind, body },
  });
}

export async function harnessListQueue(operationId: string): Promise<HarnessQueueItem[]> {
  return invoke<HarnessQueueItem[]>("harness_list_queue", { operationId });
}

export async function harnessConsumeQueue(queueId: string): Promise<HarnessQueueItem | null> {
  return invoke<HarnessQueueItem | null>("harness_consume_queue", { queueId });
}

export async function harnessCancelQueue(queueId: string): Promise<void> {
  return invoke("harness_cancel_queue", { queueId });
}

export async function harnessSteer(operationId: string, queueId: string): Promise<void> {
  return invoke("harness_steer", { operationId, queueId });
}

export async function harnessCreateSessionNode(request: {
  threadId: string;
  parentId?: string;
  branchId: string;
  kind: string;
  messageId?: string;
  operationId?: string;
}): Promise<HarnessSessionNode> {
  return invoke<HarnessSessionNode>("harness_create_session_node", { request });
}

export async function harnessListSessionNodes(threadId: string): Promise<HarnessSessionNode[]> {
  return invoke<HarnessSessionNode[]>("harness_list_session_nodes", { threadId });
}

export async function harnessForkSession(
  request: HarnessForkSessionRequest,
): Promise<HarnessSessionNode> {
  return invoke<HarnessSessionNode>("harness_fork_session", { request });
}

export async function harnessRun(
  request: HarnessRunRequest,
  onEvent: (event: HarnessRuntimeEvent) => void,
): Promise<HarnessRunOutcome> {
  const channel = new Channel<HarnessRuntimeEvent>();
  channel.onmessage = onEvent;
  return invoke<HarnessRunOutcome>("harness_run", {
    request: {
      ...request,
      messages: request.messages.filter((message) => !message.status),
    },
    onEvent: channel,
  });
}

export async function createGoal(
  threadId: string,
  objective: string,
): Promise<GoalState> {
  return invoke<GoalState>("create_goal", {
    request: { threadId, objective },
  });
}

export async function getGoal(threadId: string): Promise<GoalState | null> {
  if (!isDesktop()) return null;
  return invoke<GoalState | null>("get_goal", { threadId });
}

export async function changeGoalStatus(
  threadId: string,
  action: "pause" | "resume" | "cancel",
): Promise<GoalState> {
  return invoke<GoalState>("change_goal_status", { threadId, action });
}

export async function listMcpServers(): Promise<McpServerSnapshot[]> {
  if (!isDesktop()) return [];
  return invoke<McpServerSnapshot[]>("list_mcp_servers");
}

export async function upsertMcpServer(
  server: McpServerConfig,
  secrets: McpSecretValues,
): Promise<McpServerSnapshot> {
  return invoke<McpServerSnapshot>("upsert_mcp_server", { input: { server, secrets } });
}

export async function startMcpServer(serverId: string): Promise<McpServerSnapshot> {
  return invoke<McpServerSnapshot>("start_mcp_server", { serverId });
}

export async function stopMcpServer(serverId: string): Promise<McpServerSnapshot> {
  return invoke<McpServerSnapshot>("stop_mcp_server", { serverId });
}

export async function deleteMcpServer(serverId: string): Promise<boolean> {
  return invoke<boolean>("delete_mcp_server", { serverId });
}

export async function scanSkills(workspace?: string): Promise<SkillInfo[]> {
  if (!isDesktop()) return [];
  return invoke<SkillInfo[]>("scan_skills", { workspace: workspace || null });
}

export async function setSkillEnabled(
  skillId: string,
  enabled: boolean,
  workspace?: string,
): Promise<SkillInfo> {
  return invoke<SkillInfo>("set_skill_enabled", {
    skillId,
    enabled,
    workspace: workspace || null,
  });
}

export async function readSkillContent(skillId: string, workspace?: string): Promise<string> {
  return invoke<string>("read_skill_content", {
    skillId,
    workspace: workspace || null,
  });
}

export async function listSkillLocations(workspace?: string): Promise<SkillLocation[]> {
  if (!isDesktop()) return [];
  return invoke<SkillLocation[]>("skill_locations", { workspace: workspace || null });
}

export async function createSkill(input: {
  name: string;
  description: string;
  instructions: string;
  scope?: string;
  workspace?: string;
  overwrite?: boolean;
}): Promise<SkillMutationResult> {
  return invoke<SkillMutationResult>("create_skill", {
    request: {
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      scope: input.scope || null,
      workspace: input.workspace || null,
      overwrite: input.overwrite ?? false,
    },
  });
}

export async function updateSkill(input: {
  skillId: string;
  content: string;
  workspace?: string;
}): Promise<SkillMutationResult> {
  return invoke<SkillMutationResult>("update_skill", {
    request: {
      skillId: input.skillId,
      content: input.content,
      workspace: input.workspace || null,
    },
  });
}

export async function deleteSkill(input: { skillId: string; workspace?: string }): Promise<SkillMutationResult> {
  return invoke<SkillMutationResult>("delete_skill", {
    request: { skillId: input.skillId, workspace: input.workspace || null },
  });
}

export async function installSkill(input: {
  source: string;
  scope?: string;
  workspace?: string;
  overwrite?: boolean;
}): Promise<SkillInstallResult> {
  return invoke<SkillInstallResult>("install_skill", {
    request: {
      source: input.source,
      scope: input.scope || null,
      workspace: input.workspace || null,
      overwrite: input.overwrite ?? false,
    },
  });
}

export async function listPersistedThreads(): Promise<AgentThread[]> {
  return invoke<AgentThread[]>("list_threads");
}

export async function savePersistedThread(thread: AgentThread): Promise<void> {
  await invoke("save_thread", { thread });
}

export async function deletePersistedThread(threadId: string): Promise<boolean> {
  return invoke<boolean>("delete_thread", { threadId });
}

export async function scanExternalConfigs(): Promise<ExternalConfigCandidate[]> {
  return invoke<ExternalConfigCandidate[]>("scan_external_configs");
}

export async function importExternalConfig(candidateId: string): Promise<ProviderProfile> {
  return invoke<ProviderProfile>("import_external_config", { candidateId });
}

export async function getGitStatus(workspace: string): Promise<GitStatus> {
  return invoke<GitStatus>("get_git_status", { workspace });
}

export async function getGitWorkspaceSnapshot(workspace: string): Promise<GitWorkspaceSnapshot> {
  if (!isDesktop()) {
    return { isAvailable: false, isRepository: false, files: [] };
  }
  return invoke<GitWorkspaceSnapshot>("get_git_workspace_snapshot", { workspace });
}

export async function getGitDiff(
  workspace: string,
  path: string,
  staged: boolean,
): Promise<GitDiff> {
  return invoke<GitDiff>("get_git_diff", { workspace, path, staged });
}

export async function previewGitRollback(
  workspace: string,
  path: string,
): Promise<GitRollbackPreview> {
  return invoke<GitRollbackPreview>("preview_git_rollback", { workspace, path });
}

export async function applyGitRollback(
  confirmationToken: string,
): Promise<GitRollbackResult> {
  return invoke<GitRollbackResult>("apply_git_rollback", { confirmationToken });
}
