use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    OpenaiResponses,
    OpenaiChat,
    AnthropicMessages,
    GeminiGenerateContent,
    /// OpenCode Go selects the wire endpoint from the model ID.
    OpencodeGo,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub protocol: ProviderProtocol,
    #[serde(default)]
    pub allow_unauthenticated: bool,
    #[serde(default = "default_provider_priority")]
    pub priority: i32,
    #[serde(default = "default_true")]
    pub failover_enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub profiles: Vec<ProviderProfile>,
    pub active_profile_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WritingProjectRecord {
    pub id: String,
    pub title: String,
    pub project_type: String,
    pub payload: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_provider_priority() -> i32 {
    100
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub internal: bool,
    #[serde(default)]
    pub attachments: Vec<ImageAttachment>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub kind: AttachmentKind,
    #[serde(skip)]
    pub data_base64: Option<String>,
    #[serde(skip)]
    pub text_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreview {
    pub kind: AttachmentKind,
    pub mime_type: String,
    pub data_base64: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    #[default]
    Image,
    Video,
    Text,
    Document,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRequest {
    pub profile: ProviderProfile,
    pub messages: Vec<AgentMessage>,
    pub mode: String,
    pub workspace: Option<String>,
    pub thread_id: Option<String>,
    #[serde(default)]
    pub hatch: bool,
    /// True after the frontend has observed a successful bundled hatch-pet
    /// manifest result. This is explicit state because long conversations may
    /// omit old tool exchanges from the provider context.
    #[serde(default)]
    pub hatch_skill_loaded: bool,
    #[serde(default)]
    pub available_tools: Vec<AgentToolDefinition>,
    #[serde(default)]
    pub available_skills: Vec<AgentSkillSummary>,
    pub goal: Option<GoalState>,
    #[serde(default)]
    pub fallback_profiles: Vec<ProviderProfile>,
    #[serde(default)]
    pub custom_instructions: Option<String>,
    /// Optional provider-native reasoning control. `auto` and unknown values
    /// are treated as omitted by the adapter for backward compatibility.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub request_id: Option<String>,
    pub provider_id: Option<String>,
    pub failover_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub profile_id: String,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub last_success_at: Option<i64>,
    pub last_failure_at: Option<i64>,
    pub cooldown_until: Option<i64>,
    pub total_requests: u64,
    pub total_failovers: u64,
    pub average_latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequestLog {
    pub id: String,
    pub thread_id: Option<String>,
    pub profile_id: String,
    pub model: String,
    pub protocol: String,
    pub started_at: i64,
    pub latency_ms: u64,
    pub status: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub request_id: Option<String>,
    pub failover_index: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayDiagnostics {
    pub profile_id: String,
    pub health_ok: bool,
    pub latency_ms: u64,
    pub usage: serde_json::Value,
    pub request_id: Option<String>,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExternalConfigTarget {
    Codex,
    Claude,
    Gemini,
    Opencode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFilePreview {
    pub path: String,
    pub exists: bool,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWritePreview {
    pub target: ExternalConfigTarget,
    pub files: Vec<ConfigFilePreview>,
    pub confirmation_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWriteResult {
    pub target: ExternalConfigTarget,
    pub backup_id: String,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub kind: String,
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retry_attempts: Option<u32>,
}

impl AgentStreamEvent {
    pub fn stream_opened() -> Self {
        Self {
            kind: "stream_opened".to_owned(),
            delta: None,
            retry_attempt: None,
            max_retry_attempts: None,
        }
    }

    pub fn non_stream_response() -> Self {
        Self {
            kind: "non_stream_response".to_owned(),
            delta: None,
            retry_attempt: None,
            max_retry_attempts: None,
        }
    }

    pub fn content(delta: String) -> Self {
        Self {
            kind: "content_delta".to_owned(),
            delta: Some(delta),
            retry_attempt: None,
            max_retry_attempts: None,
        }
    }

    pub fn provider_reconnecting(retry_attempt: u32, max_retry_attempts: u32) -> Self {
        Self {
            kind: "provider_reconnecting".to_owned(),
            delta: None,
            retry_attempt: Some(retry_attempt),
            max_retry_attempts: Some(max_retry_attempts),
        }
    }

    pub fn provider_reconnected(retry_attempt: u32, max_retry_attempts: u32) -> Self {
        Self {
            kind: "provider_reconnected".to_owned(),
            delta: None,
            retry_attempt: Some(retry_attempt),
            max_retry_attempts: Some(max_retry_attempts),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionRequest {
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
    pub name: String,
    pub arguments: serde_json::Value,
    pub workspace: String,
    pub thread_id: Option<String>,
    pub profile: Option<ProviderProfile>,
    #[serde(default)]
    pub fallback_profiles: Vec<ProviderProfile>,
    /// True when the call belongs to the bundled hatch-pet workflow.
    /// Hatch media needs an adapter source path that the deterministic
    /// hatch scripts can validate; ordinary media calls keep the old path.
    #[serde(default)]
    pub hatch: bool,
    /// True after the current hatch conversation received the bundled
    /// hatch-pet SKILL.md successfully. The tool executor uses this to reject
    /// stale manifest rereads from providers that ignore an updated schema.
    #[serde(default)]
    pub hatch_skill_loaded: bool,
    /// Internal application bootstrap calls may read the bundled legacy
    /// manifest once before the provider receives a hatch turn. Provider
    /// tool calls never set this flag.
    #[serde(default)]
    pub hatch_bootstrap: bool,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub permission_level: Option<String>,
    #[serde(default)]
    pub approval_granted: bool,
    /// Full permission explicitly opts local file tools into absolute paths.
    /// The default remains workspace-scoped for older clients and for all
    /// request/agent runs.
    #[serde(default)]
    pub allow_outside_workspace: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionResponse {
    pub output: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    StreamableHttp,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    #[serde(default = "default_mcp_enabled")]
    pub enabled: bool,
    pub transport: McpTransport,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_environment_keys: Vec<String>,
    #[serde(default)]
    pub secret_header_keys: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSecretValues {
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerUpsert {
    pub server: McpServerConfig,
    #[serde(default)]
    pub secrets: McpSecretValues,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSnapshot {
    pub server: McpServerConfig,
    pub status: String,
    pub tool_count: usize,
    pub last_error: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub tools: Vec<McpToolSnapshot>,
}

fn default_mcp_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolSnapshot {
    pub name: String,
    pub exposed_name: String,
    pub description: String,
    pub read_only: bool,
    pub destructive: Option<bool>,
    pub open_world: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub enabled: bool,
    pub valid: bool,
    pub warning: Option<String>,
}

/// A host-side request for creating a new Agent Skill.  Skills are authored as
/// UTF-8 directories with a required `SKILL.md`; the host, rather than the
/// model, chooses the destination root and validates the manifest.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCreateRequest {
    pub name: String,
    pub description: String,
    pub instructions: String,
    #[serde(default)]
    pub workspace: Option<String>,
    /// `workspace`, `user`, `codex`, `claude`, or `app` (defaults to workspace
    /// when available).
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateRequest {
    pub skill_id: String,
    pub content: String,
    #[serde(default)]
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDeleteRequest {
    pub skill_id: String,
    #[serde(default)]
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallRequest {
    pub source: String,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLocation {
    pub scope: String,
    pub label: String,
    pub path: String,
    pub writable: bool,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMutationResult {
    pub skill: SkillInfo,
    pub path: String,
    pub created: bool,
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallResult {
    pub source: String,
    pub skills: Vec<SkillInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub owned_by: Option<String>,
    /// Preferred route after catalog merging. Standard `/v1/models` entries
    /// inherit the connection's configured protocol because that response
    /// does not advertise a generation protocol; native catalogs can provide
    /// a model-specific route.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProviderProtocol>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub protocols: Vec<ProviderProtocol>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_generation_methods: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_modalities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_modalities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelInfo {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub protocol: ProviderProtocol,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub protocols: Vec<ProviderProtocol>,
    pub owned_by: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_generation_methods: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_modalities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_modalities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCatalog {
    pub models: Vec<ProviderModelInfo>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VideoGenerationMode {
    #[default]
    Text,
    Image,
    Reference,
    Video,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaStatus {
    Queued,
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaModelInfo {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub protocol: ProviderProtocol,
    pub kind: MediaKind,
    pub rank: i64,
    pub recommended: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaCatalog {
    pub models: Vec<MediaModelInfo>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaGenerationRequest {
    pub profile_id: Option<String>,
    pub kind: MediaKind,
    pub model: Option<String>,
    /// Optional model-level route selected from discovery. Older callers can
    /// omit it and fall back to the connection's configured protocol.
    #[serde(default)]
    pub protocol: Option<ProviderProtocol>,
    pub prompt: String,
    #[serde(default = "default_media_count")]
    pub count: u32,
    pub size: Option<String>,
    pub quality: Option<String>,
    pub output_format: Option<String>,
    pub background: Option<String>,
    pub voice: Option<String>,
    pub instructions: Option<String>,
    pub seconds: Option<u32>,
    #[serde(default)]
    pub video_mode: VideoGenerationMode,
    pub video_resolution: Option<String>,
    pub video_aspect_ratio: Option<String>,
    #[serde(default)]
    pub reference_attachment_ids: Vec<String>,
    /// Optional PNG mask for OpenAI-compatible image edits. Transparent pixels
    /// identify the region that may be replaced.
    #[serde(default)]
    pub mask_attachment_id: Option<String>,
}

fn default_media_count() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub batch_id: String,
    pub thread_id: Option<String>,
    pub provider_id: String,
    pub provider_name: String,
    pub kind: MediaKind,
    pub status: MediaStatus,
    pub prompt: String,
    pub model: String,
    pub mime_type: Option<String>,
    pub file_name: Option<String>,
    pub file_path: Option<String>,
    pub remote_id: Option<String>,
    pub revised_prompt: Option<String>,
    pub error: Option<String>,
    pub progress: Option<u32>,
    pub size: Option<String>,
    pub quality: Option<String>,
    pub background: Option<String>,
    pub output_format: Option<String>,
    #[serde(default = "default_media_count")]
    pub count: u32,
    pub voice: Option<String>,
    pub seconds: Option<u32>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetPage {
    pub assets: Vec<MediaAsset>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaBatchResult {
    pub batch_id: String,
    pub assets: Vec<MediaAsset>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub is_error: bool,
    pub request_id: Option<String>,
    #[serde(default)]
    pub internal: bool,
    #[serde(default)]
    pub change_set: Option<serde_json::Value>,
    #[serde(default)]
    pub attachments: Vec<ImageAttachment>,
    /// The model identity captured when this assistant response was created.
    /// These fields are optional so databases/messages written by older builds
    /// continue to deserialize and can be displayed with a stable fallback.
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub provider_brand: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Auditing,
    Completed,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub id: String,
    pub thread_id: String,
    pub objective: String,
    pub status: GoalStatus,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub turns: u64,
    pub blocked_attempts: u32,
    pub last_blocker: Option<String>,
    pub audit_note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalCreateRequest {
    pub thread_id: String,
    pub objective: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredThread {
    pub id: String,
    pub title: String,
    pub workspace: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub pet_id: Option<String>,
    pub messages: Vec<StoredMessage>,
    pub updated_at: i64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalConfigCandidate {
    pub id: String,
    pub source: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub protocol: ProviderProtocol,
    pub has_secret: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_available: bool,
    pub is_repository: bool,
    pub branch: Option<String>,
    pub changes: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceFileSnapshot {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub fingerprint: String,
    pub content: Option<String>,
    pub base_content: Option<String>,
    pub content_truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceSnapshot {
    pub is_available: bool,
    pub is_repository: bool,
    pub files: Vec<GitWorkspaceFileSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRollbackPreview {
    pub path: String,
    pub status: String,
    pub action: String,
    pub diff: String,
    pub truncated: bool,
    pub confirmation_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRollbackResult {
    pub path: String,
    pub action: String,
}
