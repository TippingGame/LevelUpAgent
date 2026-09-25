//! User-installed prompt hooks. Only the application data directory is trusted
//! to register executables; workspace files and provider/IPC input cannot do so.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const MAX_CONFIG: u64 = 128 * 1024;
const MAX_IO: usize = 256 * 1024;
const MAX_CONTEXT: usize = 32 * 1024;
const OWNER: &str = "levelup-axion-hook";

#[derive(Default, Deserialize)]
struct Config {
    #[serde(default)]
    hooks: std::collections::HashMap<String, Vec<Group>>,
}

#[derive(Deserialize)]
struct Group {
    hooks: Vec<Hook>,
}

#[derive(Deserialize)]
struct Hook {
    #[serde(default)]
    name: String,
    /// Argument vector: no shell expansion and no user text in a command line.
    argv: Vec<String>,
    #[serde(default = "default_timeout")]
    timeout: u64,
}

fn default_timeout() -> u64 {
    8
}

#[derive(Default)]
pub(crate) struct HookResult {
    pub contexts: Vec<String>,
    pub owns_router: bool,
    /// Diagnostic codes only. Prompt, stdout and stderr are never logged.
    pub events: Vec<Value>,
    pub blocked: bool,
}

async fn bounded_read(mut reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    (&mut reader)
        .take((MAX_IO + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "read_failed")?;
    if bytes.len() > MAX_IO {
        return Err("output_too_large".into());
    }
    Ok(bytes)
}

async fn execute(
    hook: &Hook,
    payload: &Value,
    cwd: &Path,
    budget: Duration,
) -> Result<Value, String> {
    let Some(program) = hook.argv.first().filter(|s| !s.is_empty()) else {
        return Err("empty_argv".into());
    };
    let input = serde_json::to_vec(payload).map_err(|_| "invalid_input")?;
    if input.len() > MAX_IO {
        return Err("input_too_large".into());
    }
    let mut command = Command::new(program);
    command
        .args(&hook.argv[1..])
        .current_dir(cwd)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::process::hide_console_window(&mut command);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| "spawn_failed")?;
    let pid = child.id();
    let mut stdin = child.stdin.take().ok_or("stdin_unavailable")?;
    let stdout = child.stdout.take().ok_or("stdout_unavailable")?;
    let stderr = child.stderr.take().ok_or("stderr_unavailable")?;
    let result = tokio::time::timeout(
        Duration::from_secs(hook.timeout.clamp(1, 15)).min(budget),
        async {
            let write = async {
                stdin
                    .write_all(&input)
                    .await
                    .map_err(|_| "write_failed".to_owned())?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|_| "write_failed".to_owned())?;
                drop(stdin);
                Ok::<_, String>(())
            };
            let wait = async { child.wait().await.map_err(|_| "wait_failed".to_owned()) };
            let (_, out, _, status) =
                tokio::try_join!(write, bounded_read(stdout), bounded_read(stderr), wait)?;
            if !status.success() {
                return Err("nonzero_exit".into());
            }
            serde_json::from_slice(&out).map_err(|_| "invalid_json".into())
        },
    )
    .await;
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) if error == "nonzero_exit" || error == "invalid_json" => Err(error),
        failed => {
            // Kill the process tree as well as the immediate child. A script's
            // descendants must not keep running after an expired hook.
            if let Some(pid) = pid {
                #[cfg(windows)]
                let mut stop = {
                    let mut c = Command::new("taskkill");
                    c.args(["/PID", &pid.to_string(), "/T", "/F"]);
                    c
                };
                #[cfg(unix)]
                let mut stop = {
                    let mut c = Command::new("kill");
                    c.args(["-KILL", "--", &format!("-{pid}")]);
                    c
                };
                #[cfg(any(windows, unix))]
                {
                    crate::process::hide_console_window(&mut stop);
                    stop.stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .kill_on_drop(true);
                    let _ = tokio::time::timeout(Duration::from_secs(2), stop.status()).await;
                }
            }
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            Err(match failed {
                Ok(Err(error)) => error,
                _ => "timeout".into(),
            })
        }
    }
}

