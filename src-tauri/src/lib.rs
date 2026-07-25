mod agent;
mod attachment;
mod config_writeback;
mod database;
mod filesystem;
mod git;
mod layout;
mod mcp;
mod media;
mod migration;
mod models;
mod pet;
mod process;
mod skill;
mod subagent;
mod theme;
mod tools;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use models::{
    AgentMessage, AgentSkillSummary, AgentStreamEvent, AgentToolDefinition, AgentTurnRequest,
    AgentTurnResponse, AttachmentPreview, ConfigWritePreview, ConfigWriteResult,
    ExternalConfigCandidate, ExternalConfigTarget, GatewayDiagnostics, GitDiff, GitRollbackPreview,
    GitRollbackResult, GitStatus, GoalCreateRequest, GoalState, ImageAttachment, McpSecretValues,
    McpServerConfig, McpServerSnapshot, McpServerUpsert, MediaAsset, MediaAssetPage,
    MediaBatchResult, MediaCatalog, MediaGenerationRequest, MediaKind, MediaStatus, ModelInfo,
    ProviderHealth, ProviderProfile, ProviderRequestLog, ProviderSettings, SkillInfo, StoredThread,
    ToolExecutionRequest, ToolExecutionResponse, WritingProjectRecord,
};
use reqwest::Client;
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

const KEYRING_SERVICE: &str = "com.levelup.agent";
const PROVIDER_CREDENTIAL_PREFIX: &str = "provider:";
const MCP_CREDENTIAL_PREFIX: &str = "mcp:";
const MAX_PENDING_CONFIRMATIONS: usize = 128;

struct AppState {
    client: Client,
    active_requests: Mutex<HashMap<String, CancellationToken>>,
    pending_config_writes: Mutex<HashMap<String, PendingConfigWrite>>,
    pending_prompt_writes: Mutex<HashMap<String, PendingPromptWrite>>,
    pending_git_rollbacks: Mutex<HashMap<String, PendingGitRollback>>,
}

struct PendingConfigWrite {
    target: ExternalConfigTarget,
    profile: ProviderProfile,
    created_at: Instant,
}

struct PendingPromptWrite {
    target: ExternalConfigTarget,
    content: String,
    created_at: Instant,
}

struct PendingGitRollback {
    candidate: git::GitRollbackCandidate,
    created_at: Instant,
}

fn credential(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|error| format!("Could not open the system credential vault: {error}"))
}

fn validate_provider_id(profile_id: &str) -> Result<(), String> {
    if profile_id.is_empty()
        || profile_id.len() > 200
        || !profile_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(
            "Provider ID may only contain letters, numbers, dashes, underscores, and dots"
                .to_owned(),
        );
    }
    Ok(())
}

fn provider_credential(profile_id: &str) -> Result<keyring::Entry, String> {
    validate_provider_id(profile_id)?;
    credential(&format!("{PROVIDER_CREDENTIAL_PREFIX}{profile_id}"))
}

fn load_api_key(profile_id: &str) -> Result<String, String> {
    let entry = provider_credential(profile_id)?;
    match entry.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => {
            // 0.11 and earlier used the bare Provider ID. Migrate once without exposing it.
            let legacy = credential(profile_id)?;
            let value = legacy.get_password().map_err(|_| {
                "This provider has no API key in the system credential vault".to_owned()
            })?;
            entry
                .set_password(&value)
                .map_err(|error| format!("Could not migrate the provider API key: {error}"))?;
            let _ = legacy.delete_credential();
            Ok(value)
        }
        Err(_) => Err("This provider has no API key in the system credential vault".to_owned()),
    }
}

fn load_profile_api_key(profile: &ProviderProfile) -> Result<String, String> {
    match load_api_key(&profile.id) {
        Ok(api_key) => Ok(api_key),
        Err(_) if profile.allow_unauthenticated => Ok(String::new()),
        Err(error) => Err(error),
    }
}

fn mcp_credential(server_id: &str) -> Result<keyring::Entry, String> {
    credential(&format!("{MCP_CREDENTIAL_PREFIX}{server_id}"))
}

fn load_mcp_secrets(server_id: &str) -> Result<McpSecretValues, String> {
    match mcp_credential(server_id)?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map_err(|_| "The MCP credential entry is invalid".to_owned()),
        Err(keyring::Error::NoEntry) => Ok(McpSecretValues::default()),
        Err(error) => Err(format!("Could not read MCP credentials: {error}")),
    }
}

fn save_mcp_secrets(server: &McpServerConfig, incoming: McpSecretValues) -> Result<(), String> {
    let mut secrets = load_mcp_secrets(&server.id)?;
    secrets
        .environment
        .retain(|key, _| server.secret_environment_keys.contains(key));
    secrets
        .headers
        .retain(|key, _| server.secret_header_keys.contains(key));
    for (key, value) in incoming.environment {
        if server.secret_environment_keys.contains(&key) && !value.is_empty() {
            secrets.environment.insert(key, value);
        }
    }
    for (key, value) in incoming.headers {
        if server.secret_header_keys.contains(&key) && !value.is_empty() {
            secrets.headers.insert(key, value);
        }
    }
    let entry = mcp_credential(&server.id)?;
    if secrets.environment.is_empty() && secrets.headers.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("Could not clear MCP credentials: {error}")),
        }
    } else {
        let value = serde_json::to_string(&secrets)
            .map_err(|error| format!("Could not encode MCP credentials: {error}"))?;
        entry
            .set_password(&value)
            .map_err(|error| format!("Could not save MCP credentials: {error}"))
    }
}

async fn attach_mcp_tools(
    database: &database::Database,
    manager: &mcp::McpManager,
    request: &mut AgentTurnRequest,
) -> Result<(), String> {
    if !matches!(request.mode.as_str(), "agent" | "goal") {
        return Ok(());
    }
    for server in database
        .list_mcp_servers()?
        .into_iter()
        .filter(|server| server.enabled)
    {
        let secrets = match load_mcp_secrets(&server.id) {
            Ok(secrets) => secrets,
            Err(error) => {
                manager.set_error(&server.id, &error).await;
                continue;
            }
        };
        match manager.ensure_tools(&server, &secrets).await {
            Ok(tools) => {
                let remaining = 256_usize.saturating_sub(request.available_tools.len());
                request
                    .available_tools
                    .extend(tools.into_iter().take(remaining));
                if request.available_tools.len() >= 256 {
                    break;
                }
            }
            Err(_) => continue,
        }
    }
    Ok(())
}

fn built_in_skill_root(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let bundled_skills = app
        .path()
        .resource_dir()
        .map(|path| path.join("resources").join("skills"))
        .unwrap_or_else(|_| std::path::PathBuf::new());
    let source_skills = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("skills");
    if bundled_skills.is_dir() {
        Some(bundled_skills.as_path())
    } else if source_skills.is_dir() {
        Some(source_skills.as_path())
    } else {
        None
    }
    .map(std::path::Path::to_path_buf)
}

fn discover_skills(
    app: &tauri::AppHandle,
    database: &database::Database,
    workspace: Option<&str>,
) -> Result<Vec<SkillInfo>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate the application data directory: {error}"))?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    let built_in_skills = built_in_skill_root(app);
    let codex_home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from);
    Ok(skill::scan(
        &app_data,
        &home,
        built_in_skills.as_deref(),
        codex_home.as_deref(),
        workspace.map(std::path::Path::new),
        &database.skill_preferences()?,
    ))
}

fn attach_skills(
    app: &tauri::AppHandle,
    database: &database::Database,
    request: &mut AgentTurnRequest,
) -> Result<(), String> {
    if !matches!(request.mode.as_str(), "agent" | "goal" | "plan") {
        return Ok(());
    }
    let enabled: Vec<_> = discover_skills(app, database, request.workspace.as_deref())?
        .into_iter()
        .filter(|skill| skill.enabled && skill.valid)
        .filter(|skill| {
            !request.hatch || skill.source == "LevelUpAgent built-in" && skill.name == "hatch-pet"
        })
        .take(64)
        .collect();
    request.available_skills = enabled
        .iter()
        .map(|skill| AgentSkillSummary {
            id: skill.id.clone(),
            name: skill.name.clone(),
            description: skill.description.chars().take(500).collect(),
        })
        .collect();
    // Keep this phase explicit as well as history-derived. The frontend sends
    // the phase on every continuation because context compaction can omit the
    // original successful manifest exchange from the provider request.
    let hatch_skill_loaded = request.hatch
        && (request.hatch_skill_loaded || agent::hatch_skill_was_read(&request.messages));
    request.hatch_skill_loaded = hatch_skill_loaded;
    if request.hatch && !hatch_skill_loaded {
        return Err(
            "Hatch bootstrap has not completed; the application must load the bundled legacy hatch-pet Skill before starting a provider turn".to_owned(),
        );
    }
    // Hatch bootstrap is owned by the application. Never expose the generic
    // read_skill tool to a provider turn: models that see it can emit several
    // identical reads in one response and restart the workflow indefinitely.
    if !enabled.is_empty() && !request.hatch {
        request.available_tools.push(AgentToolDefinition {
            name: "read_skill".to_owned(),
            description: "Read an enabled Skill's SKILL.md or a referenced UTF-8 file inside that Skill directory.".to_owned(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "skillId": {
                        "type": "string",
                        "enum": enabled.iter().map(|skill| skill.id.clone()).collect::<Vec<_>>()
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional Skill-relative file path; defaults to SKILL.md"
                    }
                },
                "required": ["skillId"]
            }),
            read_only: true,
        });
    }
    Ok(())
}

fn attach_goal(
    database: &database::Database,
    request: &mut AgentTurnRequest,
) -> Result<(), String> {
    if request.mode != "goal" {
        return Ok(());
    }
    let thread_id = request
        .thread_id
        .as_deref()
        .ok_or_else(|| "Goal mode requires a task ID".to_owned())?;
    let goal = database
        .get_goal(thread_id)?
        .ok_or_else(|| "This task has no Goal".to_owned())?;
    if !matches!(
        goal.status,
        models::GoalStatus::Active | models::GoalStatus::Auditing
    ) {
        return Err("Goal is not active; resume it before continuing".to_owned());
    }
    // Hatch conversations were created by older clients without a durable
    // hatch flag. Infer the workflow from the generated objective before the
    // skill/tool catalogs are attached so a resumed legacy thread cannot
    // expose read_skill/get_goal and fall back into an observation loop.
    if is_hatch_goal_objective(&goal.objective) {
        request.hatch = true;
    }
    request.goal = Some(goal);
    if !request.hatch {
        request.available_tools.push(AgentToolDefinition {
            name: "get_goal".to_owned(),
            description: "Read the current persistent Goal, status, usage, and audit state."
                .to_owned(),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
            read_only: true,
        });
    }
    request.available_tools.push(AgentToolDefinition {
        name: "update_goal".to_owned(),
        description: "Request Goal completion or report a repeated blocker with concrete evidence. The first completion request starts an audit; a second evidence-backed request during auditing completes it.".to_owned(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "status": { "type": "string", "enum": ["complete", "blocked"] },
                "evidence": { "type": "string" }
            },
            "required": ["status", "evidence"]
        }),
        read_only: true,
    });
    Ok(())
}

fn is_hatch_goal_objective(objective: &str) -> bool {
    let normalized = objective.trim().to_ascii_lowercase();
    normalized.contains("孵化摇光残影")
        || (normalized.contains("hatch")
            && (normalized.contains("starlight echo")
                || normalized.contains("hatch-pet")
                || normalized.contains("pet")))
        || (normalized.contains("残影") && normalized.contains("孵化"))
}

fn attach_custom_instructions(
    database: &database::Database,
    request: &mut AgentTurnRequest,
) -> Result<(), String> {
    let content = database.custom_instructions()?;
    request.custom_instructions = (!content.is_empty()).then_some(content);
    Ok(())
}

fn attach_subagent_tools(request: &mut AgentTurnRequest) {
    if !matches!(request.mode.as_str(), "agent" | "goal") || request.workspace.is_none() {
        return;
    }
    request.available_tools.extend([
        AgentToolDefinition {
            name: "delegate_task".to_owned(),
            description: "Delegate one bounded implementation task to a child Agent in a temporary isolated Git worktree. The child may read, search, and write UTF-8 files but cannot run commands. The main worktree remains unchanged until a separate apply_subagent_patch approval.".to_owned(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": "Concrete implementation task with acceptance criteria" },
                    "scope": { "type": "string", "description": "Optional files or subsystem the child should stay within" },
                    "maxTurns": { "type": "integer", "minimum": 1, "maximum": 8, "default": 6 }
                },
                "required": ["task"]
            }),
            read_only: false,
        },
        AgentToolDefinition {
            name: "apply_subagent_patch".to_owned(),
            description: "Apply a previously reviewed child Agent patch to the clean main Git worktree. Requires a second user approval and fails if HEAD or the worktree changed.".to_owned(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "runId": { "type": "string", "description": "32-character run ID returned by delegate_task" }
                },
                "required": ["runId"]
            }),
            read_only: false,
        },
    ]);
}

