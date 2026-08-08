use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::process::Command;

use crate::models::{
    GitDiff, GitFileChange, GitRollbackPreview, GitRollbackResult, GitStatus,
    GitWorkspaceFileSnapshot, GitWorkspaceSnapshot,
};
use crate::process::hide_console_window;
use crate::text_encoding;

const MAX_DIFF_BYTES: usize = 512 * 1024;
const MAX_SNAPSHOT_FILE_BYTES: usize = 512 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_ROLLBACK_PREVIEW_LINES: usize = 4_000;
const GIT_UNKNOWN: u8 = 0;
const GIT_AVAILABLE: u8 = 1;
const GIT_UNAVAILABLE: u8 = 2;

static GIT_AVAILABILITY: AtomicU8 = AtomicU8::new(GIT_UNKNOWN);

#[derive(Clone, Debug, PartialEq, Eq)]
enum RollbackAction {
    RestoreHead,
    DeleteUntracked,
}

#[derive(Clone)]
pub struct GitRollbackCandidate {
    workspace: std::path::PathBuf,
    path: String,
    status: String,
    action: RollbackAction,
    head_commit: Option<String>,
    /// Opaque identity of the exact bytes reviewed.  The display preview may
    /// intentionally collapse an undecodable/binary patch to a generic message,
    /// so it must not be the only stale-change guard.
    snapshot: String,
    preview_diff: String,
    truncated: bool,
}

struct RollbackSnapshot {
    identity: String,
    preview: String,
}

impl GitRollbackCandidate {
    pub fn preview(&self) -> GitRollbackPreview {
        GitRollbackPreview {
            path: self.path.clone(),
            status: self.status.clone(),
            action: self.action_id().to_owned(),
            diff: self.preview_diff.clone(),
            truncated: self.truncated,
            confirmation_token: String::new(),
        }
    }

    fn action_id(&self) -> &'static str {
        match self.action {
            RollbackAction::RestoreHead => "restore_head",
            RollbackAction::DeleteUntracked => "delete_untracked",
        }
    }
}

pub async fn status(workspace: &str) -> Result<GitStatus, String> {
    let root = canonical_workspace(workspace)?;
    if git_is_unavailable() {
        return Ok(unavailable_status());
    }
    let repository_check = match git(&root, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(output) => output,
        Err(_) if git_is_unavailable() => return Ok(unavailable_status()),
        Err(error) => return Err(error),
    };
    if !repository_check.success || repository_check.stdout.trim() != "true" {
        return Ok(GitStatus {
            is_available: true,
            is_repository: false,
            branch: None,
            changes: Vec::new(),
        });
    }
    let branch_result = git(&root, &["branch", "--show-current"]).await?;
    let branch = branch_result
        .success
        .then(|| branch_result.stdout.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| Some("detached HEAD".to_owned()));
    let status_result = git(
        &root,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
    )
    .await?;
    if !status_result.success {
        return Err(status_result.stderr);
    }
    let changes = status_result
        .stdout
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let mut characters = line.chars();
            let index_status = characters.next()?.to_string();
            let worktree_status = characters.next()?.to_string();
            let path = line.get(3..)?.split(" -> ").last()?.to_owned();
            Some(GitFileChange {
                path,
                index_status,
                worktree_status,
            })
        })
        .take(500)
        .collect();
    Ok(GitStatus {
        is_available: true,
        is_repository: true,
        branch,
        changes,
    })
}

pub async fn workspace_snapshot(workspace: &str) -> Result<GitWorkspaceSnapshot, String> {
    let root = canonical_workspace(workspace)?;
    if git_is_unavailable() {
        return Ok(GitWorkspaceSnapshot {
            is_available: false,
            is_repository: false,
            files: Vec::new(),
        });
    }
    let current = status(workspace).await?;
    if !current.is_repository {
        return Ok(GitWorkspaceSnapshot {
            is_available: current.is_available,
            is_repository: false,
            files: Vec::new(),
        });
    }
    let mut files = Vec::with_capacity(current.changes.len());
    let mut remaining_content_bytes = MAX_SNAPSHOT_TOTAL_BYTES;
    for change in current.changes {
        let (fingerprint, mut content, mut base_content, mut content_truncated, binary) =
            file_fingerprint(&root, &change).await?;
        if let Some(text) = &content {
            if text.len() > remaining_content_bytes {
                content = None;
                content_truncated = true;
            } else {
                remaining_content_bytes -= text.len();
            }
        }
        if let Some(text) = &base_content {
            if text.len() > remaining_content_bytes {
                base_content = None;
                content_truncated = true;
            } else {
                remaining_content_bytes -= text.len();
            }
        }
        files.push(GitWorkspaceFileSnapshot {
            path: change.path,
            index_status: change.index_status,
            worktree_status: change.worktree_status,
            fingerprint,
            content,
            base_content,
            content_truncated,
            binary,
        });
    }
    Ok(GitWorkspaceSnapshot {
        is_available: true,
        is_repository: true,
        files,
    })
}

