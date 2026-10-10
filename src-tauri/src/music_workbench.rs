//! Desktop-owned audio service and IPC. Models never run inside the webview.
use crate::music_resources as resources;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

#[derive(Default)]
pub struct MusicWorkbench {
    service: Mutex<Option<Service>>,
    pub installer: Arc<resources::Installer>,
}
struct Service {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Service {
    async fn request(&mut self, action: &str, request: Value) -> Result<Value, String> {
        let line = format!("{}\n", json!({"action":action,"request":request}));
        self.input
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.input.flush().await.map_err(|e| e.to_string())?;
        let mut line = String::new();
        if self
            .output
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?
            == 0
        {
            return Err("音频服务已退出，请重新尝试。".into());
        }
        let result: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        Ok(result)
    }
    async fn close(self) {
        let Self {
            mut child,
            input,
            output,
        } = self;
        drop(input);
        drop(output);
        if tokio::time::timeout(Duration::from_secs(8), child.wait())
            .await
            .is_err()
        {
            #[cfg(windows)]
            if let Some(id) = child.id() {
                let mut command = Command::new("taskkill");
                command.args(["/PID", &id.to_string(), "/T", "/F"]);
                crate::process::hide_console_window(&mut command);
                let _ = command.output().await;
            }
            let _ = child.kill().await;
        }
    }
}
impl MusicWorkbench {
    pub async fn close(&self) {
        self.installer.cancel.store(true, Ordering::Release);
        if let Some(service) = self.service.lock().await.take() {
            service.close().await;
        }
    }
    async fn request(
        &self,
        app: &tauri::AppHandle,
        action: &str,
        request: Value,
    ) -> Result<Value, String> {
        let mut guard = self.service.lock().await;
        if self.installer.busy.load(Ordering::Acquire) {
            return Err("请等待音频环境安装完成。".into());
        }
        if guard.is_none() {
            *guard = Some(start_service(app)?);
        }
        match tokio::time::timeout(
            Duration::from_secs(20),
            guard.as_mut().unwrap().request(action, request),
        )
        .await
        {
            Ok(Ok(value)) => {
                if let Some(error) = value["error"].as_str() {
                    Err(error.to_owned())
                } else {
                    Ok(value["result"].clone())
                }
            }
            result => {
                if let Some(service) = guard.take() {
                    service.close().await;
                }
                match result {
                    Ok(Err(error)) => Err(error),
                    _ => Err("音频服务响应超时，请重试；运行任务已停止。".into()),
                }
            }
        }
    }
}
fn supported() -> bool {
    cfg!(all(windows, target_arch = "x86_64"))
}
fn storage(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("music-workbench");
    std::fs::create_dir_all(root.join("outputs")).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(root.join("outputs"), true)
        .map_err(|e| e.to_string())?;
    Ok(root)
}
fn start_service(app: &tauri::AppHandle) -> Result<Service, String> {
    if !supported() {
        return Err("本地音频生成当前支持 Windows x64；其他平台暂未提供运行环境。".into());
    }
    let root = storage(app)?;
    if !resources::installed(&root, "runtime") {
        return Err("请先下载音频运行环境。".into());
    }
    let module = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../modules/music_workbench")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("modules/music_workbench")
    };
    spawn_service(&root, &module)
}
fn spawn_service(root: &Path, module: &Path) -> Result<Service, String> {
    let resource_root = resources::resources(root);
    let mut command = Command::new(resource_root.join("runtime/python.exe"));
    command
        .args(["-u", "-B", "-s"])
        .arg(module.join("bridge.py"))
        .env("LEVELUP_MUSIC_DATA", root)
        .env("LEVELUP_MUSIC_MODELS", &resource_root)
        .env("LEVELUP_MUSIC_RUNTIME", resource_root.join("runtime"))
        .env("PYTHONUTF8", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::from(
            std::fs::File::create(root.join("service.log")).map_err(|e| e.to_string())?,
        ))
        .kill_on_drop(true);
    crate::process::hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("音频环境启动失败：{e}"))?;
    Ok(Service {
        input: child.stdin.take().ok_or("Missing audio input")?,
        output: BufReader::new(child.stdout.take().ok_or("Missing audio output")?),
        child,
    })
}

