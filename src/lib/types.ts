export type ProviderProtocol =
  | "openai_responses"
  | "openai_chat"
  | "anthropic_messages"
  | "gemini_generate_content";

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  allowUnauthenticated: boolean;
  priority: number;
  failoverEnabled: boolean;
}

export interface ProviderSettings {
  profiles: ProviderProfile[];
  activeProfileId: string;
}

export interface WritingProjectRecord {
  id: string;
  title: string;
  projectType: "novel" | "screenplay" | "game";
  payload: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ThemeManifest {
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  layout?: "standard" | "qq2007" | LayoutDefinition;
  layoutFile?: string;
  homepage?: string;
  license?: string;
  bundled?: boolean;
}

export interface ThemePackage extends ThemeManifest {
  css: string;
}

export type LayoutLocaleText = string | { "zh-CN": string; "en-US": string };
export type LayoutScalar = string | number | boolean | null;
export type LayoutValue = LayoutScalar | LayoutValue[] | { [key: string]: LayoutValue };

export interface LayoutCondition {
  path?: string;
  equals?: LayoutValue;
  notEquals?: LayoutValue;
  truthy?: boolean;
  all?: LayoutCondition[];
  any?: LayoutCondition[];
  not?: LayoutCondition;
}

export interface LayoutAction {
  name: string;
  args?: Record<string, LayoutValue>;
}

export interface LayoutNodeBase {
  type: string;
  id?: string;
  className?: string[];
  when?: LayoutCondition;
}

export interface LayoutContainerNode extends LayoutNodeBase {
  type: "container";
  role?: string;
  children: LayoutNode[];
}

export interface LayoutSlotNode extends LayoutNodeBase {
  type: "slot";
  slot: string;
}

export interface LayoutTextNode extends LayoutNodeBase {
  type: "text";
  text?: LayoutLocaleText;
  bind?: string;
}

export interface LayoutButtonNode extends LayoutNodeBase {
  type: "button";
  label: LayoutLocaleText;
  action: LayoutAction;
  icon?: string;
  activeWhen?: LayoutCondition;
  disabledWhen?: LayoutCondition;
  children?: LayoutNode[];
}

export interface LayoutImageNode extends LayoutNodeBase {
  type: "image";
  source: string;
  alt: LayoutLocaleText;
}

export interface LayoutIconNode extends LayoutNodeBase {
  type: "icon";
  name: string;
  label?: LayoutLocaleText;
}

export interface LayoutInputNode extends LayoutNodeBase {
  type: "input";
  state: string;
  label: LayoutLocaleText;
  placeholder?: LayoutLocaleText;
}

export interface LayoutRepeatNode extends LayoutNodeBase {
  type: "repeat";
  source: string;
  item: string;
  children: LayoutNode[];
  empty?: LayoutNode[];
}

export interface LayoutSpacerNode extends LayoutNodeBase {
  type: "spacer";
}

export type LayoutNode =
  | LayoutContainerNode
  | LayoutSlotNode
  | LayoutTextNode
  | LayoutButtonNode
  | LayoutImageNode
  | LayoutIconNode
  | LayoutInputNode
  | LayoutRepeatNode
  | LayoutSpacerNode;

export interface LayoutDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  window?: { decorations?: boolean };
  initialState?: Record<string, LayoutScalar>;
  root: LayoutContainerNode;
}

export interface ResolvedLayout {
  source: "default" | "theme" | "legacy";
  definition: LayoutDefinition;
  warning?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ModelProviderBrand =
  | "openai"
  | "anthropic"
  | "gemini"
  | "antigravity"
  | "grok"
  | "levelup";

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls: ToolCall[];
  toolCallId?: string;
  createdAt: number;
  isError?: boolean;
  requestId?: string;
  modelName?: string;
  providerBrand?: ModelProviderBrand;
  durationMs?: number;
  internal?: boolean;
  attachments: ImageAttachment[];
}

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "video" | "text" | "document";
}

export interface AttachmentPreview {
  kind: "image" | "video" | "text" | "document";
  mimeType: string;
  dataBase64?: string;
  text?: string;
}

export interface AgentTurnResponse {
  content: string;
  toolCalls: ToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  requestId?: string;
  providerId?: string;
  failoverCount: number;
}

export interface ProviderHealth {
  profileId: string;
  consecutiveFailures: number;
  lastError?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
  totalRequests: number;
  totalFailovers: number;
  averageLatencyMs?: number;
}

export interface ProviderRequestLog {
  id: string;
  threadId?: string;
  profileId: string;
  model: string;
  protocol: string;
  startedAt: number;
  latencyMs: number;
  status: "success" | "error" | "cancelled" | "configuration_error";
  inputTokens?: number;
  outputTokens?: number;
  requestId?: string;
  failoverIndex: number;
  error?: string;
}

export interface GatewayDiagnostics {
  profileId: string;
  healthOk: boolean;
  latencyMs: number;
  usage: Record<string, unknown>;
  requestId?: string;
  checkedAt: number;
}

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
}

export type ExternalConfigTarget = "codex" | "claude" | "gemini" | "opencode";

export interface ConfigFilePreview {
  path: string;
  exists: boolean;
  diff: string;
}

export interface ConfigWritePreview {
  target: ExternalConfigTarget;
  files: ConfigFilePreview[];
  confirmationToken: string;
}

