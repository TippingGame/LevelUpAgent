//! One restricted stdio child per account. No network listener is exposed by the host.
use super::types::*;
use crate::database::Database;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

struct Running {
    cancel: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
}
#[derive(Default)]
pub struct Runtime {
    services: Mutex<HashMap<String, Running>>,
    pub states: Mutex<HashMap<String, AccountState>>,
    /// Orders pause/reconfiguration against the final outbox claim + IPC send.
    pub gate: Mutex<()>,
    installer: Mutex<()>,
    pub shutdown: CancellationToken,
}
impl Runtime {
    pub async fn close(&self) {
        self.shutdown.cancel();
        let services = std::mem::take(&mut *self.services.lock().await);
        for s in services.values() {
            s.cancel.cancel();
        }
        for (_, s) in services {
            let _ = s.task.await;
        }
    }
}
fn root_for(app: &tauri::AppHandle, desktop: bool) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(if desktop {
            "chatbot-desktop-runtime-v1"
        } else {
            "chatbot-runtime-v1"
        }))
}
fn python_for(app: &tauri::AppHandle, desktop: bool) -> Result<PathBuf, String> {
    Ok(root_for(app, desktop)?.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    }))
}
fn source(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../modules/chat_gateway");
        if p.join("gateway.py").is_file() {
            return Ok(p);
        }
    }
    Ok(app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("modules/chat_gateway"))
}
pub fn ready(app: &tauri::AppHandle) -> bool {
    ready_for(app, false)
}
pub fn ready_for(app: &tauri::AppHandle, desktop: bool) -> bool {
    python_for(app, desktop).is_ok_and(|p| p.is_file())
        && root_for(app, desktop).is_ok_and(|p| p.join("ready-v1").is_file())
}
pub async fn detect_python(
    app: &tauri::AppHandle,
    desktop: bool,
) -> Result<Option<super::python::Python>, String> {
    Ok(super::python::detect(Some(&python_for(app, desktop)?), desktop).await)
}

async fn check_runtime(app: &tauri::AppHandle, desktop: bool) -> Result<bool, String> {
    let mut cmd = Command::new(python_for(app, desktop)?);
    cmd.arg(source(app)?.join(if desktop {
        "desktop_gateway.py"
    } else {
        "gateway.py"
    }))
    .env("PYTHONUTF8", "1")
    .arg("--check")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    crate::process::hide_console_window(&mut cmd);
    Ok(tokio::time::timeout(Duration::from_secs(30), cmd.status())
        .await
        .is_ok_and(|result| result.is_ok_and(|status| status.success())))
}

