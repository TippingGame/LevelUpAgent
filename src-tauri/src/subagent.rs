use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::process::hide_console_window;

const MAX_PATCH_CHARS: usize = 120_000;
const MAX_PENDING_PATCHES: usize = 32;
const PATCH_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone)]
pub struct PendingPatch {
    pub run_id: String,
    pub workspace: PathBuf,
    pub base_commit: String,
    pub patch: String,
    pub stat: String,
    pub summary: String,
    created_at: Instant,
}

pub struct IsolatedWorktree {
    pub run_id: String,
    pub workspace: PathBuf,
    pub path: PathBuf,
    pub base_commit: String,
}

#[derive(Default)]
pub struct SubagentManager {
    pending: Mutex<HashMap<String, PendingPatch>>,
}

impl SubagentManager {
    pub fn store(&self, patch: PendingPatch) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Could not lock sub-Agent patch state".to_owned())?;
        pending.retain(|_, item| item.created_at.elapsed() < PATCH_TTL);
        if pending.len() >= MAX_PENDING_PATCHES {
            return Err("Too many sub-Agent patches are waiting for review".to_owned());
        }
        pending.insert(patch.run_id.clone(), patch);
        Ok(())
    }

    pub fn get(&self, run_id: &str, workspace: &Path) -> Result<PendingPatch, String> {
        validate_run_id(run_id)?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Could not lock sub-Agent patch state".to_owned())?;
        pending.retain(|_, item| item.created_at.elapsed() < PATCH_TTL);
        let patch = pending
            .get(run_id)
            .ok_or_else(|| "The sub-Agent patch is missing or expired".to_owned())?;
        let requested = std::fs::canonicalize(workspace)
            .map_err(|error| format!("Workspace is unavailable: {error}"))?;
        if requested != patch.workspace {
            return Err("The sub-Agent patch belongs to a different workspace".to_owned());
        }
        Ok(patch.clone())
    }

    pub fn remove(&self, run_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(run_id);
        }
    }
}

