//! Local 3D studio bridge. The lightweight bootstrap runs in Linux/WSL2;
//! CUDA, Python, Blender and model weights are versioned Release resources.
use base64::Engine;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{io::AsyncWriteExt, process::Command};

#[derive(Default)]
pub struct ModelWorkbench {
    busy: Arc<AtomicBool>,
}

struct BusyGuard(Arc<AtomicBool>);
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn storage(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("model-workbench");
    std::fs::create_dir_all(root.join("projects")).map_err(|e| e.to_string())?;
    // The parent may exist outside MSIX while its newly created child is
    // redirected. Resolve the child so Rust and WSL see the same data root.
    let projects = root
        .join("projects")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = projects
        .parent()
        .ok_or("Invalid 3D storage directory")?
        .to_path_buf();
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| e.to_string())?;
    Ok(root)
}

fn module(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../modules/model_workbench")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("modules/model_workbench")
    };
    root.join("launcher.py")
        .canonicalize()
        .map_err(|e| format!("3D launcher is missing: {e}"))
}

async fn linux_path(path: &Path) -> Result<String, String> {
    #[cfg(windows)]
    {
        let original = path.to_string_lossy();
        let plain = original.strip_prefix(r"\\?\").unwrap_or(&original);
        let mut command = Command::new("wsl.exe");
        command
            .args(["--exec", "wslpath", "-a", plain])
            .env("WSL_UTF8", "1")
            .kill_on_drop(true);
        crate::process::hide_console_window(&mut command);
        let output = tokio::time::timeout(Duration::from_secs(15), command.output())
            .await
            .map_err(|_| "WSL2 响应超时，请启动已安装的 Linux 发行版。")?
            .map_err(|e| format!("需要 WSL2 和 Linux Python 3：{e}"))?;
        if !output.status.success() {
            return Err("需要已安装的 WSL2 Linux 发行版（含 python3）。请先完成 WSL 设置。".into());
        }
        let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !result.starts_with('/') {
            return Err("无法转换 WSL 路径。".into());
        }
        Ok(result)
    }
    #[cfg(not(windows))]
    Ok(path.to_string_lossy().into_owned())
}

async fn launcher(app: &tauri::AppHandle, action: &str) -> Result<Command, String> {
    if cfg!(target_os = "macos") || !cfg!(target_arch = "x86_64") {
        return Err("本地 3D 生成目前需要 NVIDIA GPU，支持 Windows WSL2 / Linux x64。".into());
    }
    // Resolve Windows app-container redirection before passing a path to WSL.
    let data = storage(app)?.canonicalize().map_err(|e| e.to_string())?;
    let root = linux_path(&data).await?;
    let script = linux_path(&module(app)?).await?;
    let mut command = if cfg!(windows) {
        let mut command = Command::new("wsl.exe");
        command.args(["--exec", "python3"]).env("WSL_UTF8", "1");
        command
    } else {
        Command::new("python3")
    };
    command.args([
        &script,
        "--data",
        &root,
        "--version",
        env!("CARGO_PKG_VERSION"),
        action,
    ]);
    command.kill_on_drop(true);
    crate::process::hide_console_window(&mut command);
    Ok(command)
}

async fn query(app: &tauri::AppHandle, action: &str) -> Result<Value, String> {
    let mut command = launcher(app, action).await?;
    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| "环境检测超时，请检查 WSL 或网络。")?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        // WSL may prepend host PATH/proxy warnings. The launcher emits its
        // actionable error last; keep those startup diagnostics out of the UI.
        return Err(String::from_utf8_lossy(&output.stderr)
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("3D 运行环境启动失败，请检查 WSL2 与 Python 3。")
            .chars()
            .filter(|c| *c != '\0')
            .take(2400)
            .collect());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("Invalid 3D runtime response: {e}"))
}

#[tauri::command]
pub async fn model3d_status(app: tauri::AppHandle) -> Result<Value, String> {
    query(&app, "status").await
}

#[tauri::command]
pub async fn model3d_manifest(app: tauri::AppHandle) -> Result<Value, String> {
    query(&app, "manifest").await
}

