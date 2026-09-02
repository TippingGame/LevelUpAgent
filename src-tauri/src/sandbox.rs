//! Bounded background processes for local application QA.
//!
//! `run_command` is intentionally synchronous and therefore unsuitable for a
//! dev server that must remain alive while the browser drives it.  This
//! manager owns a small set of explicitly started shell processes, captures a
//! bounded stdout/stderr tail, and gives the Agent an idempotent stop path.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::process::hide_console_window;

const MAX_PROCESSES: usize = 8;
const MAX_COMMAND_CHARS: usize = 16_000;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub id: String,
    pub pid: Option<u32>,
    pub command: String,
    pub workspace: String,
    pub label: Option<String>,
    pub running: bool,
    pub started_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutput {
    pub id: String,
    pub stdout: String,
    pub stderr: String,
    pub running: bool,
}

#[derive(Default)]
pub struct ProcessManager {
    processes: Mutex<HashMap<String, Arc<ManagedProcess>>>,
}

struct ManagedProcess {
    snapshot: ProcessSnapshot,
    child: Mutex<Child>,
    stdout: Arc<OutputTail>,
    stderr: Arc<OutputTail>,
}

#[derive(Default)]
struct OutputTail {
    bytes: Mutex<Vec<u8>>,
}

impl OutputTail {
    async fn append(&self, chunk: &[u8]) {
        let mut bytes = self.bytes.lock().await;
        if chunk.len() >= MAX_OUTPUT_BYTES {
            bytes.clear();
            bytes.extend_from_slice(&chunk[chunk.len() - MAX_OUTPUT_BYTES..]);
            return;
        }
        let excess = bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(MAX_OUTPUT_BYTES);
        if excess > 0 {
            bytes.drain(..excess);
        }
        bytes.extend_from_slice(chunk);
    }

    async fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().await).into_owned()
    }
}

