use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, ErrorCode, OptionalExtension, params};

use crate::harness::types::{
    HarnessApprovalRecord, HarnessDraftRequest, HarnessMode, HarnessOperationStarted,
    HarnessPendingApproval, HarnessQueueItem, HarnessQueueRequest, HarnessRecoveryItem,
    HarnessSessionNode, HarnessSessionNodeRequest, HarnessSubmission, PermissionLevel,
    RuntimeState,
};
use crate::models::{
    GoalCreateRequest, GoalState, GoalStatus, ImageAttachment, McpServerConfig, McpTransport,
    MediaAsset, MediaKind, MediaStatus, ProviderHealth, ProviderProfile, ProviderRequestLog,
    ProviderSettings, StoredMessage, StoredThread, ToolCall, WritingProjectRecord,
};

const SCHEMA_VERSION: i64 = 16;

fn paths_equal(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HarnessRecoverySummary {
    pub interrupted_operations: usize,
    pub unknown_tool_executions: usize,
    pub failed_provider_attempts: usize,
    pub cancelled_queue_items: usize,
}

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                storage_error("Could not create application data directory", error)
            })?;
            crate::filesystem::restrict_directory(parent)?;
        }
        let connection = Connection::open(path).map_err(database_error)?;
        crate::filesystem::restrict_file(path)?;
        let database = Self::from_connection(connection)?;
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            let sidecar = std::path::PathBuf::from(sidecar);
            if sidecar.exists() {
                crate::filesystem::restrict_file(&sidecar)?;
            }
        }
        Ok(database)
    }

    fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA busy_timeout = 5000;

                 CREATE TABLE IF NOT EXISTS threads (
                    id TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL,
                    workspace TEXT,
                    kind TEXT,
                    pet_id TEXT,
                    updated_at INTEGER NOT NULL,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0
                 );

                 CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY NOT NULL,
                    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    tool_calls_json TEXT NOT NULL DEFAULT '[]',
                    tool_call_id TEXT,
                    created_at INTEGER NOT NULL,
                     is_error INTEGER NOT NULL DEFAULT 0,
                     request_id TEXT,
                     internal INTEGER NOT NULL DEFAULT 0,
                     attachments_json TEXT NOT NULL DEFAULT '[]',
                     model_name TEXT,
                     provider_brand TEXT,
                     change_set_json TEXT,
                     status TEXT,
                     UNIQUE(thread_id, position)
                 );

                 CREATE INDEX IF NOT EXISTS idx_threads_updated_at
                    ON threads(updated_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_messages_thread_position
                    ON messages(thread_id, position);

                 CREATE TABLE IF NOT EXISTS mcp_servers (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    transport TEXT NOT NULL,
                    command TEXT,
                    args_json TEXT NOT NULL DEFAULT '[]',
                    url TEXT,
                    environment_json TEXT NOT NULL DEFAULT '{}',
                    headers_json TEXT NOT NULL DEFAULT '{}',
                    secret_environment_keys_json TEXT NOT NULL DEFAULT '[]',
                    secret_header_keys_json TEXT NOT NULL DEFAULT '[]',
                    updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_mcp_servers_name
                    ON mcp_servers(name COLLATE NOCASE);

                 CREATE TABLE IF NOT EXISTS skill_preferences (
                    id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (id, path)
                 );

                 CREATE TABLE IF NOT EXISTS goals (
                    id TEXT PRIMARY KEY NOT NULL,
                    thread_id TEXT NOT NULL UNIQUE,
                    objective TEXT NOT NULL,
                    status TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    turns INTEGER NOT NULL DEFAULT 0,
                    blocked_attempts INTEGER NOT NULL DEFAULT 0,
                    last_blocker TEXT,
                    audit_note TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );

                 CREATE TABLE IF NOT EXISTS media_assets (
                    id TEXT PRIMARY KEY NOT NULL,
                    batch_id TEXT NOT NULL,
                    thread_id TEXT,
                    provider_id TEXT NOT NULL,
                    provider_name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    model TEXT NOT NULL,
                    mime_type TEXT,
                    file_name TEXT,
                    remote_id TEXT,
                    revised_prompt TEXT,
                    error TEXT,
                    progress INTEGER,
                    size TEXT,
                    quality TEXT,
                    output_format TEXT,
                    voice TEXT,
                    seconds INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    background TEXT,
                    generation_count INTEGER NOT NULL DEFAULT 1
                 );

                 CREATE TABLE IF NOT EXISTS writing_projects (
                    id TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL,
                    project_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );

                 CREATE TABLE IF NOT EXISTS provider_health (
                    profile_id TEXT PRIMARY KEY NOT NULL,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    last_success_at INTEGER,
                    last_failure_at INTEGER,
                    cooldown_until INTEGER,
                    total_requests INTEGER NOT NULL DEFAULT 0,
                    total_failovers INTEGER NOT NULL DEFAULT 0,
                    average_latency_ms INTEGER
                 );

                 CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );

                 CREATE TABLE IF NOT EXISTS provider_requests (
                    id TEXT PRIMARY KEY NOT NULL,
                    thread_id TEXT,
                    profile_id TEXT NOT NULL,
                    model TEXT NOT NULL,
                    protocol TEXT NOT NULL,
                    started_at INTEGER NOT NULL,
                    latency_ms INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    request_id TEXT,
                    failover_index INTEGER NOT NULL DEFAULT 0,
                    error TEXT
                 );",
            )
            .map_err(database_error)?;
        connection
            .execute_batch(crate::harness::persistence::MIGRATION_SQL)
            .map_err(|error| format!("Could not migrate harness database: {error}"))?;
        // Thread kind/pet identity were originally UI-only fields. Keep them
        // in SQLite now that pet conversations also use durable Harness
        // operations, while remaining additive for existing installations.
        let thread_columns = connection
            .prepare("PRAGMA table_info(threads)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?;
        if !thread_columns.iter().any(|column| column == "kind") {
            connection
                .execute("ALTER TABLE threads ADD COLUMN kind TEXT", [])
                .map_err(database_error)?;
        }
        if !thread_columns.iter().any(|column| column == "pet_id") {
            connection
                .execute("ALTER TABLE threads ADD COLUMN pet_id TEXT", [])
                .map_err(database_error)?;
        }
        let has_harness_arguments = connection
            .prepare("PRAGMA table_info(harness_tool_executions)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?
            .iter()
            .any(|column| column == "arguments_json");
        if !has_harness_arguments {
            connection
                .execute(
                    "ALTER TABLE harness_tool_executions ADD COLUMN arguments_json TEXT NOT NULL DEFAULT '{}'",
                    [],
                )
                .map_err(database_error)?;
        }
        let has_request_id = connection
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?
            .iter()
            .any(|column| column == "request_id");
        if !has_request_id {
            connection
                .execute("ALTER TABLE messages ADD COLUMN request_id TEXT", [])
                .map_err(database_error)?;
        }
        let has_internal = connection
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?
            .iter()
            .any(|column| column == "internal");
        if !has_internal {
            connection
                .execute(
                    "ALTER TABLE messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(database_error)?;
        }
        let has_attachments = connection
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?
            .iter()
            .any(|column| column == "attachments_json");
        if !has_attachments {
            connection
                .execute(
                    "ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'",
                    [],
                )
                .map_err(database_error)?;
        }
        let has_model_name = connection
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?
            .iter()
            .any(|column| column == "model_name");
        if !has_model_name {
            connection
                .execute("ALTER TABLE messages ADD COLUMN model_name TEXT", [])
                .map_err(database_error)?;
        }
        let has_provider_brand = connection
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?
            .iter()
            .any(|column| column == "provider_brand");
        if !has_provider_brand {
            connection
                .execute("ALTER TABLE messages ADD COLUMN provider_brand TEXT", [])
                .map_err(database_error)?;
        }
        let has_change_set = connection
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?
            .iter()
            .any(|column| column == "change_set_json");
        if !has_change_set {
            connection
                .execute("ALTER TABLE messages ADD COLUMN change_set_json TEXT", [])
                .map_err(database_error)?;
        }
        let has_status = connection
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?
            .iter()
            .any(|column| column == "status");
        if !has_status {
            connection
                .execute("ALTER TABLE messages ADD COLUMN status TEXT", [])
                .map_err(database_error)?;
        }
        let media_columns = connection
            .prepare("PRAGMA table_info(media_assets)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                columns.collect::<Result<Vec<_>, _>>()
            })
            .map_err(database_error)?;
        if !media_columns.iter().any(|column| column == "background") {
            connection
                .execute("ALTER TABLE media_assets ADD COLUMN background TEXT", [])
                .map_err(database_error)?;
        }
        if !media_columns
            .iter()
            .any(|column| column == "generation_count")
        {
            connection
                .execute(
                    "ALTER TABLE media_assets ADD COLUMN generation_count INTEGER NOT NULL DEFAULT 1",
                    [],
                )
                .map_err(database_error)?;
        }
        connection
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_provider_requests_started_at
                   ON provider_requests(started_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_provider_requests_request_id
                   ON provider_requests(request_id);
                 CREATE INDEX IF NOT EXISTS idx_provider_requests_profile_model
                   ON provider_requests(profile_id, model, started_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_media_assets_created_at
                   ON media_assets(created_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_media_assets_kind_created_at
                   ON media_assets(kind, created_at DESC, id DESC);
                 CREATE INDEX IF NOT EXISTS idx_media_assets_thread
                   ON media_assets(thread_id, created_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_writing_projects_updated_at
                   ON writing_projects(updated_at DESC);",
            )
            .map_err(database_error)?;
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(database_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn list_threads(&self) -> Result<Vec<StoredThread>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, title, workspace, kind, pet_id, updated_at, input_tokens, output_tokens
                 FROM threads ORDER BY updated_at DESC LIMIT 200",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(database_error)?;
        let summaries = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        drop(statement);

        let mut threads = Vec::with_capacity(summaries.len());
        let mut message_statement = connection
            .prepare(
                "SELECT m.id, m.role, m.content, m.tool_calls_json, m.tool_call_id, m.created_at, m.is_error, m.request_id, m.internal, m.attachments_json,
                        COALESCE(m.model_name, (
                            SELECT provider_request.model
                            FROM provider_requests AS provider_request
                            WHERE provider_request.request_id = m.request_id
                              AND provider_request.status = 'success'
                            ORDER BY provider_request.started_at DESC
                            LIMIT 1
                        )) AS model_name,
                        m.provider_brand,
                        m.change_set_json,
                        m.status
                 FROM messages AS m
                 WHERE m.thread_id = ?1 ORDER BY m.position ASC",
            )
            .map_err(database_error)?;
        for (id, title, workspace, kind, pet_id, updated_at, input_tokens, output_tokens) in
            summaries
        {
            let messages = message_statement
                .query_map([&id], |row| {
                    let tool_calls_json: String = row.get(3)?;
                    let tool_calls =
                        serde_json::from_str::<Vec<ToolCall>>(&tool_calls_json).unwrap_or_default();
                    let attachments_json: String = row.get(9)?;
                    let attachments =
                        serde_json::from_str::<Vec<ImageAttachment>>(&attachments_json)
                            .unwrap_or_default();
                    Ok(StoredMessage {
                        id: row.get(0)?,
                        role: row.get(1)?,
                        content: row.get(2)?,
                        tool_calls,
                        tool_call_id: row.get(4)?,
                        created_at: row.get(5)?,
                        is_error: row.get::<_, i64>(6)? != 0,
                        request_id: row.get(7)?,
                        internal: row.get::<_, i64>(8)? != 0,
                        attachments,
                        model_name: row.get(10)?,
                        provider_brand: row.get(11)?,
                        change_set: row
                            .get::<_, Option<String>>(12)?
                            .and_then(|value| serde_json::from_str(&value).ok()),
                        status: row.get(13)?,
                    })
                })
                .map_err(database_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?;
            threads.push(StoredThread {
                id,
                title,
                workspace,
                kind,
                pet_id,
                messages,
                updated_at,
                input_tokens: input_tokens.max(0) as u64,
                output_tokens: output_tokens.max(0) as u64,
            });
        }
        Ok(threads)
    }

    pub fn save_thread(&self, thread: &StoredThread) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO threads (id, title, workspace, kind, pet_id, updated_at, input_tokens, output_tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    workspace = excluded.workspace,
                    kind = excluded.kind,
                    pet_id = excluded.pet_id,
                    updated_at = excluded.updated_at,
                    input_tokens = excluded.input_tokens,
                    output_tokens = excluded.output_tokens",
                params![
                    thread.id,
                    thread.title,
                    thread.workspace,
                    thread.kind,
                    thread.pet_id,
                    thread.updated_at,
                    thread.input_tokens.min(i64::MAX as u64) as i64,
                    thread.output_tokens.min(i64::MAX as u64) as i64,
                ],
            )
            .map_err(database_error)?;
        transaction
            .execute("DELETE FROM messages WHERE thread_id = ?1", [&thread.id])
            .map_err(database_error)?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO messages
                     (id, thread_id, position, role, content, tool_calls_json, tool_call_id, created_at, is_error, request_id, internal, attachments_json, model_name, provider_brand, change_set_json, status)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                )
                .map_err(database_error)?;
            for (position, message) in thread.messages.iter().enumerate() {
                let tool_calls = serde_json::to_string(&message.tool_calls)
                    .map_err(|error| format!("Could not serialize tool calls: {error}"))?;
                let attachments = serde_json::to_string(&message.attachments)
                    .map_err(|error| format!("Could not serialize image attachments: {error}"))?;
                statement
                    .execute(params![
                        message.id,
                        thread.id,
                        position as i64,
                        message.role,
                        message.content,
                        tool_calls,
                        message.tool_call_id,
                        message.created_at,
                        i64::from(message.is_error),
                        message.request_id,
                        i64::from(message.internal),
                        attachments,
                        message.model_name,
                        message.provider_brand,
                        message
                            .change_set
                            .as_ref()
                            .map(|value| serde_json::to_string(value)
                                .unwrap_or_else(|_| "null".to_owned())),
                        message.status,
                    ])
                    .map_err(database_error)?;
            }
        }
        transaction.commit().map_err(database_error)
    }

    pub fn delete_thread(&self, thread_id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let has_active_operation = connection
            .query_row(
                "SELECT 1 FROM harness_operations
                 WHERE thread_id = ?1
                   AND state IN ('compiling', 'running', 'awaiting_approval', 'compacting', 'persisting')
                 LIMIT 1",
                [thread_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(database_error)?
            .is_some();
        if has_active_operation {
            return Err("Cannot delete a thread while its harness operation is active".to_owned());
        }
        let exists = connection
            .query_row("SELECT 1 FROM threads WHERE id = ?1", [thread_id], |_| {
                Ok(())
            })
            .optional()
            .map_err(database_error)?
            .is_some();
        if exists {
            connection
                .execute("DELETE FROM goals WHERE thread_id = ?1", [thread_id])
                .map_err(database_error)?;
            connection
                .execute("DELETE FROM threads WHERE id = ?1", [thread_id])
                .map_err(database_error)?;
        }
        Ok(exists)
    }

    pub fn list_mcp_servers(&self) -> Result<Vec<McpServerConfig>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, enabled, transport, command, args_json, url,
                        environment_json, headers_json, secret_environment_keys_json,
                        secret_header_keys_json
                 FROM mcp_servers ORDER BY name COLLATE NOCASE, id",
            )
            .map_err(database_error)?;
        statement
            .query_map([], mcp_server_from_row)
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn get_mcp_server(&self, server_id: &str) -> Result<Option<McpServerConfig>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .query_row(
                "SELECT id, name, enabled, transport, command, args_json, url,
                        environment_json, headers_json, secret_environment_keys_json,
                        secret_header_keys_json
                 FROM mcp_servers WHERE id = ?1",
                [server_id],
                mcp_server_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    pub fn save_mcp_server(&self, server: &McpServerConfig) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "INSERT INTO mcp_servers
                 (id, name, enabled, transport, command, args_json, url, environment_json,
                  headers_json, secret_environment_keys_json, secret_header_keys_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                         CAST(strftime('%s', 'now') AS INTEGER) * 1000)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    enabled = excluded.enabled,
                    transport = excluded.transport,
                    command = excluded.command,
                    args_json = excluded.args_json,
                    url = excluded.url,
                    environment_json = excluded.environment_json,
                    headers_json = excluded.headers_json,
                    secret_environment_keys_json = excluded.secret_environment_keys_json,
                    secret_header_keys_json = excluded.secret_header_keys_json,
                    updated_at = excluded.updated_at",
                params![
                    server.id,
                    server.name,
                    i64::from(server.enabled),
                    match server.transport {
                        McpTransport::Stdio => "stdio",
                        McpTransport::StreamableHttp => "streamable_http",
                    },
                    server.command,
                    serialize_json(&server.args)?,
                    server.url,
                    serialize_json(&server.environment)?,
                    serialize_json(&server.headers)?,
                    serialize_json(&server.secret_environment_keys)?,
                    serialize_json(&server.secret_header_keys)?,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn delete_mcp_server(&self, server_id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute("DELETE FROM mcp_servers WHERE id = ?1", [server_id])
            .map(|count| count > 0)
            .map_err(database_error)
    }

    pub fn skill_preferences(
        &self,
    ) -> Result<std::collections::HashMap<(String, String), bool>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare("SELECT id, path, enabled FROM skill_preferences")
            .map_err(database_error)?;
        statement
            .query_map([], |row| {
                Ok(((row.get(0)?, row.get(1)?), row.get::<_, i64>(2)? != 0))
            })
            .map_err(database_error)?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()
            .map_err(database_error)
    }

    pub fn set_skill_enabled(&self, id: &str, path: &str, enabled: bool) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "INSERT INTO skill_preferences (id, path, enabled, updated_at)
                 VALUES (?1, ?2, ?3, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
                 ON CONFLICT(id, path) DO UPDATE SET
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at",
                params![id, path, i64::from(enabled)],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn create_goal(&self, request: &GoalCreateRequest) -> Result<GoalState, String> {
        let objective = request.objective.trim();
        if request.thread_id.trim().is_empty() || objective.is_empty() {
            return Err("Goal thread and objective are required".to_owned());
        }
        if objective.chars().count() > 20_000 {
            return Err("Goal objective is longer than 20,000 characters".to_owned());
        }
        if let Some(existing) = self.get_goal(&request.thread_id)?
            && !matches!(
                existing.status,
                GoalStatus::Completed | GoalStatus::Cancelled
            )
        {
            return Err("This task already has an unfinished Goal".to_owned());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let now = now_millis();
        let id = uuid::Uuid::new_v4().to_string();
        connection
            .execute(
                "DELETE FROM goals WHERE thread_id = ?1",
                [&request.thread_id],
            )
            .map_err(database_error)?;
        connection
            .execute(
                "INSERT INTO goals
                 (id, thread_id, objective, status, input_tokens, output_tokens,
                  turns, blocked_attempts, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'active', 0, 0, 0, 0, ?4, ?4)",
                params![id, request.thread_id, objective, now],
            )
            .map_err(database_error)?;
        drop(connection);
        self.get_goal(&request.thread_id)?
            .ok_or_else(|| "Could not read the newly created Goal".to_owned())
    }

    pub fn get_goal(&self, thread_id: &str) -> Result<Option<GoalState>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .query_row(
                "SELECT id, thread_id, objective, status, input_tokens,
                        output_tokens, turns, blocked_attempts, last_blocker, audit_note,
                        created_at, updated_at
                 FROM goals WHERE thread_id = ?1",
                [thread_id],
                goal_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    pub fn set_goal_status(&self, thread_id: &str, action: &str) -> Result<GoalState, String> {
        let current = self
            .get_goal(thread_id)?
            .ok_or_else(|| "This task has no Goal".to_owned())?;
        let next = match action {
            "pause" if matches!(current.status, GoalStatus::Active | GoalStatus::Auditing) => {
                "paused"
            }
            "resume" if matches!(current.status, GoalStatus::Paused | GoalStatus::Blocked) => {
                "active"
            }
            "cancel"
                if !matches!(
                    current.status,
                    GoalStatus::Completed | GoalStatus::Cancelled
                ) =>
            {
                "cancelled"
            }
            _ => return Err("Goal status transition is not allowed".to_owned()),
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "UPDATE goals SET status = ?2, blocked_attempts = CASE WHEN ?2 = 'active' THEN 0 ELSE blocked_attempts END,
                                  last_blocker = CASE WHEN ?2 = 'active' THEN NULL ELSE last_blocker END,
                                  updated_at = ?3 WHERE thread_id = ?1",
                params![thread_id, next, now_millis()],
            )
            .map_err(database_error)?;
        drop(connection);
        self.get_goal(thread_id)?
            .ok_or_else(|| "Goal disappeared".to_owned())
    }

    pub fn record_goal_usage(
        &self,
        thread_id: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<Option<GoalState>, String> {
        if self.get_goal(thread_id)?.is_none() {
            return Ok(None);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "UPDATE goals SET
                    input_tokens = MIN(9223372036854775807, input_tokens + ?2),
                    output_tokens = MIN(9223372036854775807, output_tokens + ?3),
                    turns = turns + 1,
                    updated_at = ?4
                 WHERE thread_id = ?1",
                params![
                    thread_id,
                    input_tokens.min(i64::MAX as u64) as i64,
                    output_tokens.min(i64::MAX as u64) as i64,
                    now_millis(),
                ],
            )
            .map_err(database_error)?;
        drop(connection);
        self.get_goal(thread_id)
    }

    pub fn save_media_asset(&self, asset: &MediaAsset) -> Result<(), String> {
        if asset.id.trim().is_empty()
            || asset.batch_id.trim().is_empty()
            || asset.provider_id.trim().is_empty()
            || asset.prompt.trim().is_empty()
            || asset.model.trim().is_empty()
        {
            return Err("Media asset metadata is incomplete".to_owned());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "INSERT INTO media_assets
                 (id, batch_id, thread_id, provider_id, provider_name, kind, status, prompt,
                  model, mime_type, file_name, remote_id, revised_prompt, error, progress,
                  size, quality, output_format, voice, seconds, created_at, updated_at,
                  background, generation_count)
                 VALUES
                 (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                  ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
                 ON CONFLICT(id) DO UPDATE SET
                   batch_id = excluded.batch_id,
                   thread_id = excluded.thread_id,
                   provider_id = excluded.provider_id,
                   provider_name = excluded.provider_name,
                   kind = excluded.kind,
                   status = excluded.status,
                   prompt = excluded.prompt,
                   model = excluded.model,
                   mime_type = excluded.mime_type,
                   file_name = excluded.file_name,
                   remote_id = excluded.remote_id,
                   revised_prompt = excluded.revised_prompt,
                   error = excluded.error,
                   progress = excluded.progress,
                   size = excluded.size,
                   quality = excluded.quality,
                   output_format = excluded.output_format,
                   voice = excluded.voice,
                   seconds = excluded.seconds,
                   background = excluded.background,
                   generation_count = excluded.generation_count,
                   updated_at = excluded.updated_at",
                params![
                    asset.id,
                    asset.batch_id,
                    asset.thread_id,
                    asset.provider_id,
                    asset.provider_name,
                    media_kind_value(&asset.kind),
                    media_status_value(&asset.status),
                    asset.prompt,
                    asset.model,
                    asset.mime_type,
                    asset.file_name,
                    asset.remote_id,
                    asset.revised_prompt,
                    asset.error,
                    asset.progress.map(i64::from),
                    asset.size,
                    asset.quality,
                    asset.output_format,
                    asset.voice,
                    asset.seconds.map(i64::from),
                    asset.created_at,
                    asset.updated_at,
                    asset.background,
                    i64::from(asset.count),
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn list_media_assets(&self, limit: usize) -> Result<Vec<MediaAsset>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, batch_id, thread_id, provider_id, provider_name, kind, status,
                        prompt, model, mime_type, file_name, remote_id, revised_prompt, error,
                        progress, size, quality, output_format, voice, seconds, created_at, updated_at,
                        background, generation_count
                 FROM media_assets ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(database_error)?;
        statement
            .query_map([limit.clamp(1, 500) as i64], media_asset_from_row)
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn list_media_assets_page(
        &self,
        kind: &MediaKind,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<MediaAsset>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, batch_id, thread_id, provider_id, provider_name, kind, status,
                        prompt, model, mime_type, file_name, remote_id, revised_prompt, error,
                        progress, size, quality, output_format, voice, seconds, created_at, updated_at,
                        background, generation_count
                 FROM media_assets
                 WHERE kind = ?1
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?2 OFFSET ?3",
            )
            .map_err(database_error)?;
        statement
            .query_map(
                params![
                    media_kind_value(kind),
                    limit.clamp(1, 500) as i64,
                    i64::try_from(offset).unwrap_or(i64::MAX),
                ],
                media_asset_from_row,
            )
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn get_media_asset(&self, id: &str) -> Result<Option<MediaAsset>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .query_row(
                "SELECT id, batch_id, thread_id, provider_id, provider_name, kind, status,
                        prompt, model, mime_type, file_name, remote_id, revised_prompt, error,
                        progress, size, quality, output_format, voice, seconds, created_at, updated_at,
                        background, generation_count
                 FROM media_assets WHERE id = ?1",
                [id],
                media_asset_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    pub fn delete_media_asset(&self, id: &str) -> Result<Option<MediaAsset>, String> {
        let current = self.get_media_asset(id)?;
        if current.is_none() {
            return Ok(None);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute("DELETE FROM media_assets WHERE id = ?1", [id])
            .map_err(database_error)?;
        Ok(current)
    }

    pub fn list_writing_projects(&self) -> Result<Vec<WritingProjectRecord>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, title, project_type, payload_json, created_at, updated_at
                 FROM writing_projects ORDER BY updated_at DESC LIMIT 100",
            )
            .map_err(database_error)?;
        statement
            .query_map([], writing_project_from_row)
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn save_writing_project(&self, project: &WritingProjectRecord) -> Result<(), String> {
        validate_writing_project(project)?;
        let payload = serde_json::to_string(&project.payload)
            .map_err(|error| format!("Could not encode writing project: {error}"))?;
        if payload.len() > 16 * 1024 * 1024 {
            return Err("Writing project data may not exceed 16 MiB".to_owned());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "INSERT INTO writing_projects
                 (id, title, project_type, payload_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    project_type = excluded.project_type,
                    payload_json = excluded.payload_json,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at",
                params![
                    project.id,
                    project.title.trim(),
                    project.project_type,
                    payload,
                    project.created_at,
                    project.updated_at,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn delete_writing_project(&self, id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute("DELETE FROM writing_projects WHERE id = ?1", [id])
            .map(|changed| changed > 0)
            .map_err(database_error)
    }

    pub fn update_goal_from_agent(
        &self,
        thread_id: &str,
        requested_status: &str,
        evidence: &str,
    ) -> Result<GoalState, String> {
        let current = self
            .get_goal(thread_id)?
            .ok_or_else(|| "This task has no Goal".to_owned())?;
        if !matches!(current.status, GoalStatus::Active | GoalStatus::Auditing) {
            return Err("Goal is not active".to_owned());
        }
        let evidence = evidence.trim();
        if evidence.chars().count() < 20 {
            return Err(
                "Goal update requires concrete evidence of at least 20 characters".to_owned(),
            );
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let now = now_millis();
        match requested_status {
            "complete" if matches!(current.status, GoalStatus::Active) => {
                connection.execute(
                    "UPDATE goals SET status = 'auditing', audit_note = ?2, updated_at = ?3 WHERE thread_id = ?1",
                    params![thread_id, evidence, now],
                )
            }
            "complete" if matches!(current.status, GoalStatus::Auditing) => {
                if evidence.chars().count() < 40 {
                    return Err("Completion audit requires at least 40 characters of evidence".to_owned());
                }
                connection.execute(
                    "UPDATE goals SET status = 'completed', audit_note = ?2, updated_at = ?3 WHERE thread_id = ?1",
                    params![thread_id, evidence, now],
                )
            }
            "blocked" => {
                let same = current.last_blocker.as_deref() == Some(evidence);
                let attempts = if same { current.blocked_attempts.saturating_add(1) } else { 1 };
                let status = if attempts >= 3 { "blocked" } else { "active" };
                connection.execute(
                    "UPDATE goals SET status = ?2, blocked_attempts = ?3, last_blocker = ?4, updated_at = ?5 WHERE thread_id = ?1",
                    params![thread_id, status, attempts, evidence, now],
                )
            }
            _ => return Err("Agent may only request complete or blocked".to_owned()),
        }
        .map_err(database_error)?;
        drop(connection);
        self.get_goal(thread_id)?
            .ok_or_else(|| "Goal disappeared".to_owned())
    }

    pub fn list_provider_health(&self) -> Result<Vec<ProviderHealth>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT profile_id, consecutive_failures, last_error, last_success_at,
                        last_failure_at, cooldown_until, total_requests, total_failovers,
                        average_latency_ms
                 FROM provider_health ORDER BY profile_id",
            )
            .map_err(database_error)?;
        statement
            .query_map([], provider_health_from_row)
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn get_provider_health(&self, profile_id: &str) -> Result<ProviderHealth, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .query_row(
                "SELECT profile_id, consecutive_failures, last_error, last_success_at,
                        last_failure_at, cooldown_until, total_requests, total_failovers,
                        average_latency_ms FROM provider_health WHERE profile_id = ?1",
                [profile_id],
                provider_health_from_row,
            )
            .optional()
            .map(|value| value.unwrap_or_else(|| empty_provider_health(profile_id)))
            .map_err(database_error)
    }

    pub fn record_provider_success(
        &self,
        profile_id: &str,
        latency_ms: u64,
        was_failover: bool,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "INSERT INTO provider_health
                 (profile_id, consecutive_failures, last_success_at, total_requests,
                  total_failovers, average_latency_ms)
                 VALUES (?1, 0, ?2, 1, ?3, ?4)
                 ON CONFLICT(profile_id) DO UPDATE SET
                    consecutive_failures = 0,
                    last_error = NULL,
                    last_success_at = excluded.last_success_at,
                    cooldown_until = NULL,
                    total_requests = provider_health.total_requests + 1,
                    total_failovers = provider_health.total_failovers + excluded.total_failovers,
                    average_latency_ms = CASE
                      WHEN provider_health.average_latency_ms IS NULL THEN excluded.average_latency_ms
                      ELSE (provider_health.average_latency_ms * 3 + excluded.average_latency_ms) / 4 END",
                params![
                    profile_id,
                    now_millis(),
                    i64::from(was_failover),
                    latency_ms.min(i64::MAX as u64) as i64,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn record_provider_failure(&self, profile_id: &str, error: &str) -> Result<(), String> {
        let current = self.get_provider_health(profile_id)?;
        let failures = current.consecutive_failures.saturating_add(1).min(16);
        let cooldown_seconds =
            (30_u64.saturating_mul(1_u64 << failures.saturating_sub(1))).min(900);
        let now = now_millis();
        let cooldown_until = now.saturating_add((cooldown_seconds * 1_000) as i64);
        let sanitized: String = error.chars().take(1_000).collect();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "INSERT INTO provider_health
                 (profile_id, consecutive_failures, last_error, last_failure_at,
                  cooldown_until, total_requests, total_failovers)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, 0)
                 ON CONFLICT(profile_id) DO UPDATE SET
                    consecutive_failures = excluded.consecutive_failures,
                    last_error = excluded.last_error,
                    last_failure_at = excluded.last_failure_at,
                    cooldown_until = excluded.cooldown_until,
                    total_requests = provider_health.total_requests + 1",
                params![profile_id, failures, sanitized, now, cooldown_until],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn reset_provider_health(&self, profile_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "DELETE FROM provider_health WHERE profile_id = ?1",
                [profile_id],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn custom_instructions(&self) -> Result<String, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'custom_instructions'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.unwrap_or_default())
            .map_err(database_error)
    }

    pub fn set_custom_instructions(&self, content: &str) -> Result<(), String> {
        if content.chars().count() > 32_000 {
            return Err("Custom instructions may contain at most 32,000 characters".to_owned());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "INSERT INTO app_settings (key, value, updated_at)
                 VALUES ('custom_instructions', ?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![content.trim(), now_millis()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn provider_settings(&self) -> Result<Option<ProviderSettings>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let value = connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'provider_settings'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|error| format!("Stored provider settings are invalid: {error}"))
            })
            .transpose()
    }

    pub fn set_provider_settings(&self, settings: &ProviderSettings) -> Result<(), String> {
        let value = serde_json::to_string(settings)
            .map_err(|error| format!("Could not encode provider settings: {error}"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "INSERT INTO app_settings (key, value, updated_at)
                 VALUES ('provider_settings', ?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![value, now_millis()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn start_harness_operation(
        &self,
        request: &HarnessDraftRequest,
        workspace: &str,
        profile_id: &str,
    ) -> Result<HarnessSubmission, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let thread_exists = transaction
            .query_row(
                "SELECT 1 FROM threads WHERE id = ?1",
                [&request.thread_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(database_error)?
            .is_some();
        if !thread_exists {
            return Err("Cannot start harness operation for an unknown thread".to_owned());
        }

        let active_operation_id = transaction
            .query_row(
                "SELECT id FROM harness_operations
                 WHERE thread_id = ?1
                   AND state IN ('compiling', 'running', 'awaiting_approval', 'compacting', 'persisting')
                 ORDER BY updated_at DESC LIMIT 1",
                [&request.thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?;
        if let Some(operation_id) = active_operation_id {
            if !request.attachment_ids.is_empty() {
                return Err("The active harness queue accepts text messages only".to_owned());
            }
            let body = request.raw_user_input.trim();
            if body.is_empty() {
                return Err("Cannot queue an empty harness message".to_owned());
            }
            let queued = HarnessQueueItem {
                id: uuid::Uuid::new_v4().to_string(),
                operation_id,
                kind: "follow_up".to_owned(),
                body: body.to_owned(),
                status: "pending".to_owned(),
            };
            transaction
                .execute(
                    "INSERT INTO harness_queues (id, operation_id, kind, body, status, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
                    params![
                        &queued.id,
                        &queued.operation_id,
                        &queued.kind,
                        &queued.body,
                        now_millis(),
                    ],
                )
                .map_err(database_error)?;
            transaction.commit().map_err(database_error)?;
            return Ok(HarnessSubmission::Queued(queued));
        }

        let draft_id = uuid::Uuid::new_v4().to_string();
        let operation_id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let mode = serde_json::to_string(&request.mode)
            .map_err(|error| format!("Could not encode harness mode: {error}"))?
            .trim_matches('"')
            .to_owned();
        let permission_level = serde_json::to_string(&request.permission_level)
            .map_err(|error| format!("Could not encode harness permission: {error}"))?
            .trim_matches('"')
            .to_owned();
        let attachment_ids_json = serde_json::to_string(&request.attachment_ids)
            .map_err(|error| format!("Could not encode harness attachments: {error}"))?;
        transaction
            .execute(
                "INSERT INTO harness_drafts
                 (id, thread_id, raw_user_input, attachment_ids_json, mode, permission_level, status, created_at, promoted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'promoted', ?7, ?7)",
                rusqlite::params![
                    &draft_id,
                    &request.thread_id,
                    &request.raw_user_input,
                    &attachment_ids_json,
                    &mode,
                    &permission_level,
                    now,
                ],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO harness_operations
                 (id, thread_id, draft_id, state, mode, permission_level, last_event_sequence, started_at, updated_at)
                 VALUES (?1, ?2, ?3, 'compiling', ?4, ?5, 1, ?6, ?6)",
                rusqlite::params![
                    &operation_id,
                    &request.thread_id,
                    &draft_id,
                    &mode,
                    &permission_level,
                    now,
                ],
            )
            .map_err(database_error)?;
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let snapshot_json = serde_json::json!({
            "draftId": &draft_id,
            "profileId": profile_id,
            "workspace": workspace,
            "mode": &mode,
            "permissionLevel": &permission_level,
            "hatch": request.hatch,
            "hatchRunDir": request.hatch_run_dir,
        });
        let snapshot_json = serde_json::to_string(&snapshot_json)
            .map_err(|error| format!("Could not encode harness snapshot: {error}"))?;
        transaction
            .execute(
                "INSERT INTO harness_snapshots
                 (id, operation_id, version, snapshot_json, snapshot_hash, created_at)
                 VALUES (?1, ?2, 1, ?3, ?4, ?5)",
                rusqlite::params![
                    &snapshot_id,
                    &operation_id,
                    &snapshot_json,
                    harness_hash(&snapshot_json),
                    now,
                ],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "UPDATE harness_operations SET current_snapshot_id = ?1 WHERE id = ?2",
                rusqlite::params![&snapshot_id, &operation_id],
            )
            .map_err(database_error)?;
        let payload = serde_json::json!({
            "draftId": &draft_id,
            "profileId": profile_id,
            "workspace": workspace,
            "hatch": request.hatch,
            "hatchRunDir": request.hatch_run_dir,
        });
        transaction
            .execute(
                "INSERT INTO harness_events
                 (id, operation_id, sequence, schema_version, kind, payload_json, created_at)
                 VALUES (?1, ?2, 1, ?3, 'operation_started', ?4, ?5)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    &operation_id,
                    crate::harness::types::HARNESS_SCHEMA_VERSION,
                    serde_json::to_string(&payload)
                        .map_err(|error| format!("Could not encode harness event: {error}"))?,
                    now,
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(HarnessSubmission::Started(HarnessOperationStarted {
            operation_id,
            draft_id,
            state: RuntimeState::Compiling,
            event_sequence: 1,
        }))
    }

    pub fn update_harness_operation_state(
        &self,
        operation_id: &str,
        state: &RuntimeState,
    ) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let current = transaction
            .query_row(
                "SELECT state, last_event_sequence FROM harness_operations WHERE id = ?1",
                [operation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(database_error)?;
        let Some((current_state, sequence)) = current else {
            return Err("Unknown harness operation".to_owned());
        };
        if matches!(current_state.as_str(), "completed" | "failed" | "cancelled") {
            transaction.commit().map_err(database_error)?;
            return Ok(());
        }
        let next_state = serde_json::to_string(state)
            .map_err(|error| format!("Could not encode harness state: {error}"))?
            .trim_matches('"')
            .to_owned();
        let next_sequence = sequence.saturating_add(1);
        let now = now_millis();
        let ended_at = if matches!(
            state,
            RuntimeState::Completed
                | RuntimeState::Failed
                | RuntimeState::Cancelled
                | RuntimeState::Interrupted
        ) {
            Some(now)
        } else {
            None
        };
        transaction
            .execute(
                "UPDATE harness_operations
                 SET state = ?1, last_event_sequence = ?2, updated_at = ?3, ended_at = COALESCE(?4, ended_at)
                 WHERE id = ?5",
                rusqlite::params![next_state, next_sequence, now, ended_at, operation_id],
            )
            .map_err(database_error)?;
        let kind = format!("operation_{next_state}");
        transaction
            .execute(
                "INSERT INTO harness_events
                 (id, operation_id, sequence, schema_version, kind, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    operation_id,
                    next_sequence,
                    crate::harness::types::HARNESS_SCHEMA_VERSION,
                    kind,
                    now,
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn harness_operation_hatch(&self, operation_id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let snapshot_json = connection
            .query_row(
                "SELECT s.snapshot_json
                 FROM harness_operations o
                 JOIN harness_snapshots s ON s.id = o.current_snapshot_id
                 WHERE o.id = ?1",
                [operation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "Harness operation has no current snapshot".to_owned())?;
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json)
            .map_err(|error| format!("Stored harness snapshot is invalid: {error}"))?;
        Ok(snapshot
            .get("hatch")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false))
    }

    pub fn harness_operation_hatch_run_dir(
        &self,
        operation_id: &str,
    ) -> Result<Option<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let snapshot_json = connection
            .query_row(
                "SELECT s.snapshot_json
                 FROM harness_operations o
                 JOIN harness_snapshots s ON s.id = o.current_snapshot_id
                 WHERE o.id = ?1",
                [operation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "Harness operation has no current snapshot".to_owned())?;
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json)
            .map_err(|error| format!("Stored harness snapshot is invalid: {error}"))?;
        Ok(snapshot
            .get("hatchRunDir")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned))
    }

    pub fn latest_harness_hatch_run_dir_for_thread(
        &self,
        thread_id: &str,
    ) -> Result<Option<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT s.snapshot_json
                 FROM harness_operations o
                 JOIN harness_snapshots s ON s.id = o.current_snapshot_id
                 WHERE o.thread_id = ?1
                 ORDER BY o.updated_at DESC",
            )
            .map_err(database_error)?;
        let snapshots = statement
            .query_map([thread_id], |row| row.get::<_, String>(0))
            .map_err(database_error)?;
        for snapshot_json in snapshots {
            let snapshot_json = snapshot_json.map_err(database_error)?;
            let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json)
                .map_err(|error| format!("Stored harness snapshot is invalid: {error}"))?;
            if !snapshot
                .get("hatch")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            if let Some(run_dir) = snapshot
                .get("hatchRunDir")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Ok(Some(run_dir.to_owned()));
            }
        }
        Ok(None)
    }

    pub fn append_harness_event(
        &self,
        operation_id: &str,
        kind: &str,
        payload: &serde_json::Value,
    ) -> Result<u64, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let sequence: i64 = transaction
            .query_row(
                "SELECT last_event_sequence FROM harness_operations WHERE id = ?1",
                [operation_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let next = sequence.saturating_add(1);
        transaction
            .execute(
                "UPDATE harness_operations SET last_event_sequence = ?1, updated_at = ?2 WHERE id = ?3",
                params![next, now_millis(), operation_id],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO harness_events
                 (id, operation_id, sequence, schema_version, kind, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    operation_id,
                    next,
                    crate::harness::types::HARNESS_SCHEMA_VERSION,
                    kind,
                    payload.to_string(),
                    now_millis(),
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(next as u64)
    }

    pub fn start_harness_tool_execution(
        &self,
        operation_id: &str,
        call_id: &str,
        tool_name: &str,
        risk: &str,
        arguments: &serde_json::Value,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let now = now_millis();
        let snapshot_id = connection
            .query_row(
                "SELECT current_snapshot_id FROM harness_operations WHERE id = ?1",
                [operation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(database_error)?
            .flatten()
            .ok_or_else(|| "Harness operation has no current snapshot".to_owned())?;
        if let Some(status) = connection
            .query_row(
                "SELECT status FROM harness_tool_executions WHERE operation_id = ?1 AND call_id = ?2",
                params![operation_id, call_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            && matches!(status.as_str(), "succeeded" | "failed" | "cancelled" | "unknown")
        {
            return Err(format!(
                "Tool call '{call_id}' already has terminal status '{status}'; refusing replay"
            ));
        }
        connection
            .execute(
                "INSERT INTO harness_tool_executions
                 (id, operation_id, snapshot_id, call_id, tool_name, risk, arguments_hash, arguments_json, status, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running', ?9)
                 ON CONFLICT(operation_id, call_id) DO UPDATE SET
                   status = CASE WHEN harness_tool_executions.status IN ('succeeded', 'failed')
                                 THEN harness_tool_executions.status ELSE 'running' END,
                   started_at = CASE WHEN harness_tool_executions.status IN ('succeeded', 'failed')
                                     THEN harness_tool_executions.started_at ELSE excluded.started_at END,
                   finished_at = CASE WHEN harness_tool_executions.status IN ('succeeded', 'failed')
                                     THEN harness_tool_executions.finished_at ELSE NULL END",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    operation_id,
                    snapshot_id,
                    call_id,
                    tool_name,
                    risk,
                    harness_hash_value(arguments),
                    arguments.to_string(),
                    now,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn harness_recent_hatch_command_kinds(
        &self,
        operation_id: &str,
        exclude_call_id: &str,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT arguments_json
                 FROM harness_tool_executions
                 WHERE operation_id = ?1
                   AND tool_name = 'run_command'
                   AND call_id <> ?2
                 ORDER BY started_at DESC, rowid DESC LIMIT ?3",
            )
            .map_err(database_error)?;
        let arguments = statement
            .query_map(
                params![
                    operation_id,
                    exclude_call_id,
                    limit.min(i64::MAX as usize) as i64
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(database_error)?;
        let mut kinds = Vec::new();
        for arguments in arguments {
            let arguments = arguments.map_err(database_error)?;
            let value: serde_json::Value = serde_json::from_str(&arguments)
                .map_err(|error| format!("Stored harness tool arguments are invalid: {error}"))?;
            let Some(command) = value
                .get("command")
                .and_then(serde_json::Value::as_str)
                .map(str::to_ascii_lowercase)
            else {
                break;
            };
            let kind = if command.contains("pet_job_status.py") {
                "status"
            } else if command.contains("prepare_pet_run.py") {
                "prepare"
            } else {
                break;
            };
            kinds.push(kind.to_owned());
        }
        Ok(kinds)
    }

    pub fn harness_operation_has_hatch_source(
        &self,
        operation_id: &str,
        source: &str,
    ) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT result_json
                 FROM harness_tool_executions
                 WHERE operation_id = ?1
                   AND tool_name = 'generate_images'
                   AND status = 'succeeded'
                   AND result_json IS NOT NULL",
            )
            .map_err(database_error)?;
        let results = statement
            .query_map([operation_id], |row| row.get::<_, String>(0))
            .map_err(database_error)?;
        for result_json in results {
            let result_json = result_json.map_err(database_error)?;
            let result: serde_json::Value = serde_json::from_str(&result_json)
                .map_err(|error| format!("Stored harness tool result is invalid: {error}"))?;
            let Some(output) = result.get("output").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(output) else {
                continue;
            };
            if payload
                .get("hatchSourcePaths")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|paths| {
                    paths.iter().any(|candidate| {
                        candidate
                            .as_str()
                            .is_some_and(|candidate| paths_equal(candidate, source))
                    })
                })
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn harness_hatch_status_requires_action(&self, operation_id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let latest = connection
            .query_row(
                "SELECT tool_name, arguments_json, status
                 FROM harness_tool_executions
                 WHERE operation_id = ?1
                 ORDER BY started_at DESC, rowid DESC LIMIT 1",
                [operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        let Some((tool_name, arguments, status)) = latest else {
            return Ok(false);
        };
        if tool_name != "run_command" || status != "succeeded" {
            return Ok(false);
        }
        let arguments: serde_json::Value = serde_json::from_str(&arguments)
            .map_err(|error| format!("Stored harness tool arguments are invalid: {error}"))?;
        Ok(arguments
            .get("command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|command| command.to_ascii_lowercase().contains("pet_job_status.py")))
    }

    pub fn create_harness_approval(
        &self,
        operation_id: &str,
        call_id: &str,
        tool_name: &str,
        risk: &str,
        arguments: &serde_json::Value,
    ) -> Result<(String, String, String), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let snapshot_id = transaction
            .query_row(
                "SELECT current_snapshot_id FROM harness_operations WHERE id = ?1",
                [operation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(database_error)?
            .flatten()
            .ok_or_else(|| "Harness operation has no current snapshot".to_owned())?;
        if let Some((approval_id, token_hash, execution_id)) = transaction
            .query_row(
                "SELECT a.id, a.token_hash, t.id
                 FROM harness_approvals a
                 JOIN harness_tool_executions t ON t.id = a.tool_execution_id
                 WHERE a.operation_id = ?1 AND t.call_id = ?2 AND a.consumed_at IS NULL
                 ORDER BY a.created_at DESC LIMIT 1",
                params![operation_id, call_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?
        {
            return Err(format!(
                "An approval is already pending for call '{call_id}' ({approval_id}/{execution_id}); token hash {token_hash}"
            ));
        }
        let tool_execution_id = uuid::Uuid::new_v4().to_string();
        let approval_id = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        transaction
            .execute(
                "INSERT INTO harness_tool_executions
                 (id, operation_id, snapshot_id, call_id, tool_name, risk, arguments_hash, arguments_json, status, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'awaiting_approval', ?9)",
                params![
                    &tool_execution_id,
                    operation_id,
                    snapshot_id,
                    call_id,
                    tool_name,
                    risk,
                    harness_hash_value(arguments),
                    arguments.to_string(),
                    now,
                ],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO harness_approvals
                 (id, operation_id, snapshot_id, tool_execution_id, arguments_hash, decision, token_hash, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8)",
                params![
                    &approval_id,
                    operation_id,
                    snapshot_id,
                    &tool_execution_id,
                    harness_hash_value(arguments),
                    harness_hash(&token),
                    now,
                    now.saturating_add(15 * 60 * 1_000),
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok((approval_id, token, tool_execution_id))
    }

    pub fn resolve_harness_approval(
        &self,
        token: &str,
        approved: bool,
    ) -> Result<HarnessApprovalRecord, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let token_hash = harness_hash(token);
        let row = transaction
            .query_row(
                "SELECT a.id, a.operation_id, a.tool_execution_id, t.call_id, t.tool_name, t.arguments_json
                 FROM harness_approvals a
                 JOIN harness_tool_executions t ON t.id = a.tool_execution_id
                 WHERE a.token_hash = ?1 AND a.consumed_at IS NULL AND a.expires_at >= ?2",
                params![token_hash, now_millis()],
                |row| {
                    let arguments: String = row.get(5)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        arguments,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "Approval token is invalid, expired, or already consumed".to_owned())?;
        let arguments = serde_json::from_str(&row.5)
            .map_err(|error| format!("Stored approval arguments are invalid: {error}"))?;
        let decision = if approved { "approved" } else { "denied" };
        transaction
            .execute(
                "UPDATE harness_approvals SET decision = ?1, consumed_at = ?2 WHERE id = ?3",
                params![decision, now_millis(), row.0],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "UPDATE harness_tool_executions
                 SET status = ?1, finished_at = CASE WHEN ?1 = 'denied' THEN ?2 ELSE NULL END
                 WHERE id = ?3",
                params![
                    if approved { "running" } else { "denied" },
                    now_millis(),
                    row.2
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(HarnessApprovalRecord {
            approval_id: row.0,
            operation_id: row.1,
            tool_execution_id: row.2,
            call_id: row.3,
            tool_name: row.4,
            arguments,
            approved,
        })
    }

    pub fn has_consumed_harness_approval(
        &self,
        operation_id: &str,
        call_id: &str,
    ) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1
                   FROM harness_approvals a
                   JOIN harness_tool_executions t ON t.id = a.tool_execution_id
                   WHERE a.operation_id = ?1
                     AND t.call_id = ?2
                     AND a.decision = 'approved'
                     AND a.consumed_at IS NOT NULL
                 )",
                params![operation_id, call_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(database_error)
    }

    pub fn harness_approval_operation(&self, token: &str) -> Result<Option<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .query_row(
                "SELECT operation_id FROM harness_approvals WHERE token_hash = ?1",
                [harness_hash(token)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)
    }

    pub fn list_harness_pending_approvals(&self) -> Result<Vec<HarnessPendingApproval>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT a.id, a.operation_id, o.thread_id, t.call_id, t.tool_name, t.arguments_json,
                        o.mode, o.permission_level, s.snapshot_json
                 FROM harness_approvals a
                 JOIN harness_operations o ON o.id = a.operation_id
                 JOIN harness_tool_executions t ON t.id = a.tool_execution_id
                 JOIN harness_snapshots s ON s.id = o.current_snapshot_id
                 WHERE a.decision = 'pending'
                   AND a.consumed_at IS NULL
                   AND a.expires_at > ?1
                   AND o.state = 'awaiting_approval'
                   AND t.status = 'awaiting_approval'
                 ORDER BY a.created_at",
            )
            .map_err(database_error)?;
        statement
            .query_map([now_millis()], |row| {
                let arguments: String = row.get(5)?;
                let mode: String = row.get(6)?;
                let permission_level: String = row.get(7)?;
                let snapshot_json: String = row.get(8)?;
                let snapshot = serde_json::from_str::<serde_json::Value>(&snapshot_json)
                    .unwrap_or(serde_json::Value::Null);
                Ok(HarnessPendingApproval {
                    approval_id: row.get(0)?,
                    operation_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    call_id: row.get(3)?,
                    tool_name: row.get(4)?,
                    arguments: serde_json::from_str(&arguments).unwrap_or(serde_json::Value::Null),
                    mode: HarnessMode::from_wire(&mode),
                    permission_level: PermissionLevel::from_wire(&permission_level),
                    requested_profile_id: snapshot
                        .get("profileId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                    hatch: snapshot
                        .get("hatch")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn reissue_harness_approval(&self, approval_id: &str) -> Result<String, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let token = uuid::Uuid::new_v4().to_string();
        let updated = connection
            .execute(
                "UPDATE harness_approvals
                 SET token_hash = ?1, expires_at = ?2
                 WHERE id = ?3 AND decision = 'pending' AND consumed_at IS NULL",
                params![
                    harness_hash(&token),
                    now_millis().saturating_add(15 * 60 * 1000),
                    approval_id
                ],
            )
            .map_err(database_error)?;
        if updated == 0 {
            return Err("Approval is no longer pending".to_owned());
        }
        Ok(token)
    }

    pub fn record_harness_context_manifest(
        &self,
        operation_id: &str,
        snapshot_id: &str,
        budget: &serde_json::Value,
        selection: &serde_json::Value,
        estimator_version: &str,
    ) -> Result<String, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let id = uuid::Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO harness_context_manifests
                 (id, operation_id, snapshot_id, budget_json, selection_json, estimator_version, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &id,
                    operation_id,
                    snapshot_id,
                    budget.to_string(),
                    selection.to_string(),
                    estimator_version,
                    now_millis(),
                ],
            )
            .map_err(database_error)?;
        Ok(id)
    }

    pub fn current_harness_snapshot(&self, operation_id: &str) -> Result<String, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .query_row(
                "SELECT current_snapshot_id FROM harness_operations WHERE id = ?1",
                [operation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(database_error)?
            .flatten()
            .ok_or_else(|| "Harness operation has no current snapshot".to_owned())
    }

    pub fn start_harness_provider_attempt(
        &self,
        operation_id: &str,
        snapshot_id: &str,
        context_manifest_id: &str,
        profile: &ProviderProfile,
        failover_index: u32,
    ) -> Result<String, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let id = uuid::Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO harness_provider_attempts
                 (id, operation_id, snapshot_id, context_manifest_id, profile_id, model, protocol, status, failover_index, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?9)",
                params![
                    &id,
                    operation_id,
                    snapshot_id,
                    context_manifest_id,
                    &profile.id,
                    &profile.model,
                    serde_json::to_string(&profile.protocol)
                        .map_err(|error| format!("Could not encode provider protocol: {error}"))?
                        .trim_matches('"')
                        .to_owned(),
                    failover_index,
                    now_millis(),
                ],
            )
            .map_err(database_error)?;
        Ok(id)
    }

    pub fn finish_harness_provider_attempt(
        &self,
        attempt_id: &str,
        response: Option<&crate::models::AgentTurnResponse>,
        error: Option<&str>,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let status = if error.is_some() {
            "failed"
        } else {
            "succeeded"
        };
        connection
            .execute(
                "UPDATE harness_provider_attempts
                 SET status = ?1, finished_at = ?2, input_tokens = ?3, output_tokens = ?4,
                     request_id = ?5, error_class = ?6
                 WHERE id = ?7",
                params![
                    status,
                    now_millis(),
                    response
                        .and_then(|value| value.input_tokens)
                        .map(|value| value as i64),
                    response
                        .and_then(|value| value.output_tokens)
                        .map(|value| value as i64),
                    response.and_then(|value| value.request_id.as_deref()),
                    error.map(|value| value.chars().take(300).collect::<String>()),
                    attempt_id,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn recover_harness_operations(&self) -> Result<HarnessRecoverySummary, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let now = now_millis();
        let transaction = connection.transaction().map_err(database_error)?;
        let unknown_tool_executions = transaction
            .execute(
                "UPDATE harness_tool_executions SET status = 'unknown' WHERE status = 'running'",
                [],
            )
            .map_err(database_error)?;
        let failed_provider_attempts = transaction
            .execute(
                "UPDATE harness_provider_attempts
                 SET status = 'failed', finished_at = ?1,
                     error_class = 'Application restarted during provider request'
                 WHERE status = 'running'",
                [now],
            )
            .map_err(database_error)?;
        let cancelled_queue_items = transaction
            .execute(
                "UPDATE harness_queues
                 SET status = 'cancelled'
                 WHERE status = 'pending'
                   AND operation_id IN (
                     SELECT id FROM harness_operations
                     WHERE state IN ('compiling', 'running', 'compacting', 'persisting')
                   )",
                [],
            )
            .map_err(database_error)?;
        let interrupted_operations = transaction
            .execute(
                "UPDATE harness_operations
                 SET state = 'interrupted', updated_at = ?1, ended_at = ?1
                 WHERE state IN ('compiling', 'running', 'compacting', 'persisting')",
                [now],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(HarnessRecoverySummary {
            interrupted_operations,
            unknown_tool_executions,
            failed_provider_attempts,
            cancelled_queue_items,
        })
    }

    pub fn list_harness_recovery_items(&self) -> Result<Vec<HarnessRecoveryItem>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT operation_id, id, call_id, tool_name, status, started_at
                 FROM harness_tool_executions
                 WHERE status = 'unknown' OR status = 'awaiting_approval'
                 ORDER BY started_at DESC",
            )
            .map_err(database_error)?;
        statement
            .query_map([], |row| {
                Ok(HarnessRecoveryItem {
                    operation_id: row.get(0)?,
                    tool_execution_id: row.get(1)?,
                    call_id: row.get(2)?,
                    tool_name: row.get(3)?,
                    status: row.get(4)?,
                    started_at: row.get(5)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn resolve_unknown_harness_tool(
        &self,
        tool_execution_id: &str,
        decision: &str,
    ) -> Result<(), String> {
        let status = match decision {
            "mark_completed" => "succeeded",
            "mark_not_executed" => "failed",
            "cancel" => "cancelled",
            _ => return Err("Unknown recovery decision".to_owned()),
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "UPDATE harness_tool_executions SET status = ?1, finished_at = ?2 WHERE id = ?3 AND status = 'unknown'",
                params![status, now_millis(), tool_execution_id],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn enqueue_harness_item(
        &self,
        request: &HarnessQueueRequest,
    ) -> Result<HarnessQueueItem, String> {
        if !matches!(request.kind.as_str(), "steer" | "follow_up" | "next_turn") {
            return Err("Unknown harness queue kind".to_owned());
        }
        if request.body.trim().is_empty() {
            return Err("Cannot queue an empty harness message".to_owned());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let operation_is_active = connection
            .query_row(
                "SELECT 1 FROM harness_operations
                 WHERE id = ?1
                   AND state IN ('compiling', 'running', 'awaiting_approval', 'compacting', 'persisting')",
                [&request.operation_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(database_error)?
            .is_some();
        if !operation_is_active {
            return Err("Harness operation is no longer active".to_owned());
        }
        let id = uuid::Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO harness_queues (id, operation_id, kind, body, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
                params![
                    &id,
                    &request.operation_id,
                    &request.kind,
                    &request.body,
                    now_millis()
                ],
            )
            .map_err(database_error)?;
        Ok(HarnessQueueItem {
            id,
            operation_id: request.operation_id.clone(),
            kind: request.kind.clone(),
            body: request.body.clone(),
            status: "pending".to_owned(),
        })
    }

    pub fn list_harness_queue(&self, operation_id: &str) -> Result<Vec<HarnessQueueItem>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, operation_id, kind, body, status FROM harness_queues
                 WHERE operation_id = ?1 AND status = 'pending' ORDER BY created_at",
            )
            .map_err(database_error)?;
        statement
            .query_map([operation_id], |row| {
                Ok(HarnessQueueItem {
                    id: row.get(0)?,
                    operation_id: row.get(1)?,
                    kind: row.get(2)?,
                    body: row.get(3)?,
                    status: row.get(4)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn consume_harness_queue(
        &self,
        queue_id: &str,
    ) -> Result<Option<HarnessQueueItem>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let item = connection
            .query_row(
                "SELECT id, operation_id, kind, body, status FROM harness_queues
                 WHERE id = ?1 AND status = 'pending'",
                [queue_id],
                |row| {
                    Ok(HarnessQueueItem {
                        id: row.get(0)?,
                        operation_id: row.get(1)?,
                        kind: row.get(2)?,
                        body: row.get(3)?,
                        status: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(database_error)?;
        if item.is_some() {
            connection
                .execute(
                    "UPDATE harness_queues SET status = 'injected', injected_at = ?1 WHERE id = ?2",
                    params![now_millis(), queue_id],
                )
                .map_err(database_error)?;
        }
        Ok(item)
    }

    pub fn cancel_harness_queue(&self, queue_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        connection
            .execute(
                "UPDATE harness_queues SET status = 'cancelled', injected_at = ?1
                 WHERE id = ?2 AND status = 'pending'",
                params![now_millis(), queue_id],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn promote_harness_queue_to_steer(
        &self,
        operation_id: &str,
        queue_id: &str,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let updated = connection
            .execute(
                "UPDATE harness_queues SET kind = 'steer'
                 WHERE id = ?1 AND operation_id = ?2 AND status = 'pending'",
                params![queue_id, operation_id],
            )
            .map_err(database_error)?;
        if updated == 0 {
            return Err("Queue item is no longer pending for this operation".to_owned());
        }
        Ok(())
    }

    pub fn create_harness_session_node(
        &self,
        request: &HarnessSessionNodeRequest,
    ) -> Result<HarnessSessionNode, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let id = uuid::Uuid::new_v4().to_string();
        let position: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM harness_session_nodes WHERE thread_id = ?1 AND branch_id = ?2",
                params![&request.thread_id, &request.branch_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        connection
            .execute(
                "INSERT INTO harness_session_nodes
                 (id, thread_id, parent_id, branch_id, kind, message_id, operation_id, position, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    &id,
                    &request.thread_id,
                    &request.parent_id,
                    &request.branch_id,
                    &request.kind,
                    &request.message_id,
                    &request.operation_id,
                    position,
                    now_millis(),
                ],
            )
            .map_err(database_error)?;
        Ok(HarnessSessionNode {
            id,
            thread_id: request.thread_id.clone(),
            parent_id: request.parent_id.clone(),
            branch_id: request.branch_id.clone(),
            kind: request.kind.clone(),
            message_id: request.message_id.clone(),
            operation_id: request.operation_id.clone(),
            position,
        })
    }

    pub fn list_harness_session_nodes(
        &self,
        thread_id: &str,
    ) -> Result<Vec<HarnessSessionNode>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, thread_id, parent_id, branch_id, kind, message_id, operation_id, position
                 FROM harness_session_nodes WHERE thread_id = ?1 ORDER BY position",
            )
            .map_err(database_error)?;
        statement
            .query_map([thread_id], |row| {
                Ok(HarnessSessionNode {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    parent_id: row.get(2)?,
                    branch_id: row.get(3)?,
                    kind: row.get(4)?,
                    message_id: row.get(5)?,
                    operation_id: row.get(6)?,
                    position: row.get(7)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn finish_harness_tool_execution(
        &self,
        operation_id: &str,
        call_id: &str,
        response: &crate::models::ToolExecutionResponse,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let status = if response.is_error {
            "failed"
        } else {
            "succeeded"
        };
        let output = response.output.chars().take(20_000).collect::<String>();
        let result_json = serde_json::json!({
            "output": output,
            "isError": response.is_error,
        });
        connection
            .execute(
                "UPDATE harness_tool_executions
                 SET status = ?1, result_json = ?2, finished_at = ?3
                 WHERE operation_id = ?4 AND call_id = ?5",
                params![
                    status,
                    serde_json::to_string(&result_json)
                        .map_err(|error| format!("Could not encode tool result: {error}"))?,
                    now_millis(),
                    operation_id,
                    call_id,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn record_provider_request(&self, log: &ProviderRequestLog) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let error = log
            .error
            .as_ref()
            .map(|value| value.chars().take(1_000).collect::<String>());
        connection
            .execute(
                "INSERT INTO provider_requests
                 (id, thread_id, profile_id, model, protocol, started_at, latency_ms, status,
                  input_tokens, output_tokens, request_id, failover_index, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    log.id,
                    log.thread_id,
                    log.profile_id,
                    log.model,
                    log.protocol,
                    log.started_at,
                    log.latency_ms.min(i64::MAX as u64) as i64,
                    log.status,
                    log.input_tokens
                        .map(|value| value.min(i64::MAX as u64) as i64),
                    log.output_tokens
                        .map(|value| value.min(i64::MAX as u64) as i64),
                    log.request_id,
                    i64::from(log.failover_index),
                    error,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn list_provider_requests(&self, limit: usize) -> Result<Vec<ProviderRequestLog>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, thread_id, profile_id, model, protocol, started_at, latency_ms,
                        status, input_tokens, output_tokens, request_id, failover_index, error
                 FROM provider_requests ORDER BY started_at DESC LIMIT ?1",
            )
            .map_err(database_error)?;
        statement
            .query_map([limit.clamp(1, 500) as i64], |row| {
                Ok(ProviderRequestLog {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    profile_id: row.get(2)?,
                    model: row.get(3)?,
                    protocol: row.get(4)?,
                    started_at: row.get(5)?,
                    latency_ms: row.get::<_, i64>(6)?.max(0) as u64,
                    status: row.get(7)?,
                    input_tokens: row
                        .get::<_, Option<i64>>(8)?
                        .map(|value| value.max(0) as u64),
                    output_tokens: row
                        .get::<_, Option<i64>>(9)?
                        .map(|value| value.max(0) as u64),
                    request_id: row.get(10)?,
                    failover_index: row.get::<_, i64>(11)?.clamp(0, u32::MAX as i64) as u32,
                    error: row.get(12)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }
}

fn provider_health_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderHealth> {
    Ok(ProviderHealth {
        profile_id: row.get(0)?,
        consecutive_failures: row.get::<_, i64>(1)?.clamp(0, u32::MAX as i64) as u32,
        last_error: row.get(2)?,
        last_success_at: row.get(3)?,
        last_failure_at: row.get(4)?,
        cooldown_until: row.get(5)?,
        total_requests: row.get::<_, i64>(6)?.max(0) as u64,
        total_failovers: row.get::<_, i64>(7)?.max(0) as u64,
        average_latency_ms: row
            .get::<_, Option<i64>>(8)?
            .map(|value| value.max(0) as u64),
    })
}

fn empty_provider_health(profile_id: &str) -> ProviderHealth {
    ProviderHealth {
        profile_id: profile_id.to_owned(),
        consecutive_failures: 0,
        last_error: None,
        last_success_at: None,
        last_failure_at: None,
        cooldown_until: None,
        total_requests: 0,
        total_failovers: 0,
        average_latency_ms: None,
    }
}

fn goal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GoalState> {
    let status: String = row.get(3)?;
    let status = match status.as_str() {
        "active" => GoalStatus::Active,
        "paused" => GoalStatus::Paused,
        "auditing" => GoalStatus::Auditing,
        "completed" => GoalStatus::Completed,
        "blocked" => GoalStatus::Blocked,
        "cancelled" => GoalStatus::Cancelled,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(GoalState {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        objective: row.get(2)?,
        status,
        input_tokens: row.get::<_, i64>(4)?.max(0) as u64,
        output_tokens: row.get::<_, i64>(5)?.max(0) as u64,
        turns: row.get::<_, i64>(6)?.max(0) as u64,
        blocked_attempts: row.get::<_, i64>(7)?.clamp(0, u32::MAX as i64) as u32,
        last_blocker: row.get(8)?,
        audit_note: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn media_kind_value(kind: &MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "image",
        MediaKind::Video => "video",
        MediaKind::Audio => "audio",
    }
}

fn media_status_value(status: &MediaStatus) -> &'static str {
    match status {
        MediaStatus::Queued => "queued",
        MediaStatus::InProgress => "in_progress",
        MediaStatus::Completed => "completed",
        MediaStatus::Failed => "failed",
    }
}

fn media_asset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaAsset> {
    let kind = match row.get::<_, String>(5)?.as_str() {
        "image" => MediaKind::Image,
        "video" => MediaKind::Video,
        "audio" => MediaKind::Audio,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let status = match row.get::<_, String>(6)?.as_str() {
        "queued" => MediaStatus::Queued,
        "in_progress" => MediaStatus::InProgress,
        "completed" => MediaStatus::Completed,
        "failed" => MediaStatus::Failed,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(MediaAsset {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        thread_id: row.get(2)?,
        provider_id: row.get(3)?,
        provider_name: row.get(4)?,
        kind,
        status,
        prompt: row.get(7)?,
        model: row.get(8)?,
        mime_type: row.get(9)?,
        file_name: row.get(10)?,
        file_path: None,
        remote_id: row.get(11)?,
        revised_prompt: row.get(12)?,
        error: row.get(13)?,
        progress: row
            .get::<_, Option<i64>>(14)?
            .map(|value| value.clamp(0, 100) as u32),
        size: row.get(15)?,
        quality: row.get(16)?,
        output_format: row.get(17)?,
        voice: row.get(18)?,
        seconds: row
            .get::<_, Option<i64>>(19)?
            .map(|value| value.clamp(0, u32::MAX as i64) as u32),
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
        background: row.get(22)?,
        count: row.get::<_, i64>(23)?.clamp(1, u32::MAX as i64) as u32,
    })
}

fn writing_project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WritingProjectRecord> {
    let payload: String = row.get(3)?;
    Ok(WritingProjectRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        project_type: row.get(2)?,
        payload: serde_json::from_str(&payload).map_err(json_column_error)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn validate_writing_project(project: &WritingProjectRecord) -> Result<(), String> {
    if project.id.is_empty()
        || project.id.len() > 128
        || !project
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(
            "Writing project ID must be 1-128 letters, numbers, dashes, or underscores".to_owned(),
        );
    }
    let title_length = project.title.trim().chars().count();
    if title_length == 0 || title_length > 200 {
        return Err("Writing project title must be 1-200 characters".to_owned());
    }
    if !matches!(
        project.project_type.as_str(),
        "novel" | "screenplay" | "game"
    ) {
        return Err("Writing project type must be novel, screenplay, or game".to_owned());
    }
    if project.created_at < 0 || project.updated_at < project.created_at {
        return Err("Writing project timestamps are invalid".to_owned());
    }
    if !project.payload.is_object() {
        return Err("Writing project payload must be a JSON object".to_owned());
    }
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn harness_hash(value: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn harness_hash_value(value: &serde_json::Value) -> String {
    harness_hash(&value.to_string())
}

fn mcp_server_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<McpServerConfig> {
    let transport: String = row.get(3)?;
    let parse = |index| -> rusqlite::Result<serde_json::Value> {
        let value: String = row.get(index)?;
        serde_json::from_str(&value).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    };
    Ok(McpServerConfig {
        id: row.get(0)?,
        name: row.get(1)?,
        enabled: row.get::<_, i64>(2)? != 0,
        transport: match transport.as_str() {
            "stdio" => McpTransport::Stdio,
            "streamable_http" => McpTransport::StreamableHttp,
            _ => {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    format!("Unsupported MCP transport: {transport}").into(),
                ));
            }
        },
        command: row.get(4)?,
        args: serde_json::from_value(parse(5)?).map_err(json_column_error)?,
        url: row.get(6)?,
        environment: serde_json::from_value(parse(7)?).map_err(json_column_error)?,
        headers: serde_json::from_value(parse(8)?).map_err(json_column_error)?,
        secret_environment_keys: serde_json::from_value(parse(9)?).map_err(json_column_error)?,
        secret_header_keys: serde_json::from_value(parse(10)?).map_err(json_column_error)?,
    })
}

fn json_column_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn serialize_json(value: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("Could not serialize MCP configuration: {error}"))
}

fn database_error(error: rusqlite::Error) -> String {
    let hint = match &error {
        rusqlite::Error::SqliteFailure(code, _)
            if matches!(
                code.code,
                ErrorCode::DiskFull | ErrorCode::SystemIoFailure | ErrorCode::ReadOnly
            ) =>
        {
            " Storage may be full or read-only; free disk space and verify the application data directory is writable before retrying."
        }
        _ => "",
    };
    format!("Conversation database error: {error}.{hint}")
}

fn storage_error(action: &str, error: impl std::fmt::Display) -> String {
    format!("{action}: {error}. Storage may be full or read-only; free disk space and retry.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_thread() -> StoredThread {
        StoredThread {
            id: "thread-1".to_owned(),
            title: "Inspect project".to_owned(),
            workspace: Some("C:/workspace".to_owned()),
            kind: Some("standard".to_owned()),
            pet_id: None,
            messages: vec![StoredMessage {
                id: "message-1".to_owned(),
                role: "assistant".to_owned(),
                content: "Reading README".to_owned(),
                tool_calls: vec![ToolCall {
                    id: "call-1".to_owned(),
                    name: "read_file".to_owned(),
                    arguments: serde_json::json!({ "path": "README.md" }),
                }],
                tool_call_id: None,
                created_at: 1_700_000_000_000,
                is_error: false,
                request_id: Some("request-1".to_owned()),
                internal: true,
                change_set: Some(serde_json::json!({
                    "operationId": "operation-1",
                    "workspace": "C:/workspace",
                    "status": "completed",
                    "startedAt": 1_699_999_999_000_i64,
                    "completedAt": 1_700_000_000_000_i64,
                    "files": [{ "path": "README.md", "kind": "modified" }],
                })),
                attachments: Vec::new(),
                model_name: Some("gpt-5.5".to_owned()),
                provider_brand: Some("openai".to_owned()),
                status: Some("reconnected".to_owned()),
            }],
            updated_at: 1_700_000_000_000,
            input_tokens: 120,
            output_tokens: 30,
        }
    }

    #[test]
    fn database_error_explains_storage_failures() {
        let error = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: ErrorCode::DiskFull,
                extended_code: 13,
            },
            Some("database or disk is full".to_owned()),
        );
        let message = database_error(error);
        assert!(message.contains("Storage may be full or read-only"));
        assert!(message.contains("free disk space"));
    }

    #[test]
    fn round_trips_threads_and_tool_calls() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let thread = sample_thread();
        database.save_thread(&thread).unwrap();
        assert_eq!(database.list_threads().unwrap(), vec![thread]);
    }

    #[test]
    fn starts_one_harness_operation_and_records_its_first_event() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.save_thread(&sample_thread()).unwrap();
        let request = crate::harness::types::HarnessDraftRequest {
            thread_id: "thread-1".to_owned(),
            raw_user_input: "continue".to_owned(),
            attachment_ids: Vec::new(),
            mode: crate::harness::types::HarnessMode::Agent,
            permission_level: crate::harness::types::PermissionLevel::Request,
            requested_profile_id: Some("test".to_owned()),
            workspace: Some("C:/workspace".to_owned()),
            hatch: false,
            hatch_run_dir: None,
        };
        let started = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();
        assert_eq!(
            started.state,
            crate::harness::types::RuntimeState::Compiling
        );
        assert_eq!(started.event_sequence, 1);
        let connection = database.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM harness_events WHERE operation_id = ?1",
                    [&started.operation_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        drop(connection);
        database
            .start_harness_tool_execution(
                &started.operation_id,
                "call-1",
                "read_file",
                "read_only",
                &serde_json::json!({ "path": "README.md" }),
            )
            .unwrap();
        database
            .finish_harness_tool_execution(
                &started.operation_id,
                "call-1",
                &crate::models::ToolExecutionResponse {
                    output: "ok".to_owned(),
                    is_error: false,
                },
            )
            .unwrap();
        let replay = database.start_harness_tool_execution(
            &started.operation_id,
            "call-1",
            "read_file",
            "read_only",
            &serde_json::json!({ "path": "README.md" }),
        );
        assert!(replay.unwrap_err().contains("refusing replay"));
        let connection = database.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM harness_tool_executions WHERE operation_id = ?1 AND call_id = 'call-1'",
                    [&started.operation_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "succeeded"
        );
        drop(connection);
        let queued = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_queued()
            .unwrap();
        assert_eq!(queued.operation_id, started.operation_id);
        assert_eq!(queued.kind, "follow_up");
        assert_eq!(queued.body, "continue");
        database
            .update_harness_operation_state(
                &started.operation_id,
                &crate::harness::types::RuntimeState::Completed,
            )
            .unwrap();
        let restarted = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();
        assert_ne!(restarted.operation_id, started.operation_id);
    }

    #[test]
    fn latest_hatch_run_directory_comes_from_a_durable_snapshot() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.save_thread(&sample_thread()).unwrap();
        let request = crate::harness::types::HarnessDraftRequest {
            thread_id: "thread-1".to_owned(),
            raw_user_input: "hatch".to_owned(),
            attachment_ids: Vec::new(),
            mode: crate::harness::types::HarnessMode::Goal,
            permission_level: crate::harness::types::PermissionLevel::Request,
            requested_profile_id: Some("test".to_owned()),
            workspace: Some("C:/workspace".to_owned()),
            hatch: true,
            hatch_run_dir: Some("C:/workspace/pet-hatch/noct".to_owned()),
        };
        let started = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();
        assert!(
            database
                .harness_operation_hatch(&started.operation_id)
                .unwrap()
        );
        assert_eq!(
            database
                .latest_harness_hatch_run_dir_for_thread("thread-1")
                .unwrap()
                .as_deref(),
            Some("C:/workspace/pet-hatch/noct")
        );
    }

    #[test]
    fn approval_token_is_persisted_and_consumed_once() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.save_thread(&sample_thread()).unwrap();
        let request = crate::harness::types::HarnessDraftRequest {
            thread_id: "thread-1".to_owned(),
            raw_user_input: "write".to_owned(),
            attachment_ids: Vec::new(),
            mode: crate::harness::types::HarnessMode::Agent,
            permission_level: crate::harness::types::PermissionLevel::Request,
            requested_profile_id: Some("test".to_owned()),
            workspace: Some("C:/workspace".to_owned()),
            hatch: false,
            hatch_run_dir: None,
        };
        let operation = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();
        let (approval_id, token, execution_id) = database
            .create_harness_approval(
                &operation.operation_id,
                "call-write",
                "write_file",
                "workspace_write",
                &serde_json::json!({ "path": "out.txt", "content": "ok" }),
            )
            .unwrap();
        assert!(!approval_id.is_empty());
        assert!(!execution_id.is_empty());
        let record = database.resolve_harness_approval(&token, true).unwrap();
        assert!(record.approved);
        assert!(
            database
                .has_consumed_harness_approval(&operation.operation_id, "call-write")
                .unwrap()
        );
        let replay = database.resolve_harness_approval(&token, true);
        assert!(replay.unwrap_err().contains("already consumed"));
    }

    #[test]
    fn restart_recovery_marks_running_unknown_but_keeps_approval_waiting() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.save_thread(&sample_thread()).unwrap();
        let request = crate::harness::types::HarnessDraftRequest {
            thread_id: "thread-1".to_owned(),
            raw_user_input: "continue".to_owned(),
            attachment_ids: Vec::new(),
            mode: crate::harness::types::HarnessMode::Agent,
            permission_level: crate::harness::types::PermissionLevel::Request,
            requested_profile_id: Some("test".to_owned()),
            workspace: Some("C:/workspace".to_owned()),
            hatch: false,
            hatch_run_dir: None,
        };
        let operation = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();
        database
            .start_harness_tool_execution(
                &operation.operation_id,
                "call-running",
                "write_file",
                "workspace_write",
                &serde_json::json!({ "path": "out.txt" }),
            )
            .unwrap();
        database
            .create_harness_approval(
                &operation.operation_id,
                "call-approval",
                "write_file",
                "workspace_write",
                &serde_json::json!({ "path": "approval.txt" }),
            )
            .unwrap();
        database
            .update_harness_operation_state(
                &operation.operation_id,
                &crate::harness::types::RuntimeState::AwaitingApproval,
            )
            .unwrap();
        let summary = database.recover_harness_operations().unwrap();
        assert_eq!(summary.interrupted_operations, 0);
        assert_eq!(summary.unknown_tool_executions, 1);
        assert_eq!(summary.failed_provider_attempts, 0);
        assert_eq!(summary.cancelled_queue_items, 0);
        let connection = database.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM harness_tool_executions WHERE call_id = 'call-running'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "unknown"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM harness_tool_executions WHERE call_id = 'call-approval'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "awaiting_approval"
        );
        drop(connection);
        assert_eq!(database.list_harness_pending_approvals().unwrap().len(), 1);
    }

    #[test]
    fn restart_recovery_allows_a_new_operation_after_interrupting_the_old_one() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.save_thread(&sample_thread()).unwrap();
        let request = crate::harness::types::HarnessDraftRequest {
            thread_id: "thread-1".to_owned(),
            raw_user_input: "continue".to_owned(),
            attachment_ids: Vec::new(),
            mode: crate::harness::types::HarnessMode::Agent,
            permission_level: crate::harness::types::PermissionLevel::Request,
            requested_profile_id: Some("test".to_owned()),
            workspace: Some("C:/workspace".to_owned()),
            hatch: false,
            hatch_run_dir: None,
        };
        let interrupted = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();
        let context_manifest_id = database
            .record_harness_context_manifest(
                &interrupted.operation_id,
                &database
                    .current_harness_snapshot(&interrupted.operation_id)
                    .unwrap(),
                &serde_json::json!({}),
                &serde_json::json!({}),
                "test",
            )
            .unwrap();
        let provider_attempt_id = database
            .start_harness_provider_attempt(
                &interrupted.operation_id,
                &database
                    .current_harness_snapshot(&interrupted.operation_id)
                    .unwrap(),
                &context_manifest_id,
                &crate::models::ProviderProfile {
                    id: "test".to_owned(),
                    name: "Test".to_owned(),
                    base_url: "https://example.test".to_owned(),
                    model: "test".to_owned(),
                    protocol: crate::models::ProviderProtocol::OpenaiResponses,
                    allow_unauthenticated: true,
                    priority: 0,
                    failover_enabled: false,
                },
                0,
            )
            .unwrap();
        let queued = database
            .enqueue_harness_item(&crate::harness::types::HarnessQueueRequest {
                operation_id: interrupted.operation_id.clone(),
                kind: "follow_up".to_owned(),
                body: "queued before restart".to_owned(),
            })
            .unwrap();

        let summary = database.recover_harness_operations().unwrap();
        assert_eq!(summary.interrupted_operations, 1);
        assert_eq!(summary.unknown_tool_executions, 0);
        assert_eq!(summary.failed_provider_attempts, 1);
        assert_eq!(summary.cancelled_queue_items, 1);

        let restarted = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();
        assert_ne!(restarted.operation_id, interrupted.operation_id);
        let connection = database.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT state FROM harness_operations WHERE id = ?1",
                    [&interrupted.operation_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "interrupted"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM harness_provider_attempts WHERE id = ?1",
                    [&provider_attempt_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "failed"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM harness_queues WHERE id = ?1",
                    [&queued.id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "cancelled"
        );
    }

    #[test]
    fn queue_and_session_fork_are_durable() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.save_thread(&sample_thread()).unwrap();
        let request = crate::harness::types::HarnessDraftRequest {
            thread_id: "thread-1".to_owned(),
            raw_user_input: "continue".to_owned(),
            attachment_ids: Vec::new(),
            mode: crate::harness::types::HarnessMode::Agent,
            permission_level: crate::harness::types::PermissionLevel::Request,
            requested_profile_id: Some("test".to_owned()),
            workspace: Some("C:/workspace".to_owned()),
            hatch: false,
            hatch_run_dir: None,
        };
        let operation = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();
        let queued = database
            .enqueue_harness_item(&crate::harness::types::HarnessQueueRequest {
                operation_id: operation.operation_id.clone(),
                kind: "steer".to_owned(),
                body: "use the smaller file".to_owned(),
            })
            .unwrap();
        assert_eq!(
            database
                .list_harness_queue(&operation.operation_id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            database
                .consume_harness_queue(&queued.id)
                .unwrap()
                .unwrap()
                .kind,
            "steer"
        );
        let node = database
            .create_harness_session_node(&crate::harness::types::HarnessSessionNodeRequest {
                thread_id: "thread-1".to_owned(),
                parent_id: None,
                branch_id: "main".to_owned(),
                kind: "root".to_owned(),
                message_id: None,
                operation_id: Some(operation.operation_id),
            })
            .unwrap();
        let fork = database
            .create_harness_session_node(&crate::harness::types::HarnessSessionNodeRequest {
                thread_id: "thread-1".to_owned(),
                parent_id: Some(node.id),
                branch_id: "branch-1".to_owned(),
                kind: "fork".to_owned(),
                message_id: None,
                operation_id: None,
            })
            .unwrap();
        assert_eq!(fork.kind, "fork");
    }

    #[test]
    fn replaces_message_order_transactionally() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut thread = sample_thread();
        database.save_thread(&thread).unwrap();
        thread.messages.insert(
            0,
            StoredMessage {
                id: "message-0".to_owned(),
                role: "user".to_owned(),
                content: "Start".to_owned(),
                tool_calls: Vec::new(),
                tool_call_id: None,
                created_at: 1_699_999_999_000,
                is_error: false,
                request_id: None,
                internal: false,
                change_set: None,
                attachments: Vec::new(),
                model_name: None,
                provider_brand: None,
                status: None,
            },
        );
        database.save_thread(&thread).unwrap();
        assert_eq!(
            database.list_threads().unwrap()[0].messages,
            thread.messages
        );
    }

    #[test]
    fn deleting_thread_cascades_messages() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.save_thread(&sample_thread()).unwrap();
        assert!(database.delete_thread("thread-1").unwrap());
        assert!(database.list_threads().unwrap().is_empty());
        assert!(!database.delete_thread("missing").unwrap());
    }

    #[test]
    fn deleting_thread_with_an_active_harness_operation_is_rejected() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.save_thread(&sample_thread()).unwrap();
        let request = crate::harness::types::HarnessDraftRequest {
            thread_id: "thread-1".to_owned(),
            raw_user_input: "continue".to_owned(),
            attachment_ids: Vec::new(),
            mode: crate::harness::types::HarnessMode::Agent,
            permission_level: crate::harness::types::PermissionLevel::Request,
            requested_profile_id: Some("test".to_owned()),
            workspace: Some("C:/workspace".to_owned()),
            hatch: false,
            hatch_run_dir: None,
        };
        let operation = database
            .start_harness_operation(&request, "C:/workspace", "test")
            .unwrap()
            .into_started()
            .unwrap();

        let error = database.delete_thread("thread-1").unwrap_err();

        assert!(error.contains("harness operation is active"));
        assert_eq!(database.list_threads().unwrap().len(), 1);
        database
            .update_harness_operation_state(&operation.operation_id, &RuntimeState::Completed)
            .unwrap();
        assert!(database.delete_thread("thread-1").unwrap());
    }

    #[test]
    fn migrates_v1_messages_to_current_schema() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT,
                    updated_at INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL
                 );
                 CREATE TABLE messages (
                    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
                    tool_calls_json TEXT NOT NULL, tool_call_id TEXT, created_at INTEGER NOT NULL,
                    is_error INTEGER NOT NULL, UNIQUE(thread_id, position)
                 );
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        let database = Database::from_connection(connection).unwrap();
        let connection = database.connection.lock().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let columns = connection
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut statement| {
                let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(columns.iter().any(|column| column == "request_id"));
        assert!(columns.iter().any(|column| column == "internal"));
        assert!(columns.iter().any(|column| column == "attachments_json"));
        assert!(columns.iter().any(|column| column == "model_name"));
        assert!(columns.iter().any(|column| column == "provider_brand"));
        assert!(columns.iter().any(|column| column == "status"));
        let thread_columns = connection
            .prepare("PRAGMA table_info(threads)")
            .and_then(|mut statement| {
                let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        assert!(thread_columns.iter().any(|column| column == "kind"));
        assert!(thread_columns.iter().any(|column| column == "pet_id"));
    }

    #[test]
    fn restores_legacy_model_name_from_provider_request_log() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut thread = sample_thread();
        thread.messages[0].model_name = None;
        thread.messages[0].provider_brand = None;
        database
            .record_provider_request(&ProviderRequestLog {
                id: "provider-log-1".to_owned(),
                thread_id: Some(thread.id.clone()),
                profile_id: "legacy-profile".to_owned(),
                model: "legacy-model".to_owned(),
                protocol: "openai_responses".to_owned(),
                started_at: 1_700_000_000_001,
                latency_ms: 42,
                status: "success".to_owned(),
                input_tokens: None,
                output_tokens: None,
                request_id: Some("request-1".to_owned()),
                failover_index: 0,
                error: None,
            })
            .unwrap();
        database.save_thread(&thread).unwrap();
        let restored = database.list_threads().unwrap();
        assert_eq!(
            restored[0].messages[0].model_name.as_deref(),
            Some("legacy-model")
        );
        assert_eq!(restored[0].messages[0].provider_brand, None);
    }

    #[test]
    fn provider_health_applies_cooldown_and_resets_after_success() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database
            .record_provider_failure("primary", "503 Service Unavailable")
            .unwrap();
        let first = database.get_provider_health("primary").unwrap();
        assert_eq!(first.consecutive_failures, 1);
        assert_eq!(first.total_requests, 1);
        assert!(first.cooldown_until.unwrap() > now_millis());

        database
            .record_provider_failure("primary", "429 Too Many Requests")
            .unwrap();
        let second = database.get_provider_health("primary").unwrap();
        assert_eq!(second.consecutive_failures, 2);
        assert!(second.cooldown_until.unwrap() > first.cooldown_until.unwrap());

        database
            .record_provider_success("primary", 120, true)
            .unwrap();
        let healthy = database.get_provider_health("primary").unwrap();
        assert_eq!(healthy.consecutive_failures, 0);
        assert_eq!(healthy.total_requests, 3);
        assert_eq!(healthy.total_failovers, 1);
        assert_eq!(healthy.average_latency_ms, Some(120));
        assert!(healthy.cooldown_until.is_none());

        database.reset_provider_health("primary").unwrap();
        assert_eq!(
            database
                .get_provider_health("primary")
                .unwrap()
                .total_requests,
            0
        );
    }

    #[test]
    fn custom_instructions_are_trimmed_persisted_and_bounded() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        assert_eq!(database.custom_instructions().unwrap(), "");
        database
            .set_custom_instructions("  Prefer evidence.  ")
            .unwrap();
        assert_eq!(database.custom_instructions().unwrap(), "Prefer evidence.");
        assert!(
            database
                .set_custom_instructions(&"x".repeat(32_001))
                .is_err()
        );
    }

    #[test]
    fn provider_settings_round_trip_without_credentials() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        assert!(database.provider_settings().unwrap().is_none());
        let settings = ProviderSettings {
            profiles: vec![crate::models::ProviderProfile {
                id: "levelup-api".to_owned(),
                name: "LevelUpAPI".to_owned(),
                base_url: "https://api.example.test/v1".to_owned(),
                model: "gpt-test".to_owned(),
                protocol: crate::models::ProviderProtocol::OpenaiResponses,
                allow_unauthenticated: false,
                priority: 10,
                failover_enabled: true,
            }],
            active_profile_id: "levelup-api".to_owned(),
        };
        database.set_provider_settings(&settings).unwrap();
        assert_eq!(database.provider_settings().unwrap(), Some(settings));
    }

    #[test]
    fn provider_request_logs_round_trip_without_request_content() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let log = ProviderRequestLog {
            id: "request-log-1".to_owned(),
            thread_id: Some("thread-1".to_owned()),
            profile_id: "levelup".to_owned(),
            model: "gpt-test".to_owned(),
            protocol: "openai_responses".to_owned(),
            started_at: 123,
            latency_ms: 456,
            status: "success".to_owned(),
            input_tokens: Some(10),
            output_tokens: Some(5),
            request_id: Some("gateway-id".to_owned()),
            failover_index: 1,
            error: None,
        };
        database.record_provider_request(&log).unwrap();
        let stored = database.list_provider_requests(20).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].model, "gpt-test");
        assert_eq!(stored[0].request_id.as_deref(), Some("gateway-id"));
        assert_eq!(stored[0].failover_index, 1);
    }

    #[test]
    fn round_trips_and_deletes_mcp_servers() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let server = McpServerConfig {
            id: "filesystem".to_owned(),
            name: "Filesystem".to_owned(),
            enabled: true,
            transport: McpTransport::Stdio,
            command: Some("npx".to_owned()),
            args: vec![
                "-y".to_owned(),
                "@modelcontextprotocol/server-filesystem".to_owned(),
            ],
            url: None,
            environment: [("LOG_LEVEL".to_owned(), "warn".to_owned())].into(),
            headers: Default::default(),
            secret_environment_keys: vec!["ACCESS_TOKEN".to_owned()],
            secret_header_keys: Vec::new(),
        };
        database.save_mcp_server(&server).unwrap();
        assert_eq!(
            database.get_mcp_server(&server.id).unwrap(),
            Some(server.clone())
        );
        assert_eq!(database.list_mcp_servers().unwrap(), vec![server]);
        assert!(database.delete_mcp_server("filesystem").unwrap());
        assert!(!database.delete_mcp_server("filesystem").unwrap());
    }

    #[test]
    fn persists_skill_enablement_without_skill_content() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database
            .set_skill_enabled("skill-one", "C:/skills/one/SKILL.md", true)
            .unwrap();
        let preferences = database.skill_preferences().unwrap();
        assert_eq!(
            preferences.get(&("skill-one".to_owned(), "C:/skills/one/SKILL.md".to_owned())),
            Some(&true)
        );
        database
            .set_skill_enabled("skill-one", "C:/skills/one/SKILL.md", false)
            .unwrap();
        assert_eq!(
            database
                .skill_preferences()
                .unwrap()
                .get(&("skill-one".to_owned(), "C:/skills/one/SKILL.md".to_owned())),
            Some(&false)
        );
    }

    fn goal_request() -> GoalCreateRequest {
        GoalCreateRequest {
            thread_id: "thread-goal".to_owned(),
            objective: "Implement and verify the requested feature.".to_owned(),
        }
    }

    #[test]
    fn legacy_goal_budget_column_is_ignored() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE goals (
                    id TEXT PRIMARY KEY NOT NULL,
                    thread_id TEXT NOT NULL UNIQUE,
                    objective TEXT NOT NULL,
                    status TEXT NOT NULL,
                    token_budget INTEGER,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    turns INTEGER NOT NULL DEFAULT 0,
                    blocked_attempts INTEGER NOT NULL DEFAULT 0,
                    last_blocker TEXT,
                    audit_note TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO goals
                    (id, thread_id, objective, status, token_budget, input_tokens,
                     output_tokens, turns, blocked_attempts, created_at, updated_at)
                 VALUES
                    ('legacy-goal', 'thread-goal', 'Finish the migration.', 'active',
                     1000, 800, 100, 1, 0, 1, 2);",
            )
            .unwrap();
        let database = Database::from_connection(connection).unwrap();
        let goal = database
            .record_goal_usage("thread-goal", 100, 100)
            .unwrap()
            .unwrap();
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.input_tokens, 900);
        assert_eq!(goal.output_tokens, 200);
        assert_eq!(goal.turns, 2);
    }

    #[test]
    fn goal_completion_requires_a_separate_audit() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let created = database.create_goal(&goal_request()).unwrap();
        assert_eq!(created.status, GoalStatus::Active);
        let auditing = database
            .update_goal_from_agent(
                "thread-goal",
                "complete",
                "Implementation and focused tests now pass.",
            )
            .unwrap();
        assert_eq!(auditing.status, GoalStatus::Auditing);
        let completed = database
            .update_goal_from_agent(
                "thread-goal",
                "complete",
                "Audited every stated requirement against source files and passing integration tests.",
            )
            .unwrap();
        assert_eq!(completed.status, GoalStatus::Completed);
    }

    #[test]
    fn goal_blocks_only_after_three_identical_reports() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.create_goal(&goal_request()).unwrap();
        let reason = "Required external service is unavailable after all safe retries.";
        for attempt in 1..=3 {
            let goal = database
                .update_goal_from_agent("thread-goal", "blocked", reason)
                .unwrap();
            assert_eq!(goal.blocked_attempts, attempt);
            assert_eq!(
                goal.status,
                if attempt == 3 {
                    GoalStatus::Blocked
                } else {
                    GoalStatus::Active
                }
            );
        }
    }

    #[test]
    fn goal_usage_is_recorded_without_pausing() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        database.create_goal(&goal_request()).unwrap();
        let goal = database
            .record_goal_usage("thread-goal", 800, 200)
            .unwrap()
            .unwrap();
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.input_tokens, 800);
        assert_eq!(goal.output_tokens, 200);
        assert_eq!(goal.turns, 1);
    }

    #[test]
    fn round_trips_and_updates_persistent_media_assets() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut asset = MediaAsset {
            id: "media-1".to_owned(),
            batch_id: "batch-1".to_owned(),
            thread_id: Some("thread-1".to_owned()),
            provider_id: "provider-1".to_owned(),
            provider_name: "Provider".to_owned(),
            kind: MediaKind::Video,
            status: MediaStatus::Queued,
            prompt: "A camera move".to_owned(),
            model: "sora-2".to_owned(),
            mime_type: None,
            file_name: None,
            file_path: None,
            remote_id: Some("video-1".to_owned()),
            revised_prompt: None,
            error: None,
            progress: Some(0),
            size: Some("1280x720".to_owned()),
            quality: None,
            output_format: Some("mp4".to_owned()),
            background: Some("opaque".to_owned()),
            count: 3,
            voice: None,
            seconds: Some(8),
            created_at: 100,
            updated_at: 100,
        };
        database.save_media_asset(&asset).unwrap();
        assert_eq!(
            database.get_media_asset("media-1").unwrap(),
            Some(asset.clone())
        );

        asset.status = MediaStatus::Completed;
        asset.progress = Some(100);
        asset.mime_type = Some("video/mp4".to_owned());
        asset.file_name = Some("media-1.mp4".to_owned());
        asset.updated_at = 200;
        database.save_media_asset(&asset).unwrap();
        assert_eq!(database.list_media_assets(10).unwrap(), vec![asset.clone()]);
        assert_eq!(database.delete_media_asset("media-1").unwrap(), Some(asset));
        assert!(database.list_media_assets(10).unwrap().is_empty());
    }

    #[test]
    fn pages_media_assets_by_kind_without_reading_other_history() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let asset = |id: &str, kind: MediaKind, created_at: i64| MediaAsset {
            id: id.to_owned(),
            batch_id: format!("batch-{id}"),
            thread_id: None,
            provider_id: "provider-1".to_owned(),
            provider_name: "Provider".to_owned(),
            kind,
            status: MediaStatus::Completed,
            prompt: format!("Prompt {id}"),
            model: "media-model".to_owned(),
            mime_type: None,
            file_name: None,
            file_path: None,
            remote_id: None,
            revised_prompt: None,
            error: None,
            progress: Some(100),
            size: None,
            quality: None,
            output_format: None,
            background: None,
            count: 1,
            voice: None,
            seconds: None,
            created_at,
            updated_at: created_at,
        };
        for item in [
            asset("video-old", MediaKind::Video, 100),
            asset("video-middle", MediaKind::Video, 200),
            asset("video-new", MediaKind::Video, 300),
            asset("image-newest", MediaKind::Image, 400),
        ] {
            database.save_media_asset(&item).unwrap();
        }

        let first_page = database
            .list_media_assets_page(&MediaKind::Video, 2, 0)
            .unwrap();
        assert_eq!(
            first_page
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["video-new", "video-middle"]
        );
        let second_page = database
            .list_media_assets_page(&MediaKind::Video, 2, 2)
            .unwrap();
        assert_eq!(
            second_page
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["video-old"]
        );
    }

    #[test]
    fn round_trips_writing_projects() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut project = WritingProjectRecord {
            id: "story-1".to_owned(),
            title: "The Long Night".to_owned(),
            project_type: "game".to_owned(),
            payload: serde_json::json!({ "schemaVersion": 1, "documents": [] }),
            created_at: 100,
            updated_at: 100,
        };
        database.save_writing_project(&project).unwrap();
        assert_eq!(
            database.list_writing_projects().unwrap(),
            vec![project.clone()]
        );
        project.title = "The Longer Night".to_owned();
        project.updated_at = 200;
        database.save_writing_project(&project).unwrap();
        assert_eq!(database.list_writing_projects().unwrap(), vec![project]);
        assert!(database.delete_writing_project("story-1").unwrap());
        assert!(!database.delete_writing_project("story-1").unwrap());
    }
}