#[tauri::command]
pub async fn music_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicWorkbench>,
) -> Result<Value, String> {
    let root = storage(&app)?;
    let runtime = resources::installed(&root, "runtime");
    let operation = state
        .installer
        .operation
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut result = json!({"supported":supported(), "ready":false, "jobs":[], "runtimeReady":runtime, "modelReady":resources::installed(&root,"musicgen-small"),
        "root":root, "memory":resources::memory(), "diskFreeBytes":resources::disk_free(&root), "operation":operation, "resourceVersion":resources::spec()["resourceVersion"]});
    if runtime && !state.installer.busy.load(Ordering::Acquire) {
        match state.request(&app, "status", json!({})).await {
            Ok(service) => {
                result["ready"] = service["ready"].clone();
                result["jobs"] = service["jobs"].clone();
            }
            Err(error) => {
                result["serviceError"] = error.into();
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn music_hardware() -> Value {
    let mut command = Command::new("nvidia-smi");
    command
        .args([
            "--query-gpu=name,memory.total,memory.free,driver_version",
            "--format=csv,noheader,nounits",
        ])
        .kill_on_drop(true);
    crate::process::hide_console_window(&mut command);
    let mut gpus = Vec::new();
    if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(5), command.output()).await
        && output.status.success()
    {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let parts: Vec<_> = line.split(',').map(str::trim).collect();
            if parts.len() == 4
                && let (Ok(total), Ok(free)) = (parts[1].parse::<u64>(), parts[2].parse::<u64>())
            {
                gpus.push(
                    json!({"name":parts[0],"totalMiB":total,"freeMiB":free,"driver":parts[3]}),
                );
            }
        }
    }
    json!({"gpus":gpus,"memory":resources::memory(),"checkedAt":chrono::Utc::now().timestamp()})
}

#[tauri::command]
pub async fn music_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicWorkbench>,
    action: String,
    request: Value,
) -> Result<Value, String> {
    if !matches!(
        action.as_str(),
        "generate" | "cancel" | "trim" | "favorite" | "archive"
    ) || !request.is_object()
        || request.to_string().len() > 32_000
    {
        return Err("Invalid audio request".into());
    }
    if state.installer.busy.load(Ordering::Acquire) {
        return Err("请等待音频环境安装完成。".into());
    }
    state.request(&app, &action, request).await
}
#[tauri::command]
pub async fn music_manifest() -> Result<resources::Manifest, String> {
    resources::fetch_manifest().await
}

#[tauri::command]
pub async fn music_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, MusicWorkbench>,
    offline_directory: Option<String>,
) -> Result<(), String> {
    if !supported() {
        return Err("音频资源当前仅支持 Windows x64。".into());
    }
    let root = storage(&app)?;
    let offline = offline_directory.map(PathBuf::from);
    if state
        .installer
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("已有音频下载正在进行。".into());
    }
    state.installer.cancel.store(false, Ordering::Release);
    // Installation and inference must not replace a Python tree in use.
    let service = { state.service.lock().await.take() };
    if let Some(mut service) = service {
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            service.request("status", json!({})),
        )
        .await;
        if let Ok(Ok(status)) = result
            && status["result"]["jobs"].as_array().is_some_and(|jobs| {
                jobs.iter()
                    .any(|j| j["status"] == "queued" || j["status"] == "running")
            })
        {
            *state.service.lock().await = Some(service);
            state.installer.busy.store(false, Ordering::Release);
            return Err("请先等待生成完成或取消音频任务。".into());
        }
        service.close().await;
    }
    state
        .installer
        .report(json!({"status":"running","phase":"prepare","detail":"正在读取音频资源清单"}));
    let installer = state.installer.clone();
    tauri::async_runtime::spawn(async move {
        let result = resources::install(root, offline, installer.clone()).await;
        match result {
            Ok(()) => installer.report(json!({"status":"completed","phase":"completed","detail":"音频环境已安装","progress":1})),
            Err(error) => installer.report(json!({"status":if installer.cancel.load(Ordering::Acquire) {"cancelled"} else {"failed"},"detail":error})),
        }
        installer.busy.store(false, Ordering::Release);
    });
    Ok(())
}
#[tauri::command]
pub fn music_cancel_install(state: tauri::State<'_, MusicWorkbench>) {
    state.installer.cancel.store(true, Ordering::Release);
}

