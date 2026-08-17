//! Additive SQLite schema for the harness. The existing messages/threads
//! tables remain authoritative for user-visible history; these tables record
//! control flow, snapshots, approvals, and execution outcomes.

pub const MIGRATION_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS harness_drafts (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    raw_user_input TEXT NOT NULL,
    attachment_ids_json TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL,
    permission_level TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL,
    promoted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_harness_drafts_thread_status
    ON harness_drafts(thread_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS harness_operations (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    draft_id TEXT REFERENCES harness_drafts(id) ON DELETE SET NULL,
    state TEXT NOT NULL,
    mode TEXT NOT NULL,
    permission_level TEXT NOT NULL,
    current_snapshot_id TEXT,
    last_event_sequence INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_harness_operations_thread_updated
    ON harness_operations(thread_id, updated_at DESC);
DROP INDEX IF EXISTS idx_harness_active_operation_per_thread;
CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_active_operation_per_thread
    ON harness_operations(thread_id)
    WHERE state IN ('compiling', 'running', 'awaiting_approval', 'compacting', 'persisting');

CREATE TABLE IF NOT EXISTS harness_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES harness_operations(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    parent_snapshot_id TEXT REFERENCES harness_snapshots(id) ON DELETE RESTRICT,
    snapshot_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(operation_id, version)
);

CREATE TABLE IF NOT EXISTS harness_events (
    id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES harness_operations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(operation_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_harness_events_operation_sequence
    ON harness_events(operation_id, sequence);

CREATE TABLE IF NOT EXISTS harness_context_manifests (
    id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES harness_operations(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES harness_snapshots(id) ON DELETE CASCADE,
    attempt_id TEXT,
    budget_json TEXT NOT NULL,
    selection_json TEXT NOT NULL,
    estimator_version TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_provider_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES harness_operations(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES harness_snapshots(id) ON DELETE CASCADE,
    context_manifest_id TEXT NOT NULL REFERENCES harness_context_manifests(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL,
    model TEXT NOT NULL,
    protocol TEXT NOT NULL,
    status TEXT NOT NULL,
    failover_index INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    first_delta_at INTEGER,
    finished_at INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    request_id TEXT,
    error_class TEXT
);

CREATE TABLE IF NOT EXISTS harness_tool_executions (
    id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES harness_operations(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES harness_snapshots(id) ON DELETE CASCADE,
    call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    risk TEXT NOT NULL,
    arguments_hash TEXT NOT NULL,
    arguments_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    result_json TEXT,
    artifact_ref TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    UNIQUE(operation_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_harness_tool_executions_status
    ON harness_tool_executions(operation_id, status);

CREATE TABLE IF NOT EXISTS harness_approvals (
    id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES harness_operations(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES harness_snapshots(id) ON DELETE CASCADE,
    tool_execution_id TEXT NOT NULL REFERENCES harness_tool_executions(id) ON DELETE CASCADE,
    arguments_hash TEXT NOT NULL,
    decision TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS harness_session_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES harness_session_nodes(id) ON DELETE RESTRICT,
    branch_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    operation_id TEXT REFERENCES harness_operations(id) ON DELETE SET NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harness_session_nodes_parent
    ON harness_session_nodes(thread_id, parent_id, position);

CREATE TABLE IF NOT EXISTS harness_session_heads (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    active_leaf_id TEXT NOT NULL REFERENCES harness_session_nodes(id) ON DELETE RESTRICT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_queues (
    id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES harness_operations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    injected_at INTEGER,
    retracted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_harness_queues_pending
    ON harness_queues(operation_id, status, created_at);

CREATE TABLE IF NOT EXISTS harness_compactions (
    id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES harness_operations(id) ON DELETE CASCADE,
    source_node_ids_json TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    tokens_before INTEGER NOT NULL,
    tokens_after INTEGER NOT NULL,
    summary_node_id TEXT REFERENCES harness_session_nodes(id) ON DELETE SET NULL,
    summary_json TEXT NOT NULL DEFAULT '{}',
    source_fingerprint TEXT NOT NULL DEFAULT '',
    source_message_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harness_compactions_operation_created
    ON harness_compactions(operation_id, created_at DESC);
"#;

#[cfg(test)]
mod tests {
    use super::MIGRATION_SQL;
    use rusqlite::Connection;

    #[test]
    fn migration_is_additive_and_contains_execution_idempotency_constraints() {
        assert!(MIGRATION_SQL.contains("CREATE TABLE IF NOT EXISTS harness_operations"));
        assert!(MIGRATION_SQL.contains("UNIQUE(operation_id, call_id)"));
        assert!(MIGRATION_SQL.contains("UNIQUE(operation_id, sequence)"));
        assert!(MIGRATION_SQL.contains("idx_harness_active_operation_per_thread"));
        assert!(
            MIGRATION_SQL.contains("DROP INDEX IF EXISTS idx_harness_active_operation_per_thread")
        );
        assert!(!MIGRATION_SQL.contains("'persisting', 'interrupted'"));
    }

    #[test]
    fn migration_replaces_the_legacy_active_operation_index() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE harness_operations (
                    id TEXT PRIMARY KEY NOT NULL,
                    thread_id TEXT NOT NULL,
                    draft_id TEXT,
                    state TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    permission_level TEXT NOT NULL,
                    current_snapshot_id TEXT,
                    last_event_sequence INTEGER NOT NULL DEFAULT 0,
                    started_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    ended_at INTEGER,
                    error TEXT
                );
                CREATE UNIQUE INDEX idx_harness_active_operation_per_thread
                    ON harness_operations(thread_id)
                    WHERE state IN ('compiling', 'running', 'awaiting_approval', 'compacting', 'persisting', 'interrupted');",
            )
            .unwrap();

        connection.execute_batch(MIGRATION_SQL).unwrap();

        let definition: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_harness_active_operation_per_thread'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!definition.contains("interrupted"));
        assert!(definition.contains("persisting"));
    }
}
