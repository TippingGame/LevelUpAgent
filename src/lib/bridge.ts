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
  GitRollbackPreview,
  GitRollbackResult,
  GitStatus,
  GoalState,
  GatewayDiagnostics,
  ImageAttachment,
  AttachmentPreview,
  ModelInfo,
  McpSecretValues,
  McpServerConfig,
  McpServerSnapshot,
  MediaAsset,
  MediaBatchResult,
  MediaCatalog,
  MediaGenerationRequest,
  ProviderProfile,
  ProviderSettings,
  ProviderHealth,
  ProviderRequestLog,
  SkillInfo,
  ToolCall,
  ToolExecutionResponse,
  ThemeManifest,
  ThemePackage,
} from "./types";

export const isDesktop = () => "__TAURI_INTERNALS__" in window;

export async function listThemes(): Promise<ThemeManifest[]> {
  if (!isDesktop()) return [];
  return invoke<ThemeManifest[]>("list_themes");
}

export async function loadTheme(themeId: string): Promise<ThemePackage> {
  return invoke<ThemePackage>("load_theme", { themeId });
}

export async function selectAndInstallTheme(): Promise<ThemeManifest | null> {
  if (!isDesktop()) return null;
  const sourcePath = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "LevelUpAgent theme", extensions: ["levelup-theme"] }],
  });
  if (typeof sourcePath !== "string") return null;
  return invoke<ThemeManifest>("install_theme", { sourcePath });
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

export async function getMediaCatalog(): Promise<MediaCatalog> {
  if (!isDesktop()) return { models: [], errors: [] };
  return invoke<MediaCatalog>("get_media_catalog");
}

export async function generateMedia(
  request: MediaGenerationRequest,
  threadId?: string,
): Promise<MediaBatchResult> {
  return invoke<MediaBatchResult>("generate_media", { request, threadId: threadId || null });
}

export async function listMediaAssets(limit = 200): Promise<MediaAsset[]> {
  if (!isDesktop()) return [];
  return invoke<MediaAsset[]>("list_media_assets", { limit });
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
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the pasted image"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read the pasted image"));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("The pasted image data is invalid"));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
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
): Promise<AgentTurnResponse> {
  const cleanMessages = messages.map(({ role, content, toolCalls, toolCallId, internal, attachments }) => ({
    role,
    content,
    toolCalls,
    toolCallId,
    internal: Boolean(internal),
    attachments,
  }));
  return invoke<AgentTurnResponse>("agent_turn", {
    request: { profile, messages: cleanMessages, mode, workspace, threadId, fallbackProfiles },
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
): Promise<AgentTurnResponse> {
  const cleanMessages = messages.map(({ role, content, toolCalls, toolCallId, internal, attachments }) => ({
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
  };
  return invoke<AgentTurnResponse>("agent_turn_stream", {
    request: { profile, messages: cleanMessages, mode, workspace, threadId, fallbackProfiles },
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

export async function checkAppUpdate(): Promise<AppUpdateInfo | null> {
  if (!isDesktop()) throw new Error("Updates are available only in the desktop app");
  const { check } = await import("@tauri-apps/plugin-updater");
  pendingAppUpdate = await check();
  if (!pendingAppUpdate) return null;
  return {
    currentVersion: pendingAppUpdate.currentVersion,
    version: pendingAppUpdate.version,
    date: pendingAppUpdate.date,
    body: pendingAppUpdate.body,
  };
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
): Promise<ToolExecutionResponse> {
  return invoke<ToolExecutionResponse>("execute_tool", {
    request: { name: call.name, arguments: call.arguments, workspace, threadId, profile, fallbackProfiles },
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