impl ProcessManager {
    pub async fn start(
        &self,
        workspace: &Path,
        command: &str,
        label: Option<&str>,
    ) -> Result<ProcessSnapshot, String> {
        let command = command.trim();
        if command.is_empty() || command.chars().count() > MAX_COMMAND_CHARS {
            return Err(format!(
                "Background command must contain 1-{MAX_COMMAND_CHARS} characters"
            ));
        }
        let workspace = canonical_workspace(workspace)?;

        let mut processes = self.processes.lock().await;
        let mut finished = Vec::new();
        for (id, process) in processes.iter() {
            if process
                .child
                .lock()
                .await
                .try_wait()
                .map_err(|error| format!("Could not inspect background process: {error}"))?
                .is_some()
            {
                finished.push(id.clone());
            }
        }
        for id in finished {
            processes.remove(&id);
        }
        if processes.len() >= MAX_PROCESSES {
            return Err(format!(
                "At most {MAX_PROCESSES} background processes may run at once"
            ));
        }

        let mut process = shell_command(command);
        process
            .current_dir(&workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console_window(&mut process);
        process.kill_on_drop(true);
        let mut child = process
            .spawn()
            .map_err(|error| format!("Could not start background process: {error}"))?;
        let pid = child.id();
        let stdout = Arc::new(OutputTail::default());
        let stderr = Arc::new(OutputTail::default());
        if let Some(stream) = child.stdout.take() {
            spawn_reader(stream, stdout.clone());
        }
        if let Some(stream) = child.stderr.take() {
            spawn_reader(stream, stderr.clone());
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let snapshot = ProcessSnapshot {
            id: id.clone(),
            pid,
            command: command.to_owned(),
            workspace: workspace.to_string_lossy().into_owned(),
            label: label
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            running: true,
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
                .unwrap_or_default(),
        };
        processes.insert(
            id,
            Arc::new(ManagedProcess {
                snapshot: snapshot.clone(),
                child: Mutex::new(child),
                stdout,
                stderr,
            }),
        );
        Ok(snapshot)
    }

    pub async fn list(&self, workspace: &Path) -> Result<Vec<ProcessSnapshot>, String> {
        let workspace = canonical_workspace(workspace)?;
        let processes = self.processes.lock().await;
        let mut snapshots = Vec::with_capacity(processes.len());
        for process in processes.values() {
            if process.snapshot.workspace != workspace.to_string_lossy() {
                continue;
            }
            let running = process
                .child
                .lock()
                .await
                .try_wait()
                .map_err(|error| format!("Could not inspect background process: {error}"))?
                .is_none();
            let mut snapshot = process.snapshot.clone();
            snapshot.running = running;
            snapshots.push(snapshot);
        }
        snapshots.sort_by_key(|snapshot| snapshot.started_at);
        Ok(snapshots)
    }

    pub async fn output(&self, id: &str, workspace: &Path) -> Result<ProcessOutput, String> {
        let workspace = canonical_workspace(workspace)?;
        let process = self.process(id, &workspace).await?;
        let running = process
            .child
            .lock()
            .await
            .try_wait()
            .map_err(|error| format!("Could not inspect background process: {error}"))?
            .is_none();
        Ok(ProcessOutput {
            id: id.to_owned(),
            stdout: crate::logging::redact_sensitive(&process.stdout.text().await),
            stderr: crate::logging::redact_sensitive(&process.stderr.text().await),
            running,
        })
    }

    pub async fn stop(&self, id: &str, workspace: &Path) -> Result<bool, String> {
        let workspace = canonical_workspace(workspace)?;
        let process = {
            let mut processes = self.processes.lock().await;
            let belongs = processes
                .get(id)
                .is_some_and(|process| process.snapshot.workspace == workspace.to_string_lossy());
            if belongs { processes.remove(id) } else { None }
        };
        let Some(process) = process else {
            return Ok(false);
        };
        let mut child = process.child.lock().await;
        terminate_child(&mut child).await;
        Ok(true)
    }

    pub async fn stop_all(&self) {
        let ids = self
            .processes
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.stop_unscoped(&id).await;
        }
    }

    async fn stop_unscoped(&self, id: &str) -> Result<bool, String> {
        let process = self.processes.lock().await.remove(id);
        let Some(process) = process else {
            return Ok(false);
        };
        let mut child = process.child.lock().await;
        terminate_child(&mut child).await;
        Ok(true)
    }

    async fn process(&self, id: &str, workspace: &Path) -> Result<Arc<ManagedProcess>, String> {
        let process = self
            .processes
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Background process does not exist: {id}"))?;
        if process.snapshot.workspace != workspace.to_string_lossy() {
            return Err("Background process belongs to a different workspace".to_owned());
        }
        Ok(process)
    }
}

fn canonical_workspace(workspace: &Path) -> Result<std::path::PathBuf, String> {
    let workspace = std::fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    if !workspace.is_dir() {
        return Err("Background process workspace must be a directory".to_owned());
    }
    Ok(workspace)
}

fn shell_command(command: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut process = Command::new("powershell");
        process.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "$utf8 = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $PSDefaultParameterValues['*:Encoding'] = 'utf8'; {}",
                command
            ),
        ]);
        process.env("PYTHONIOENCODING", "utf-8");
        process.env("PYTHONUTF8", "1");
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-lc", command]);
        process
    }
}

fn spawn_reader<R>(mut stream: R, output: Arc<OutputTail>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            let read = match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            output.append(&chunk[..read]).await;
        }
    });
}

async fn terminate_child(child: &mut Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_console_window(&mut taskkill);
        let _ = tokio::time::timeout(STOP_TIMEOUT, taskkill.output()).await;
    }
    let _ = tokio::time::timeout(STOP_TIMEOUT, child.kill()).await;
    let _ = tokio::time::timeout(STOP_TIMEOUT, child.wait()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn starts_captures_lists_and_stops_a_bounded_process() {
        let root = std::env::temp_dir().join(format!("levelup-process-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let manager = ProcessManager::default();
        let command = if cfg!(windows) {
            "Write-Output process-manager-fixture; Start-Sleep -Milliseconds 300"
        } else {
            "printf process-manager-fixture; sleep 0.3"
        };
        let snapshot = manager
            .start(&root, command, Some("fixture"))
            .await
            .unwrap();
        assert!(snapshot.running);
        assert_eq!(manager.list(&root).await.unwrap().len(), 1);
        let mut output = manager.output(&snapshot.id, &root).await.unwrap();
        for _ in 0..100 {
            if output.stdout.contains("process-manager-fixture") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            output = manager.output(&snapshot.id, &root).await.unwrap();
        }
        assert!(output.stdout.contains("process-manager-fixture"));
        assert!(manager.stop(&snapshot.id, &root).await.unwrap());
        assert!(!manager.stop(&snapshot.id, &root).await.unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}