/// Reload the user-level configuration for each provider request, including
/// resumed/compacted turns. Context is ephemeral and never stored in history.
pub(crate) async fn run(
    data_root: &Path,
    prompt: &str,
    session: Option<&str>,
    workspace: Option<&str>,
) -> HookResult {
    let mut result = HookResult::default();
    let config_path = data_root.join("hooks.json");
    if !config_path.exists() {
        return result;
    }
    let config = async {
        let metadata = tokio::fs::symlink_metadata(&config_path)
            .await
            .map_err(|_| "config_unreadable")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_CONFIG {
            return Err("invalid_config_file");
        }
        let data = tokio::fs::read(&config_path)
            .await
            .map_err(|_| "config_unreadable")?;
        serde_json::from_slice::<Config>(&data).map_err(|_| "invalid_config")
    }
    .await;
    let config = match config {
        Ok(config) => config,
        Err(code) => {
            result.events.push(json!({"status": code}));
            return result;
        }
    };
    let cwd = workspace
        .map(Path::new)
        .filter(|p| p.is_dir())
        .unwrap_or(data_root);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut count = 0;
    let mut context_bytes = 0;
    for event in ["UserPromptSubmit", "BeforeAgent"] {
        for hook in config
            .hooks
            .get(event)
            .into_iter()
            .flatten()
            .flat_map(|g| &g.hooks)
        {
            result.owns_router |= hook.name == OWNER;
            count += 1;
            if count > 16 || tokio::time::Instant::now() >= deadline {
                result
                    .events
                    .push(json!({"event": event, "status": "budget_exceeded"}));
                continue;
            }
            let payload = json!({"hook_event_name": event, "prompt": prompt, "session_id": session, "cwd": cwd});
            let value = execute(
                hook,
                &payload,
                cwd,
                deadline.saturating_duration_since(tokio::time::Instant::now()),
            )
            .await;
            let status = match value {
                Ok(value) => {
                    if value.get("continue").and_then(Value::as_bool) == Some(false)
                        || value.get("decision").and_then(Value::as_str) == Some("block")
                    {
                        result.blocked = true;
                    }
                    let output = value.get("hookSpecificOutput");
                    let output_event = output
                        .and_then(|v| v.get("hookEventName"))
                        .and_then(Value::as_str);
                    if output_event.is_some_and(|name| name != event) {
                        "event_mismatch"
                    } else if let Some(text) = output
                        .and_then(|v| v.get("additionalContext"))
                        .and_then(Value::as_str)
                    {
                        if text.len() + context_bytes > MAX_CONTEXT {
                            "context_too_large"
                        } else {
                            if !text.trim().is_empty() && !result.contexts.iter().any(|v| v == text)
                            {
                                context_bytes += text.len();
                                result.contexts.push(text.to_owned());
                            }
                            "context_loaded"
                        }
                    } else {
                        "completed"
                    }
                }
                Err(ref error) => {
                    result
                        .events
                        .push(json!({"event": event, "name": hook.name, "status": error}));
                    continue;
                }
            };
            result
                .events
                .push(json!({"event": event, "name": hook.name, "status": status}));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(script: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("levelup hook 测试 {}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("hook.py"), script).unwrap();
            let fixture = Self(root);
            fixture.configure(2);
            fixture
        }
        fn configure(&self, timeout: u64) {
            let python = if cfg!(windows) { "python" } else { "python3" };
            std::fs::write(self.0.join("hooks.json"), json!({"hooks": {
                "UserPromptSubmit": [{"hooks": [{"name": OWNER, "argv": [python, self.0.join("hook.py")], "timeout": timeout}]}]
            }}).to_string()).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn prompt_round_trips_through_stdin_and_uninstall_stops_execution() {
        let fixture = Fixture::new(
            "import json,sys\np=json.load(sys.stdin)\nprint(json.dumps({'hookSpecificOutput':{'hookEventName':p['hook_event_name'],'additionalContext':p['prompt']}}))\n",
        );
        let prompt = "测试路径 & $(shell) `literal` \"quotes\"\nnext line";
        let result = run(&fixture.0, prompt, Some("thread"), None).await;
        assert!(result.owns_router);
        assert_eq!(result.contexts, [prompt]);
        assert!(!result.events.iter().any(|e| e.to_string().contains(prompt)));
        std::fs::remove_file(fixture.0.join("hooks.json")).unwrap();
        let removed = run(&fixture.0, prompt, None, None).await;
        assert!(!removed.owns_router);
        assert!(removed.contexts.is_empty());
    }

    #[tokio::test]
    async fn malformed_failed_and_wrong_event_outputs_do_not_enter_context() {
        for script in [
            "print('not json')\n",
            "import sys\nprint('private prompt')\nsys.exit(1)\n",
            "import json\nprint(json.dumps({'hookSpecificOutput':{'hookEventName':'Stop','additionalContext':'wrong event'}}))\n",
        ] {
            let fixture = Fixture::new(script);
            let result = run(&fixture.0, "private prompt", None, None).await;
            assert!(result.contexts.is_empty());
            assert!(result.owns_router);
            assert!(
                !result
                    .events
                    .iter()
                    .any(|e| e.to_string().contains("private prompt"))
            );
        }
    }

    #[tokio::test]
    async fn stalled_hook_is_terminated_and_request_can_continue() {
        let fixture = Fixture::new("import time\ntime.sleep(30)\n");
        fixture.configure(1);
        let started = std::time::Instant::now();
        let result = run(&fixture.0, "test", None, None).await;
        assert!(started.elapsed() < Duration::from_secs(6));
        assert!(result.contexts.is_empty());
        assert_eq!(result.events[0]["status"], "timeout");
        assert!(!result.blocked);
    }

    #[tokio::test]
    async fn config_is_reloaded_and_duplicate_context_is_not_stacked() {
        let fixture = Fixture::new(
            "import json\nprint(json.dumps({'hookSpecificOutput':{'additionalContext':'reference'}}))\n",
        );
        let path = fixture.0.join("hooks.json");
        let mut config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        config["hooks"]["BeforeAgent"] = config["hooks"]["UserPromptSubmit"].clone();
        std::fs::write(&path, config.to_string()).unwrap();
        assert_eq!(
            run(&fixture.0, "turn", None, None).await.contexts,
            ["reference"]
        );
        std::fs::write(&path, "{\"hooks\":{}}").unwrap();
        assert!(
            run(&fixture.0, "turn after uninstall", None, None)
                .await
                .contexts
                .is_empty()
        );
    }
}