async fn file_fingerprint(
    root: &Path,
    change: &GitFileChange,
) -> Result<(String, Option<String>, Option<String>, bool, bool), String> {
    let mut hasher = DefaultHasher::new();
    change.index_status.hash(&mut hasher);
    change.worktree_status.hash(&mut hasher);
    change.path.hash(&mut hasher);
    let diff = git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            "HEAD",
            "--",
            &change.path,
        ],
    )
    .await?;
    if diff.success && !diff.stdout_bytes.is_empty() {
        diff.stdout_bytes.hash(&mut hasher);
    }
    let path = root.join(&change.path);
    let parent_inside = path
        .parent()
        .and_then(|parent| canonical_existing_ancestor(parent).ok())
        .is_some_and(|parent| parent.starts_with(root));
    let path_metadata = parent_inside
        .then(|| std::fs::symlink_metadata(&path).ok())
        .flatten();
    let (content, content_truncated, mut binary) = match path_metadata {
        Some(metadata) if metadata.file_type().is_symlink() => {
            if let Ok(target) = std::fs::read_link(&path) {
                target.hash(&mut hasher);
            }
            (None, false, true)
        }
        Some(metadata) if metadata.is_file() => {
            if metadata.len() > MAX_SNAPSHOT_FILE_BYTES as u64 {
                // Do not allocate an unbounded buffer merely to fingerprint a
                // large changed file. The snapshot deliberately omits its
                // text, but the identity still needs to include every byte.
                hash_large_file(&path, &mut hasher)?;
                (None, true, false)
            } else {
                let bytes = std::fs::read(&path)
                    .map_err(|error| format!("Could not read workspace file: {error}"))?;
                bytes.hash(&mut hasher);
                match text_encoding::decode(&bytes) {
                    Ok(decoded) => (Some(decoded.content), false, false),
                    Err(_) => (None, false, true),
                }
            }
        }
        _ => (None, false, false),
    };
    let mut base_binary = false;
    let base_content = git(root, &["show", &format!("HEAD:{}", change.path)])
        .await
        .ok()
        .filter(|output| output.success)
        .and_then(|output| {
            let bytes = output.stdout_bytes;
            bytes.hash(&mut hasher);
            if bytes.len() > MAX_SNAPSHOT_FILE_BYTES {
                return None;
            }
            match text_encoding::decode(&bytes) {
                Ok(decoded) => Some(decoded.content),
                Err(_) => {
                    base_binary = true;
                    None
                }
            }
        });
    binary |= base_binary;
    Ok((
        format!("{:016x}", hasher.finish()),
        content,
        base_content,
        content_truncated,
        binary,
    ))
}