fn attach_media_tools(request: &mut AgentTurnRequest) {
    if !matches!(request.mode.as_str(), "agent" | "goal") {
        return;
    }
    request.available_tools.extend([
        AgentToolDefinition {
            name: "generate_images".to_owned(),
            description: "Generate or edit raster images using the newest suitable image model from configured connections by default. When the user asks for an image, call this tool instead of writing an SVG, HTML, or other code-drawn substitute unless they explicitly request vector or code-native output. Multiple generate_images calls in one response run concurrently for ordinary tasks and may incur provider charges. During a hatch-pet run, the adapter also exports unchanged completed image bytes to a standard generated_images/ig_* source and returns hatchSourcePaths for record_imagegen_result.py; use that returned path instead of the media storage path.".to_owned(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Detailed image prompt" },
                    "count": { "type": "integer", "minimum": 1, "maximum": 8, "default": 1 },
                    "model": { "type": "string", "description": "Optional explicit image model; omit to use the newest recommended model" },
                    "profileId": { "type": "string", "description": "Optional configured connection ID" },
                    "size": { "type": "string", "default": "auto", "description": "Image size or aspect ratio. Examples: auto, 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 1152x2048, 3840x2160, 2160x3840, 16:9, 9:16, 21:9, 9:21. The backend reinforces recognized sizes and aspect ratios in the effective image prompt." },
                    "quality": { "type": "string", "description": "Provider-specific quality such as auto, high, medium, 2K, or 4K" },
                    "outputFormat": { "type": "string", "enum": ["png", "jpeg", "webp"] },
                    "background": { "type": "string", "enum": ["auto", "transparent", "opaque"], "description": "Set transparent only when the user explicitly requests a transparent background; omit it otherwise. Model compatibility is enforced by the media backend." },
                    "referenceAttachmentIds": { "type": "array", "items": { "type": "string" }, "maxItems": 8, "description": "Managed image attachment IDs for edits or visual references" },
                    "hatchRunDir": { "type": "string", "description": "Hatch-pet run directory returned by prepare_pet_run.py; only used by the bundled hatch adapter" },
                    "hatchJobId": { "type": "string", "description": "Pending imagegen-jobs.json job ID for a hatch-pet row; the adapter loads that job's grounding images" }
                },
                "required": ["prompt"]
            }),
            read_only: false,
        },
        AgentToolDefinition {
            name: "generate_videos".to_owned(),
            description: "Start one or more video generations using the newest suitable video model by default. Returns persistent job assets. If any job is queued or in progress, call check_media_jobs until terminal before giving the final summary. Multiple generation calls run concurrently and may incur provider charges.".to_owned(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Detailed video prompt including subject, motion, camera, lighting, and timing" },
                    "count": { "type": "integer", "minimum": 1, "maximum": 4, "default": 1 },
                    "model": { "type": "string", "description": "Optional explicit video model; omit for newest recommended" },
                    "profileId": { "type": "string" },
                    "size": { "type": "string", "description": "Examples: 1280x720, 720x1280, 16:9, 9:16" },
                    "seconds": { "type": "integer", "minimum": 1, "maximum": 20 }
                },
                "required": ["prompt"]
            }),
            read_only: false,
        },
        AgentToolDefinition {
            name: "generate_speech".to_owned(),
            description: "Generate spoken audio from text using the newest suitable TTS model by default. Multiple speech calls run concurrently and may incur provider charges.".to_owned(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Exact text to speak" },
                    "voice": { "type": "string", "description": "Provider voice name; defaults to alloy for OpenAI and Kore for Gemini" },
                    "instructions": { "type": "string", "description": "Delivery, emotion, accent, or pacing instructions" },
                    "outputFormat": { "type": "string", "enum": ["mp3", "wav", "aac", "flac", "opus", "pcm"] },
                    "count": { "type": "integer", "minimum": 1, "maximum": 4, "default": 1 },
                    "model": { "type": "string", "description": "Optional explicit TTS model; omit for newest recommended" },
                    "profileId": { "type": "string" }
                },
                "required": ["prompt"]
            }),
            read_only: false,
        },
        AgentToolDefinition {
            name: "check_media_jobs".to_owned(),
            description: "Refresh persistent video generation jobs and return their latest status and local paths. Call again while any requested asset is queued or in progress; summarize only after all are completed or failed.".to_owned(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "assetIds": { "type": "array", "items": { "type": "string" }, "maxItems": 16, "description": "Video asset IDs returned by generate_videos; omit to refresh this task's pending video jobs" }
                }
            }),
            read_only: true,
        },
    ]);
}

fn attachment_storage(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate the application data directory: {error}"))?
        .join("attachments"))
}

fn media_storage(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate the application data directory: {error}"))?
        .join("media"))
}

fn ensure_default_workspace(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let workspace = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not locate the local application data directory: {error}"))?
        .join("workspace");
    std::fs::create_dir_all(&workspace)
        .map_err(|error| format!("Could not create the temporary workspace: {error}"))?;
    filesystem::restrict_directory(&workspace)?;
    Ok(workspace)
}

fn attach_default_workspace(
    app: &tauri::AppHandle,
    request: &mut AgentTurnRequest,
) -> Result<(), String> {
    if request
        .workspace
        .as_deref()
        .is_none_or(|workspace| workspace.trim().is_empty())
    {
        request.workspace = Some(
            ensure_default_workspace(app)?
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok(())
}

fn subagent_storage(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate the application data directory: {error}"))?
        .join("subagents"))
}

fn theme_storage(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate the application data directory: {error}"))?
        .join("themes"))
}

fn bundled_theme_source(app: &tauri::AppHandle) -> Result<Option<std::path::PathBuf>, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not locate the application resource directory: {error}"))?
        .join("themes");
    if bundled.is_dir() {
        return Ok(Some(bundled));
    }
    let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.join("themes"));
    Ok(source.filter(|path| path.is_dir()))
}

#[tauri::command]
fn list_themes(app: tauri::AppHandle) -> Result<Vec<theme::ThemeManifest>, String> {
    theme::list(&theme_storage(&app)?)
}

