use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{AgentMessage, AgentTurnResponse, ProviderProfile, ToolCall};

pub const HARNESS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HarnessMode {
    Chat,
    Plan,
    Agent,
    Goal,
}

impl HarnessMode {
    pub fn from_wire(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "plan" => Self::Plan,
            "agent" => Self::Agent,
            "goal" => Self::Goal,
            _ => Self::Chat,
        }
    }

    pub fn allows_tools(self) -> bool {
        !matches!(self, Self::Chat)
    }

    pub fn allows_side_effects(self) -> bool {
        matches!(self, Self::Agent | Self::Goal)
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionLevel {
    #[default]
    Request,
    Agent,
    Full,
}

impl PermissionLevel {
    pub fn from_wire(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "agent" => Self::Agent,
            "full" => Self::Full,
            _ => Self::Request,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolRisk {
    ReadOnly,
    WorkspaceWrite,
    Destructive,
    Process,
    External,
    Costly,
    Delegation,
    CredentialSensitive,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    Allow,
    NeedsApproval,
    Deny,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    Host,
    User,
    Workspace,
    Untrusted,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextInclusion {
    Include,
    Exclude,
    SummaryOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDraftRequest {
    pub thread_id: String,
    pub raw_user_input: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    pub mode: HarnessMode,
    #[serde(default)]
    pub permission_level: PermissionLevel,
    pub requested_profile_id: Option<String>,
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub ok: bool,
    pub workspace: String,
    pub selected_profile_id: Option<String>,
    pub mode: HarnessMode,
    pub permission_level: PermissionLevel,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessOperationStarted {
    pub operation_id: String,
    pub draft_id: String,
    pub state: RuntimeState,
    pub event_sequence: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessToolPolicyRequest {
    pub mode: HarnessMode,
    #[serde(default)]
    pub permission_level: PermissionLevel,
    pub call: ToolCall,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessOperationStateUpdate {
    pub operation_id: String,
    pub state: RuntimeState,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunRequest {
    pub operation_id: String,
    pub thread_id: String,
    pub messages: Vec<AgentMessage>,
    pub profile: ProviderProfile,
    pub mode: HarnessMode,
    #[serde(default)]
    pub permission_level: PermissionLevel,
    pub workspace: Option<String>,
    #[serde(default)]
    pub fallback_profiles: Vec<ProviderProfile>,
    #[serde(default)]
    pub hatch: bool,
    #[serde(default)]
    pub hatch_skill_loaded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRuntimeEvent {
    pub schema_version: u32,
    pub operation_id: String,
    pub sequence: u64,
    pub kind: String,
    pub payload: Value,
}

impl HarnessRuntimeEvent {
    pub fn new(operation_id: &str, sequence: u64, kind: &str, payload: Value) -> Self {
        Self {
            schema_version: HARNESS_SCHEMA_VERSION,
            operation_id: operation_id.to_owned(),
            sequence,
            kind: kind.to_owned(),
            payload,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessApprovalResolution {
    pub operation_id: String,
    pub token: String,
    pub approved: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessApprovalRecord {
    pub approval_id: String,
    pub operation_id: String,
    pub tool_execution_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub arguments: Value,
    pub approved: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPendingApproval {
    pub approval_id: String,
    pub operation_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRecoveryDecision {
    pub operation_id: String,
    pub tool_execution_id: String,
    pub decision: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRecoveryItem {
    pub operation_id: String,
    pub tool_execution_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub status: String,
    pub started_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessQueueRequest {
    pub operation_id: String,
    pub kind: String,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessQueueItem {
    pub id: String,
    pub operation_id: String,
    pub kind: String,
    pub body: String,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSessionNodeRequest {
    pub thread_id: String,
    pub parent_id: Option<String>,
    pub branch_id: String,
    pub kind: String,
    pub message_id: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSessionNode {
    pub id: String,
    pub thread_id: String,
    pub parent_id: Option<String>,
    pub branch_id: String,
    pub kind: String,
    pub message_id: Option<String>,
    pub operation_id: Option<String>,
    pub position: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessForkSessionRequest {
    pub thread_id: String,
    pub parent_id: Option<String>,
    pub branch_id: String,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessProviderStep {
    pub response: AgentTurnResponse,
    pub profile_id: String,
    pub attempt_id: String,
    pub context_manifest_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessProviderAttempt {
    pub attempt_id: String,
    pub operation_id: String,
    pub snapshot_id: String,
    pub context_manifest_id: String,
    pub profile_id: String,
    pub model: String,
    pub protocol: String,
    pub failover_index: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskContract {
    pub objective: Option<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub deliverables: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub ambiguities: Vec<String>,
    pub raw_input_hash: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionLayer {
    pub source_id: String,
    pub source_kind: String,
    pub priority: u16,
    pub content_hash: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPolicy {
    pub mode: HarnessMode,
    pub permission_level: PermissionLevel,
    pub workspace: String,
    pub policy_version: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustManifestEntry {
    pub source_id: String,
    pub source_kind: String,
    pub trust: TrustLevel,
    pub content_hash: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustManifest {
    #[serde(default)]
    pub entries: Vec<TrustManifestEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelectedTool {
    pub name: String,
    pub risk: ToolRisk,
    pub schema_hash: String,
    pub selection_reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub profile_id: String,
    pub model: String,
    pub protocol: String,
    pub context_window: u32,
    pub capability_hash: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub id: String,
    pub operation_id: String,
    pub version: u32,
    pub raw_user_message_id: String,
    pub task_contract: TaskContract,
    #[serde(default)]
    pub instruction_layers: Vec<InstructionLayer>,
    pub execution_policy: ExecutionPolicy,
    pub trust_manifest: TrustManifest,
    #[serde(default)]
    pub selected_tools: Vec<SelectedTool>,
    pub provider: ProviderSnapshot,
    pub parent_snapshot_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    pub context_window: u32,
    pub reserve_output_tokens: u32,
    pub safety_margin_tokens: u32,
    pub system_tokens: u32,
    pub instruction_tokens: u32,
    pub tool_schema_tokens: u32,
    pub message_tokens: u32,
    pub attachment_tokens: u32,
    pub memory_tokens: u32,
}

impl ContextBudget {
    pub fn input_capacity(&self) -> u32 {
        self.context_window.saturating_sub(
            self.reserve_output_tokens
                .saturating_add(self.safety_margin_tokens),
        )
    }

    pub fn fixed_tokens(&self) -> u32 {
        self.system_tokens
            .saturating_add(self.instruction_tokens)
            .saturating_add(self.tool_schema_tokens)
            .saturating_add(self.attachment_tokens)
            .saturating_add(self.memory_tokens)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextBlock {
    pub id: String,
    pub source_kind: String,
    pub content_hash: String,
    pub estimated_tokens: u32,
    pub trust: TrustLevel,
    pub inclusion: ContextInclusion,
    pub group_id: Option<String>,
    pub mandatory: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextSelection {
    pub selected_ids: Vec<String>,
    pub omitted_ids: Vec<String>,
    pub estimated_tokens: u32,
    pub overflow: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultEnvelope {
    pub call_id: String,
    pub tool_name: String,
    pub status: String,
    pub is_error: bool,
    pub truncated: bool,
    pub trust: TrustLevel,
    pub context_inclusion: ContextInclusion,
    #[serde(default)]
    pub content: Vec<Value>,
    pub artifact_ref: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    DraftSaved,
    NeedsConfiguration,
    Compiling,
    Running,
    AwaitingApproval,
    Compacting,
    Persisting,
    Interrupted,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEvent {
    DraftUpdated,
    PreflightBlocked,
    PreflightReady,
    SnapshotCommitted,
    ApprovalRequired,
    ApprovalResolved,
    CompactionRequired,
    CompactionCommitted,
    ProviderStepFinished,
    SavePointCommitted { continue_work: bool },
    Resume,
    Cancel,
    Crash,
    Fail,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessEvent {
    pub schema_version: u32,
    pub operation_id: String,
    pub thread_id: String,
    pub snapshot_id: Option<String>,
    pub sequence: u64,
    pub kind: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEnvelope {
    pub call: ToolCall,
    pub risk: ToolRisk,
    pub decision: PolicyDecision,
    pub arguments_hash: String,
}