pub async fn diff(workspace: &str, relative_path: &str, staged: bool) -> Result<GitDiff, String> {
    let root = canonical_workspace(workspace)?;
    validate_relative_path(relative_path)?;
    if relative_path.chars().any(char::is_control) {
        return Err("Diff paths may not contain control characters".to_owned());
    }
    ensure_path_inside(
        &root,
        relative_path,
        "Diff path escapes the selected workspace",
    )?;
    let candidate = root.join(relative_path);
    let arguments = if staged {
        vec![
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            relative_path,
        ]
    } else {
        vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            relative_path,
        ]
    };
    let result = git(&root, &arguments).await?;
    if !result.success {
        return Err(result.stderr);
    }
    let mut output = if result.stdout_bytes.is_empty() {
        String::new()
    } else {
        decode_git_patch(&root, relative_path, staged, &result.stdout_bytes).await
    };
    let candidate_is_regular = std::fs::symlink_metadata(&candidate)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false);
    if output.is_empty() && !staged && candidate_is_regular {
        let tracked = git(&root, &["ls-files", "--error-unmatch", "--", relative_path]).await?;
        if !tracked.success {
            output = match std::fs::metadata(&candidate)
                .ok()
                .filter(|metadata| metadata.len() <= MAX_DIFF_BYTES as u64)
                .and_then(|_| std::fs::read(&candidate).ok())
                .and_then(|bytes| text_encoding::decode(&bytes).ok())
            {
                Some(decoded) => {
                    let text = decoded.content;
                    let added = text
                        .lines()
                        .map(|line| format!("+{line}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("--- /dev/null\n+++ b/{relative_path}\n@@ new file @@\n{added}\n")
                }
                None => "Binary, undecodable, or oversized untracked file; pass an explicit encoding to the text tool\n".to_owned(),
            };
        }
    }
    let truncated = output.len() > MAX_DIFF_BYTES;
    let content = truncate_utf8(&output, MAX_DIFF_BYTES);
    Ok(GitDiff {
        path: relative_path.to_owned(),
        content,
        truncated,
    })
}

pub async fn rollback_candidate(
    workspace: &str,
    relative_path: &str,
) -> Result<GitRollbackCandidate, String> {
    let root = repository_root(workspace).await?;
    validate_relative_path(relative_path)?;
    if relative_path.chars().any(char::is_control) {
        return Err("Rollback paths may not contain control characters".to_owned());
    }
    ensure_path_inside(
        &root,
        relative_path,
        "Rollback path escapes the selected workspace",
    )?;

    let status = status_for_path(&root, relative_path).await?;
    let mut head_commit = None;
    let action = if status == "??" {
        let path = root.join(relative_path);
        let link_metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect untracked file: {error}"))?;
        if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
            return Err(
                "Only an untracked regular file can be removed by safe rollback".to_owned(),
            );
        }
        if link_metadata.len() > MAX_DIFF_BYTES as u64 {
            return Err("Rollback preview exceeds 512 KiB; use Git directly for this unusually large untracked file".to_owned());
        }
        let hash = git(&root, &["hash-object", "--no-filters", "--", relative_path]).await?;
        if !hash.success {
            return Err(hash.stderr);
        }
        RollbackAction::DeleteUntracked
    } else {
        let head = git(&root, &["rev-parse", "--verify", "HEAD"]).await?;
        if !head.success {
            return Err("Tracked rollback requires a repository with a HEAD commit".to_owned());
        }
        head_commit = Some(head.stdout.trim().to_owned());
        let index = git(&root, &["ls-files", "--stage", "--", relative_path]).await?;
        if index.stdout.starts_with("160000 ") {
            return Err("Submodule rollback is not supported".to_owned());
        }
        RollbackAction::RestoreHead
    };

    let rollback_snapshot = rollback_snapshot(&root, relative_path, &status, &action).await?;
    if rollback_snapshot.preview.len() > MAX_DIFF_BYTES
        || rollback_snapshot.preview.lines().count() > MAX_ROLLBACK_PREVIEW_LINES
    {
        return Err(
            "Rollback preview is too large to show in full; use Git directly for this unusually large change"
                .to_owned(),
        );
    }
    Ok(GitRollbackCandidate {
        workspace: root,
        path: relative_path.to_owned(),
        status,
        action,
        head_commit,
        snapshot: rollback_snapshot.identity,
        preview_diff: rollback_snapshot.preview,
        truncated: false,
    })
}

pub async fn apply_rollback(pending: &GitRollbackCandidate) -> Result<GitRollbackResult, String> {
    let current = rollback_candidate(&pending.workspace.to_string_lossy(), &pending.path).await?;
    if current.workspace != pending.workspace
        || current.status != pending.status
        || current.action != pending.action
        || current.head_commit != pending.head_commit
        || current.snapshot != pending.snapshot
    {
        return Err("Git change no longer matches the reviewed rollback preview".to_owned());
    }

    match pending.action {
        RollbackAction::RestoreHead => {
            let result = git(
                &pending.workspace,
                &[
                    "restore",
                    "--source=HEAD",
                    "--staged",
                    "--worktree",
                    "--",
                    &pending.path,
                ],
            )
            .await?;
            if !result.success {
                return Err(format!("Could not restore tracked file: {}", result.stderr));
            }
        }
        RollbackAction::DeleteUntracked => {
            let path = pending.workspace.join(&pending.path);
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("Could not recheck untracked file: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Untracked rollback target is no longer a regular file".to_owned());
            }
            std::fs::remove_file(&path)
                .map_err(|error| format!("Could not remove untracked file: {error}"))?;
        }
    }

    let remaining = git(
        &pending.workspace,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--",
            &pending.path,
        ],
    )
    .await?;
    if !remaining.success || !remaining.stdout.trim().is_empty() {
        return Err("Git rollback did not leave the selected path clean".to_owned());
    }
    Ok(GitRollbackResult {
        path: pending.path.clone(),
        action: pending.action_id().to_owned(),
    })
}

async fn repository_root(workspace: &str) -> Result<std::path::PathBuf, String> {
    let workspace = canonical_workspace(workspace)?;
    let result = git(&workspace, &["rev-parse", "--show-toplevel"]).await?;
    if !result.success {
        return Err("The selected workspace is not a Git repository".to_owned());
    }
    let root = std::fs::canonicalize(result.stdout.trim())
        .map_err(|error| format!("Could not resolve Git repository root: {error}"))?;
    if root != workspace {
        return Err("Safe rollback requires selecting the Git repository root".to_owned());
    }
    Ok(root)
}