#[tauri::command]
pub async fn model3d_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, ModelWorkbench>,
    action: String,
    mut request: Value,
) -> Result<(), String> {
    if !matches!(action.as_str(), "install" | "generate")
        || !request.is_object()
        || request.to_string().len() > 32_000
    {
        return Err("Invalid 3D request".into());
    }
    if state
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("已有下载或生成任务正在运行。".into());
    }
    let guard = BusyGuard(state.busy.clone());
    let root = storage(&app)?;
    if let Some(path) = request.get("offlineDirectory").and_then(Value::as_str) {
        let directory = PathBuf::from(path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        request["offlineDirectory"] = linux_path(&directory).await?.into();
    }
    let mut command = launcher(&app, &action).await?;
    let _ = std::fs::remove_file(root.join("cancel"));
    std::fs::write(root.join("lease"), b"alive").map_err(|e| e.to_string())?;
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null());
    let log = std::fs::File::create(root.join("launcher.log")).map_err(|e| e.to_string())?;
    command.stderr(std::process::Stdio::from(log));
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("Could not open worker input")?;
    stdin
        .write_all(request.to_string().as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    drop(stdin);
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                result = child.wait() => {
                    if !result.is_ok_and(|status| status.success()) {
                        let path = root.join("operation.json");
                        let mut value: Value = std::fs::read(&path).ok().and_then(|v| serde_json::from_slice(&v).ok()).unwrap_or(json!({}));
                        if value["status"] != "failed" && value["status"] != "cancelled" {
                            value["status"] = "failed".into();
                            value["detail"] = "运行环境未能启动，请检查 launcher.log 后重试。".into();
                            let _ = std::fs::write(path, value.to_string());
                        }
                    }
                    break;
                },
                _ = interval.tick() => { let _ = std::fs::write(root.join("lease"), b"alive"); }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn model3d_cancel(app: tauri::AppHandle) -> Result<(), String> {
    std::fs::write(storage(&app)?.join("cancel"), b"cancel").map_err(|e| e.to_string())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

#[tauri::command]
pub async fn model3d_import(app: tauri::AppHandle, source: String) -> Result<Value, String> {
    let source = PathBuf::from(source)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let metadata = std::fs::metadata(&source).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err("参考图不能超过 16 MiB。".into());
    }
    let bytes = tokio::fs::read(&source).await.map_err(|e| e.to_string())?;
    if !(bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(b"\xff\xd8\xff")) {
        return Err("请选择 PNG 或 JPEG 参考图。".into());
    }
    let size = imagesize::blob_size(&bytes).map_err(|_| "无效的参考图片。")?;
    if size.width * size.height > 20_000_000 || size.width < 32 || size.height < 32 {
        return Err("参考图需至少 32 × 32，且不超过 2000 万像素。".into());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let root = storage(&app)?.join("projects").join(&id);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    tokio::fs::write(root.join("input.png"), bytes)
        .await
        .map_err(|e| e.to_string())?;
    let project = json!({"id":id, "name":source.file_stem().unwrap_or_default().to_string_lossy(),
        "updatedAt":chrono::Utc::now().timestamp(), "stages":{}});
    std::fs::write(root.join("project.json"), project.to_string()).map_err(|e| e.to_string())?;
    Ok(project)
}

fn save_reference(root: &Path, project_id: &str, image: Option<&str>) -> Result<Value, String> {
    if !valid_id(project_id) {
        return Err("Invalid project ID".into());
    }
    let project = root
        .join("projects")
        .join(project_id)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !project.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("Invalid project path".into());
    }
    let metadata = project.join("project.json");
    let mut record: Value =
        serde_json::from_slice(&std::fs::read(&metadata).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if !record.is_object() {
        return Err("Invalid project record".into());
    }
    if let Some(image) = image {
        if image.len() > 12 * 1024 * 1024 {
            return Err("Processed PNG exceeds 9 MiB".into());
        }
        let encoded = image
            .strip_prefix("data:image/png;base64,")
            .ok_or("Expected PNG data URL")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid PNG data")?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Expected PNG image".into());
        }
        let size = imagesize::blob_size(&bytes).map_err(|_| "Invalid PNG image")?;
        if size.width < 32 || size.height < 32 || size.width > 2048 || size.height > 2048 {
            return Err("Invalid reference dimensions".into());
        }
        let file = format!("reference-{}.png", uuid::Uuid::new_v4().simple());
        std::fs::write(project.join(&file), bytes).map_err(|e| e.to_string())?;
        record["reference"] = json!({"file":file,"method":"spine-solid-background"});
    } else {
        record
            .as_object_mut()
            .ok_or("Invalid project record")?
            .remove("reference");
    }
    record["updatedAt"] = (chrono::Utc::now().timestamp_millis() as f64 / 1000.0).into();
    let temporary = project.join(format!("project-{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&temporary, record.to_string()).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&temporary, &metadata) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(record)
}

#[tauri::command]
pub async fn model3d_reference(
    app: tauri::AppHandle,
    state: tauri::State<'_, ModelWorkbench>,
    project_id: String,
    image: Option<String>,
) -> Result<Value, String> {
    if state
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("请等待当前下载或生成完成。".into());
    }
    let _guard = BusyGuard(state.busy.clone());
    save_reference(&storage(&app)?, &project_id, image.as_deref())
}

fn artifact(root: &Path, project_id: &str, stage: &str, name: &str) -> Result<PathBuf, String> {
    if !valid_id(project_id)
        || !matches!(stage, "input" | "shape" | "texture" | "rig")
        || !matches!(
            name,
            "input.png"
                | "reference.png"
                | "model.glb"
                | "basecolor.png"
                | "delivery.zip"
                | "validation.json"
                | "character.blend"
                | "character.fbx"
        )
    {
        return Err("Invalid 3D artifact".into());
    }
    let project = root.join("projects").join(project_id);
    let path = if stage == "input" && name == "input.png" {
        project.join(name)
    } else if stage == "input" && name == "reference.png" {
        let record: Value = serde_json::from_slice(
            &std::fs::read(project.join("project.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        project.join(record["reference"]["file"].as_str().unwrap_or("input.png"))
    } else {
        let record: Value = serde_json::from_slice(
            &std::fs::read(project.join("project.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let directory = record["stages"][stage]["directory"]
            .as_str()
            .ok_or("阶段结果不存在。")?;
        project.join(directory).join(name)
    };
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(project.canonicalize().map_err(|e| e.to_string())?)
        || !canonical.is_file()
    {
        return Err("Invalid artifact path".into());
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn model3d_artifact(
    app: tauri::AppHandle,
    project_id: String,
    stage: String,
    name: String,
) -> Result<String, String> {
    Ok(artifact(&storage(&app)?, &project_id, &stage, &name)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn model3d_export(
    app: tauri::AppHandle,
    project_id: String,
    stage: String,
    name: String,
    destination: String,
) -> Result<(), String> {
    let source = artifact(&storage(&app)?, &project_id, &stage, &name)?;
    let destination = PathBuf::from(destination);
    if !destination.is_absolute() || destination.extension() != source.extension() {
        return Err("导出文件扩展名不匹配。".into());
    }
    if destination.exists() && destination.canonicalize().ok().as_ref() == Some(&source) {
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
    fn reference_apply_restore_preserves_original_and_completed_stages() {
        let root = std::env::temp_dir().join(format!("levelup-reference-{}", uuid::Uuid::new_v4()));
        let id = "b".repeat(32);
        let project = root.join("projects").join(&id);
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("input.png"), b"untouched-original").unwrap();
        let original = json!({"id":id,"stages":{"shape":{"directory":"runs/original"}}});
        std::fs::write(project.join("project.json"), original.to_string()).unwrap();
        let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAN0lEQVR4nO3QQQ0AMAgEwVJlSEMesggq+MwZ2MtEZfc73L+MO0CAAAECBAgQIECAAAECBAgswQBZ8QKQ3gJ+OgAAAABJRU5ErkJggg==";
        let saved = save_reference(&root, &id, Some(image)).unwrap();
        assert_eq!(saved["stages"], original["stages"]);
        let cutout = artifact(&root, &id, "input", "reference.png").unwrap();
        assert!(
            cutout
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("reference-")
        );
        assert_eq!(
            std::fs::read(project.join("input.png")).unwrap(),
            b"untouched-original"
        );
        let restored = save_reference(&root, &id, None).unwrap();
        assert!(restored.get("reference").is_none());
        assert_eq!(restored["stages"], original["stages"]);
        assert_eq!(
            artifact(&root, &id, "input", "reference.png").unwrap(),
            project.join("input.png").canonicalize().unwrap()
        );
        assert!(cutout.exists());
        assert!(save_reference(&root, "../escape", Some(image)).is_err());
        assert!(save_reference(&root, &id, Some("data:image/png;base64,broken")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn artifact_rejects_traversal_and_unknown_files() {
        assert!(artifact(Path::new("."), "../secrets", "shape", "model.glb").is_err());
        assert!(artifact(Path::new("."), &"a".repeat(32), "shape", "../../secret").is_err());
        assert!(artifact(Path::new("."), &"a".repeat(32), "other", "model.glb").is_err());
    }
}