pub async fn install(
    app: &tauri::AppHandle,
    executable: Option<&str>,
    desktop: bool,
) -> Result<(), String> {
    if desktop && !cfg!(windows) {
        return Err("Desktop DingTalk requires Windows".into());
    }
    let runtime = app.state::<Runtime>();
    let _installer = runtime
        .installer
        .try_lock()
        .map_err(|_| "Chat gateway installation is already running")?;
    if !runtime.services.lock().await.is_empty() {
        return Err("Disable platform accounts before changing the runtime".into());
    }
    // Preflight before changing the managed runtime or removing its ready marker.
    let selected = if let Some(path) = executable.filter(|s| !s.trim().is_empty()) {
        super::python::inspect(std::path::Path::new(path), desktop).await?
    } else {
        detect_python(app, desktop).await?.ok_or_else(|| format!(
            "No compatible installed Python was detected. Required: {}. If Python is installed in a custom directory, choose python.exe manually.", super::python::requirement(desktop)))?
    };
    let managed = python_for(app, desktop)?;
    let existing = super::python::inspect(&managed, desktop).await.is_ok();
    // Rechecking an already healthy environment requires no network or pip run.
    if existing && check_runtime(app, desktop).await? {
        std::fs::write(root_for(app, desktop)?.join("ready-v1"), "1").map_err(|e| e.to_string())?;
        return Ok(());
    }
    let target = root_for(app, desktop)?;
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    crate::filesystem::restrict_directory(&target)?;
    let _ = std::fs::remove_file(target.join("ready-v1"));
    if !existing {
        let mut cmd = Command::new(&selected.executable);
        cmd.args(["-m", "venv", "--clear"])
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        crate::process::hide_console_window(&mut cmd);
        let status = tokio::time::timeout(Duration::from_secs(120), cmd.status())
            .await
            .map_err(|_| "Creating Python environment timed out")?
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(
                "Could not create a Python virtual environment; Python 3.10+ with venv is required"
                    .into(),
            );
        }
    }
    let mut cmd = Command::new(python_for(app, desktop)?);
    cmd.env("PYTHONUTF8", "1");
    cmd.args([
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "-r",
    ])
    .arg(source(app)?.join(if desktop {
        "requirements-desktop.txt"
    } else {
        "requirements.txt"
    }))
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    crate::process::hide_console_window(&mut cmd);
    let status = tokio::time::timeout(Duration::from_secs(600), cmd.status())
        .await
        .map_err(|_| "SDK installation timed out; check PyPI connectivity")?
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(
            "Could not install pinned gateway SDKs; check Python version and PyPI connectivity"
                .into(),
        );
    }
    if !check_runtime(app, desktop).await? {
        return Err(
            "Gateway check failed; desktop mode requires Windows and Python 3.10–3.12".into(),
        );
    }
    std::fs::write(target.join("ready-v1"), "1").map_err(|e| e.to_string())?;
    Ok(())
}
async fn status(app: &tauri::AppHandle, id: &str, state: &str, detail: &str) {
    app.state::<Runtime>().states.lock().await.insert(
        id.into(),
        AccountState {
            account_id: id.into(),
            status: state.into(),
            detail: detail.into(),
        },
    );
}
pub async fn disconnect(app: &tauri::AppHandle, id: &str) {
    let item = app.state::<Runtime>().services.lock().await.remove(id);
    if let Some(s) = item {
        s.cancel.cancel();
        let _ = s.task.await;
    }
    status(app, id, "stopped", "Account is offline").await;
}
pub async fn connect(app: &tauri::AppHandle, account: Account) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let _installer = match runtime.installer.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            status(
                app,
                &account.id,
                "setup_required",
                "Wait for gateway installation to finish, then reconnect",
            )
            .await;
            return Err("Wait for gateway installation to finish".into());
        }
    };
    let desktop = account.platform == "dingtalk_desktop";
    if !ready_for(app, desktop) {
        status(
            app,
            &account.id,
            "setup_required",
            "Install the chat gateway runtime first",
        )
        .await;
        return Err("Install the chat gateway runtime first".into());
    }
    let secret = if desktop {
        String::new()
    } else {
        match crate::credential(&format!("chatbot:{}", account.id)).and_then(|entry| {
            entry
                .get_password()
                .map_err(|_| "Credential unavailable".to_string())
        }) {
            Ok(value) => value,
            Err(_) => {
                status(
                    app,
                    &account.id,
                    "credential_required",
                    "Save the platform secret/access token first",
                )
                .await;
                return Err("Save the platform secret/access token first".into());
            }
        }
    };
    let runtime = app.state::<Runtime>();
    let mut services = runtime.services.lock().await;
    if services.contains_key(&account.id) {
        return Ok(());
    }
    let cancel = runtime.shutdown.child_token();
    let child_cancel = cancel.clone();
    let id = account.id.clone();
    let app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut delay = 2;
        while !child_cancel.is_cancelled() {
            status(
                &app,
                &account.id,
                "connecting",
                if desktop {
                    "Starting local DingTalk desktop controller"
                } else {
                    "Starting official gateway / external OneBot connection"
                },
            )
            .await;
            let result = serve(&app, &account, &secret, &child_cancel).await;
            let _ = app
                .state::<Database>()
                .chat_account_disconnected(&account.id);
            if child_cancel.is_cancelled() {
                break;
            }
            status(
                &app,
                &account.id,
                "reconnecting",
                if result.is_err() {
                    "Gateway disconnected; retrying with bounded backoff"
                } else {
                    "Gateway exited; restarting"
                },
            )
            .await;
            tokio::select! {_=child_cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(delay))=>{}}
            delay = (delay * 2).min(30);
        }
    });
    services.insert(id, Running { cancel, task });
    Ok(())
}
async fn line(
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    let size = reader
        .take(65537)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    if size == 0 {
        return Ok(None);
    }
    if size > 65536 || bytes.last() != Some(&b'\n') {
        return Err("Oversized gateway frame".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Invalid gateway frame".into())
}
async fn write(input: &mut tokio::process::ChildStdin, value: Value) -> Result<(), String> {
    let data = format!("{value}\n");
    tokio::time::timeout(Duration::from_secs(3), input.write_all(data.as_bytes()))
        .await
        .map_err(|_| "Gateway input timeout")?
        .map_err(|e| e.to_string())
}
async fn serve(
    app: &tauri::AppHandle,
    account: &Account,
    secret: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let desktop = account.platform == "dingtalk_desktop";
    let mut cmd = Command::new(python_for(app, desktop)?);
    cmd.arg("-u")
        .arg(source(app)?.join(if desktop {
            "desktop_gateway.py"
        } else {
            "gateway.py"
        }))
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if desktop {
        // Hash the stored account ID instead of allowing it to become a path.
        use sha2::{Digest, Sha256};
        let filename = format!("state-{:x}.json", Sha256::digest(account.id.as_bytes()));
        cmd.arg("--state").arg(root_for(app, true)?.join(filename));
    }
    crate::process::hide_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut input = child.stdin.take().ok_or("No gateway input")?;
    let mut output = BufReader::new(child.stdout.take().ok_or("No gateway output")?);
    write(
        &mut input,
        json!({"type":"configure","version":1,"account":account,"secret":secret,"routes":desktop_routes(app, &account.id)?}),
    )
    .await?;
    let (frames, mut incoming) = tokio::sync::mpsc::channel(64);
    let reader = tokio::spawn(async move {
        while let Ok(Some(v)) = line(&mut output).await {
            if frames.send(v).await.is_err() {
                break;
            }
        }
    });
    let mut tick = tokio::time::interval(Duration::from_millis(400));
    let mut online = false;
    let mut in_flight: Option<(String, std::time::Instant)> = None;
    let result=async{loop{tokio::select!{
        _=cancel.cancelled()=>break Ok(()),
        value=incoming.recv()=>{let Some(value)=value else{break Err("Gateway closed output".to_string())};match value["type"].as_str(){
            Some("status")=>{let state=value["status"].as_str().unwrap_or("connecting");online=state=="online";
                if desktop {
                    let state=if ["online","waiting","error","connecting"].contains(&state) {state} else {"waiting"};
                    let detail=value["detail"].as_str().unwrap_or("Desktop transport").chars().take(300).collect::<String>();
                    status(app,&account.id,state,&detail).await;
                } else {status(app,&account.id,if online{"online"}else{"connecting"},if online{"Transport connected; text messages enabled"}else{"Connecting to platform"}).await;}
            },
            Some("inbound")=>{
                let parsed=serde_json::from_value::<Inbound>(value["message"].clone()).map_err(|_|"Invalid inbound frame".to_string());
                let result=parsed.and_then(|m|app.state::<Database>().chat_receive(&account.id,m));
                write(&mut input,json!({"type":"ack","requestId":value["requestId"],"ok":result.is_ok()})).await?;
            },
            Some("delivery")=>{if let Some(id)=value["id"].as_str()
                && in_flight.as_ref().is_some_and(|(known,_)|known==id){
                    if desktop && value["status"].as_str()==Some("deferred") {
                        let runtime=app.state::<Runtime>();
                        let guard=tokio::select!{_=cancel.cancelled()=>break Ok(()),guard=runtime.gate.lock()=>guard};
                        app.state::<Database>().chat_delivery_deferred(&account.id,id)?;
                        drop(guard);
                        online=false; // Wait for a successful, idle scan before retry.
                        status(app,&account.id,"waiting","钉钉正在使用或有草稿，原回复保留排队").await;
                    } else {
                        app.state::<Database>().chat_delivery_result(&account.id,id,value["status"].as_str().unwrap_or("delivery_unknown"))?;
                    }
                    in_flight=None;
                }},
            _=>{}
        }},
        _=tick.tick()=>{
            if in_flight.as_ref().is_some_and(|(_,started)|started.elapsed()>Duration::from_secs(45)){break Err("Send confirmation timed out".into());}
            if online && in_flight.is_none(){
                let runtime=app.state::<Runtime>();
                // Cancellation remains responsive while configuration holds the send gate.
                let guard=tokio::select!{_=cancel.cancelled()=>break Ok(()),guard=runtime.gate.lock()=>guard};
                if let Some(delivery)=app.state::<Database>().chat_delivery(&account.id)? {
                    in_flight=Some((delivery.id.clone(),std::time::Instant::now()));
                    write(&mut input,json!({"type":"send","delivery":delivery})).await?;
                }
                drop(guard);
            }
        }
    }}}.await;
    reader.abort();
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

fn desktop_routes(app: &tauri::AppHandle, account: &str) -> Result<Vec<Route>, String> {
    let dashboard = app.state::<Database>().chat_dashboard()?;
    Ok(dashboard
        .routes
        .into_iter()
        .filter(|r| {
            r.account_id == account
                && !r.paused
                && dashboard.bots.iter().any(|b| b.id == r.bot_id && b.enabled)
        })
        .collect())
}

pub async fn refresh_desktops(app: &tauri::AppHandle) -> Result<(), String> {
    for account in app
        .state::<Database>()
        .chat_accounts()?
        .into_iter()
        .filter(|a| a.platform == "dingtalk_desktop" && a.enabled)
    {
        disconnect(app, &account.id).await;
        let _ = connect(app, account).await;
    }
    Ok(())
}

pub async fn desktop_probe(app: &tauri::AppHandle, request: Value) -> Result<Value, String> {
    if !cfg!(windows) || !ready_for(app, true) {
        return Err("Install the Windows desktop runtime first".into());
    }
    if app
        .state::<Database>()
        .chat_accounts()?
        .iter()
        .any(|a| a.platform == "dingtalk_desktop" && a.enabled)
    {
        return Err("Disconnect the desktop account before preview/calibration".into());
    }
    let mut cmd = Command::new(python_for(app, true)?);
    cmd.arg(source(app)?.join("desktop_gateway.py"))
        .arg("--probe")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::process::hide_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut input = child.stdin.take().ok_or("No probe stdin")?;
    write(&mut input, request).await?;
    drop(input);
    let output = tokio::time::timeout(Duration::from_secs(90), child.wait_with_output())
        .await
        .map_err(|_| "Desktop preview timed out")?
        .map_err(|e| e.to_string())?;
    let result: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "Invalid desktop preview result")?;
    if !output.status.success() {
        return Err(result["detail"]
            .as_str()
            .unwrap_or("Desktop preview failed")
            .to_string());
    }
    Ok(result)
}

pub fn clear_desktop_state(app: &tauri::AppHandle, account: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let filename = format!("state-{:x}.json", Sha256::digest(account.as_bytes()));
    let path = root_for(app, true)?.join(filename);
    for target in [path.with_extension("tmp"), path] {
        match std::fs::remove_file(target) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