fn ensure_path_inside(root: &Path, relative_path: &str, message: &str) -> Result<(), String> {
    let candidate = root.join(relative_path);
    let ancestor = canonical_existing_ancestor(candidate.parent().unwrap_or(root))?;
    if !ancestor.starts_with(root) {
        return Err(message.to_owned());
    }
    // Check the final component as well.  A symlink may point outside even
    // when its parent directory is inside the workspace; dangling links are
    // rejected rather than treated as ordinary diff/rollback paths.
    if let Ok(metadata) = std::fs::symlink_metadata(&candidate)
        && metadata.file_type().is_symlink()
    {
        let resolved = std::fs::canonicalize(&candidate)
            .map_err(|_| "The selected path is a dangling symbolic link".to_owned())?;
        if !resolved.starts_with(root) {
            return Err(message.to_owned());
        }
    }
    Ok(())
}

async fn status_for_path(root: &Path, relative_path: &str) -> Result<String, String> {
    let result = git(
        root,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--",
            relative_path,
        ],
    )
    .await?;
    if !result.success {
        return Err(result.stderr);
    }
    let lines = result.stdout.lines().collect::<Vec<_>>();
    if lines.len() != 1 || lines[0].len() < 3 || lines[0].contains(" -> ") {
        return Err("Safe rollback requires exactly one non-renamed changed path".to_owned());
    }
    Ok(lines[0][..2].to_owned())
}

