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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::process::hide_console_window;

const MAX_PROCESSES: usize = 8;
const MAX_COMPLETED_PROCESSES: usize = 64;
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
    pub workdir: String,
    pub label: Option<String>,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub started_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutput {
    pub id: String,
    pub stdout: String,
    pub stderr: String,
    pub running: bool,
    pub exit_code: Option<i32>,
}

#[derive(Default)]
pub struct ProcessManager {
    processes: Mutex<HashMap<String, Arc<ManagedProcess>>>,
}

struct ManagedProcess {
    snapshot: ProcessSnapshot,
    state: Mutex<ProcessState>,
    stdout: Arc<OutputTail>,
    stderr: Arc<OutputTail>,
    stdout_reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stderr_reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

struct ProcessState {
    child: Option<Child>,
    exit_code: Option<i32>,
    finished_at: Option<Instant>,
    stopped: bool,
}

impl ProcessState {
    fn refresh(&mut self) -> Result<(), String> {
        if let Some(child) = self.child.as_mut()
            && let Some(status) = child
                .try_wait()
                .map_err(|error| format!("Could not inspect background process: {error}"))?
        {
            self.exit_code = status.code();
            self.finished_at = Some(Instant::now());
            self.child = None;
        }
        Ok(())
    }
}

impl ManagedProcess {
    async fn snapshot(&self) -> Result<ProcessSnapshot, String> {
        let mut state = self.state.lock().await;
        state.refresh()?;
        let mut snapshot = self.snapshot.clone();
        snapshot.running = state.child.is_some();
        snapshot.exit_code = state.exit_code;
        Ok(snapshot)
    }

    async fn finish_readers(&self) {
        tokio::join!(
            finish_reader(&self.stdout_reader),
            finish_reader(&self.stderr_reader)
        );
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        // Eviction must also release readers whose pipes were inherited by descendants.
        for reader in [&mut self.stdout_reader, &mut self.stderr_reader] {
            if let Some(task) = reader.get_mut().take() {
                task.abort();
            }
        }
    }
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
        workdir: Option<&Path>,
    ) -> Result<ProcessSnapshot, String> {
        let command = command.trim();
        if command.is_empty() || command.chars().count() > MAX_COMMAND_CHARS {
            return Err(format!(
                "Background command must contain 1-{MAX_COMMAND_CHARS} characters"
            ));
        }
        let workspace = canonical_workspace(workspace)?;
        let workdir = canonical_workspace(workdir.unwrap_or(&workspace))?;

        let mut processes = self.processes.lock().await;
        if refresh_processes(&mut processes).await? >= MAX_PROCESSES {
            return Err(format!(
                "At most {MAX_PROCESSES} background processes may run at once"
            ));
        }

        let mut process = shell_command(command);
        process
            .current_dir(&workdir)
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
        let stdout_reader = child
            .stdout
            .take()
            .map(|stream| spawn_reader(stream, stdout.clone()));
        let stderr_reader = child
            .stderr
            .take()
            .map(|stream| spawn_reader(stream, stderr.clone()));
        let id = uuid::Uuid::new_v4().simple().to_string();
        let snapshot = ProcessSnapshot {
            id: id.clone(),
            pid,
            command: command.to_owned(),
            workspace: workspace.to_string_lossy().into_owned(),
            workdir: workdir.to_string_lossy().into_owned(),
            label: label
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            running: true,
            exit_code: None,
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
                .unwrap_or_default(),
        };
        processes.insert(
            id,
            Arc::new(ManagedProcess {
                snapshot: snapshot.clone(),
                state: Mutex::new(ProcessState {
                    child: Some(child),
                    exit_code: None,
                    finished_at: None,
                    stopped: false,
                }),
                stdout,
                stderr,
                stdout_reader: Mutex::new(stdout_reader),
                stderr_reader: Mutex::new(stderr_reader),
            }),
        );
        Ok(snapshot)
    }

    pub async fn list(&self, workspace: &Path) -> Result<Vec<ProcessSnapshot>, String> {
        let workspace = canonical_workspace(workspace)?;
        let mut processes = self.processes.lock().await;
        refresh_processes(&mut processes).await?;
        let mut snapshots = Vec::with_capacity(processes.len());
        for process in processes.values() {
            if process.snapshot.workspace != workspace.to_string_lossy() {
                continue;
            }
            snapshots.push(process.snapshot().await?);
        }
        snapshots.sort_by_key(|snapshot| snapshot.started_at);
        Ok(snapshots)
    }

    pub async fn output(&self, id: &str, workspace: &Path) -> Result<ProcessOutput, String> {
        let workspace = canonical_workspace(workspace)?;
        let process = self.process(id, &workspace).await?;
        let snapshot = process.snapshot().await?;
        if !snapshot.running {
            process.finish_readers().await;
        }
        Ok(ProcessOutput {
            id: id.to_owned(),
            stdout: crate::logging::redact_sensitive(&process.stdout.text().await),
            stderr: crate::logging::redact_sensitive(&process.stderr.text().await),
            running: snapshot.running,
            exit_code: snapshot.exit_code,
        })
    }

