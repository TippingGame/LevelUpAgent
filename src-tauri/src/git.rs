use std::path::{Component, Path};
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::process::Command;

use crate::models::{GitDiff, GitFileChange, GitRollbackPreview, GitRollbackResult, GitStatus};
use crate::process::hide_console_window;

const MAX_DIFF_BYTES: usize = 512 * 1024;
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
    snapshot: String,
    preview_diff: String,
    truncated: bool,
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

pub async fn diff(workspace: &str, relative_path: &str, staged: bool) -> Result<GitDiff, String> {
    let root = canonical_workspace(workspace)?;
    validate_relative_path(relative_path)?;
    let candidate = root.join(relative_path);
    if let Some(parent) = candidate.parent() {
        let canonical_parent = canonical_existing_ancestor(parent)?;
        if !canonical_parent.starts_with(&root) {
            return Err("Diff path escapes the selected workspace".to_owned());
        }
    }
    let arguments = if staged {
        vec!["diff", "--cached", "--no-ext-diff", "--", relative_path]
    } else {
        vec!["diff", "--no-ext-diff", "--", relative_path]
    };
    let result = git(&root, &arguments).await?;
    if !result.success {
        return Err(result.stderr);
    }
    let mut output = result.stdout;
    if output.is_empty() && !staged && candidate.is_file() {
        let tracked = git(&root, &["ls-files", "--error-unmatch", "--", relative_path]).await?;
        if !tracked.success {
            output = match std::fs::read_to_string(&candidate) {
                Ok(text) => {
                    let added = text
                        .lines()
                        .map(|line| format!("+{line}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("--- /dev/null\n+++ b/{relative_path}\n@@ new file @@\n{added}\n")
                }
                Err(_) => "Binary or non-UTF-8 untracked file\n".to_owned(),
            };
        }
    }
    let bytes = output.as_bytes();
    let truncated = bytes.len() > MAX_DIFF_BYTES;
    let content = if truncated {
        String::from_utf8_lossy(&bytes[..MAX_DIFF_BYTES]).into_owned()
    } else {
        output
    };
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
    ensure_candidate_inside(&root, relative_path)?;

    let status = status_for_path(&root, relative_path).await?;
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
        let index = git(&root, &["ls-files", "--stage", "--", relative_path]).await?;
        if index.stdout.starts_with("160000 ") {
            return Err("Submodule rollback is not supported".to_owned());
        }
        RollbackAction::RestoreHead
    };

    let snapshot = rollback_snapshot(&root, relative_path, &status, &action).await?;
    if snapshot.len() > MAX_DIFF_BYTES || snapshot.lines().count() > MAX_ROLLBACK_PREVIEW_LINES {
        return Err(
            "Rollback preview is too large to show in full; use Git directly for this unusually large change"
                .to_owned(),
        );
    }
    let preview_diff = snapshot.clone();
    Ok(GitRollbackCandidate {
        workspace: root,
        path: relative_path.to_owned(),
        status,
        action,
        snapshot,
        preview_diff,
        truncated: false,
    })
}

pub async fn apply_rollback(pending: &GitRollbackCandidate) -> Result<GitRollbackResult, String> {
    let current = rollback_candidate(&pending.workspace.to_string_lossy(), &pending.path).await?;
    if current.workspace != pending.workspace
        || current.status != pending.status
        || current.action != pending.action
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

fn ensure_candidate_inside(root: &Path, relative_path: &str) -> Result<(), String> {
    let candidate = root.join(relative_path);
    let ancestor = canonical_existing_ancestor(candidate.parent().unwrap_or(root))?;
    if !ancestor.starts_with(root) {
        return Err("Rollback path escapes the selected workspace".to_owned());
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
) -> Result<String, String> {
    match action {
        RollbackAction::RestoreHead => {
            let result = git(root, &["diff", "--binary", "HEAD", "--", relative_path]).await?;
            if !result.success {
                return Err(result.stderr);
            }
            if result.stdout.is_empty() {
                return Err("Git produced no rollback preview for this tracked path".to_owned());
            }
            Ok(format!("status {status}\n{}", result.stdout))
        }
        RollbackAction::DeleteUntracked => {
            let hash = git(root, &["hash-object", "--no-filters", "--", relative_path]).await?;
            if !hash.success {
                return Err(hash.stderr);
            }
            let path = root.join(relative_path);
            let content = match std::fs::read_to_string(&path) {
                Ok(text) => text
                    .lines()
                    .map(|line| format!("+{line}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                Err(_) => "Binary or non-UTF-8 untracked file".to_owned(),
            };
            Ok(format!(
                "status {status}\nhash {}\n--- /dev/null\n+++ b/{relative_path}\n@@ untracked file @@\n{content}\n",
                hash.stdout.trim()
            ))
        }
    }
}

struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
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
    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
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
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "--quiet"]);
        run(&["config", "user.email", "test@levelup.invalid"]);
        run(&["config", "user.name", "LevelUp Test"]);
        std::fs::write(root.join("tracked.txt"), "before\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "--quiet", "-m", "baseline"]);
        std::fs::write(root.join("tracked.txt"), "after\n").unwrap();
        std::fs::write(root.join("new.txt"), "new file\n").unwrap();

        let root_text = root.to_string_lossy().to_string();
        let state = status(&root_text).await.unwrap();
        assert!(state.is_repository);
        assert_eq!(state.changes.len(), 2);
        let tracked = diff(&root_text, "tracked.txt", false).await.unwrap();
        assert!(tracked.content.contains("-before"));
        assert!(tracked.content.contains("+after"));
        let untracked = diff(&root_text, "new.txt", false).await.unwrap();
        assert!(untracked.content.contains("--- /dev/null"));
        assert!(untracked.content.contains("+new file"));

        std::fs::remove_dir_all(root).unwrap();
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
                String::from_utf8_lossy(&output.stderr)
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
}