async fn rollback_snapshot(
    root: &Path,
    relative_path: &str,
    status: &str,
    action: &RollbackAction,
) -> Result<RollbackSnapshot, String> {
    match action {
        RollbackAction::RestoreHead => {
            let result = git(
                root,
                &[
                    "diff",
                    "--binary",
                    "--no-ext-diff",
                    "--no-textconv",
                    "HEAD",
                    "--",
                    relative_path,
                ],
            )
            .await?;
            if !result.success {
                return Err(result.stderr);
            }
            if result.stdout_bytes.is_empty() {
                return Err("Git produced no rollback preview for this tracked path".to_owned());
            }
            if result.stdout_bytes.len() > MAX_DIFF_BYTES {
                return Err(
                    "Rollback preview exceeds 512 KiB; use Git directly for this unusually large change"
                        .to_owned(),
                );
            }
            let preview = format!(
                "status {status}\n{}",
                decode_git_patch(root, relative_path, false, &result.stdout_bytes).await
            );
            Ok(RollbackSnapshot {
                identity: format!(
                    "tracked-diff:{:016x}",
                    bytes_fingerprint(&result.stdout_bytes)
                ),
                preview,
            })
        }
        RollbackAction::DeleteUntracked => {
            let hash = git(root, &["hash-object", "--no-filters", "--", relative_path]).await?;
            if !hash.success {
                return Err(hash.stderr);
            }
            let path = root.join(relative_path);
            let content = match std::fs::metadata(&path)
                .ok()
                .filter(|metadata| metadata.len() <= MAX_DIFF_BYTES as u64)
                .and_then(|_| std::fs::read(&path).ok())
                .and_then(|bytes| text_encoding::decode(&bytes).ok())
            {
                Some(decoded) => decoded
                    .content
                    .lines()
                    .map(|line| format!("+{line}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                None => "Binary or undecodable untracked file".to_owned(),
            };
            Ok(RollbackSnapshot {
                identity: format!("untracked-hash:{}", hash.stdout.trim()),
                preview: format!(
                    "status {status}\nhash {}\n--- /dev/null\n+++ b/{relative_path}\n@@ untracked file @@\n{content}\n",
                    hash.stdout.trim()
                ),
            })
        }
    }
}

fn bytes_fingerprint(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn hash_large_file(path: &Path, hasher: &mut DefaultHasher) -> Result<(), String> {
    const BUFFER_BYTES: usize = 64 * 1024;
    b"levelup-large-file-v1".hash(hasher);
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Could not read workspace file: {error}"))?;
    let mut buffer = [0_u8; BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read workspace file: {error}"))?;
        if read == 0 {
            break;
        }
        buffer[..read].hash(hasher);
        total = total.saturating_add(read as u64);
    }
    total.hash(hasher);
    Ok(())
}

struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
    /// Git's stdout is retained as bytes as well as a display string.
    /// File contents can use a project-local legacy code page, and converting
    /// them to UTF-8 with replacement characters before snapshot/diff handling
    /// would make review state lossy and potentially non-reproducible.
    stdout_bytes: Vec<u8>,
}

/// Decode a Git patch without ever converting source-file bytes through a
/// lossy UTF-8 conversion. Git keeps patch headers in an ASCII/UTF-8 envelope but
/// emits the actual hunk payload in the file's original encoding.  For the
/// common legacy-code-page case the whole stream is still valid in that codec;
/// if it is not, the mixed-line fallback decodes only hunk payloads with the
/// detected source encoding and leaves headers as UTF-8.
async fn decode_git_patch(root: &Path, relative_path: &str, staged: bool, bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text_encoding::normalize_line_endings(text);
    }
    let encoding = source_file_encoding(root, relative_path, staged).await;
    if let Some(encoding) = encoding {
        if let Some(text) = decode_mixed_patch(bytes, encoding) {
            return text_encoding::normalize_line_endings(&text);
        }
        if let Ok(text) = text_encoding::decode_bytes_with_encoding(bytes, encoding) {
            return text_encoding::normalize_line_endings(&text);
        }
    }
    let fallback = text_encoding::decode_command_output(bytes);
    if !fallback.contains('\u{fffd}') {
        fallback
    } else {
        "Binary or undecodable Git diff; inspect the file with an explicit encoding hint\n"
            .to_owned()
    }
}

async fn source_file_encoding(
    root: &Path,
    relative_path: &str,
    staged: bool,
) -> Option<text_encoding::TextEncoding> {
    let current = root.join(relative_path);
    if !staged {
        let parent_inside = current
            .parent()
            .and_then(|parent| canonical_existing_ancestor(parent).ok())
            .is_some_and(|parent| parent.starts_with(root));
        let regular = parent_inside
            && std::fs::symlink_metadata(&current)
                .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
                .unwrap_or(false);
        if regular
            && std::fs::metadata(&current)
                .map(|metadata| metadata.len() <= MAX_SNAPSHOT_FILE_BYTES as u64)
                .unwrap_or(false)
            && let Ok(bytes) = std::fs::read(&current)
            && bytes.len() <= MAX_SNAPSHOT_FILE_BYTES
            && let Ok(decoded) = text_encoding::decode(&bytes)
        {
            return Some(decoded.encoding);
        }
    } else if let Ok(output) = git(root, &["show", &format!(":{relative_path}")]).await
        && output.success
        && output.stdout_bytes.len() <= MAX_SNAPSHOT_FILE_BYTES
        && let Ok(decoded) = text_encoding::decode(&output.stdout_bytes)
    {
        return Some(decoded.encoding);
    }
    // Deleted files have no worktree bytes; HEAD is the best authoritative
    // source for their encoding.  `git show` is intentionally kept raw here.
    let output = git(root, &["show", &format!("HEAD:{relative_path}")])
        .await
        .ok()?;
    if !output.success || output.stdout_bytes.len() > MAX_SNAPSHOT_FILE_BYTES {
        return None;
    }
    text_encoding::decode(&output.stdout_bytes)
        .ok()
        .map(|decoded| decoded.encoding)
}

fn decode_mixed_patch(bytes: &[u8], encoding: text_encoding::TextEncoding) -> Option<String> {
    if !matches!(
        encoding,
        text_encoding::TextEncoding::Gbk
            | text_encoding::TextEncoding::Gb18030
            | text_encoding::TextEncoding::Big5
            | text_encoding::TextEncoding::ShiftJis
            | text_encoding::TextEncoding::Windows1252
    ) {
        return None;
    }
    let mut output = String::new();
    let mut in_hunk = false;
    let mut offset = 0;
    while offset < bytes.len() {
        let line_end = bytes[offset..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| offset + index + 1)
            .unwrap_or(bytes.len());
        let line = &bytes[offset..line_end];
        let has_newline = line.last() == Some(&b'\n');
        let body_end = if has_newline {
            line.len() - 1
        } else {
            line.len()
        };
        let body = &line[..body_end];
        let (prefix_len, decode_as_source) = if in_hunk
            && !body.starts_with(b"\\ No newline at end of file")
            && (body.starts_with(b"+") || body.starts_with(b"-") || body.starts_with(b" "))
        {
            (1, true)
        } else {
            (0, false)
        };
        let decoded_body = if decode_as_source {
            let prefix = &body[..prefix_len];
            let payload =
                text_encoding::decode_bytes_with_encoding(&body[prefix_len..], encoding).ok()?;
            let mut value = String::from_utf8(prefix.to_vec()).ok()?;
            value.push_str(&payload);
            value
        } else {
            std::str::from_utf8(body)
                .ok()
                .map(str::to_owned)
                .or_else(|| text_encoding::decode_bytes_with_encoding(body, encoding).ok())?
        };
        output.push_str(&decoded_body);
        if has_newline {
            output.push('\n');
        }
        if body.starts_with(b"@@") {
            in_hunk = true;
        }
        offset = line_end;
    }
    Some(output)
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… diff truncated", &value[..end])
}

async fn git(root: &Path, arguments: &[&str]) -> Result<GitOutput, String> {
    if git_is_unavailable() {
        return Err(git_unavailable_message());
    }
    let mut command = Command::new("git");
    command.args(arguments).current_dir(root);
    hide_console_window(&mut command);
    let output = match command.output().await {
        Ok(output) => {
            GIT_AVAILABILITY.store(GIT_AVAILABLE, Ordering::Relaxed);
            output
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            GIT_AVAILABILITY.store(GIT_UNAVAILABLE, Ordering::Relaxed);
            return Err(git_unavailable_message());
        }
        Err(error) => return Err(format!("Could not run Git: {error}")),
    };
    let stdout_bytes = output.stdout;
    let stderr_bytes = output.stderr;
    Ok(GitOutput {
        success: output.status.success(),
        stdout: text_encoding::decode_command_output(&stdout_bytes),
        stderr: text_encoding::decode_command_output(&stderr_bytes)
            .trim()
            .to_owned(),
        stdout_bytes,
    })
}

fn git_is_unavailable() -> bool {
    GIT_AVAILABILITY.load(Ordering::Relaxed) == GIT_UNAVAILABLE
}

fn git_unavailable_message() -> String {
    "Git is not installed or is not available in PATH. Git features are optional; the Agent remains fully usable."
        .to_owned()
}

fn unavailable_status() -> GitStatus {
    GitStatus {
        is_available: false,
        is_repository: false,
        branch: None,
        changes: Vec::new(),
    }
}

fn canonical_workspace(workspace: &str) -> Result<std::path::PathBuf, String> {
    std::fs::canonicalize(workspace).map_err(|error| format!("Workspace is unavailable: {error}"))
}

fn canonical_existing_ancestor(path: &Path) -> Result<std::path::PathBuf, String> {
    let mut candidate = Some(path);
    while let Some(current) = candidate {
        if current.exists() {
            return std::fs::canonicalize(current)
                .map_err(|error| format!("Could not resolve diff path: {error}"));
        }
        candidate = current.parent();
    }
    Err("Could not resolve diff path".to_owned())
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Diff paths must stay inside the selected workspace".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    #[test]
    fn rejects_escaping_diff_paths() {
        assert!(validate_relative_path("../outside.txt").is_err());
        assert!(validate_relative_path("src/main.rs").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_external_and_dangling_symlink_diff_paths() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("levelup-git-path-root-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("levelup-git-path-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("external.txt")).unwrap();
        symlink(outside.join("missing.txt"), root.join("dangling.txt")).unwrap();
        let canonical_root = std::fs::canonicalize(&root).unwrap();

        assert!(ensure_path_inside(&canonical_root, "external.txt", "escape").is_err());
        assert!(ensure_path_inside(&canonical_root, "dangling.txt", "escape").is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn reads_status_tracked_diff_and_untracked_diff() {
        let root = std::env::temp_dir().join(format!("levelup-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let run = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                text_encoding::decode_command_output(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        run(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("tracked.txt"), "before\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        std::fs::write(root.join("tracked.txt"), "after\n").unwrap();
        std::fs::write(root.join("new.txt"), "new file\n").unwrap();

        let root_text = root.to_string_lossy().to_string();
        let first_snapshot = workspace_snapshot(&root_text).await.unwrap();
        let first_tracked = first_snapshot
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        assert_eq!(first_tracked.content.as_deref(), Some("after\n"));
        assert!(!first_tracked.content_truncated);
        assert!(!first_tracked.binary);
        let first_fingerprint = first_tracked.fingerprint.clone();
        std::fs::write(root.join("tracked.txt"), "after again\n").unwrap();
        let second_snapshot = workspace_snapshot(&root_text).await.unwrap();
        let second_tracked = second_snapshot
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        assert_ne!(first_fingerprint, second_tracked.fingerprint);
        assert_eq!(second_tracked.content.as_deref(), Some("after again\n"));

        let state = status(&root_text).await.unwrap();
        assert!(state.is_repository);
        assert_eq!(state.changes.len(), 2);
        let tracked = diff(&root_text, "tracked.txt", false).await.unwrap();
        assert!(tracked.content.contains("-before"));
        assert!(tracked.content.contains("+after again"));
        let untracked = diff(&root_text, "new.txt", false).await.unwrap();
        assert!(untracked.content.contains("--- /dev/null"));
        assert!(untracked.content.contains("+new file"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn keeps_legacy_bytes_decodable_in_snapshot_diff_and_rollback_preview() {
        let root = std::env::temp_dir().join(format!("levelup-git-gbk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let run = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                text_encoding::decode_command_output(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        run(&["config", "core.autocrlf", "false"]);
        let path = root.join("legacy.txt");
        let (before, _, before_errors) =
            encoding_rs::GBK.encode("这是一个较长的中文基线内容，用于检查快照\n");
        assert!(!before_errors);
        std::fs::write(&path, before.as_ref()).unwrap();
        run(&["add", "legacy.txt"]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        let (after, _, after_errors) =
            encoding_rs::GBK.encode("这是一个较长的中文修改内容，用于检查差异\n");
        assert!(!after_errors);
        std::fs::write(&path, after.as_ref()).unwrap();

        let root_text = root.to_string_lossy().into_owned();
        let snapshot = workspace_snapshot(&root_text).await.unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == "legacy.txt")
            .unwrap();
        assert!(!file.binary);
        assert_eq!(
            file.content.as_deref(),
            Some("这是一个较长的中文修改内容，用于检查差异\n")
        );
        assert_eq!(
            file.base_content.as_deref(),
            Some("这是一个较长的中文基线内容，用于检查快照\n")
        );

        let diff = diff(&root_text, "legacy.txt", false).await.unwrap();
        assert!(diff.content.contains("中文基线内容"));
        assert!(diff.content.contains("中文修改内容"));
        assert!(!diff.content.contains('\u{fffd}'));

        let candidate = rollback_candidate(&root_text, "legacy.txt").await.unwrap();
        assert!(candidate.preview_diff.contains("中文基线内容"));
        assert!(!candidate.preview_diff.contains('\u{fffd}'));
        apply_rollback(&candidate).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before.as_ref());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn keeps_big5_and_shift_jis_diff_text_lossless() {
        let root =
            std::env::temp_dir().join(format!("levelup-git-eastasia-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let run = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                text_encoding::decode_command_output(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        run(&["config", "core.autocrlf", "false"]);
        let samples = [
            (
                "big5.txt",
                encoding_rs::BIG5,
                "這是一段較長的繁體中文基線內容，用於檢查差異\n",
                "這是一段較長的繁體中文修改內容，用於檢查差異\n",
            ),
            (
                "sjis.txt",
                encoding_rs::SHIFT_JIS,
                "これは長い日本語の基線テキストで差異を確認します\n",
                "これは長い日本語の変更テキストで差異を確認します\n",
            ),
        ];
        for (name, codec, before_text, _) in samples {
            let (bytes, _, had_errors) = codec.encode(before_text);
            assert!(!had_errors);
            std::fs::write(root.join(name), bytes.as_ref()).unwrap();
        }
        run(&["add", "."]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        for (name, codec, _, after_text) in samples {
            let (bytes, _, had_errors) = codec.encode(after_text);
            assert!(!had_errors);
            std::fs::write(root.join(name), bytes.as_ref()).unwrap();
        }
        let root_text = root.to_string_lossy().into_owned();
        for (name, _, _, after_text) in samples {
            let snapshot = workspace_snapshot(&root_text).await.unwrap();
            let file = snapshot
                .files
                .iter()
                .find(|file| file.path == name)
                .unwrap();
            assert!(!file.binary, "{name}");
            assert_eq!(
                file.content.as_deref(),
                Some(text_encoding::normalize_line_endings(after_text).as_str())
            );
            let diff = diff(&root_text, name, false).await.unwrap();
            assert!(
                diff.content.contains(after_text.trim()),
                "{name}: {}",
                diff.content
            );
            assert!(
                !diff.content.contains('\u{fffd}'),
                "{name}: {}",
                diff.content
            );
        }
        run(&["add", "big5.txt"]);
        let staged = diff(&root_text, "big5.txt", true).await.unwrap();
        assert!(staged.content.contains("繁體中文修改內容"));
        assert!(!staged.content.contains('\u{fffd}'));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn displays_short_legacy_diff_without_replacement_characters() {
        let root = std::env::temp_dir().join(format!("levelup-git-short-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let run = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                text_encoding::decode_command_output(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        run(&["config", "core.autocrlf", "false"]);
        let path = root.join("short.txt");
        let (before, _, before_errors) = encoding_rs::GBK.encode("中文\n");
        assert!(!before_errors);
        std::fs::write(&path, before.as_ref()).unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        let (after, _, after_errors) = encoding_rs::GBK.encode("汉字\n");
        assert!(!after_errors);
        std::fs::write(&path, after.as_ref()).unwrap();
        let root_text = root.to_string_lossy().into_owned();
        let diff = diff(&root_text, "short.txt", false).await.unwrap();
        assert!(diff.content.contains("中文"), "{}", diff.content);
        assert!(diff.content.contains("汉字"), "{}", diff.content);
        assert!(!diff.content.contains('\u{fffd}'));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn displays_short_big5_and_shift_jis_diffs_without_replacement_characters() {
        let root = std::env::temp_dir().join(format!(
            "levelup-git-short-eastasia-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let run = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                text_encoding::decode_command_output(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        run(&["config", "core.autocrlf", "false"]);
        let samples = [
            ("short-big5.txt", encoding_rs::BIG5, "中文\n", "繁體\n"),
            (
                "short-sjis.txt",
                encoding_rs::SHIFT_JIS,
                "日本語\n",
                "変更\n",
            ),
        ];
        for (name, codec, before, _) in samples {
            let (bytes, _, had_errors) = codec.encode(before);
            assert!(!had_errors, "{name}");
            std::fs::write(root.join(name), bytes.as_ref()).unwrap();
        }
        run(&["add", "."]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        for (name, codec, _, after) in samples {
            let (bytes, _, had_errors) = codec.encode(after);
            assert!(!had_errors, "{name}");
            std::fs::write(root.join(name), bytes.as_ref()).unwrap();
            let root_text = root.to_string_lossy().into_owned();
            let diff = diff(&root_text, name, false).await.unwrap();
            assert!(
                diff.content.contains(after.trim()),
                "{name}: {}",
                diff.content
            );
            assert!(
                !diff.content.contains('\u{fffd}'),
                "{name}: {}",
                diff.content
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn rollback_requires_unchanged_preview_and_handles_tracked_and_untracked_files() {
        let root =
            std::env::temp_dir().join(format!("levelup-git-rollback-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let run = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                text_encoding::decode_command_output(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        std::fs::write(root.join("tracked.txt"), "before\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        let root_text = root.to_string_lossy().to_string();

        std::fs::write(root.join("tracked.txt"), "after\n").unwrap();
        let tracked = rollback_candidate(&root_text, "tracked.txt").await.unwrap();
        assert_eq!(tracked.preview().action, "restore_head");
        apply_rollback(&tracked).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "before\n"
        );

        std::fs::write(root.join("new.txt"), "first\n").unwrap();
        let stale = rollback_candidate(&root_text, "new.txt").await.unwrap();
        assert_eq!(stale.preview().action, "delete_untracked");
        std::fs::write(root.join("new.txt"), "changed after preview\n").unwrap();
        assert!(apply_rollback(&stale).await.is_err());
        assert!(root.join("new.txt").exists());
        let current = rollback_candidate(&root_text, "new.txt").await.unwrap();
        apply_rollback(&current).await.unwrap();
        assert!(!root.join("new.txt").exists());

        std::fs::write(root.join("staged-new.txt"), "staged\n").unwrap();
        run(&["add", "staged-new.txt"]);
        let staged = rollback_candidate(&root_text, "staged-new.txt")
            .await
            .unwrap();
        apply_rollback(&staged).await.unwrap();
        assert!(!root.join("staged-new.txt").exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn rollback_rejects_stale_binary_preview_even_when_display_is_generic() {
        let root = std::env::temp_dir().join(format!(
            "levelup-git-binary-rollback-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let run = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                text_encoding::decode_command_output(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        run(&["config", "core.autocrlf", "false"]);
        let path = root.join("payload.bin");
        std::fs::write(&path, [0, 1, 2, 3, 0xff]).unwrap();
        run(&["add", "payload.bin"]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        std::fs::write(&path, [0, 1, 2, 3, 0xfe]).unwrap();

        let root_text = root.to_string_lossy().into_owned();
        let candidate = rollback_candidate(&root_text, "payload.bin").await.unwrap();
        assert!(
            candidate.preview_diff.contains("Binary") || candidate.preview_diff.contains("binary")
        );
        std::fs::write(&path, [0, 1, 2, 3, 0xfd]).unwrap();
        assert!(apply_rollback(&candidate).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), [0, 1, 2, 3, 0xfd]);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn rollback_rejects_a_changed_head_even_when_the_diff_bytes_match() {
        let root = std::env::temp_dir().join(format!(
            "levelup-git-head-rollback-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let run = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                text_encoding::decode_command_output(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        run(&["config", "core.autocrlf", "false"]);
        let path = root.join("tracked.txt");
        std::fs::write(&path, "before\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        std::fs::write(&path, "after\n").unwrap();
        let root_text = root.to_string_lossy().into_owned();
        let candidate = rollback_candidate(&root_text, "tracked.txt").await.unwrap();
        run(&["commit", "--amend", "-m", "baseline-amended"]);
        assert!(apply_rollback(&candidate).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
        let _ = std::fs::remove_dir_all(root);
    }
}