    pub async fn stop(&self, id: &str, workspace: &Path) -> Result<bool, String> {
        let workspace = canonical_workspace(workspace)?;
        let process = {
            let processes = self.processes.lock().await;
            processes
                .get(id)
                .filter(|process| process.snapshot.workspace == workspace.to_string_lossy())
                .cloned()
        };
        let Some(process) = process else {
            return Ok(false);
        };
        let mut state = process.state.lock().await;
        if state.stopped {
            return Ok(false);
        }
        state.refresh()?;
        if let Some(child) = state.child.as_mut() {
            terminate_child(child).await;
            state.refresh()?;
            if state.child.is_some() {
                return Err(
                    "Could not stop background process; use list_processes to check its status"
                        .to_owned(),
                );
            }
        }
        state.stopped = true;
        drop(state);
        process.finish_readers().await;
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
        let mut state = process.state.lock().await;
        state.refresh()?;
        if let Some(child) = state.child.as_mut() {
            terminate_child(child).await;
        }
        Ok(true)
    }

    async fn process(&self, id: &str, workspace: &Path) -> Result<Arc<ManagedProcess>, String> {
        let process = self
            .processes
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Background process ID is no longer available: {id}. IDs are local to this app run; the app may have restarted or the completed record may have expired. Use list_processes to find current IDs and inspect their status before deciding whether a command needs to be started again."
                )
            })?;
        if process.snapshot.workspace != workspace.to_string_lossy() {
            return Err("Background process belongs to a different workspace".to_owned());
        }
        Ok(process)
    }
}

async fn refresh_processes(
    processes: &mut HashMap<String, Arc<ManagedProcess>>,
) -> Result<usize, String> {
    let mut running = 0;
    let mut finished = Vec::new();
    for (id, process) in processes.iter() {
        let mut state = process.state.lock().await;
        state.refresh()?;
        if let Some(finished_at) = state.finished_at {
            finished.push((finished_at, id.clone()));
        } else {
            running += 1;
        }
    }
    finished.sort_unstable();
    let excess = finished.len().saturating_sub(MAX_COMPLETED_PROCESSES);
    for (_, id) in finished.into_iter().take(excess) {
        processes.remove(&id);
    }
    Ok(running)
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

fn spawn_reader<R>(mut stream: R, output: Arc<OutputTail>) -> tokio::task::JoinHandle<()>
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
    })
}