pub async fn create_worktree(storage: &Path, workspace: &Path) -> Result<IsolatedWorktree, String> {
    let workspace = ensure_clean_repository(workspace).await?;
    let base_commit = git_stdout(&workspace, &["rev-parse", "--verify", "HEAD"]).await?;
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::create_dir_all(storage)
        .map_err(|error| format!("Could not create sub-Agent storage: {error}"))?;
    let path = storage.join(&run_id);
    let mut command = Command::new("git");
    command
        .current_dir(&workspace)
        .arg("worktree")
        .arg("add")
        .arg("--detach")
        .arg(&path)
        .arg(&base_commit);
    hide_console_window(&mut command);
    let output = command
        .output()
        .await
        .map_err(|error| format!("Could not start Git worktree creation: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not create isolated Git worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let path = std::fs::canonicalize(&path)
        .map_err(|error| format!("Could not resolve isolated worktree: {error}"))?;
    Ok(IsolatedWorktree {
        run_id,
        workspace,
        path,
        base_commit,
    })
}

pub async fn capture_patch(worktree: &IsolatedWorktree) -> Result<(String, String), String> {
    git_stdout(&worktree.path, &["add", "-N", "--", "."]).await?;
    let patch = git_stdout_raw(
        &worktree.path,
        &["diff", "--binary", "--no-ext-diff", "--", "."],
    )
    .await?;
    if patch.chars().count() > MAX_PATCH_CHARS {
        return Err(format!(
            "Sub-Agent patch exceeds {MAX_PATCH_CHARS} characters; delegate a smaller task"
        ));
    }
    let stat = git_stdout(&worktree.path, &["diff", "--stat", "--", "."]).await?;
    Ok((patch, stat))
}

pub async fn cleanup_worktree(worktree: &IsolatedWorktree) -> Result<(), String> {
    let mut remove = Command::new("git");
    remove
        .current_dir(&worktree.workspace)
        .arg("worktree")
        .arg("remove")
        .arg("--force")
        .arg(&worktree.path);
    hide_console_window(&mut remove);
    let output = remove
        .output()
        .await
        .map_err(|error| format!("Could not start Git worktree cleanup: {error}"))?;
    let mut prune = Command::new("git");
    prune
        .current_dir(&worktree.workspace)
        .args(["worktree", "prune"]);
    hide_console_window(&mut prune);
    let _ = prune.output().await;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not remove isolated Git worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

pub fn pending_patch(
    worktree: &IsolatedWorktree,
    patch: String,
    stat: String,
    summary: String,
) -> PendingPatch {
    PendingPatch {
        run_id: worktree.run_id.clone(),
        workspace: worktree.workspace.clone(),
        base_commit: worktree.base_commit.clone(),
        patch,
        stat,
        summary,
        created_at: Instant::now(),
    }
}

pub async fn apply_patch(pending: &PendingPatch) -> Result<String, String> {
    let workspace = ensure_clean_repository(&pending.workspace).await?;
    let current_commit = git_stdout(&workspace, &["rev-parse", "--verify", "HEAD"]).await?;
    if current_commit != pending.base_commit {
        return Err("Repository HEAD changed after delegation; run the sub-Agent again".to_owned());
    }
    let mut command = Command::new("git");
    command
        .current_dir(&workspace)
        .args(["apply", "--binary", "--whitespace=nowarn", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Git patch application: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Could not open Git patch input".to_owned())?
        .write_all(pending.patch.as_bytes())
        .await
        .map_err(|error| format!("Could not write Git patch input: {error}"))?;
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("Could not wait for Git patch application: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Sub-Agent patch no longer applies cleanly: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(pending.stat.clone())
}

async fn ensure_clean_repository(workspace: &Path) -> Result<PathBuf, String> {
    let workspace = std::fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    let root = git_stdout(&workspace, &["rev-parse", "--show-toplevel"]).await?;
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("Could not resolve Git repository root: {error}"))?;
    if root != workspace {
        return Err("Sub-Agent isolation requires selecting the Git repository root".to_owned());
    }
    let status = git_stdout(
        &workspace,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )
    .await?;
    if !status.trim().is_empty() {
        return Err(
            "Sub-Agent isolation requires a clean Git worktree; commit or stash current changes first"
                .to_owned(),
        );
    }
    Ok(workspace)
}

async fn git_stdout(cwd: &Path, args: &[&str]) -> Result<String, String> {
    Ok(git_stdout_raw(cwd, args).await?.trim().to_owned())
}

async fn git_stdout_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    hide_console_window(&mut command);
    let output = command
        .output()
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Isolated sub-Agents require Git. Install Git to use this optional feature; the main Agent remains available."
                    .to_owned()
            } else {
                format!("Could not start Git: {error}")
            }
        })?;
    if !output.status.success() {
        return Err(format!(
            "Git command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.len() == 32 && run_id.chars().all(|value| value.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Sub-Agent run ID is invalid".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn git(root: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn isolated_patch_is_reviewed_then_applied_to_clean_workspace() {
        let root = std::env::temp_dir().join(format!("levelup-subagent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]);
        git(&root, &["config", "user.email", "levelup@example.test"]);
        git(&root, &["config", "user.name", "LevelUpAgent Test"]);
        std::fs::write(root.join("existing.txt"), "before\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "initial"]);

        let storage = root
            .parent()
            .unwrap()
            .join(format!("levelup-subagents-{}", uuid::Uuid::new_v4()));
        let worktree = create_worktree(&storage, &root).await.unwrap();
        std::fs::write(worktree.path.join("existing.txt"), "after\n").unwrap();
        std::fs::write(worktree.path.join("new.txt"), "new file\n").unwrap();
        let (patch, stat) = capture_patch(&worktree).await.unwrap();
        assert!(patch.contains("existing.txt"));
        assert!(patch.contains("new.txt"));
        assert!(stat.contains("2 files changed"));
        let pending = pending_patch(&worktree, patch, stat, "updated files".to_owned());
        cleanup_worktree(&worktree).await.unwrap();

        let manager = SubagentManager::default();
        manager.store(pending.clone()).unwrap();
        let restored = manager.get(&pending.run_id, &root).unwrap();
        let applied = apply_patch(&restored).await.unwrap();
        assert!(applied.contains("2 files changed"));
        assert_eq!(
            std::fs::read_to_string(root.join("existing.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "after\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("new.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "new file\n"
        );
        manager.remove(&pending.run_id);

        let _ = std::fs::remove_dir_all(storage);
        let _ = std::fs::remove_dir_all(root);
    }
}