#[tauri::command]
fn install_theme(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<theme::ThemeManifest, String> {
    theme::install(&theme_storage(&app)?, std::path::Path::new(&source_path))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardThemePayload {
    name: String,
    data_base64: String,
    #[serde(default)]
    layout_name: Option<String>,
    #[serde(default)]
    layout_data_base64: Option<String>,
}

#[tauri::command]
fn install_theme_data(
    app: tauri::AppHandle,
    payload: ClipboardThemePayload,
) -> Result<theme::ThemeManifest, String> {
    let _name = std::path::Path::new(payload.name.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| value.to_ascii_lowercase().ends_with(".levelup-theme"))
        .ok_or_else(|| "Clipboard content must be a .levelup-theme file".to_owned())?;
    if payload.data_base64.len() > 16 * 1024 * 1024 {
        return Err("Clipboard theme package is too large".to_owned());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.data_base64.trim())
        .map_err(|error| format!("Clipboard theme data is not valid base64: {error}"))?;
    if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 {
        return Err("Theme packages must be between 1 byte and 12 MiB".to_owned());
    }
    let layout = match (payload.layout_name, payload.layout_data_base64) {
        (None, None) => None,
        (Some(name), Some(data_base64)) => {
            let name = std::path::Path::new(name.trim())
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Clipboard layout file name is invalid".to_owned())?
                .to_owned();
            theme::validate_layout_file_name(&name)?;
            if data_base64.len() > 768 * 1024 {
                return Err("Clipboard layout file is too large".to_owned());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_base64.trim())
                .map_err(|error| format!("Clipboard layout data is not valid base64: {error}"))?;
            if bytes.is_empty() || bytes.len() > 512 * 1024 {
                return Err("Layout files must be between 1 byte and 512 KiB".to_owned());
            }
            Some((name, bytes))
        }
        _ => return Err("Clipboard theme layout data is incomplete".to_owned()),
    };

    let import_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not locate the local application data directory: {error}"))?
        .join("theme-imports");
    std::fs::create_dir_all(&import_root)
        .map_err(|error| format!("Could not create temporary theme storage: {error}"))?;
    filesystem::restrict_directory(&import_root)?;
    let temporary = import_root.join(format!(".{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&temporary)
        .map_err(|error| format!("Could not create temporary theme directory: {error}"))?;
    filesystem::restrict_directory(&temporary)?;
    let source = temporary.join("pasted.levelup-theme");
    let result = (|| {
        std::fs::write(&source, bytes)
            .map_err(|error| format!("Could not stage clipboard theme: {error}"))?;
        filesystem::restrict_file(&source)?;
        if let Some((name, bytes)) = layout {
            let layout_path = temporary.join(name);
            std::fs::write(&layout_path, bytes)
                .map_err(|error| format!("Could not stage clipboard layout: {error}"))?;
            filesystem::restrict_file(&layout_path)?;
        }
        theme::install(&theme_storage(&app)?, &source)
    })();
    let _ = std::fs::remove_dir_all(&temporary);
    result
}

#[tauri::command]
fn load_theme(app: tauri::AppHandle, theme_id: String) -> Result<theme::ThemePackage, String> {
    theme::load(&theme_storage(&app)?, &theme_id)
}

#[tauri::command]
fn load_theme_layout(
    app: tauri::AppHandle,
    theme_id: String,
) -> Result<layout::ResolvedLayout, String> {
    theme::load_layout(&theme_storage(&app)?, &theme_id)
}

#[tauri::command]
fn uninstall_theme(app: tauri::AppHandle, theme_id: String) -> Result<bool, String> {
    theme::uninstall(&theme_storage(&app)?, &theme_id)
}

fn emit_pet_dashboard(app: &tauri::AppHandle, manager: &pet::PetManager) {
    if let Ok(dashboard) = manager.dashboard() {
        let _ = app.emit_to("pet", "pet://refresh", dashboard);
    }
}

#[tauri::command]
fn get_pet_runtime(
    manager: tauri::State<'_, pet::PetManager>,
    runtime: tauri::State<'_, pet::PetRuntime>,
) -> Result<pet::PetRuntimeSnapshot, String> {
    Ok(pet::PetRuntimeSnapshot {
        dashboard: manager.dashboard()?,
        activities: runtime.activities()?,
    })
}

#[tauri::command]
fn select_pet(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    pet_id: String,
) -> Result<pet::PetDashboard, String> {
    let dashboard = manager.set_active(&pet_id)?;
    let _ = app.emit_to("pet", "pet://refresh", &dashboard);
    Ok(dashboard)
}

#[tauri::command]
fn set_pet_overlay_visible(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    visible: bool,
) -> Result<pet::PetDashboard, String> {
    let dashboard = manager.set_overlay_visible(visible)?;
    let window = pet::create_window(&app, visible)?;
    if visible {
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|error| format!("Could not show Starlight Echo window: {error}"))?;
    } else {
        window
            .hide()
            .map_err(|error| format!("Could not hide Starlight Echo window: {error}"))?;
    }
    let _ = app.emit_to("pet", "pet://refresh", &dashboard);
    Ok(dashboard)
}

#[tauri::command]
fn set_pet_scale(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    pet_id: String,
    scale: f64,
) -> Result<pet::PetDashboard, String> {
    let dashboard = manager.set_scale(&pet_id, scale)?;
    let _ = app.emit_to("pet", "pet://refresh", &dashboard);
    Ok(dashboard)
}

#[tauri::command]
fn install_pet(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    source_path: String,
) -> Result<pet::PetProfile, String> {
    let profile = manager.install_package(Path::new(&source_path), true)?;
    emit_pet_dashboard(&app, &manager);
    Ok(profile)
}

#[tauri::command]
fn remove_pet(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    pet_id: String,
) -> Result<bool, String> {
    let removed = manager.remove_package(&pet_id)?;
    if removed {
        emit_pet_dashboard(&app, &manager);
    }
    Ok(removed)
}

#[tauri::command]
fn record_pet_usage(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    pet_id: String,
    usage_id: String,
    input_tokens: u64,
    output_tokens: u64,
) -> Result<pet::PetProgress, String> {
    let progress = manager.record_usage(&pet_id, &usage_id, input_tokens, output_tokens)?;
    emit_pet_dashboard(&app, &manager);
    Ok(progress)
}

#[tauri::command]
fn learn_pet_memory(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    pet_id: String,
    text: String,
) -> Result<Vec<pet::PetMemory>, String> {
    let memories = manager.learn_from_message(&pet_id, &text)?;
    emit_pet_dashboard(&app, &manager);
    Ok(memories)
}

#[tauri::command]
fn delete_pet_memory(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    pet_id: String,
    memory_id: String,
) -> Result<bool, String> {
    let removed = manager.delete_memory(&pet_id, &memory_id)?;
    if removed {
        emit_pet_dashboard(&app, &manager);
    }
    Ok(removed)
}

#[tauri::command]
fn get_pet_hatch_environment(manager: tauri::State<'_, pet::PetManager>) -> pet::HatchEnvironment {
    manager.hatch_environment()
}

fn enable_pet_hatch_skills(
    database: &database::Database,
    environment: &pet::HatchEnvironment,
) -> Result<(), String> {
    for directory in [
        environment.hatch_skill_path.as_deref(),
        environment.imagegen_skill_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let path = std::fs::canonicalize(Path::new(directory).join("SKILL.md"))
            .map_err(|error| format!("Could not resolve bundled Skill manifest: {error}"))?;
        let id = skill::id_for_path(&path);
        database.set_skill_enabled(&id, &path.to_string_lossy(), true)?;
    }
    Ok(())
}

#[tauri::command]
fn configure_pet_hatch(
    manager: tauri::State<'_, pet::PetManager>,
    database: tauri::State<'_, database::Database>,
) -> Result<pet::HatchEnvironment, String> {
    let environment = manager.configure_hatch()?;
    enable_pet_hatch_skills(&database, &environment)?;
    Ok(environment)
}

#[tauri::command]
fn import_hatched_pets(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    after_ms: i64,
) -> Result<Vec<pet::PetProfile>, String> {
    let installed = manager.import_discovered(after_ms)?;
    if !installed.is_empty() {
        emit_pet_dashboard(&app, &manager);
    }
    Ok(installed)
}

#[tauri::command]
fn update_pet_activities(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, pet::PetRuntime>,
    activities: Vec<pet::PetActivity>,
) -> Result<Vec<pet::PetActivity>, String> {
    let activities = runtime.replace(activities)?;
    let _ = app.emit_to("pet", "pet://activities", &activities);
    Ok(activities)
}

#[tauri::command]
fn open_pet_chat(
    app: tauri::AppHandle,
    manager: tauri::State<'_, pet::PetManager>,
    pet_id: String,
) -> Result<(), String> {
    let dashboard = manager.dashboard()?;
    if !dashboard.pets.iter().any(|profile| profile.id == pet_id) {
        return Err("The selected Starlight Echo is not installed".to_owned());
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "The LevelUpAgent main window is unavailable".to_owned())?;
    main.show()
        .and_then(|_| main.unminimize())
        .and_then(|_| main.set_focus())
        .map_err(|error| format!("Could not focus LevelUpAgent: {error}"))?;
    app.emit_to(
        "main",
        "pet://open-chat",
        serde_json::json!({ "petId": pet_id }),
    )
    .map_err(|error| format!("Could not open the Starlight Echo conversation: {error}"))
}

fn attach_images(app: &tauri::AppHandle, request: &mut AgentTurnRequest) -> Result<(), String> {
    attachment::resolve(&attachment_storage(app)?, &mut request.messages)
}

fn provider_candidates(request: &AgentTurnRequest) -> Vec<ProviderProfile> {
    let mut seen = HashSet::from([request.profile.id.clone()]);
    let mut fallbacks = request
        .fallback_profiles
        .iter()
        .filter(|profile| profile.failover_enabled)
        .cloned()
        .collect::<Vec<_>>();
    fallbacks.sort_by(|left, right| {
        left.priority
            .cmp(&right.priority)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut candidates = vec![request.profile.clone()];
    candidates.extend(
        fallbacks
            .into_iter()
            .filter(|profile| seen.insert(profile.id.clone()))
            .take(7),
    );
    candidates
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn provider_is_cooling_down(
    database: &database::Database,
    profile_id: &str,
) -> Result<bool, String> {
    Ok(database
        .get_provider_health(profile_id)?
        .cooldown_until
        .is_some_and(|deadline| deadline > now_millis()))
}

fn provider_protocol_id(protocol: &models::ProviderProtocol) -> &'static str {
    match protocol {
        models::ProviderProtocol::OpenaiResponses => "openai_responses",
        models::ProviderProtocol::OpenaiChat => "openai_chat",
        models::ProviderProtocol::AnthropicMessages => "anthropic_messages",
        models::ProviderProtocol::GeminiGenerateContent => "gemini_generate_content",
    }
}

#[allow(clippy::too_many_arguments)]
fn record_provider_request(
    database: &database::Database,
    request: &AgentTurnRequest,
    profile: &ProviderProfile,
    started_at: i64,
    latency_ms: u64,
    status: &str,
    response: Option<&AgentTurnResponse>,
    failover_index: u32,
    error: Option<&str>,
) -> Result<(), String> {
    database.record_provider_request(&ProviderRequestLog {
        id: uuid::Uuid::new_v4().to_string(),
        thread_id: request.thread_id.clone(),
        profile_id: profile.id.clone(),
        model: profile.model.clone(),
        protocol: provider_protocol_id(&profile.protocol).to_owned(),
        started_at,
        latency_ms,
        status: status.to_owned(),
        input_tokens: response.and_then(|item| item.input_tokens),
        output_tokens: response.and_then(|item| item.output_tokens),
        request_id: response.and_then(|item| item.request_id.clone()),
        failover_index,
        error: error.map(str::to_owned),
    })
}

async fn run_agent_turn_with_failover<F>(
    client: &Client,
    database: &database::Database,
    mut request: AgentTurnRequest,
    mut key_loader: F,
) -> Result<AgentTurnResponse, String>
where
    F: FnMut(&str) -> Result<String, String>,
{
    let candidates = provider_candidates(&request);
    request.fallback_profiles.clear();
    let mut last_error = "No provider is available".to_owned();
    let mut failover_attempts = 0_u32;
    for (index, profile) in candidates.into_iter().enumerate() {
        if index > 0 && provider_is_cooling_down(database, &profile.id)? {
            continue;
        }
        if index > 0 {
            failover_attempts = failover_attempts.saturating_add(1);
        }
        let started_at = now_millis();
        let api_key = match key_loader(&profile.id) {
            Ok(api_key) => api_key,
            Err(_) if profile.allow_unauthenticated => String::new(),
            Err(error) => {
                record_provider_request(
                    database,
                    &request,
                    &profile,
                    started_at,
                    0,
                    "configuration_error",
                    None,
                    failover_attempts,
                    Some(&error),
                )?;
                last_error = error;
                continue;
            }
        };
        let mut attempt = request.clone();
        attempt.profile = profile.clone();
        let started = Instant::now();
        match agent::run_turn(client, attempt, &api_key).await {
            Ok(mut result) => {
                let latency_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                database.record_provider_success(&profile.id, latency_ms, index > 0)?;
                result.provider_id = Some(profile.id.clone());
                result.failover_count = failover_attempts;
                record_provider_request(
                    database,
                    &request,
                    &profile,
                    started_at,
                    latency_ms,
                    "success",
                    Some(&result),
                    failover_attempts,
                    None,
                )?;
                return Ok(result);
            }
            Err(error) => {
                let error = agent::annotate_tool_compatibility_error(error, &request);
                let latency_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                let status = if error.contains("REQUEST_CANCELLED") {
                    "cancelled"
                } else {
                    "error"
                };
                record_provider_request(
                    database,
                    &request,
                    &profile,
                    started_at,
                    latency_ms,
                    status,
                    None,
                    failover_attempts,
                    Some(&error),
                )?;
                if agent::is_retryable_provider_error(&error) {
                    database.record_provider_failure(&profile.id, &error)?;
                    last_error = error;
                    continue;
                }
                return Err(error);
            }
        }
    }
    Err(last_error)
}

#[tauri::command]
fn save_api_key(profile_id: String, api_key: String) -> Result<(), String> {
    let value = api_key.trim();
    if value.is_empty() {
        return Err("API key cannot be empty".to_owned());
    }
    provider_credential(&profile_id)?
        .set_password(value)
        .map_err(|error| format!("Could not save API key: {error}"))
}

#[tauri::command]
fn has_api_key(profile_id: String) -> bool {
    load_api_key(&profile_id).is_ok()
}

#[tauri::command]
fn delete_api_key(profile_id: String) -> Result<(), String> {
    validate_provider_id(&profile_id)?;
    let current = provider_credential(&profile_id)?.delete_credential();
    let legacy = credential(&profile_id)?.delete_credential();
    for result in [current, legacy] {
        match result {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(format!("Could not delete API key: {error}")),
        }
    }
    Ok(())
}

fn validate_provider_settings(settings: &ProviderSettings) -> Result<(), String> {
    if settings.profiles.is_empty() || settings.profiles.len() > 64 {
        return Err("Provider settings must contain 1-64 connections".to_owned());
    }
    let mut ids = HashSet::new();
    for profile in &settings.profiles {
        validate_provider_id(&profile.id)?;
        if !ids.insert(profile.id.as_str()) {
            return Err("Provider IDs must be unique".to_owned());
        }
        if profile.name.trim().is_empty() || profile.name.chars().count() > 120 {
            return Err("Provider name must contain 1-120 characters".to_owned());
        }
        if profile.model.trim().is_empty() || profile.model.chars().count() > 240 {
            return Err("Provider model must contain 1-240 characters".to_owned());
        }
        if !(-100_000..=100_000).contains(&profile.priority) {
            return Err("Provider priority is outside the supported range".to_owned());
        }
        agent::validate_provider_base_url(&profile.base_url)?;
    }
    if !ids.contains(settings.active_profile_id.as_str()) {
        return Err("Active Provider must reference a saved connection".to_owned());
    }
    Ok(())
}

#[tauri::command]
fn get_provider_settings(
    database: tauri::State<'_, database::Database>,
) -> Result<Option<ProviderSettings>, String> {
    let settings = database.provider_settings()?;
    if let Some(settings) = &settings {
        validate_provider_settings(settings)?;
    }
    Ok(settings)
}

#[tauri::command]
fn save_provider_settings(
    database: tauri::State<'_, database::Database>,
    settings: ProviderSettings,
) -> Result<(), String> {
    validate_provider_settings(&settings)?;
    database.set_provider_settings(&settings)
}

fn configured_media_providers(
    settings: &ProviderSettings,
) -> (Vec<media::MediaProvider>, Vec<String>) {
    let mut providers = Vec::new();
    let mut errors = Vec::new();
    for profile in &settings.profiles {
        match load_profile_api_key(profile) {
            Ok(api_key) => providers.push(media::MediaProvider {
                profile: profile.clone(),
                api_key,
            }),
            Err(error) => errors.push(format!("{}: {error}", profile.name)),
        }
    }
    (providers, errors)
}

fn media_settings(database: &database::Database) -> Result<ProviderSettings, String> {
    let settings = database.provider_settings()?.ok_or_else(|| {
        "Configure at least one model connection before using Media Studio".to_owned()
    })?;
    validate_provider_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
async fn get_media_catalog(
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, database::Database>,
) -> Result<MediaCatalog, String> {
    let settings = media_settings(&database)?;
    let (providers, mut credential_errors) = configured_media_providers(&settings);
    let mut catalog =
        media::discover_catalog(&state.client, &providers, &settings.active_profile_id).await;
    credential_errors.append(&mut catalog.errors);
    catalog.errors = credential_errors;
    Ok(catalog)
}

fn read_media_references(
    app: &tauri::AppHandle,
    request: &MediaGenerationRequest,
) -> Result<Vec<attachment::ManagedReference>, String> {
    let storage = attachment_storage(app)?;
    let mut seen = HashSet::new();
    request
        .reference_attachment_ids
        .iter()
        .filter(|id| seen.insert((*id).clone()))
        .map(|id| attachment::read_managed_reference(&storage, id))
        .collect()
}

#[derive(Debug, Deserialize)]
struct HatchJobManifest {
    #[serde(default)]
    jobs: Vec<HatchJobEntry>,
}

#[derive(Debug, Deserialize)]
struct HatchJobEntry {
    id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    input_images: Vec<HatchJobInput>,
    #[serde(default)]
    output_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HatchJobInput {
    path: String,
}

fn hatch_run_directory(request: &ToolExecutionRequest) -> Result<Option<PathBuf>, String> {
    let workspace = std::fs::canonicalize(&request.workspace)
        .map_err(|error| format!("Hatch workspace is unavailable: {error}"))?;
    let requested = request
        .arguments
        .get("hatchRunDir")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(raw) = requested {
        let raw_path = Path::new(raw);
        let candidate = if raw_path.is_absolute() {
            raw_path.to_path_buf()
        } else {
            workspace.join(raw_path)
        };
        let run_dir = std::fs::canonicalize(&candidate)
            .map_err(|error| format!("Hatch run directory is unavailable: {error}"))?;
        if !run_dir.starts_with(&workspace) || !run_dir.join("imagegen-jobs.json").is_file() {
            return Err("Hatch run directory must stay inside the selected workspace and contain imagegen-jobs.json".to_owned());
        }
        return Ok(Some(run_dir));
    }

    if workspace.join("imagegen-jobs.json").is_file() {
        return Ok(Some(workspace));
    }
    let mut discovered = Vec::new();
    let entries = std::fs::read_dir(&workspace)
        .map_err(|error| format!("Could not inspect hatch workspace: {error}"))?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate.is_dir() && candidate.join("imagegen-jobs.json").is_file() {
            discovered.push(
                std::fs::canonicalize(candidate)
                    .map_err(|error| format!("Could not resolve hatch run directory: {error}"))?,
            );
        }
    }
    match discovered.as_slice() {
        [run_dir] => Ok(Some(run_dir.clone())),
        [] => Ok(None),
        _ => {
            Err("Multiple hatch run directories were found; pass hatchRunDir explicitly".to_owned())
        }
    }
}

fn read_hatch_job_references(
    request: &ToolExecutionRequest,
) -> Result<Option<Vec<attachment::ManagedReference>>, String> {
    if !request.hatch {
        return Ok(None);
    }
    let job_id = request
        .arguments
        .get("hatchJobId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Hatch image generation requires hatchRunDir and hatchJobId so the adapter can enforce grounded manifest inputs".to_owned()
        })?;
    if job_id.len() > 80
        || !job_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Hatch job ID is invalid".to_owned());
    }
    let Some(run_dir) = hatch_run_directory(request)? else {
        return Err("Pass hatchRunDir for a prepared hatch-pet job".to_owned());
    };
    let manifest_path = run_dir.join("imagegen-jobs.json");
    let manifest = serde_json::from_str::<HatchJobManifest>(
        &std::fs::read_to_string(&manifest_path)
            .map_err(|error| format!("Could not read imagegen-jobs.json: {error}"))?,
    )
    .map_err(|error| format!("imagegen-jobs.json is invalid: {error}"))?;
    let job = manifest
        .jobs
        .iter()
        .find(|job| job.id == job_id)
        .ok_or_else(|| format!("Hatch job {job_id} is not present in imagegen-jobs.json"))?;
    if job.status.eq_ignore_ascii_case("complete") {
        return Err(format!(
            "Hatch job {job_id} is already complete; do not submit another image generation"
        ));
    }
    let output_exists = job.output_path.as_deref().is_some_and(|path| {
        let candidate = run_dir.join(path);
        std::fs::canonicalize(candidate)
            .map(|resolved| resolved.starts_with(&run_dir) && resolved.is_file())
            .unwrap_or(false)
    });
    if output_exists {
        return Err(format!(
            "Hatch job {job_id} already has an output file; record it before generating again"
        ));
    }
    if job.input_images.is_empty() {
        // The hatch-pet skill permits the base job to be prompt-only when the
        // user supplied no references. Keep managed attachment IDs available
        // as a fallback if the caller supplied them.
        return Ok(None);
    }

    let mut references = Vec::new();
    for input in &job.input_images {
        let candidate = run_dir.join(&input.path);
        let path = std::fs::canonicalize(&candidate).map_err(|error| {
            format!(
                "Hatch grounding image is unavailable ({}): {error}",
                input.path
            )
        })?;
        if !path.starts_with(&run_dir) {
            return Err(format!(
                "Hatch grounding image escapes the run directory: {}",
                input.path
            ));
        }
        let reference = attachment::read_local_media_reference(&path)?;
        if !references
            .iter()
            .any(|existing: &attachment::ManagedReference| existing.bytes == reference.bytes)
        {
            references.push(reference);
        }
    }
    if references.len() > 8 {
        return Err(format!(
            "Hatch job {job_id} requires {} distinct grounding images; the selected image model accepts at most 8",
            references.len()
        ));
    }
    let total = references
        .iter()
        .map(|reference| reference.bytes.len())
        .sum::<usize>();
    if total > 32 * 1024 * 1024 {
        return Err(format!(
            "Hatch job {job_id} grounding images exceed the 32 MiB image reference limit"
        ));
    }
    Ok(Some(references))
}

async fn generate_media_internal(
    app: &tauri::AppHandle,
    state: &AppState,
    database: &database::Database,
    request: MediaGenerationRequest,
    thread_id: Option<&str>,
    references_override: Option<Vec<attachment::ManagedReference>>,
) -> Result<MediaBatchResult, String> {
    let settings = media_settings(database)?;
    let (providers, credential_errors) = configured_media_providers(&settings);
    if providers.is_empty() {
        return Err(if credential_errors.is_empty() {
            "No media-capable connection is configured".to_owned()
        } else {
            credential_errors.join("; ")
        });
    }
    let (selections, catalog) = match (
        request.profile_id.as_deref(),
        request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        (Some(profile_id), Some(model)) => {
            let provider = providers
                .iter()
                .find(|provider| provider.profile.id == profile_id)
                .cloned()
                .ok_or_else(|| {
                    "The selected media connection is unavailable or has no API key".to_owned()
                })?;
            (
                vec![media::MediaSelection {
                    provider,
                    model: model.trim_start_matches("models/").to_owned(),
                }],
                None,
            )
        }
        _ => {
            let catalog =
                media::discover_catalog(&state.client, &providers, &settings.active_profile_id)
                    .await;
            let selections = media::selection_candidates(&providers, &catalog, &request);
            (selections, Some(catalog))
        }
    };
    if selections.is_empty() {
        let catalog = catalog.expect("automatic media selection always has a catalog");
        let detail = if catalog.models.is_empty() {
            "No image, video, or TTS model was discovered. Check that the connection exposes /models and that the account can access a generation model."
        } else {
            "No discovered media model matches the requested kind, connection, and model."
        };
        let errors = credential_errors
            .into_iter()
            .chain(catalog.errors)
            .collect::<Vec<_>>();
        return Err(if errors.is_empty() {
            detail.to_owned()
        } else {
            format!("{detail} {}", errors.join("; "))
        });
    }
    let references = match references_override {
        Some(references) => references,
        None => read_media_references(app, &request)?,
    };
    let storage = media_storage(app)?;
    let mut failures = Vec::new();
    for selection in &selections {
        match media::generate_batch(
            &state.client,
            &storage,
            database,
            selection,
            &request,
            thread_id,
            &references,
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(error) => failures.push((
                format!("{} / {}", selection.provider.profile.name, selection.model),
                error,
            )),
        }
    }
    let first = &selections[0];
    let error = format_media_failures(&failures);
    media::failed_asset(
        database,
        &request,
        thread_id,
        &first.provider.profile.id,
        &first.provider.profile.name,
        &first.model,
        &error,
    )
}

fn format_media_failures(failures: &[(String, String)]) -> String {
    let mut groups: Vec<(String, Vec<&str>)> = Vec::new();
    for (candidate, error) in failures {
        if let Some((_, candidates)) = groups.iter_mut().find(|(value, _)| value == error) {
            candidates.push(candidate);
        } else {
            groups.push((error.clone(), vec![candidate]));
        }
    }
    groups
        .into_iter()
        .map(|(error, candidates)| {
            let label = if candidates.len() == 1 {
                candidates[0].to_owned()
            } else {
                format!("{} (+{} candidates)", candidates[0], candidates.len() - 1)
            };
            format!("{label}: {error}")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

#[tauri::command]
async fn generate_media(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, database::Database>,
    request: MediaGenerationRequest,
    thread_id: Option<String>,
) -> Result<MediaBatchResult, String> {
    generate_media_internal(&app, &state, &database, request, thread_id.as_deref(), None).await
}

#[tauri::command]
fn list_media_assets(
    app: tauri::AppHandle,
    database: tauri::State<'_, database::Database>,
    kind: MediaKind,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<MediaAssetPage, String> {
    media::list_assets_page(
        &database,
        &media_storage(&app)?,
        &kind,
        limit.unwrap_or(24),
        offset.unwrap_or(0),
    )
}

async fn refresh_media_asset_internal(
    app: &tauri::AppHandle,
    state: &AppState,
    database: &database::Database,
    asset_id: &str,
) -> Result<MediaAsset, String> {
    let storage = media_storage(app)?;
    let asset = media::get_asset(database, &storage, asset_id)?
        .ok_or_else(|| "Media asset was not found".to_owned())?;
    if asset.kind != MediaKind::Video
        || matches!(asset.status, MediaStatus::Completed | MediaStatus::Failed)
    {
        return Ok(asset);
    }
    let settings = media_settings(database)?;
    let profile = settings
        .profiles
        .into_iter()
        .find(|profile| profile.id == asset.provider_id)
        .ok_or_else(|| "The connection used by this video job no longer exists".to_owned())?;
    let provider = media::MediaProvider {
        api_key: load_profile_api_key(&profile)?,
        profile,
    };
    media::refresh_asset(&state.client, &storage, database, &provider, asset).await
}

#[tauri::command]
async fn refresh_media_asset(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, database::Database>,
    asset_id: String,
) -> Result<MediaAsset, String> {
    refresh_media_asset_internal(&app, &state, &database, &asset_id).await
}

#[tauri::command]
async fn export_media_asset(
    app: tauri::AppHandle,
    database: tauri::State<'_, database::Database>,
    asset_id: String,
    destination_path: String,
) -> Result<String, String> {
    let destination = std::path::PathBuf::from(destination_path);
    let exported =
        media::export_asset(&database, &media_storage(&app)?, &asset_id, &destination).await?;
    Ok(exported.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_media_asset(
    app: tauri::AppHandle,
    database: tauri::State<'_, database::Database>,
    asset_id: String,
) -> Result<bool, String> {
    media::delete_asset(&database, &media_storage(&app)?, &asset_id)
}

#[tauri::command]
fn import_image_attachments(
    app: tauri::AppHandle,
    source_paths: Vec<String>,
) -> Result<Vec<ImageAttachment>, String> {
    if source_paths.len() > 12 {
        return Err("Select at most 12 attachments at a time".to_owned());
    }
    let storage = attachment_storage(&app)?;
    let mut imported = Vec::new();
    for path in source_paths {
        match attachment::import(&storage, std::path::Path::new(&path)) {
            Ok(item) => imported.push(item),
            Err(error) => {
                for item in &imported {
                    let _ = attachment::delete(&storage, &item.id);
                }
                return Err(error);
            }
        }
    }
    Ok(imported)
}

#[tauri::command]
fn import_media_references(
    app: tauri::AppHandle,
    source_paths: Vec<String>,
) -> Result<Vec<ImageAttachment>, String> {
    if source_paths.is_empty() || source_paths.len() > 7 {
        return Err("Select between 1 and 7 media references at a time".to_owned());
    }
    let storage = attachment_storage(&app)?;
    let mut imported = Vec::new();
    for path in source_paths {
        match attachment::import_media_reference(&storage, std::path::Path::new(&path)) {
            Ok(item) => imported.push(item),
            Err(error) => {
                for item in &imported {
                    let _ = attachment::delete(&storage, &item.id);
                }
                return Err(error);
            }
        }
    }
    Ok(imported)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardAttachmentPayload {
    name: String,
    data_base64: String,
}

#[tauri::command]
fn import_clipboard_images(
    app: tauri::AppHandle,
    images: Vec<ClipboardAttachmentPayload>,
) -> Result<Vec<ImageAttachment>, String> {
    if images.is_empty() || images.len() > 8 {
        return Err("Paste between 1 and 8 images at a time".to_owned());
    }
    let storage = attachment_storage(&app)?;
    let mut imported = Vec::new();
    for image in images {
        match attachment::import_base64_image(&storage, &image.name, &image.data_base64) {
            Ok(item) => imported.push(item),
            Err(error) => {
                for item in &imported {
                    let _ = attachment::delete(&storage, &item.id);
                }
                return Err(error);
            }
        }
    }
    Ok(imported)
}

#[tauri::command]
fn import_clipboard_attachments(
    app: tauri::AppHandle,
    attachments: Vec<ClipboardAttachmentPayload>,
) -> Result<Vec<ImageAttachment>, String> {
    if attachments.is_empty() || attachments.len() > 12 {
        return Err("Paste between 1 and 12 files at a time".to_owned());
    }
    let storage = attachment_storage(&app)?;
    let mut imported = Vec::new();
    for payload in attachments {
        match attachment::import_base64_attachment(&storage, &payload.name, &payload.data_base64) {
            Ok(item) => imported.push(item),
            Err(error) => {
                for item in &imported {
                    let _ = attachment::delete(&storage, &item.id);
                }
                return Err(error);
            }
        }
    }
    Ok(imported)
}

#[tauri::command]
fn delete_image_attachment(app: tauri::AppHandle, attachment_id: String) -> Result<bool, String> {
    attachment::delete(&attachment_storage(&app)?, &attachment_id)
}

#[tauri::command]
fn get_default_workspace(app: tauri::AppHandle) -> Result<String, String> {
    Ok(ensure_default_workspace(&app)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
fn preview_attachment(
    app: tauri::AppHandle,
    attachment_id: String,
    name: String,
) -> Result<AttachmentPreview, String> {
    attachment::preview(&attachment_storage(&app)?, &attachment_id, &name)
}

#[tauri::command]
fn list_provider_health(
    database: tauri::State<'_, database::Database>,
) -> Result<Vec<ProviderHealth>, String> {
    database.list_provider_health()
}

#[tauri::command]
fn list_provider_requests(
    database: tauri::State<'_, database::Database>,
) -> Result<Vec<ProviderRequestLog>, String> {
    database.list_provider_requests(300)
}

#[tauri::command]
fn reset_provider_health(
    database: tauri::State<'_, database::Database>,
    profile_id: String,
) -> Result<(), String> {
    database.reset_provider_health(&profile_id)
}

#[tauri::command]
async fn get_gateway_diagnostics(
    state: tauri::State<'_, AppState>,
    profile: ProviderProfile,
) -> Result<GatewayDiagnostics, String> {
    let api_key = load_profile_api_key(&profile)?;
    agent::fetch_gateway_diagnostics(&state.client, &profile, &api_key).await
}

#[tauri::command]
fn get_custom_instructions(
    database: tauri::State<'_, database::Database>,
) -> Result<String, String> {
    database.custom_instructions()
}

#[tauri::command]
fn save_custom_instructions(
    database: tauri::State<'_, database::Database>,
    content: String,
) -> Result<(), String> {
    database.set_custom_instructions(&content)
}

#[tauri::command]
async fn agent_turn(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, database::Database>,
    manager: tauri::State<'_, mcp::McpManager>,
    mut request: AgentTurnRequest,
) -> Result<AgentTurnResponse, String> {
    attach_default_workspace(&app, &mut request)?;
    attach_images(&app, &mut request)?;
    attach_custom_instructions(&database, &mut request)?;
    attach_goal(&database, &mut request)?;
    attach_subagent_tools(&mut request);
    attach_media_tools(&mut request);
    attach_skills(&app, &database, &mut request)?;
    attach_mcp_tools(&database, &manager, &mut request).await?;
    let goal_thread = (request.mode == "goal")
        .then(|| request.thread_id.clone())
        .flatten();
    let response =
        run_agent_turn_with_failover(&state.client, &database, request, load_api_key).await?;
    if let Some(thread_id) = goal_thread {
        database.record_goal_usage(
            &thread_id,
            response.input_tokens.unwrap_or(0),
            response.output_tokens.unwrap_or(0),
        )?;
    }
    Ok(response)
}

#[tauri::command]
async fn agent_turn_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, database::Database>,
    manager: tauri::State<'_, mcp::McpManager>,
    mut request: AgentTurnRequest,
    operation_id: String,
    on_event: Channel<AgentStreamEvent>,
) -> Result<AgentTurnResponse, String> {
    attach_default_workspace(&app, &mut request)?;
    attach_images(&app, &mut request)?;
    attach_custom_instructions(&database, &mut request)?;
    attach_goal(&database, &mut request)?;
    attach_subagent_tools(&mut request);
    attach_media_tools(&mut request);
    attach_skills(&app, &database, &mut request)?;
    attach_mcp_tools(&database, &manager, &mut request).await?;
    let goal_thread = (request.mode == "goal")
        .then(|| request.thread_id.clone())
        .flatten();
    let candidates = provider_candidates(&request);
    request.fallback_profiles.clear();
    let cancellation = CancellationToken::new();
    {
        let mut active = state
            .active_requests
            .lock()
            .map_err(|_| "Could not lock active request state".to_owned())?;
        if let Some(previous) = active.insert(operation_id.clone(), cancellation.clone()) {
            previous.cancel();
        }
    }

    let mut last_error = "No provider is available".to_owned();
    let mut result = None;
    let mut failover_attempts = 0_u32;
    for (index, profile) in candidates.into_iter().enumerate() {
        if index > 0 && provider_is_cooling_down(&database, &profile.id)? {
            continue;
        }
        if index > 0 {
            failover_attempts = failover_attempts.saturating_add(1);
        }
        let started_at = now_millis();
        let api_key = match load_profile_api_key(&profile) {
            Ok(api_key) => api_key,
            Err(error) => {
                record_provider_request(
                    &database,
                    &request,
                    &profile,
                    started_at,
                    0,
                    "configuration_error",
                    None,
                    failover_attempts,
                    Some(&error),
                )?;
                last_error = error;
                continue;
            }
        };
        let mut attempt = request.clone();
        attempt.profile = profile.clone();
        let emitted = Arc::new(AtomicBool::new(false));
        let output_started = emitted.clone();
        let event_channel = on_event.clone();
        let started = Instant::now();
        match agent::run_turn_stream(
            &state.client,
            attempt,
            &api_key,
            cancellation.clone(),
            move |event| {
                if event
                    .delta
                    .as_deref()
                    .is_some_and(|delta| !delta.is_empty())
                {
                    output_started.store(true, Ordering::Release);
                }
                let _ = event_channel.send(event);
            },
        )
        .await
        {
            Ok(mut response) => {
                let latency_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                database.record_provider_success(&profile.id, latency_ms, index > 0)?;
                response.provider_id = Some(profile.id.clone());
                response.failover_count = failover_attempts;
                record_provider_request(
                    &database,
                    &request,
                    &profile,
                    started_at,
                    latency_ms,
                    "success",
                    Some(&response),
                    failover_attempts,
                    None,
                )?;
                result = Some(Ok(response));
                break;
            }
            Err(error) => {
                let error = agent::annotate_tool_compatibility_error(error, &request);
                let latency_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                let status = if error.contains("REQUEST_CANCELLED") {
                    "cancelled"
                } else {
                    "error"
                };
                record_provider_request(
                    &database,
                    &request,
                    &profile,
                    started_at,
                    latency_ms,
                    status,
                    None,
                    failover_attempts,
                    Some(&error),
                )?;
                let retryable = agent::is_retryable_provider_error(&error);
                if retryable {
                    database.record_provider_failure(&profile.id, &error)?;
                }
                if emitted.load(Ordering::Acquire) || !retryable {
                    result = Some(Err(error));
                    break;
                }
                last_error = error;
            }
        }
    }
    let result = result.unwrap_or(Err(last_error));

    if let Ok(mut active) = state.active_requests.lock() {
        active.remove(&operation_id);
    }
    if let (Some(thread_id), Ok(response)) = (&goal_thread, &result) {
        database.record_goal_usage(
            thread_id,
            response.input_tokens.unwrap_or(0),
            response.output_tokens.unwrap_or(0),
        )?;
    }
    result
}

#[tauri::command]
fn cancel_agent_turn(state: tauri::State<'_, AppState>, operation_id: String) -> bool {
    let Ok(active) = state.active_requests.lock() else {
        return false;
    };
    if let Some(cancellation) = active.get(&operation_id) {
        cancellation.cancel();
        true
    } else {
        false
    }
}

#[tauri::command]
async fn fetch_models(
    state: tauri::State<'_, AppState>,
    profile: ProviderProfile,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, String> {
    let api_key = api_key
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .map(Ok)
        .unwrap_or_else(|| load_profile_api_key(&profile))?;
    agent::fetch_models(&state.client, profile, &api_key).await
}

struct IsolatedSubagentTask<'a> {
    task: &'a str,
    scope: Option<&'a str>,
    max_turns: usize,
}

async fn run_isolated_subagent<F>(
    client: &Client,
    database: &database::Database,
    request: &ToolExecutionRequest,
    worktree: &subagent::IsolatedWorktree,
    delegated: IsolatedSubagentTask<'_>,
    mut key_loader: F,
) -> Result<String, String>
where
    F: FnMut(&str) -> Result<String, String>,
{
    let profile = request
        .profile
        .clone()
        .ok_or_else(|| "Sub-Agent delegation requires the active provider".to_owned())?;
    let mut history = vec![AgentMessage {
        role: "user".to_owned(),
        content: format!(
            "Work as a bounded child Agent inside an isolated Git worktree. Inspect the current repository state, implement the task with focused UTF-8 file edits, and finish with a concise summary of changed files and unresolved validation. You cannot run commands; do not claim tests ran. Stay within the optional scope when provided.\n\nTask:\n{}\n\nScope:\n{}",
            delegated.task,
            delegated
                .scope
                .unwrap_or("Repository-wide only where required by the task")
        ),
        tool_calls: Vec::new(),
        tool_call_id: None,
        internal: false,
        attachments: Vec::new(),
    }];
    let mut last_summary = String::new();
    let child_thread_id = format!(
        "{}:subagent:{}",
        request.thread_id.as_deref().unwrap_or("standalone"),
        worktree.run_id
    );
    for _ in 0..delegated.max_turns {
        let turn = AgentTurnRequest {
            profile: profile.clone(),
            messages: history.clone(),
            mode: "subagent".to_owned(),
            workspace: Some(worktree.path.to_string_lossy().into_owned()),
            thread_id: Some(child_thread_id.clone()),
            hatch: false,
            hatch_skill_loaded: false,
            available_tools: Vec::new(),
            available_skills: Vec::new(),
            goal: None,
            fallback_profiles: request.fallback_profiles.clone(),
            custom_instructions: Some(
                "This is an isolated child run. Never attempt shell commands, delegation, Goal updates, MCP calls, or access outside the selected worktree. Main-worktree application requires a separate approval."
                    .to_owned(),
            ),
        };
        let response = run_agent_turn_with_failover(client, database, turn, |profile_id| {
            key_loader(profile_id)
        })
        .await?;
        if !response.content.trim().is_empty() {
            last_summary = response.content.trim().to_owned();
        }
        let tool_calls = response.tool_calls.clone();
        history.push(AgentMessage {
            role: "assistant".to_owned(),
            content: response.content,
            tool_calls: response.tool_calls,
            tool_call_id: None,
            internal: false,
            attachments: Vec::new(),
        });
        if tool_calls.is_empty() {
            return Ok(if last_summary.is_empty() {
                "Child Agent finished without a textual summary.".to_owned()
            } else {
                last_summary
            });
        }
        for call in tool_calls {
            let result = if matches!(
                call.name.as_str(),
                "list_files" | "read_file" | "search_files" | "write_file" | "delete_file"
            ) {
                tools::execute(ToolExecutionRequest {
                    name: call.name,
                    arguments: call.arguments,
                    workspace: worktree.path.to_string_lossy().into_owned(),
                    thread_id: Some(child_thread_id.clone()),
                    profile: None,
                    fallback_profiles: Vec::new(),
                    hatch: false,
                    hatch_skill_loaded: false,
                    hatch_bootstrap: false,
                })
                .await
            } else {
                ToolExecutionResponse {
                    output: "This tool is unavailable inside an isolated child Agent".to_owned(),
                    is_error: true,
                }
            };
            history.push(AgentMessage {
                role: "tool".to_owned(),
                content: result.output,
                tool_calls: Vec::new(),
                tool_call_id: Some(call.id),
                internal: false,
                attachments: Vec::new(),
            });
        }
    }
    Ok(format!(
        "{}\n\nChild Agent reached its {}-turn limit; review the patch carefully.",
        if last_summary.is_empty() {
            "No final summary was produced."
        } else {
            &last_summary
        },
        delegated.max_turns,
    ))
}

async fn delegate_task(
    app: &tauri::AppHandle,
    state: &AppState,
    database: &database::Database,
    subagents: &subagent::SubagentManager,
    request: &ToolExecutionRequest,
) -> Result<String, String> {
    let task = request
        .arguments
        .get("task")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing string argument: task".to_owned())?;
    if task.chars().count() > 20_000 {
        return Err("Sub-Agent task is longer than 20,000 characters".to_owned());
    }
    let scope = request
        .arguments
        .get("scope")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if scope.is_some_and(|value| value.chars().count() > 4_000) {
        return Err("Sub-Agent scope is longer than 4,000 characters".to_owned());
    }
    let max_turns = request
        .arguments
        .get("maxTurns")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(6);
    if !(1..=8).contains(&max_turns) {
        return Err("Sub-Agent maxTurns must be between 1 and 8".to_owned());
    }

    let worktree = subagent::create_worktree(
        &subagent_storage(app)?,
        std::path::Path::new(&request.workspace),
    )
    .await?;
    let result = run_isolated_subagent(
        &state.client,
        database,
        request,
        &worktree,
        IsolatedSubagentTask {
            task,
            scope,
            max_turns: max_turns as usize,
        },
        load_api_key,
    )
    .await;
    let summary = match result {
        Ok(summary) => summary,
        Err(error) => {
            let cleanup = subagent::cleanup_worktree(&worktree).await;
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => format!("{error}; cleanup also failed: {cleanup_error}"),
            });
        }
    };
    let captured = subagent::capture_patch(&worktree).await;
    let cleanup = subagent::cleanup_worktree(&worktree).await;
    let (patch, stat) = captured?;
    cleanup?;
    if patch.trim().is_empty() {
        return Ok(format!(
            "Sub-Agent completed in isolation and made no file changes.\n\nSummary:\n{summary}"
        ));
    }
    subagents.store(subagent::pending_patch(
        &worktree,
        patch.clone(),
        stat.clone(),
        summary.clone(),
    ))?;
    Ok(format!(
        "Sub-Agent completed in an isolated worktree. The main workspace is unchanged.\nRun ID: {}\n\nSummary:\n{}\n\nDiff stat:\n{}\n\nReviewable patch:\n```diff\n{}```\nCall apply_subagent_patch with this run ID only after reviewing the patch; that call requires a second user approval.",
        worktree.run_id,
        summary,
        if stat.trim().is_empty() {
            "No stat available"
        } else {
            stat.trim()
        },
        patch,
    ))
}

async fn apply_delegated_patch(
    subagents: &subagent::SubagentManager,
    request: &ToolExecutionRequest,
) -> Result<String, String> {
    let run_id = request
        .arguments
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Missing string argument: runId".to_owned())?;
    let pending = subagents.get(run_id, std::path::Path::new(&request.workspace))?;
    let stat = subagent::apply_patch(&pending).await?;
    subagents.remove(run_id);
    Ok(format!(
        "Applied reviewed sub-Agent patch {} to the main worktree as unstaged changes.\n\nChild summary:\n{}\n\nCurrent diff stat:\n{}",
        pending.run_id,
        pending.summary,
        if stat.trim().is_empty() {
            "No changes"
        } else {
            stat.trim()
        },
    ))
}

fn tool_execution_result(result: Result<String, String>) -> ToolExecutionResponse {
    match result {
        Ok(output) => ToolExecutionResponse {
            output,
            is_error: false,
        },
        Err(output) => ToolExecutionResponse {
            output,
            is_error: true,
        },
    }
}

fn media_request_from_tool(
    name: &str,
    arguments: &serde_json::Value,
) -> Result<MediaGenerationRequest, String> {
    let kind = match name {
        "generate_images" => "image",
        "generate_videos" => "video",
        "generate_speech" => "audio",
        _ => return Err("Unknown media generation tool".to_owned()),
    };
    let mut value = arguments.clone();
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Media tool arguments must be an object".to_owned())?;
    object.insert(
        "kind".to_owned(),
        serde_json::Value::String(kind.to_owned()),
    );
    if name == "generate_images"
        && object
            .get("background")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("transparent"))
        && !object
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .is_some_and(media::prompt_requests_transparency)
    {
        object.remove("background");
    }
    serde_json::from_value(value)
        .map_err(|error| format!("Invalid media generation arguments: {error}"))
}

async fn execute_media_generation_tool(
    app: &tauri::AppHandle,
    state: &AppState,
    database: &database::Database,
    request: &ToolExecutionRequest,
) -> ToolExecutionResponse {
    let result = match media_request_from_tool(&request.name, &request.arguments) {
        Ok(mut generation) => {
            if request.hatch && generation.kind == MediaKind::Image {
                // A hatch job is one manifest row at a time and the
                // deterministic pipeline expects a lossless PNG source.
                generation.count = 1;
                generation.output_format = Some("png".to_owned());
            }
            let hatch_references = if request.hatch && generation.kind == MediaKind::Image {
                read_hatch_job_references(request)
            } else {
                Ok(None)
            };
            match hatch_references {
                Ok(references_override) => {
                    generate_media_internal(
                        app,
                        state,
                        database,
                        generation,
                        request.thread_id.as_deref(),
                        references_override,
                    )
                    .await
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(result) => {
            let source_paths = if request.hatch {
                match export_hatch_image_sources(app, &result, request.thread_id.as_deref()).await {
                    Ok(paths) => paths,
                    Err(error) => {
                        return ToolExecutionResponse {
                            output: format!(
                                "Media generation succeeded, but the hatch-pet source adapter failed: {error}"
                            ),
                            is_error: true,
                        };
                    }
                }
            } else {
                Vec::new()
            };
            let is_error = result
                .assets
                .iter()
                .all(|asset| asset.status == MediaStatus::Failed);
            let mut payload = match serde_json::to_value(&result) {
                Ok(value) => value,
                Err(error) => {
                    return ToolExecutionResponse {
                        output: format!("Could not encode media result: {error}"),
                        is_error: true,
                    };
                }
            };
            if !source_paths.is_empty()
                && let Some(object) = payload.as_object_mut()
            {
                object.insert(
                    "hatchSourcePaths".to_owned(),
                    serde_json::Value::Array(
                        source_paths
                            .into_iter()
                            .map(serde_json::Value::String)
                            .collect(),
                    ),
                );
                object.insert(
                    "hatchSourceProvenance".to_owned(),
                    serde_json::Value::String("levelup-agent-imagegen-adapter".to_owned()),
                );
            }
            ToolExecutionResponse {
                output: serde_json::to_string(&payload)
                    .unwrap_or_else(|error| format!("Could not encode media result: {error}")),
                is_error,
            }
        }
        Err(output) => ToolExecutionResponse {
            output,
            is_error: true,
        },
    }
}

fn hatch_generated_images_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let root = codex_home.join("generated_images").join("levelup-agent");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create hatch image source directory: {error}"))?;
    filesystem::restrict_directory(&root)?;
    Ok(root)
}

fn hatch_safe_component(value: &str) -> String {
    let normalized = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(80)
        .collect::<String>();
    if normalized.is_empty() {
        "run".to_owned()
    } else {
        normalized
    }
}

fn hatch_source_extension(asset: &MediaAsset) -> String {
    asset
        .file_name
        .as_deref()
        .and_then(|name| Path::new(name).extension())
        .and_then(|extension| extension.to_str())
        .filter(|extension| {
            !extension.is_empty()
                && extension.len() <= 8
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .map(|extension| extension.to_ascii_lowercase())
        .unwrap_or_else(|| match asset.mime_type.as_deref() {
            Some("image/jpeg") => "jpg".to_owned(),
            Some("image/webp") => "webp".to_owned(),
            Some("image/gif") => "gif".to_owned(),
            _ => "png".to_owned(),
        })
}

/// Export the unchanged provider bytes to the path convention enforced by
/// hatch-pet's `record_imagegen_result.py`. This is the LevelUpAgent imagegen
/// adapter boundary; it does not alter, synthesize, or claim a different image.
async fn export_hatch_image_sources(
    app: &tauri::AppHandle,
    result: &MediaBatchResult,
    thread_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let source_root = hatch_generated_images_root(app)?;
    let run_root = source_root.join(format!(
        "thread-{}",
        hatch_safe_component(thread_id.unwrap_or("standalone"))
    ));
    tokio::fs::create_dir_all(&run_root)
        .await
        .map_err(|error| format!("Could not create hatch image source run: {error}"))?;
    filesystem::restrict_directory(&run_root)?;

    let media_root = std::fs::canonicalize(media_storage(app)?)
        .map_err(|error| format!("Could not resolve media storage: {error}"))?;
    let mut paths = Vec::new();
    for asset in &result.assets {
        if asset.kind != MediaKind::Image || asset.status != MediaStatus::Completed {
            continue;
        }
        let raw_path = asset
            .file_path
            .as_deref()
            .ok_or_else(|| format!("Hatch image asset {} has no local source path", asset.id))?;
        let source = std::fs::canonicalize(raw_path)
            .map_err(|error| format!("Could not resolve hatch image source: {error}"))?;
        if !source.starts_with(&media_root) || !source.is_file() {
            return Err(format!(
                "Hatch image source is outside managed media storage: {}",
                source.display()
            ));
        }
        let destination = run_root.join(format!(
            "ig_{}.{}",
            hatch_safe_component(&asset.id),
            hatch_source_extension(asset)
        ));
        tokio::fs::copy(&source, &destination)
            .await
            .map_err(|error| format!("Could not export hatch image source: {error}"))?;
        filesystem::restrict_file(&destination)?;
        paths.push(destination.to_string_lossy().into_owned());
    }
    Ok(paths)
}

async fn execute_media_job_check(
    app: &tauri::AppHandle,
    state: &AppState,
    database: &database::Database,
    request: &ToolExecutionRequest,
) -> ToolExecutionResponse {
    let requested: Vec<String> = request
        .arguments
        .get("assetIds")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ids: Vec<String> = if requested.is_empty() {
        let storage = match media_storage(app) {
            Ok(path) => path,
            Err(output) => {
                return ToolExecutionResponse {
                    output,
                    is_error: true,
                };
            }
        };
        match media::list_assets(database, &storage, 200) {
            Ok(assets) => assets
                .into_iter()
                .filter(|asset| {
                    asset.kind == MediaKind::Video
                        && !matches!(asset.status, MediaStatus::Completed | MediaStatus::Failed)
                        && request
                            .thread_id
                            .as_deref()
                            .is_none_or(|thread_id| asset.thread_id.as_deref() == Some(thread_id))
                })
                .map(|asset| asset.id)
                .collect(),
            Err(output) => {
                return ToolExecutionResponse {
                    output,
                    is_error: true,
                };
            }
        }
    } else {
        requested.into_iter().take(16).collect()
    };
    let mut assets = Vec::new();
    let mut refresh_errors = Vec::new();
    for attempt in 0..6 {
        assets.clear();
        refresh_errors.clear();
        for id in &ids {
            match refresh_media_asset_internal(app, state, database, id).await {
                Ok(asset) => assets.push(asset),
                Err(error) => {
                    refresh_errors.push(serde_json::json!({ "assetId": id, "error": error }))
                }
            }
        }
        let all_terminal = assets
            .iter()
            .all(|asset| matches!(asset.status, MediaStatus::Completed | MediaStatus::Failed));
        if all_terminal || !refresh_errors.is_empty() || attempt == 5 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    let all_terminal = assets
        .iter()
        .all(|asset| matches!(asset.status, MediaStatus::Completed | MediaStatus::Failed));
    ToolExecutionResponse {
        output: serde_json::to_string(&serde_json::json!({
            "assets": assets,
            "refreshErrors": refresh_errors,
            "allTerminal": all_terminal
        }))
        .unwrap_or_else(|error| format!("Could not encode media job status: {error}")),
        is_error: !refresh_errors.is_empty(),
    }
}

fn hatch_command_is_observation(arguments: &serde_json::Value) -> bool {
    let Some(command) = arguments.get("command").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let normalized = command.to_ascii_lowercase();
    normalized.contains("levelup-pet-hatch.json")
        || [
            "get-childitem",
            " gci",
            " get-content",
            " gc ",
            " type ",
            " cat ",
            " more ",
            "select-string",
            "findstr",
            " rg ",
            " grep ",
            "get-location",
            " pwd",
        ]
        .iter()
        .any(|marker| normalized.starts_with(marker.trim()) || normalized.contains(marker))
}

fn hatch_tool_policy_error(request: &ToolExecutionRequest) -> Option<&'static str> {
    if !request.hatch {
        return None;
    }
    if matches!(
        request.name.as_str(),
        "get_goal" | "list_files" | "read_file" | "search_files"
    ) {
        return Some(
            "This observation tool is unavailable during pet hatching. The Goal and pet target are already attached; run prepare_pet_run.py or the next concrete hatch command.",
        );
    }
    if request.name == "run_command" && hatch_command_is_observation(&request.arguments) {
        return Some(
            "This workspace observation command is unavailable during pet hatching. The Goal and pet target are already attached; run prepare_pet_run.py or the next concrete hatch command.",
        );
    }
    if request.name != "read_skill" || request.hatch_bootstrap {
        return None;
    }
    if request.hatch_skill_loaded {
        Some(
            "The bundled hatch-pet Skill is already loaded; read_skill is closed for this provider turn. Run prepare_pet_run.py or the next concrete hatch command.",
        )
    } else {
        Some(
            "read_skill is application-owned during pet hatching and is unavailable to provider turns. Run prepare_pet_run.py or the next concrete hatch command.",
        )
    }
}

#[tauri::command]
async fn execute_tool(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    database: tauri::State<'_, database::Database>,
    manager: tauri::State<'_, mcp::McpManager>,
    subagents: tauri::State<'_, subagent::SubagentManager>,
    mut request: ToolExecutionRequest,
) -> Result<ToolExecutionResponse, String> {
    // Older clients did not persist the hatch flag on every tool request.
    // Recover it from the durable Goal before applying the tool policy so a
    // resumed legacy thread cannot re-expose read_skill/get_goal or bypass
    // grounded media generation merely because its frontend flag was lost.
    if !request.hatch
        && let Some(thread_id) = request.thread_id.as_deref()
        && let Some(goal) = database.get_goal(thread_id)?
        && is_hatch_goal_objective(&goal.objective)
    {
        request.hatch = true;
    }
    if let Some(output) = hatch_tool_policy_error(&request) {
        return Ok(ToolExecutionResponse {
            output: output.to_owned(),
            is_error: true,
        });
    }
    if request.workspace.trim().is_empty() {
        request.workspace = ensure_default_workspace(&app)?
            .to_string_lossy()
            .into_owned();
    }
    Ok(
        if matches!(
            request.name.as_str(),
            "generate_images" | "generate_videos" | "generate_speech"
        ) {
            execute_media_generation_tool(&app, &state, &database, &request).await
        } else if request.name == "check_media_jobs" {
            execute_media_job_check(&app, &state, &database, &request).await
        } else if request.name == "delegate_task" {
            tool_execution_result(
                delegate_task(&app, &state, &database, &subagents, &request).await,
            )
        } else if request.name == "apply_subagent_patch" {
            tool_execution_result(apply_delegated_patch(&subagents, &request).await)
        } else if request.name == "get_goal" {
            let thread_id = request
                .thread_id
                .as_deref()
                .ok_or_else(|| "Goal tool requires a task ID".to_owned())?;
            match database.get_goal(thread_id)? {
                Some(goal) => ToolExecutionResponse {
                    output: serde_json::to_string_pretty(&goal)
                        .map_err(|error| format!("Could not encode Goal: {error}"))?,
                    is_error: false,
                },
                None => ToolExecutionResponse {
                    output: "This task has no Goal".to_owned(),
                    is_error: true,
                },
            }
        } else if request.name == "update_goal" {
            let thread_id = request
                .thread_id
                .as_deref()
                .ok_or_else(|| "Goal tool requires a task ID".to_owned())?;
            let status = request
                .arguments
                .get("status")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Missing string argument: status".to_owned())?;
            let evidence = request
                .arguments
                .get("evidence")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Missing string argument: evidence".to_owned())?;
            match database.update_goal_from_agent(thread_id, status, evidence) {
                Ok(goal) => ToolExecutionResponse {
                    output: format!(
                        "Goal status is now {:?}. Completion requires a separate audit; blocked requires three consecutive identical reports.",
                        goal.status
                    ),
                    is_error: false,
                },
                Err(output) => ToolExecutionResponse {
                    output,
                    is_error: true,
                },
            }
        } else if request.name == "read_skill" {
            let skill_id = request
                .arguments
                .get("skillId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Missing string argument: skillId".to_owned())?;
            let relative = request
                .arguments
                .get("path")
                .and_then(serde_json::Value::as_str);
            let workspace =
                (!request.workspace.trim().is_empty()).then_some(request.workspace.as_str());
            let skills = discover_skills(&app, &database, workspace)?;
            match skill::read_enabled(&skills, skill_id, relative) {
                Ok(output) => ToolExecutionResponse {
                    output,
                    is_error: false,
                },
                Err(output) => ToolExecutionResponse {
                    output,
                    is_error: true,
                },
            }
        } else if request.name.starts_with("mcp_") {
            manager.execute(&request.name, request.arguments).await
        } else {
            tools::execute(request).await
        },
    )
}

#[tauri::command]
fn create_goal(
    database: tauri::State<'_, database::Database>,
    request: GoalCreateRequest,
) -> Result<GoalState, String> {
    database.create_goal(&request)
}

#[tauri::command]
fn get_goal(
    database: tauri::State<'_, database::Database>,
    thread_id: String,
) -> Result<Option<GoalState>, String> {
    database.get_goal(&thread_id)
}

#[tauri::command]
fn change_goal_status(
    database: tauri::State<'_, database::Database>,
    thread_id: String,
    action: String,
) -> Result<GoalState, String> {
    database.set_goal_status(&thread_id, &action)
}

#[tauri::command]
fn scan_skills(
    app: tauri::AppHandle,
    database: tauri::State<'_, database::Database>,
    workspace: Option<String>,
) -> Result<Vec<SkillInfo>, String> {
    discover_skills(&app, &database, workspace.as_deref())
}

#[tauri::command]
fn set_skill_enabled(
    app: tauri::AppHandle,
    database: tauri::State<'_, database::Database>,
    workspace: Option<String>,
    skill_id: String,
    enabled: bool,
) -> Result<SkillInfo, String> {
    let skills = discover_skills(&app, &database, workspace.as_deref())?;
    let selected = skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .ok_or_else(|| "Skill is no longer available".to_owned())?;
    if !selected.valid {
        return Err(selected
            .warning
            .clone()
            .unwrap_or_else(|| "Invalid Skill cannot be enabled".to_owned()));
    }
    database.set_skill_enabled(&selected.id, &selected.path, enabled)?;
    discover_skills(&app, &database, workspace.as_deref())?
        .into_iter()
        .find(|skill| skill.id == skill_id)
        .ok_or_else(|| "Skill is no longer available".to_owned())
}

#[tauri::command]
async fn list_mcp_servers(
    database: tauri::State<'_, database::Database>,
    manager: tauri::State<'_, mcp::McpManager>,
) -> Result<Vec<McpServerSnapshot>, String> {
    let mut snapshots = Vec::new();
    for server in database.list_mcp_servers()? {
        snapshots.push(manager.snapshot(server).await);
    }
    Ok(snapshots)
}

#[tauri::command]
async fn upsert_mcp_server(
    database: tauri::State<'_, database::Database>,
    manager: tauri::State<'_, mcp::McpManager>,
    mut input: McpServerUpsert,
) -> Result<McpServerSnapshot, String> {
    normalize_mcp_config(&mut input.server)?;
    database.save_mcp_server(&input.server)?;
    save_mcp_secrets(&input.server, input.secrets)?;
    manager.stop(&input.server.id).await;
    Ok(manager.snapshot(input.server).await)
}

#[tauri::command]
async fn start_mcp_server(
    database: tauri::State<'_, database::Database>,
    manager: tauri::State<'_, mcp::McpManager>,
    server_id: String,
) -> Result<McpServerSnapshot, String> {
    let server = database
        .get_mcp_server(&server_id)?
        .ok_or_else(|| "MCP server does not exist".to_owned())?;
    let secrets = load_mcp_secrets(&server.id)?;
    manager.start(&server, &secrets).await?;
    Ok(manager.snapshot(server).await)
}

#[tauri::command]
async fn stop_mcp_server(
    database: tauri::State<'_, database::Database>,
    manager: tauri::State<'_, mcp::McpManager>,
    server_id: String,
) -> Result<McpServerSnapshot, String> {
    let server = database
        .get_mcp_server(&server_id)?
        .ok_or_else(|| "MCP server does not exist".to_owned())?;
    manager.stop(&server_id).await;
    Ok(manager.snapshot(server).await)
}

#[tauri::command]
async fn delete_mcp_server(
    database: tauri::State<'_, database::Database>,
    manager: tauri::State<'_, mcp::McpManager>,
    server_id: String,
) -> Result<bool, String> {
    manager.stop(&server_id).await;
    let deleted = database.delete_mcp_server(&server_id)?;
    match mcp_credential(&server_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(deleted),
        Err(error) => Err(format!(
            "MCP server was deleted, but its credential could not be removed: {error}"
        )),
    }
}

fn normalize_mcp_config(server: &mut McpServerConfig) -> Result<(), String> {
    server.id = server.id.trim().to_owned();
    server.name = server.name.trim().to_owned();
    if server.id.is_empty()
        || server.id.len() > 128
        || !server
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(
            "MCP server ID must be 1-128 letters, numbers, dashes, or underscores".to_owned(),
        );
    }
    if server.name.is_empty() {
        return Err("MCP server name is required".to_owned());
    }
    server.secret_environment_keys.sort();
    server.secret_environment_keys.dedup();
    server.secret_header_keys.sort();
    server.secret_header_keys.dedup();
    for key in &server.secret_environment_keys {
        server.environment.remove(key);
    }
    let secret_headers: std::collections::HashSet<_> = server
        .secret_header_keys
        .iter()
        .map(|key| key.to_ascii_lowercase())
        .collect();
    server
        .headers
        .retain(|key, _| !secret_headers.contains(&key.to_ascii_lowercase()));
    Ok(())
}

#[tauri::command]
fn list_threads(
    database: tauri::State<'_, database::Database>,
) -> Result<Vec<StoredThread>, String> {
    database.list_threads()
}

#[tauri::command]
fn save_thread(
    database: tauri::State<'_, database::Database>,
    thread: StoredThread,
) -> Result<(), String> {
    database.save_thread(&thread)
}

#[tauri::command]
fn list_writing_projects(
    database: tauri::State<'_, database::Database>,
) -> Result<Vec<WritingProjectRecord>, String> {
    database.list_writing_projects()
}

#[tauri::command]
fn save_writing_project(
    database: tauri::State<'_, database::Database>,
    project: WritingProjectRecord,
) -> Result<(), String> {
    database.save_writing_project(&project)
}

#[tauri::command]
fn delete_writing_project(
    database: tauri::State<'_, database::Database>,
    project_id: String,
) -> Result<bool, String> {
    database.delete_writing_project(&project_id)
}

#[tauri::command]
fn export_writing_file(destination: String, content: String) -> Result<String, String> {
    if content.len() > 16 * 1024 * 1024 {
        return Err("Writing export may not exceed 16 MiB".to_owned());
    }
    let path = PathBuf::from(destination);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "json" | "md" | "yarn" | "txt") {
        return Err("Writing exports must use .json, .md, .yarn, or .txt".to_owned());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Writing export destination has no parent directory".to_owned())?;
    if !parent.is_dir() {
        return Err("Writing export destination directory does not exist".to_owned());
    }
    std::fs::write(&path, content)
        .map_err(|error| format!("Could not export writing project: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_thread(
    app: tauri::AppHandle,
    database: tauri::State<'_, database::Database>,
    thread_id: String,
) -> Result<bool, String> {
    let attachment_ids = database
        .list_threads()?
        .into_iter()
        .find(|thread| thread.id == thread_id)
        .map(|thread| {
            thread
                .messages
                .into_iter()
                .flat_map(|message| message.attachments.into_iter().map(|item| item.id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let deleted = database.delete_thread(&thread_id)?;
    if deleted {
        let storage = attachment_storage(&app)?;
        for id in attachment_ids {
            let _ = attachment::delete(&storage, &id);
        }
    }
    Ok(deleted)
}

#[tauri::command]
fn scan_external_configs(app: tauri::AppHandle) -> Result<Vec<ExternalConfigCandidate>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    Ok(migration::scan(&home)
        .into_iter()
        .map(|item| item.candidate)
        .collect())
}

#[tauri::command]
fn import_external_config(
    app: tauri::AppHandle,
    candidate_id: String,
) -> Result<ProviderProfile, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    let material = migration::scan(&home)
        .into_iter()
        .find(|item| item.candidate.id == candidate_id)
        .ok_or_else(|| "The selected external configuration is no longer available".to_owned())?;
    let api_key = material
        .api_key
        .ok_or_else(|| "The selected configuration has no importable API key".to_owned())?;
    let profile = migration::profile_from_candidate(&material.candidate);
    provider_credential(&profile.id)?
        .set_password(api_key.trim())
        .map_err(|error| format!("Could not save imported API key: {error}"))?;
    Ok(profile)
}

#[tauri::command]
async fn get_git_status(workspace: String) -> Result<GitStatus, String> {
    git::status(&workspace).await
}

#[tauri::command]
async fn get_git_diff(workspace: String, path: String, staged: bool) -> Result<GitDiff, String> {
    git::diff(&workspace, &path, staged).await
}

#[tauri::command]
async fn preview_git_rollback(
    state: tauri::State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<GitRollbackPreview, String> {
    let candidate = git::rollback_candidate(&workspace, &path).await?;
    let mut preview = candidate.preview();
    let token = uuid::Uuid::new_v4().to_string();
    let mut pending = state
        .pending_git_rollbacks
        .lock()
        .map_err(|_| "Could not lock pending Git rollbacks".to_owned())?;
    pending.retain(|_, item| item.created_at.elapsed() < std::time::Duration::from_secs(600));
    if pending.len() >= MAX_PENDING_CONFIRMATIONS {
        return Err("Too many Git rollbacks are waiting for confirmation".to_owned());
    }
    pending.insert(
        token.clone(),
        PendingGitRollback {
            candidate,
            created_at: Instant::now(),
        },
    );
    preview.confirmation_token = token;
    Ok(preview)
}

#[tauri::command]
async fn apply_git_rollback(
    state: tauri::State<'_, AppState>,
    confirmation_token: String,
) -> Result<GitRollbackResult, String> {
    let pending = state
        .pending_git_rollbacks
        .lock()
        .map_err(|_| "Could not lock pending Git rollbacks".to_owned())?
        .remove(&confirmation_token)
        .ok_or_else(|| "Rollback preview expired; review the Git change again".to_owned())?;
    if pending.created_at.elapsed() >= std::time::Duration::from_secs(600) {
        return Err("Rollback preview expired; review the Git change again".to_owned());
    }
    git::apply_rollback(&pending.candidate).await
}

#[tauri::command]
fn preview_external_config_write(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile: ProviderProfile,
    target: ExternalConfigTarget,
) -> Result<ConfigWritePreview, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    let api_key = load_api_key(&profile.id)?;
    let mut preview = config_writeback::preview(&home, target, &profile, &api_key)?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut pending = state
        .pending_config_writes
        .lock()
        .map_err(|_| "Could not lock pending configuration writes".to_owned())?;
    pending.retain(|_, item| item.created_at.elapsed() < std::time::Duration::from_secs(600));
    if pending.len() >= MAX_PENDING_CONFIRMATIONS {
        return Err("Too many configuration previews are waiting for confirmation".to_owned());
    }
    pending.insert(
        token.clone(),
        PendingConfigWrite {
            target,
            profile: profile.clone(),
            created_at: Instant::now(),
        },
    );
    preview.confirmation_token = token;
    Ok(preview)
}

#[tauri::command]
fn apply_external_config_write(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile: ProviderProfile,
    target: ExternalConfigTarget,
    confirmation_token: String,
) -> Result<ConfigWriteResult, String> {
    let pending = state
        .pending_config_writes
        .lock()
        .map_err(|_| "Could not lock pending configuration writes".to_owned())?
        .remove(&confirmation_token)
        .ok_or_else(|| "Preview expired; review the configuration diff again".to_owned())?;
    if pending.created_at.elapsed() >= std::time::Duration::from_secs(600)
        || pending.target != target
        || pending.profile != profile
    {
        return Err("Preview no longer matches this configuration write".to_owned());
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    let api_key = load_api_key(&profile.id)?;
    config_writeback::apply(&home, target, &profile, &api_key)
}

#[tauri::command]
fn rollback_external_config_write(
    app: tauri::AppHandle,
    target: ExternalConfigTarget,
    backup_id: String,
) -> Result<Vec<String>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    config_writeback::rollback(&home, target, &backup_id)
}

#[tauri::command]
fn preview_external_prompt_write(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    target: ExternalConfigTarget,
    content: String,
) -> Result<ConfigWritePreview, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    let mut preview = config_writeback::prompt_preview(&home, target, &content)?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut pending = state
        .pending_prompt_writes
        .lock()
        .map_err(|_| "Could not lock pending instruction writes".to_owned())?;
    pending.retain(|_, item| item.created_at.elapsed() < std::time::Duration::from_secs(600));
    if pending.len() >= MAX_PENDING_CONFIRMATIONS {
        return Err("Too many instruction previews are waiting for confirmation".to_owned());
    }
    pending.insert(
        token.clone(),
        PendingPromptWrite {
            target,
            content,
            created_at: Instant::now(),
        },
    );
    preview.confirmation_token = token;
    Ok(preview)
}

#[tauri::command]
fn apply_external_prompt_write(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    target: ExternalConfigTarget,
    confirmation_token: String,
) -> Result<ConfigWriteResult, String> {
    let pending = state
        .pending_prompt_writes
        .lock()
        .map_err(|_| "Could not lock pending instruction writes".to_owned())?
        .remove(&confirmation_token)
        .ok_or_else(|| "Preview expired; review the instruction diff again".to_owned())?;
    if pending.created_at.elapsed() >= std::time::Duration::from_secs(600)
        || pending.target != target
    {
        return Err("Preview no longer matches this instruction write".to_owned());
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    config_writeback::prompt_apply(&home, target, &pending.content)
}

#[tauri::command]
fn rollback_external_prompt_write(
    app: tauri::AppHandle,
    target: ExternalConfigTarget,
    backup_id: String,
) -> Result<Vec<String>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not locate the home directory: {error}"))?;
    config_writeback::prompt_rollback(&home, target, &backup_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(AppState {
            client: Client::builder()
                .user_agent(concat!("LevelUpAgent/", env!("CARGO_PKG_VERSION")))
                .timeout(std::time::Duration::from_secs(180))
                .build()
                .expect("failed to build HTTP client"),
            active_requests: Mutex::new(HashMap::new()),
            pending_config_writes: Mutex::new(HashMap::new()),
            pending_prompt_writes: Mutex::new(HashMap::new()),
            pending_git_rollbacks: Mutex::new(HashMap::new()),
        })
        .manage(mcp::McpManager::default())
        .manage(subagent::SubagentManager::default())
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
                && let Some(pet_window) = window.app_handle().get_webview_window("pet")
            {
                let _ = pet_window.close();
            }
        })
        .setup(|app| {
            ensure_default_workspace(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            if let Some(source) = bundled_theme_source(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?
            {
                let storage = theme_storage(app.handle())
                    .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
                theme::sync_bundled(&storage, &source)
                    .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            }
            let app_data = app.path().app_data_dir()?;
            let media_directory = app_data.join("media");
            std::fs::create_dir_all(&media_directory)?;
            filesystem::restrict_directory(&media_directory)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            app.asset_protocol_scope()
                .allow_directory(&media_directory, true)?;
            let database_path = app_data.join("levelup-agent.sqlite3");
            let database = database::Database::open(&database_path)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let home = app.path().home_dir()?;
            let built_in_skills = built_in_skill_root(app.handle());
            let pet_manager =
                pet::PetManager::open_with_skills(&app_data, &home, built_in_skills.as_deref())
                    .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let hatch_environment = pet_manager
                .configure_hatch()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            enable_pet_hatch_skills(&database, &hatch_environment)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let pet_visible = pet_manager.overlay_visible();
            app.asset_protocol_scope()
                .allow_directory(pet_manager.root(), true)?;
            app.manage(database);
            app.manage(pet_manager);
            app.manage(pet::PetRuntime::default());
            pet::create_window(app.handle(), pet_visible)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // The app stores conversations, Goals, and hatch state in one shared
        // SQLite database. A second process would race the first process's
        // pause/resume and hydration logic, so bring the existing window to
        // the foreground instead of starting another state machine.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    let builder = if option_env!("LEVELUP_ENABLE_UPDATER").is_some() {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    builder
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            has_api_key,
            delete_api_key,
            get_provider_settings,
            save_provider_settings,
            get_media_catalog,
            generate_media,
            list_media_assets,
            refresh_media_asset,
            export_media_asset,
            delete_media_asset,
            import_image_attachments,
            import_media_references,
            import_clipboard_images,
            import_clipboard_attachments,
            delete_image_attachment,
            get_default_workspace,
            preview_attachment,
            list_provider_health,
            list_provider_requests,
            reset_provider_health,
            get_gateway_diagnostics,
            get_custom_instructions,
            save_custom_instructions,
            fetch_models,
            agent_turn,
            agent_turn_stream,
            cancel_agent_turn,
            execute_tool,
            create_goal,
            get_goal,
            change_goal_status,
            scan_skills,
            set_skill_enabled,
            list_mcp_servers,
            upsert_mcp_server,
            start_mcp_server,
            stop_mcp_server,
            delete_mcp_server,
            list_threads,
            save_thread,
            delete_thread,
            list_writing_projects,
            save_writing_project,
            delete_writing_project,
            export_writing_file,
            scan_external_configs,
            import_external_config,
            get_git_status,
            get_git_diff,
            preview_git_rollback,
            apply_git_rollback,
            preview_external_config_write,
            apply_external_config_write,
            rollback_external_config_write,
            preview_external_prompt_write,
            apply_external_prompt_write,
            rollback_external_prompt_write,
            list_themes,
            install_theme,
            install_theme_data,
            load_theme,
            load_theme_layout,
            uninstall_theme,
            get_pet_runtime,
            select_pet,
            set_pet_overlay_visible,
            set_pet_scale,
            install_pet,
            remove_pet,
            record_pet_usage,
            learn_pet_memory,
            delete_pet_memory,
            get_pet_hatch_environment,
            configure_pet_hatch,
            import_hatched_pets,
            update_pet_activities,
            open_pet_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::process::Command as StdCommand;
    use std::thread;

    fn profile(id: &str, priority: i32, failover_enabled: bool) -> ProviderProfile {
        ProviderProfile {
            id: id.to_owned(),
            name: id.to_owned(),
            base_url: "https://example.test".to_owned(),
            model: "test".to_owned(),
            protocol: models::ProviderProtocol::OpenaiResponses,
            allow_unauthenticated: false,
            priority,
            failover_enabled,
        }
    }

    #[test]
    fn hatch_manifest_references_are_grounded_and_completed_jobs_are_rejected() {
        let root =
            std::env::temp_dir().join(format!("levelup-hatch-manifest-{}", uuid::Uuid::new_v4()));
        let run = root.join("noct-run");
        let references = run.join("references");
        std::fs::create_dir_all(&references).unwrap();
        std::fs::write(references.join("base.png"), b"\x89PNG\r\n\x1a\nbase").unwrap();
        let manifest = serde_json::json!({
            "jobs": [{
                "id": "idle",
                "status": "pending",
                "input_images": [{ "path": "references/base.png" }],
                "output_path": "decoded/idle.png"
            }]
        });
        std::fs::write(
            run.join("imagegen-jobs.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let request = ToolExecutionRequest {
            name: "generate_images".to_owned(),
            arguments: serde_json::json!({
                "hatchRunDir": run.to_string_lossy(),
                "hatchJobId": "idle"
            }),
            workspace: root.to_string_lossy().into_owned(),
            thread_id: Some("hatch-thread".to_owned()),
            profile: None,
            fallback_profiles: Vec::new(),
            hatch: true,
            hatch_skill_loaded: false,
            hatch_bootstrap: false,
        };
        let references = read_hatch_job_references(&request).unwrap().unwrap();
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].mime_type, "image/png");

        let completed = serde_json::json!({
            "jobs": [{
                "id": "idle",
                "status": "complete",
                "input_images": [{ "path": "references/base.png" }],
                "output_path": "decoded/idle.png"
            }]
        });
        std::fs::write(
            run.join("imagegen-jobs.json"),
            serde_json::to_vec(&completed).unwrap(),
        )
        .unwrap();
        let error = match read_hatch_job_references(&request) {
            Ok(_) => panic!("completed hatch job unexpectedly accepted"),
            Err(error) => error,
        };
        assert!(error.contains("already complete"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn hatch_tool_policy_rejects_state_refreshes_and_loaded_manifest_rereads() {
        let mut request = ToolExecutionRequest {
            name: "get_goal".to_owned(),
            arguments: serde_json::json!({}),
            workspace: "C:/hatch".to_owned(),
            thread_id: Some("hatch-thread".to_owned()),
            profile: None,
            fallback_profiles: Vec::new(),
            hatch: true,
            hatch_skill_loaded: true,
            hatch_bootstrap: false,
        };
        assert!(hatch_tool_policy_error(&request).is_some());

        request.name = "read_skill".to_owned();
        assert!(hatch_tool_policy_error(&request).is_some());
        request.arguments = serde_json::json!({ "path": "./SKILL.md" });
        assert!(hatch_tool_policy_error(&request).is_some());
        request.arguments = serde_json::json!({ "path": "references/animation-rows.md" });
        assert!(hatch_tool_policy_error(&request).is_some());

        request.name = "run_command".to_owned();
        request.arguments =
            serde_json::json!({ "command": "Get-Content .\\levelup-pet-hatch.json" });
        assert!(hatch_tool_policy_error(&request).is_some());
        request.arguments =
            serde_json::json!({ "command": "python prepare_pet_run.py --output-dir C:/run" });
        assert!(hatch_tool_policy_error(&request).is_none());

        request.hatch_bootstrap = true;
        assert!(hatch_tool_policy_error(&request).is_none());

        request.hatch = false;
        request.name = "get_goal".to_owned();
        assert!(hatch_tool_policy_error(&request).is_none());
    }

    #[test]
    fn hatch_goal_objective_detection_covers_legacy_and_english_requests() {
        assert!(is_hatch_goal_objective(
            "孵化摇光残影“Noct”：黑发蓝眼，黑色披风"
        ));
        assert!(is_hatch_goal_objective(
            "Hatch the Starlight Echo \"Noct\" using the hatch-pet workflow"
        ));
        assert!(is_hatch_goal_objective("Hatch a custom pet named Noct"));
        assert!(is_hatch_goal_objective("孵化残影 Noct"));
        assert!(!is_hatch_goal_objective("分析当前项目并修复测试失败"));
    }

    #[test]
    fn provider_candidates_keep_primary_first_and_sort_enabled_fallbacks() {
        let request = AgentTurnRequest {
            profile: profile("primary", 999, false),
            messages: Vec::new(),
            mode: "chat".to_owned(),
            workspace: None,
            thread_id: None,
            hatch: false,
            hatch_skill_loaded: false,
            available_tools: Vec::new(),
            available_skills: Vec::new(),
            goal: None,
            fallback_profiles: vec![
                profile("slow", 80, true),
                profile("disabled", 1, false),
                profile("fast", 10, true),
                profile("primary", 0, true),
            ],
            custom_instructions: None,
        };
        let ids = provider_candidates(&request)
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["primary", "fast", "slow"]);
    }

    #[test]
    fn media_tools_are_attached_without_a_project_workspace() {
        let mut request = AgentTurnRequest {
            profile: profile("primary", 10, true),
            messages: Vec::new(),
            mode: "agent".to_owned(),
            workspace: None,
            thread_id: Some("thread-media".to_owned()),
            hatch: false,
            hatch_skill_loaded: false,
            available_tools: Vec::new(),
            available_skills: Vec::new(),
            goal: None,
            fallback_profiles: Vec::new(),
            custom_instructions: None,
        };
        attach_media_tools(&mut request);
        assert!(
            request
                .available_tools
                .iter()
                .any(|tool| tool.name == "generate_images")
        );
    }

    #[test]
    fn hatch_goal_keeps_updates_but_does_not_expose_goal_refresh() {
        let root =
            std::env::temp_dir().join(format!("levelup-hatch-goal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let database = database::Database::open(&root.join("test.sqlite3")).unwrap();
        let thread_id = "hatch-thread".to_owned();
        database
            .create_goal(&GoalCreateRequest {
                thread_id: thread_id.clone(),
                objective: "Hatch the requested pet".to_owned(),
            })
            .unwrap();
        let mut request = AgentTurnRequest {
            profile: profile("primary", 10, true),
            messages: Vec::new(),
            mode: "goal".to_owned(),
            workspace: Some(root.to_string_lossy().into_owned()),
            thread_id: Some(thread_id),
            hatch: true,
            hatch_skill_loaded: false,
            available_tools: Vec::new(),
            available_skills: Vec::new(),
            goal: None,
            fallback_profiles: Vec::new(),
            custom_instructions: None,
        };

        attach_goal(&database, &mut request).unwrap();

        assert!(request.goal.is_some());
        assert!(
            request
                .available_tools
                .iter()
                .any(|tool| tool.name == "update_goal")
        );
        assert!(
            request
                .available_tools
                .iter()
                .all(|tool| tool.name != "get_goal")
        );
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_hatch_goal_forces_hatch_mode_before_catalog_attachment() {
        let root = std::env::temp_dir().join(format!(
            "levelup-legacy-hatch-goal-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let database = database::Database::open(&root.join("test.sqlite3")).unwrap();
        let thread_id = "legacy-hatch-thread".to_owned();
        database
            .create_goal(&GoalCreateRequest {
                thread_id: thread_id.clone(),
                objective: "孵化摇光残影“Noct”：黑发蓝眼，黑色披风".to_owned(),
            })
            .unwrap();
        let mut request = AgentTurnRequest {
            profile: profile("primary", 10, true),
            messages: Vec::new(),
            mode: "goal".to_owned(),
            workspace: Some(root.to_string_lossy().into_owned()),
            thread_id: Some(thread_id),
            hatch: false,
            hatch_skill_loaded: true,
            available_tools: Vec::new(),
            available_skills: Vec::new(),
            goal: None,
            fallback_profiles: Vec::new(),
            custom_instructions: None,
        };

        attach_goal(&database, &mut request).unwrap();

        assert!(request.hatch);
        assert!(
            request
                .available_tools
                .iter()
                .all(|tool| tool.name != "get_goal")
        );
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn agent_image_tool_drops_accidental_transparency_but_keeps_explicit_intent() {
        let accidental = media_request_from_tool(
            "generate_images",
            &serde_json::json!({
                "prompt": "一只可爱的像素小猫",
                "background": "transparent"
            }),
        )
        .unwrap();
        assert_eq!(accidental.background, None);

        let explicit = media_request_from_tool(
            "generate_images",
            &serde_json::json!({
                "prompt": "一只可爱的像素小猫，透明背景 PNG",
                "background": "transparent"
            }),
        )
        .unwrap();
        assert_eq!(explicit.background.as_deref(), Some("transparent"));
    }

    #[test]
    fn provider_ids_cannot_collide_with_mcp_or_escape_the_credential_namespace() {
        for valid in ["provider-123", "cc-switch_claude", "local.test"] {
            assert!(validate_provider_id(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "",
            "mcp:server",
            "../secret",
            "provider/key",
            "provider key",
        ] {
            assert!(validate_provider_id(invalid).is_err(), "{invalid}");
        }
        assert_ne!(PROVIDER_CREDENTIAL_PREFIX, MCP_CREDENTIAL_PREFIX);
    }

    #[test]
    fn provider_settings_require_unique_valid_connections_and_active_selection() {
        let first = profile("primary", 10, true);
        let second = profile("fallback", 20, true);
        let mut settings = ProviderSettings {
            profiles: vec![first.clone(), second.clone()],
            active_profile_id: first.id.clone(),
        };
        assert!(validate_provider_settings(&settings).is_ok());

        settings.active_profile_id = "missing".to_owned();
        assert!(validate_provider_settings(&settings).is_err());
        settings.active_profile_id = first.id.clone();
        settings.profiles.push(first);
        assert!(validate_provider_settings(&settings).is_err());
        settings.profiles = vec![second];
        settings.profiles[0].base_url = "file:///tmp/provider".to_owned();
        settings.active_profile_id = settings.profiles[0].id.clone();
        assert!(validate_provider_settings(&settings).is_err());
    }

    #[test]
    fn repeated_media_candidate_failures_are_compacted() {
        let failures = vec![
            (
                "LevelUpAPI / gpt-image-2".to_owned(),
                "Media provider request failed (502 Bad Gateway): Upstream request failed"
                    .to_owned(),
            ),
            (
                "LevelUpAPI / gpt-image-1.5".to_owned(),
                "Media provider request failed (502 Bad Gateway): Upstream request failed"
                    .to_owned(),
            ),
        ];
        assert_eq!(
            format_media_failures(&failures),
            "LevelUpAPI / gpt-image-2 (+1 candidates): Media provider request failed (502 Bad Gateway): Upstream request failed"
        );
    }

    fn mock_responses_server(status: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = vec![0_u8; 32 * 1024];
            let size = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.starts_with("POST /v1/responses "));
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        format!("http://{address}")
    }

    fn mock_responses_sequence_server(bodies: Vec<&'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for body in bodies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = vec![0_u8; 32 * 1024];
                let size = stream.read(&mut request).unwrap();
                assert!(
                    String::from_utf8_lossy(&request[..size]).starts_with("POST /v1/responses ")
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn real_http_failure_fails_over_and_records_both_attempts() {
        let root = std::env::temp_dir().join(format!("levelup-failover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let database = database::Database::open(&root.join("test.sqlite3")).unwrap();
        let mut primary = profile("primary", 10, true);
        primary.base_url =
            mock_responses_server("503 Service Unavailable", r#"{"error":{"message":"busy"}}"#);
        let mut fallback = profile("fallback", 20, true);
        fallback.base_url = mock_responses_server(
            "200 OK",
            r#"{"output":[{"type":"message","content":[{"type":"output_text","text":"fallback worked"}]}],"usage":{"input_tokens":4,"output_tokens":2}}"#,
        );
        let request = AgentTurnRequest {
            profile: primary,
            messages: vec![models::AgentMessage {
                role: "user".to_owned(),
                content: "test".to_owned(),
                tool_calls: Vec::new(),
                tool_call_id: None,
                internal: false,
                attachments: Vec::new(),
            }],
            mode: "chat".to_owned(),
            workspace: None,
            thread_id: Some("thread-failover".to_owned()),
            hatch: false,
            hatch_skill_loaded: false,
            available_tools: Vec::new(),
            available_skills: Vec::new(),
            goal: None,
            fallback_profiles: vec![fallback],
            custom_instructions: None,
        };
        let result = run_agent_turn_with_failover(&Client::new(), &database, request, |_| {
            Ok("test-key".to_owned())
        })
        .await
        .unwrap();
        assert_eq!(result.content, "fallback worked");
        assert_eq!(result.provider_id.as_deref(), Some("fallback"));
        assert_eq!(result.failover_count, 1);
        assert_eq!(
            database
                .get_provider_health("primary")
                .unwrap()
                .consecutive_failures,
            1
        );
        let logs = database.list_provider_requests(10).unwrap();
        assert_eq!(logs.len(), 2);
        assert!(
            logs.iter()
                .any(|item| item.profile_id == "primary" && item.status == "error")
        );
        assert!(
            logs.iter()
                .any(|item| item.profile_id == "fallback" && item.status == "success")
        );
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn explicitly_unauthenticated_profile_runs_without_a_saved_key() {
        let root = std::env::temp_dir().join(format!("levelup-noauth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let database = database::Database::open(&root.join("test.sqlite3")).unwrap();
        let mut local = profile("local", 10, false);
        local.allow_unauthenticated = true;
        local.base_url = mock_responses_server(
            "200 OK",
            r#"{"output":[{"type":"message","content":[{"type":"output_text","text":"local worked"}]}]}"#,
        );
        let request = AgentTurnRequest {
            profile: local,
            messages: vec![models::AgentMessage {
                role: "user".to_owned(),
                content: "test".to_owned(),
                tool_calls: Vec::new(),
                tool_call_id: None,
                internal: false,
                attachments: Vec::new(),
            }],
            mode: "chat".to_owned(),
            workspace: None,
            thread_id: Some("thread-local".to_owned()),
            hatch: false,
            hatch_skill_loaded: false,
            available_tools: Vec::new(),
            available_skills: Vec::new(),
            goal: None,
            fallback_profiles: Vec::new(),
            custom_instructions: None,
        };
        let result = run_agent_turn_with_failover(&Client::new(), &database, request, |_| {
            Err("No API key is stored".to_owned())
        })
        .await
        .unwrap();
        assert_eq!(result.content, "local worked");
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[ignore = "requires LEVELUP_TEST_APP_DATA and an explicitly configured real provider"]
    async fn configured_media_provider_real_smoke() {
        let app_data = std::env::var_os("LEVELUP_TEST_APP_DATA")
            .map(std::path::PathBuf::from)
            .expect("set LEVELUP_TEST_APP_DATA to the LevelUpAgent application-data directory");
        let database = database::Database::open(&app_data.join("levelup-agent.sqlite3")).unwrap();
        let settings = media_settings(&database).unwrap();
        let (providers, credential_errors) = configured_media_providers(&settings);
        assert!(
            credential_errors.is_empty(),
            "could not load configured media credentials: {}",
            credential_errors.join("; ")
        );
        assert!(
            !providers.is_empty(),
            "no configured provider has a credential"
        );

        let client = Client::builder()
            .user_agent("LevelUpAgent/real-media-smoke")
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .unwrap();
        let catalog =
            media::discover_catalog(&client, &providers, settings.active_profile_id.as_str()).await;
        assert!(
            catalog.errors.is_empty(),
            "media catalog errors: {}",
            catalog.errors.join("; ")
        );
        let image_models = catalog
            .models
            .iter()
            .filter(|model| model.kind == MediaKind::Image)
            .collect::<Vec<_>>();
        let recommended = image_models
            .iter()
            .copied()
            .find(|model| model.recommended)
            .expect("no recommended image model was discovered");
        assert!(
            image_models
                .iter()
                .all(|model| recommended.rank >= model.rank),
            "the recommended image model is not the highest-ranked available model"
        );
        println!(
            "discovered_image_models={} recommended_image_model={} ids={:?}",
            image_models.len(),
            recommended.id,
            image_models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>()
        );

        if std::env::var("LEVELUP_REAL_MEDIA_GENERATE").as_deref() != Ok("1") {
            return;
        }
        let requested_model = std::env::var("LEVELUP_REAL_MEDIA_MODEL").ok();
        let request = MediaGenerationRequest {
            profile_id: None,
            kind: MediaKind::Image,
            model: requested_model.clone(),
            prompt: "A minimal verification image: one coral circle centered on a clean warm-white background, no text".to_owned(),
            count: 1,
            size: Some("1024x1024".to_owned()),
            quality: None,
            output_format: Some("png".to_owned()),
            background: None,
            voice: None,
            instructions: None,
            seconds: None,
            video_mode: models::VideoGenerationMode::Text,
            video_resolution: None,
            video_aspect_ratio: None,
            reference_attachment_ids: Vec::new(),
        };
        let selections = media::selection_candidates(&providers, &catalog, &request);
        let selection = selections
            .first()
            .expect("automatic image selection returned no candidate");
        if requested_model.is_none() {
            assert_eq!(selection.model, recommended.id);
        }
        let storage = app_data.join("media");
        let result = media::generate_batch(
            &client,
            &storage,
            &database,
            selection,
            &request,
            Some("real-media-smoke"),
            &[],
        )
        .await
        .unwrap();
        assert!(
            result.errors.is_empty(),
            "generation errors: {:?}",
            result.errors
        );
        let asset = result.assets.first().expect("generation returned no asset");
        assert_eq!(asset.status, MediaStatus::Completed);
        let path = asset
            .file_path
            .as_deref()
            .expect("completed generation has no local file path");
        assert!(std::path::Path::new(path).is_file());
        println!(
            "generated_asset_id={} generated_model={}",
            asset.id, asset.model
        );
        if std::env::var("LEVELUP_REAL_MEDIA_KEEP").as_deref() != Ok("1") {
            assert!(media::delete_asset(&database, &storage, &asset.id).unwrap());
        }
    }

    #[tokio::test]
    async fn isolated_subagent_runs_a_real_provider_tool_loop_without_shell_access() {
        let suite =
            std::env::temp_dir().join(format!("levelup-subagent-loop-{}", uuid::Uuid::new_v4()));
        let repository = suite.join("repository");
        std::fs::create_dir_all(&repository).unwrap();
        let git = |args: &[&str]| {
            let output = StdCommand::new("git")
                .current_dir(&repository)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "levelup@example.test"]);
        git(&["config", "user.name", "LevelUpAgent Test"]);
        std::fs::write(repository.join("README.md"), "# Fixture\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "initial"]);

        let worktree = subagent::create_worktree(&suite.join("worktrees"), &repository)
            .await
            .unwrap();
        let database = database::Database::open(&suite.join("requests.sqlite3")).unwrap();
        let mut child_profile = profile("child-provider", 10, true);
        child_profile.base_url = mock_responses_sequence_server(vec![
            r#"{"output":[{"type":"function_call","call_id":"write-one","name":"write_file","arguments":"{\"path\":\"child.txt\",\"content\":\"hello from child\\n\"}"}],"usage":{"input_tokens":8,"output_tokens":4}}"#,
            r#"{"output":[{"type":"message","content":[{"type":"output_text","text":"Created child.txt in the isolated worktree."}]}],"usage":{"input_tokens":12,"output_tokens":5}}"#,
        ]);
        let request = ToolExecutionRequest {
            name: "delegate_task".to_owned(),
            arguments: serde_json::json!({ "task": "Create child.txt" }),
            workspace: repository.to_string_lossy().into_owned(),
            thread_id: Some("parent-thread".to_owned()),
            profile: Some(child_profile),
            fallback_profiles: Vec::new(),
            hatch: false,
            hatch_skill_loaded: false,
            hatch_bootstrap: false,
        };
        let summary = run_isolated_subagent(
            &Client::new(),
            &database,
            &request,
            &worktree,
            IsolatedSubagentTask {
                task: "Create child.txt",
                scope: Some("child.txt"),
                max_turns: 4,
            },
            |_| Ok("test-key".to_owned()),
        )
        .await
        .unwrap();
        assert!(summary.contains("Created child.txt"));
        assert_eq!(
            std::fs::read_to_string(worktree.path.join("child.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "hello from child\n"
        );
        subagent::cleanup_worktree(&worktree).await.unwrap();
        drop(database);
        let _ = std::fs::remove_dir_all(suite);
    }
}