export interface ConfigWriteResult {
  target: ExternalConfigTarget;
  backupId: string;
  changedFiles: string[];
}

export interface AgentStreamEvent {
  kind: "content_delta";
  delta?: string;
}

export interface ToolExecutionResponse {
  output: string;
  isError: boolean;
}

export type McpTransport = "stdio" | "streamable_http";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  environment: Record<string, string>;
  headers: Record<string, string>;
  secretEnvironmentKeys: string[];
  secretHeaderKeys: string[];
}

export interface McpSecretValues {
  environment: Record<string, string>;
  headers: Record<string, string>;
}

export interface McpServerSnapshot {
  server: McpServerConfig;
  status: "disabled" | "connected" | "error" | "stopped";
  toolCount: number;
  lastError?: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  enabled: boolean;
  valid: boolean;
  warning?: string;
}

export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

export type MediaKind = "image" | "video" | "audio";
export type MediaStatus = "queued" | "in_progress" | "completed" | "failed";
export type VideoGenerationMode = "text" | "image" | "reference" | "video";

export interface MediaModelInfo {
  id: string;
  profileId: string;
  profileName: string;
  kind: MediaKind;
  rank: number;
  recommended: boolean;
}

export interface MediaCatalog {
  models: MediaModelInfo[];
  errors: string[];
}

export interface MediaGenerationRequest {
  profileId?: string;
  kind: MediaKind;
  model?: string;
  prompt: string;
  count: number;
  size?: string;
  quality?: string;
  outputFormat?: string;
  background?: string;
  voice?: string;
  instructions?: string;
  seconds?: number;
  videoMode?: VideoGenerationMode;
  videoResolution?: string;
  videoAspectRatio?: string;
  referenceAttachmentIds: string[];
}

export interface MediaAsset {
  id: string;
  batchId: string;
  threadId?: string;
  providerId: string;
  providerName: string;
  kind: MediaKind;
  status: MediaStatus;
  prompt: string;
  model: string;
  mimeType?: string;
  fileName?: string;
  filePath?: string;
  remoteId?: string;
  revisedPrompt?: string;
  error?: string;
  progress?: number;
  size?: string;
  quality?: string;
  outputFormat?: string;
  voice?: string;
  seconds?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MediaAssetPage {
  assets: MediaAsset[];
  hasMore: boolean;
}

export interface MediaBatchResult {
  batchId: string;
  assets: MediaAsset[];
  errors: string[];
}

export interface ExternalConfigCandidate {
  id: string;
  source: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  hasSecret: boolean;
  warning?: string;
}

export interface GitFileChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatus {
  isAvailable: boolean;
  isRepository: boolean;
  branch?: string;
  changes: GitFileChange[];
}

export interface GitDiff {
  path: string;
  content: string;
  truncated: boolean;
}

export interface GitRollbackPreview {
  path: string;
  status: string;
  action: "restore_head" | "delete_untracked";
  diff: string;
  truncated: boolean;
  confirmationToken: string;
}

export interface GitRollbackResult {
  path: string;
  action: "restore_head" | "delete_untracked";
}

export interface AgentThread {
  id: string;
  title: string;
  workspace?: string;
  kind?: "standard" | "pet";
  petId?: string;
  messages: AgentMessage[];
  updatedAt: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PendingApproval {
  calls: ToolCall[];
  history: AgentMessage[];
  mode: AgentMode;
  permissionLevel: PermissionLevel;
  startedAt: number;
  nextRound: number;
  profileId: string;
  rewardPetId?: string;
}

export interface PetProfile {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  personality?: string;
  removable: boolean;
}

export interface PetProgress {
  petId: string;
  level: number;
  totalXp: number;
  currentXp: number;
  requiredXp: number;
  progress: number;
  totalTokens: number;
  requests: number;
}

export interface PetMemory {
  id: string;
  text: string;
  kind: string;
  confidence: number;
  evidenceCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface PetDashboard {
  pets: PetProfile[];
  activePetId: string;
  progress: PetProgress;
  memories: PetMemory[];
  overlayVisible: boolean;
  scale: number;
}

export type PetActivityState = "working" | "generating" | "waiting";

export interface PetActivity {
  id: string;
  title: string;
  detail: string;
  state: PetActivityState;
}

export interface PetRuntimeSnapshot {
  dashboard: PetDashboard;
  activities: PetActivity[];
}

export interface HatchRequirement {
  id: "hatch_skill" | "imagegen_skill" | "python" | string;
  detail: string;
}

export interface HatchEnvironment {
  configured: boolean;
  bundled: boolean;
  codexHome: string;
  hatchSkillPath?: string;
  imagegenSkillPath?: string;
  pythonCommand?: string;
  workDirectory: string;
  packageDirectory: string;
  missing: HatchRequirement[];
}

export type AgentMode = "agent" | "plan" | "goal" | "chat";
export type PermissionLevel = "request" | "agent" | "full";

export type GoalStatus =
  | "active"
  | "paused"
  | "auditing"
  | "completed"
  | "blocked"
  | "cancelled";

export interface GoalState {
  id: string;
  threadId: string;
  objective: string;
  status: GoalStatus;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  blockedAttempts: number;
  lastBlocker?: string;
  auditNote?: string;
  createdAt: number;
  updatedAt: number;
}
