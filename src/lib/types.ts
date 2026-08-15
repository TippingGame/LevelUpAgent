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

export type DiffFontFamily = "monaco" | "system" | "consolas";

export interface DiffViewSettings {
  fontFamily: DiffFontFamily;
  fontSize: number;
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

export interface ThemeGenerationTarget {
  relativePath: string;
  sourcePath: string;
}

export interface ThemeGenerationBackgroundInput {
  assetId: string;
  fit: "cover" | "contain" | "tile";
  focus: "left" | "center" | "right";
  readability: "soft" | "balanced" | "strong";
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
  status?: "reconnecting" | "reconnected" | "failed";
  durationMs?: number;
  internal?: boolean;
  changeSet?: ConversationChangeSet;
  attachments: ImageAttachment[];
}

export type ConversationChangeStatus = "completed" | "failed" | "cancelled" | "interrupted";
export type ConversationFileChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface ConversationFileChange {
  path: string;
  kind: ConversationFileChangeKind;
  indexStatus: string;
  worktreeStatus: string;
  additions?: number;
  deletions?: number;
  diffAvailable: boolean;
  turnDiff?: string;
  turnDiffTruncated?: boolean;
}

export interface ConversationChangeSet {
  operationId: string;
  workspace: string;
  status: ConversationChangeStatus;
  startedAt: number;
  completedAt: number;
  files: ConversationFileChange[];
}

export interface GitWorkspaceFileSnapshot {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  fingerprint: string;
  content?: string;
  baseContent?: string;
  contentTruncated: boolean;
  binary: boolean;
}

export interface GitWorkspaceSnapshot {
  isAvailable: boolean;
  isRepository: boolean;
  files: GitWorkspaceFileSnapshot[];
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

export interface HarnessRunRequest {
  operationId: string;
  threadId: string;
  messages: AgentMessage[];
  profile: ProviderProfile;
  mode: AgentMode;
  permissionLevel: PermissionLevel;
  workspace?: string;
  fallbackProfiles?: ProviderProfile[];
  hatch?: boolean;
  hatchSkillLoaded?: boolean;
}

export interface HarnessRuntimeEvent {
  schemaVersion: number;
  operationId: string;
  sequence: number;
  kind: string;
  payload: unknown;
}

export interface HarnessRunOutcome {
  state: HarnessOperationState;
}

export interface HarnessApprovalResolution {
  operationId: string;
  token: string;
  approved: boolean;
}

export interface HarnessApprovalRecord {
  approvalId: string;
  operationId: string;
  toolExecutionId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  approved: boolean;
}

export interface HarnessPendingApproval {
  approvalId: string;
  operationId: string;
  threadId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  mode: AgentMode;
  permissionLevel: PermissionLevel;
  requestedProfileId?: string;
  hatch: boolean;
}

export interface HarnessRecoveryItem {
  operationId: string;
  toolExecutionId: string;
  callId: string;
  toolName: string;
  status: string;
  startedAt: number;
}

export interface HarnessQueueItem {
  id: string;
  operationId: string;
  kind: "steer" | "follow_up" | "next_turn";
  body: string;
  status: string;
}

export interface HarnessSessionNode {
  id: string;
  threadId: string;
  parentId?: string;
  branchId: string;
  kind: string;
  messageId?: string;
  operationId?: string;
  position: number;
}

export interface HarnessForkSessionRequest {
  threadId: string;
  parentId?: string;
  branchId: string;
  operationId?: string;
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
  kind: "content_delta" | "provider_reconnecting" | "provider_reconnected";
  delta?: string;
  retryAttempt?: number;
  maxRetryAttempts?: number;
}

export interface ToolExecutionResponse {
  output: string;
  isError: boolean;
}

export interface HarnessDraftRequest {
  threadId: string;
  rawUserInput: string;
  attachmentIds?: string[];
  mode: AgentMode;
  permissionLevel?: PermissionLevel;
  requestedProfileId?: string;
  workspace?: string;
  /** True for the bundled hatch-pet workflow. The operation is still durable. */
  hatch?: boolean;
  /** Canonical per-hatch run directory persisted into the operation snapshot. */
  hatchRunDir?: string;
}

export interface HarnessPreflightReport {
  ok: boolean;
  workspace: string;
  selectedProfileId?: string;
  mode: AgentMode;
  permissionLevel: PermissionLevel;
  errors: string[];
  warnings: string[];
}

export interface HarnessOperationStarted {
  operationId: string;
  draftId: string;
  state: string;
  eventSequence: number;
}

export type HarnessSubmission =
  | { disposition: "started"; value: HarnessOperationStarted }
  | { disposition: "queued"; value: HarnessQueueItem };

export type HarnessOperationState =
  | "draft_saved"
  | "compiling"
  | "running"
  | "awaiting_approval"
  | "compacting"
  | "persisting"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export interface HarnessToolPolicyRequest {
  mode: AgentMode;
  permissionLevel?: PermissionLevel;
  call: ToolCall;
}

export type HarnessPolicyDecision = "allow" | "needs_approval" | "deny";

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
  protocol?: ProviderProtocol;
  protocols?: ProviderProtocol[];
  supportedGenerationMethods?: string[];
  inputModalities?: string[];
  outputModalities?: string[];
}

export interface ProviderModelInfo extends ModelInfo {
  profileId: string;
  profileName: string;
  protocol: ProviderProtocol;
}

export interface ProviderModelCatalog {
  models: ProviderModelInfo[];
  errors: string[];
}

export type MediaKind = "image" | "video" | "audio";
export type MediaStatus = "queued" | "in_progress" | "completed" | "failed";
export type VideoGenerationMode = "text" | "image" | "reference" | "video";

export interface MediaModelInfo {
  id: string;
  profileId: string;
  profileName: string;
  protocol: ProviderProtocol;
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
  protocol?: ProviderProtocol;
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
  maskAttachmentId?: string;
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
  background?: string;
  outputFormat?: string;
  count?: number;
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
  operationId?: string;
  approvalTokens?: string[];
  approvalId?: string;
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

export interface PetNeeds {
  energy: number;
  focus: number;
  curiosity: number;
  social: number;
  mood: number;
}

export interface PetBehavior {
  state: "idle" | "wandering" | "resting" | "sleeping" | "studying" | "learning" | "planning" | "waiting" | "celebrating" | "discovering" | "dreaming" | string;
  reason: string;
  message: string;
  since: number;
  nextDecisionAt: number;
  direction?: "left" | "right" | string;
}

export interface PetLifeSettings {
  autonomyEnabled: boolean;
  learningEnabled: boolean;
  movementEnabled: boolean;
  dailyPlanEnabled: boolean;
  remindersEnabled: boolean;
  launchAtLogin: boolean;
  studyGoalMinutes: number;
  knowledgeGoal: number;
  quietStartMinute: number;
  quietEndMinute: number;
  patrolSpeed: number;
}

export interface PetScheduleItem {
  id: string;
  title: string;
  detail: string;
  startMinute: number;
  durationMinutes: number;
  kind: "plan" | "focus" | "learn" | "wander" | "reflect" | string;
  status: "planned" | "active" | "completed" | "missed" | "skipped" | string;
  source: string;
  createdAt: number;
  completedAt?: number;
}

export interface PetCheckIn {
  slot: string;
  status: "checked" | "missed" | string;
  respondedAt?: number;
}

export interface PetDayRecord {
  date: string;
  planGeneratedAt: number;
  planReason: string;
  schedule: PetScheduleItem[];
  checkIns: Record<string, PetCheckIn>;
  reflection: string;
  settledAt?: number;
  taskReminders: Record<string, number>;
  chatterSlots: Record<string, number>;
  studyLaunches: Record<string, PetStudyLaunch>;
}

export interface PetStudyLaunch {
  period: "morning" | "afternoon" | "evening" | string;
  availableAt: number;
  promptedAt?: number;
  snoozedUntil?: number;
  lastReminderAt?: number;
  reminderCount: number;
  completedAt?: number;
  skippedAt?: number;
  source?: string;
  supervisionTier: "playful" | "firm" | "angry" | "final" | string;
}

export interface PetTask {
  id: string;
  title: string;
  notes: string;
  dueDate?: string;
  recurrence?: "daily" | "weekdays" | "weekly" | string;
  priority: number;
  status: "pending" | "completed" | string;
  createdAt: number;
  completedAt?: number;
  seriesId?: string;
  occurrenceDate?: string;
}

export interface PetPrompt {
  id: string;
  kind: "check-in" | "study-launch" | "task-reminder" | string;
  message: string;
  period?: string;
  tier?: "playful" | "firm" | "angry" | "final" | string;
  actions: Array<"check-in" | "start" | "snooze" | "skip" | "open" | "dismiss" | string>;
}

export interface PetKnowledge {
  id: string;
  title: string;
  summary: string;
  source: string;
  sourceKind: "agent" | "conversation" | "task" | "memory" | "document" | "web" | "reflection" | "discovery" | "other" | string;
  sourceRef?: string;
  tags: string[];
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastReviewedAt?: number;
  reviewCount: number;
}

export interface PetLearningQuest {
  id: string;
  question: string;
  topic: string;
  status: "formation-pending" | "formulating" | "formation-retrying" | "formation-failed" | "deferred" | "pending" | "asking" | "retrying" | "completed" | "failed" | string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  nextRetryAt?: number;
  attempts: number;
  formationAttempts: number;
  rationale?: string;
  questionProviderId?: string;
  answerTitle?: string;
  knowledgeId?: string;
  providerId?: string;
  error?: string;
}

export interface PetUserObservation {
  id: string;
  text: string;
  createdAt: number;
}

export interface PetStudySession {
  id: string;
  source: string;
  startedAt: number;
  endedAt?: number;
}

export interface PetReward {
  id: string;
  kind: string;
  title: string;
  date: string;
  earnedAt: number;
}

export interface PetActivityLogEntry {
  id: string;
  kind: string;
  message: string;
  createdAt: number;
}

export interface PetLifeStats {
  todayStudyMs: number;
  totalStudyMs: number;
  knowledgeCount: number;
  todayKnowledgeCount: number;
  completedTasks: number;
  checkedIn: number;
  missedCheckIns: number;
  rewardCount: number;
  streakDays: number;
}

export interface PetLifeSnapshot {
  version: number;
  needs: PetNeeds;
  behavior: PetBehavior;
  settings: PetLifeSettings;
  today: PetDayRecord;
  tasks: PetTask[];
  knowledge: PetKnowledge[];
  learningQuests: PetLearningQuest[];
  recentObservations: PetUserObservation[];
  activeSession?: PetStudySession;
  rewards: PetReward[];
  activityLog: PetActivityLogEntry[];
  stats: PetLifeStats;
  history: PetDaySummary[];
  windowPosition?: { x: number; y: number };
  prompt?: PetPrompt;
  bornAt: number;
  lastTickAt: number;
}

export interface PetDaySummary {
  date: string;
  studyMs: number;
  checkedIn: number;
  missedCheckIns: number;
  completedSchedule: number;
  scheduleCount: number;
  completedTasks: number;
  knowledgeCount: number;
  rewardCount: number;
  reflection: string;
}

export interface PetBackupResult {
  petId: string;
  destination: string;
  exportedAt: number;
  bytes: number;
}

export interface PetDashboard {
  pets: PetProfile[];
  activePetId: string;
  progress: PetProgress;
  memories: PetMemory[];
  overlayVisible: boolean;
  scale: number;
  life: PetLifeSnapshot;
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