fn artifact(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("Invalid audio ID".into());
    }
    let outputs = root
        .join("outputs")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = outputs
        .join(id)
        .join("audio.wav")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&outputs) || !path.is_file() {
        return Err("Invalid audio path".into());
    }
    Ok(path)
}
#[tauri::command]
pub async fn music_artifact(app: tauri::AppHandle, id: String) -> Result<String, String> {
    Ok(artifact(&storage(&app)?, &id)?
        .to_string_lossy()
        .into_owned())
}
#[tauri::command]
pub async fn music_export(
    app: tauri::AppHandle,
    id: String,
    destination: String,
) -> Result<(), String> {
    let source = artifact(&storage(&app)?, &id)?;
    let destination = PathBuf::from(destination);
    if !destination.is_absolute()
        || !destination
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("wav"))
    {
        return Err("请选择 WAV 保存路径。".into());
    }
    if destination.canonicalize().ok().as_ref() == Some(&source) {
        return Ok(());
    }
    tokio::fs::copy(source, destination)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn music_artifact_rejects_path_traversal() {
        for id in [
            "../secret",
            "../../outside",
            "",
            "ABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
        ] {
            assert!(artifact(Path::new("."), id).is_err());
        }
    }

    #[tokio::test]
    #[ignore = "Requires locally prepared audio Release assets and a CUDA GPU or CPU runtime"]
    async fn music_portable_install_generate_cancel_and_eof() {
        let assets = PathBuf::from(std::env::var("MUSIC_TEST_ASSETS").expect("MUSIC_TEST_ASSETS"));
        let root = PathBuf::from(std::env::var("MUSIC_TEST_ROOT").expect("MUSIC_TEST_ROOT"));
        assert!(!root.exists(), "Use a fresh test root");
        std::fs::create_dir_all(root.join("outputs")).unwrap();
        let installer = Arc::new(resources::Installer::default());
        resources::install(root.clone(), Some(assets), installer)
            .await
            .unwrap();
        assert!(resources::installed(&root, "runtime"));
        let module = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../modules/music_workbench");
        let mut service = spawn_service(&root, &module).unwrap();
        assert_eq!(
            service.request("status", json!({})).await.unwrap()["result"]["ready"],
            true
        );
        let created = service.request("generate", json!({"prompt":"Soft warm piano, calm atmosphere, instrumental, no vocals", "title":"Portable runtime acceptance", "duration":4, "seed":20261009})).await.unwrap();
        assert!(created["error"].is_null(), "{created}");
        let id = created["result"]["id"].as_str().unwrap().to_owned();
        let started = std::time::Instant::now();
        let job = loop {
            let result = service.request("status", json!({})).await.unwrap();
            let job = result["result"]["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|j| j["id"] == id)
                .unwrap()
                .clone();
            if !matches!(job["status"].as_str(), Some("queued" | "running")) {
                break job;
            }
            assert!(
                started.elapsed() < Duration::from_secs(300),
                "Generation timeout"
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
        };
        assert_eq!(job["status"], "succeeded", "{job}");
        assert!(artifact(&root, &id).unwrap().is_file());
        let trimmed = service
            .request("trim", json!({"id":id,"start":0.5,"end":2.5,"fade":0.1}))
            .await
            .unwrap();
        assert_eq!(trimmed["result"]["audio"]["duration"], 2.0, "{trimmed}");
        let next = service
            .request(
                "generate",
                json!({"prompt":"Soft warm piano", "duration":30}),
            )
            .await
            .unwrap();
        let next_id = next["result"]["id"].as_str().unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(
            service
                .request("cancel", json!({"id":next_id}))
                .await
                .unwrap()["result"]["status"],
            "cancelled"
        );
        // Invalid user input must not kill the queue or desynchronize JSON lines.
        assert!(
            service
                .request("trim", json!({"id":id,"start":3,"end":1}))
                .await
                .unwrap()["error"]
                .is_string()
        );
        assert_eq!(
            service.request("status", json!({})).await.unwrap()["result"]["ready"],
            true
        );
        // Close the pipe with an active child: the worker must be stopped.
        service
            .request("generate", json!({"prompt":"Gentle flute", "duration":30}))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        service.close().await;
        let mut service = spawn_service(&root, &module).unwrap();
        let result = service.request("status", json!({})).await.unwrap();
        assert!(
            !result["result"]["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|j| j["status"] == "running" || j["status"] == "queued")
        );
        service.close().await;
        std::fs::write(
            root.join("acceptance.json"),
            serde_json::to_vec_pretty(
                &json!({"generation":job,"trim":trimmed,"afterRestart":result}),
            )
            .unwrap(),
        )
        .unwrap();
        println!("Audio acceptance and WAV outputs: {}", root.display());
    }
}