async fn finish_reader(reader: &Mutex<Option<tokio::task::JoinHandle<()>>>) {
    // Keep ownership of the handle if the caller is cancelled while waiting.
    let mut reader = reader.lock().await;
    if let Some(task) = reader.as_mut()
        && tokio::time::timeout(STOP_TIMEOUT, &mut *task)
            .await
            .is_err()
    {
        task.abort();
        let _ = task.await;
    }
    reader.take();
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

    fn idle_command() -> &'static str {
        if cfg!(windows) {
            "Start-Sleep -Seconds 60"
        } else {
            "exec sleep 60"
        }
    }

    async fn wait_for_exit(manager: &ProcessManager, id: &str, workspace: &Path) -> ProcessOutput {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let output = manager.output(id, workspace).await.unwrap();
                if !output.running {
                    return output;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("fixture process did not exit")
    }

    #[tokio::test]
    async fn cancelling_process_output_keeps_the_reader_available_for_cleanup() {
        let (writer, stream) = tokio::io::duplex(1024);
        let reader = Mutex::new(Some(spawn_reader(stream, Arc::new(OutputTail::default()))));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), finish_reader(&reader))
                .await
                .is_err()
        );
        assert!(reader.lock().await.is_some());
        drop(writer);
        finish_reader(&reader).await;
        assert!(reader.lock().await.is_none());
    }

    #[tokio::test]
    async fn completed_output_and_exit_code_survive_starting_another_process() {
        let root =
            std::env::temp_dir().join(format!("levelup-process-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let manager = ProcessManager::default();
        let command = if cfg!(windows) {
            "[Console]::Out.WriteLine('completed-process-fixture'); [Console]::Error.WriteLine('completed-process-stderr'); exit 7"
        } else {
            "printf completed-process-fixture; printf completed-process-stderr >&2; exit 7"
        };
        let first = manager.start(&root, command, None, None).await.unwrap();
        let original = wait_for_exit(&manager, &first.id, &root).await;
        manager
            .start(&root, idle_command(), None, None)
            .await
            .unwrap();
        let retained = manager.output(&first.id, &root).await.unwrap();
        let snapshots = manager.list(&root).await.unwrap();
        manager.stop_all().await;

        assert_eq!(original.exit_code, Some(7));
        assert!(retained.stdout.contains("completed-process-fixture"));
        assert!(retained.stderr.contains("completed-process-stderr"));
        assert_eq!(retained.stdout, original.stdout);
        assert_eq!(retained.stderr, original.stderr);
        assert_eq!(retained.exit_code, Some(7));
        assert!(!retained.running);
        assert_eq!(snapshots.len(), 2);
        let completed = snapshots
            .iter()
            .find(|snapshot| snapshot.id == first.id)
            .unwrap();
        assert!(!completed.running);
        assert_eq!(completed.exit_code, Some(7));
        assert!(manager.list(&root).await.unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn completed_history_does_not_use_running_process_slots() {
        let root =
            std::env::temp_dir().join(format!("levelup-process-slots-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let manager = ProcessManager::default();
        let mut snapshots = Vec::new();
        for _ in 0..MAX_PROCESSES {
            snapshots.push(
                manager
                    .start(&root, idle_command(), None, None)
                    .await
                    .unwrap(),
            );
        }
        let limit_error = manager
            .start(&root, idle_command(), None, None)
            .await
            .unwrap_err();
        assert!(limit_error.contains("at once"));
        assert!(manager.stop(&snapshots[0].id, &root).await.unwrap());
        manager
            .start(&root, idle_command(), None, None)
            .await
            .unwrap();
        let stopped = manager.output(&snapshots[0].id, &root).await.unwrap();
        let snapshots = manager.list(&root).await.unwrap();
        manager.stop_all().await;

        assert!(!stopped.running);
        assert_eq!(
            snapshots.iter().filter(|snapshot| snapshot.running).count(),
            MAX_PROCESSES
        );
        assert_eq!(snapshots.len(), MAX_PROCESSES + 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn history_evicts_oldest_completed_records_and_keeps_running_processes() {
        let root =
            std::env::temp_dir().join(format!("levelup-process-eviction-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let manager = ProcessManager::default();
        let active = manager
            .start(&root, idle_command(), None, None)
            .await
            .unwrap();
        let finished_at = Instant::now();
        {
            let mut processes = manager.processes.lock().await;
            for index in 0..=MAX_COMPLETED_PROCESSES {
                let id = format!("completed-{index}");
                processes.insert(
                    id.clone(),
                    Arc::new(ManagedProcess {
                        snapshot: ProcessSnapshot {
                            id,
                            pid: None,
                            running: false,
                            exit_code: Some(0),
                            ..active.clone()
                        },
                        state: Mutex::new(ProcessState {
                            child: None,
                            exit_code: Some(0),
                            finished_at: Some(finished_at + Duration::from_millis(index as u64)),
                            stopped: false,
                        }),
                        stdout: Arc::new(OutputTail::default()),
                        stderr: Arc::new(OutputTail::default()),
                        stdout_reader: Mutex::new(None),
                        stderr_reader: Mutex::new(None),
                    }),
                );
            }
        }
        manager
            .start(&root, idle_command(), None, None)
            .await
            .unwrap();
        let snapshots = manager.list(&root).await.unwrap();
        let expired = manager.output("completed-0", &root).await.unwrap_err();
        let retained = manager.output("completed-1", &root).await.unwrap();
        manager.stop_all().await;

        assert_eq!(snapshots.len(), MAX_COMPLETED_PROCESSES + 2);
        assert_eq!(
            snapshots.iter().filter(|snapshot| snapshot.running).count(),
            2
        );
        assert!(snapshots.iter().any(|snapshot| snapshot.id == active.id));
        assert!(expired.contains("list_processes"));
        assert!(!retained.running);
        assert_eq!(retained.exit_code, Some(0));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn external_workdir_keeps_process_ownership_in_the_original_workspace() {
        let suite =
            std::env::temp_dir().join(format!("levelup-process-workdir-{}", uuid::Uuid::new_v4()));
        let workspace = suite.join("workspace");
        let workdir = suite.join("external");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(workdir.join("marker.txt"), "external-process-fixture").unwrap();
        let manager = ProcessManager::default();
        let command = if cfg!(windows) {
            "Get-Content marker.txt; Start-Sleep -Seconds 5"
        } else {
            "cat marker.txt; sleep 5"
        };
        let snapshot = manager
            .start(&workspace, command, None, Some(&workdir))
            .await
            .unwrap();
        assert_eq!(
            snapshot.workdir,
            std::fs::canonicalize(&workdir).unwrap().to_string_lossy()
        );
        assert_eq!(manager.list(&workspace).await.unwrap().len(), 1);
        assert!(manager.list(&workdir).await.unwrap().is_empty());
        assert!(manager.output(&snapshot.id, &workdir).await.is_err());
        let mut output = manager.output(&snapshot.id, &workspace).await.unwrap();
        for _ in 0..100 {
            if output.stdout.contains("external-process-fixture") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            output = manager.output(&snapshot.id, &workspace).await.unwrap();
        }
        let stopped = manager.stop(&snapshot.id, &workspace).await.unwrap();
        assert!(stopped);
        assert!(manager.output(&snapshot.id, &workdir).await.is_err());
        assert!(!manager.stop(&snapshot.id, &workdir).await.unwrap());
        assert!(
            output.stdout.contains("external-process-fixture"),
            "{}",
            output.stderr
        );
        std::fs::remove_dir_all(suite).unwrap();
    }

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
            .start(&root, command, Some("fixture"), None)
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
        let stopped = manager.output(&snapshot.id, &root).await.unwrap();
        assert!(!stopped.running);
        assert!(stopped.stdout.contains("process-manager-fixture"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
