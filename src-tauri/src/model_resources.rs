//! Immutable, independently versioned Windows 3D resources. Bootstrap needs no Python.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;

pub const COMPONENTS: [&str; 4] = ["runtime", "triposg", "texture", "blender"];
pub const SPEC: &str = include_str!("../../modules/model_workbench/resources-windows.json");
pub fn spec() -> Value {
    serde_json::from_str(SPEC).expect("Windows 3D resource spec")
}
pub fn manifest_name() -> String {
    let s = spec();
    format!(
        "model-workbench-{}-{}.json",
        s["resourceVersion"].as_str().unwrap(),
        s["target"].as_str().unwrap()
    )
}
fn base_url() -> String {
    format!(
        "https://github.com/TippingGame/LevelUpAgent/releases/download/{}",
        spec()["releaseTag"].as_str().unwrap()
    )
}
pub fn resources(data: &Path) -> PathBuf {
    data.join("resources")
        .join(spec()["resourceVersion"].as_str().unwrap())
        .join(spec()["target"].as_str().unwrap())
}
pub fn required(name: &str) -> Vec<&'static str> {
    match name {
        "runtime" => vec![
            "python/python.exe",
            "python/python310._pth",
            "ready.json",
            "python/Lib/site-packages/torch/__init__.py",
            "python/Lib/site-packages/nvdiffrast/nvdiffrast_plugin.pyd",
            "vendor/TripoSG/triposg/pipelines/pipeline_triposg.py",
            "vendor/MV-Adapter/mvadapter/__init__.py",
        ],
        "triposg" => vec!["model_index.json"],
        "texture" => vec![
            "base/model_index.json",
            "adapter/mvadapter_ig2mv_sd21.safetensors",
            "provenance.json",
        ],
        "blender" => vec!["blender.exe"],
        _ => vec![],
    }
}
pub fn read_json(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or(Value::Null)
}
pub fn installed(root: &Path, name: &str) -> bool {
    let manifest = fs::read(root.join("manifest.json"))
        .ok()
        .and_then(|v| validate(&v).ok());
    let Some(manifest) = manifest else {
        return false;
    };
    let Some(component) = manifest.components.get(name) else {
        return false;
    };
    let marker = read_json(&root.join(name).join(".installed.json"));
    marker["resourceVersion"] == spec()["resourceVersion"]
        && marker["target"] == spec()["target"]
        && marker["sha256"] == component.sha256
        && required(name)
            .iter()
            .all(|file| root.join(name).join(file).is_file())
}
fn resource_lock(root: &Path) -> Result<fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(root.join(".operation.lock"))
        .map_err(|e| format!("另一个工作台正在使用这些 3D 资源，请稍后重试：{e}"))
}

pub async fn status(data: &Path, installer: &Installer) -> Result<Value, String> {
    let root = resources(data);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut projects = Vec::new();
    for entry in fs::read_dir(data.join("projects"))
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let project = read_json(&entry.path().join("project.json"));
        if project.is_object() {
            projects.push(project);
        }
    }
    projects.sort_by(|a, b| {
        b["updatedAt"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["updatedAt"].as_f64().unwrap_or(0.0))
    });
    let current = installer
        .operation
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut operation = if current.is_null() {
        read_json(&data.join("operation.json"))
    } else {
        current
    };
    if operation["status"] == "running" && operation["kind"] != "install" {
        let alive = fs::metadata(data.join("lease"))
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age < Duration::from_secs(30));
        if !alive {
            operation["status"] = json!("interrupted");
            operation["detail"] = json!("运行已中断，可以重试；已完成的阶段仍保留。");
        }
    } else if operation["status"] == "running"
        && installer
            .operation
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_null()
    {
        operation["status"] = json!("interrupted");
        operation["detail"] = json!("安装已中断，重新导入可继续。");
    }
    if let Some(run) = operation["run"]
        .as_str()
        .filter(|p| crate::music_resources::safe_entry(p))
    {
        let progress = read_json(&data.join(run).join("progress.json"));
        if !progress.is_null() {
            operation["worker"] = progress;
        }
    }
    let mut gpus = Vec::new();
    let mut command = tokio::process::Command::new("nvidia-smi");
    command
        .args([
            "--query-gpu=name,memory.total,memory.free,driver_version",
            "--format=csv,noheader,nounits",
        ])
        .kill_on_drop(true);
    crate::process::hide_console_window(&mut command);
    if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(5), command.output()).await {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let cells: Vec<_> = line.split(',').map(str::trim).collect();
            if cells.len() == 4
                && let (Ok(total), Ok(free)) = (cells[1].parse::<u64>(), cells[2].parse::<u64>())
            {
                gpus.push(
                    json!({"name":cells[0],"totalMiB":total,"freeMiB":free,"driver":cells[3]}),
                );
            }
        }
    }
    let memory = crate::music_resources::memory();
    let components: BTreeMap<_, _> = COMPONENTS
        .iter()
        .map(|name| (*name, installed(&root, name)))
        .collect();
    let manifest = fs::read(root.join("manifest.json"))
        .ok()
        .and_then(|v| validate(&v).ok());
    Ok(
        json!({"version":env!("CARGO_PKG_VERSION"),"resourceVersion":spec()["resourceVersion"],"runtimeRoot":root,
        "system":{"platform":spec()["target"],"gpus":gpus,"ramTotalMiB":memory["totalMiB"],"ramAvailableMiB":memory["availableMiB"],
            "diskFreeBytes":crate::music_resources::disk_free(&root)},
        "components":components,"manifest":manifest,"projects":projects,"operation":operation,
        "estimates":{"shape":{"vramMiB":10500,"ramMiB":18000},"texture":{"vramMiB":6000,"ramMiB":14000},"rig":{"vramMiB":0,"ramMiB":4000}}}),
    )
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub label: String,
    pub unpacked_bytes: u64,
    pub sha256: String,
    pub parts: Vec<Part>,
    pub license: String,
    pub sources: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub resource_version: String,
    pub release_tag: String,
    pub target: String,
    pub cuda: String,
    pub components: BTreeMap<String, Component>,
}
fn hash_valid(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub fn validate(bytes: &[u8]) -> Result<Manifest, String> {
    if bytes.len() > 1024 * 1024 {
        return Err("资源清单过大".into());
    }
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(&manifest).map_err(|e| e.to_string())?;
    for key in [
        "schemaVersion",
        "resourceVersion",
        "releaseTag",
        "target",
        "cuda",
    ] {
        if value[key] != spec()[key] {
            return Err(format!("3D资源版本不兼容：{key}"));
        }
    }
    if manifest.components.len() != 4
        || COMPONENTS
            .iter()
            .any(|n| !manifest.components.contains_key(*n))
    {
        return Err("资源组件不完整".into());
    }
    for (name, c) in &manifest.components {
        if c.unpacked_bytes == 0
            || c.unpacked_bytes > 40 * 1024_u64.pow(3)
            || !hash_valid(&c.sha256)
            || c.license.is_empty()
            || c.sources.is_empty()
            || c.parts.is_empty()
            || c.parts.len() > 64
        {
            return Err("无效的资源组件".into());
        }
        for (i, p) in c.parts.iter().enumerate() {
            let expected = format!(
                "model-workbench-{}-{}-{}.zip.part{:03}",
                manifest.resource_version,
                manifest.target,
                name,
                i + 1
            );
            if p.name != expected
                || p.bytes == 0
                || p.bytes >= 2_000_000_000
                || !hash_valid(&p.sha256)
            {
                return Err("无效的资源分卷".into());
            }
        }
    }
    Ok(manifest)
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("LevelUpAgent-3D/1")
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}
pub async fn fetch_manifest() -> Result<Manifest, String> {
    let response = client()?
        .get(format!("{}/{}", base_url(), manifest_name()))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("此版本的3D资源尚未发布，请稍后重试，或导入离线资源包。".into());
    }
    let mut response = response.error_for_status().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > 1024 * 1024 {
            return Err("资源清单过大".into());
        }
    }
    validate(&bytes)
}

#[derive(Default)]
pub struct Installer {
    pub cancel: AtomicBool,
    pub operation: Mutex<Value>,
}
impl Installer {
    pub fn report(&self, mut value: Value) {
        value["kind"] = json!("install");
        *self.operation.lock().unwrap_or_else(|e| e.into_inner()) = value;
    }
    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            Err("已取消下载，已完成的分卷会在重试时复用。".into())
        } else {
            Ok(())
        }
    }
}
fn digest(file: &Path, state: &Installer) -> Result<String, String> {
    let name = file
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut file = fs::File::open(file).map_err(|e| e.to_string())?;
    let total = file.metadata().map_err(|e| e.to_string())?.len().max(1);
    let mut verified = 0u64;
    let mut hash = Sha256::new();
    let mut block = vec![0; 4 * 1024 * 1024];
    loop {
        state.check()?;
        let n = file.read(&mut block).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&block[..n]);
        verified += n as u64;
        state.report(json!({"status":"running","phase":"verify","detail":name,"progress":verified as f64/total as f64}));
    }
    Ok(format!("{:x}", hash.finalize()))
}

async fn download(
    part: &Part,
    path: &Path,
    state: &Installer,
    prior: u64,
    total: u64,
) -> Result<(), String> {
    download_from(
        &format!("{}/{}", base_url(), part.name),
        part,
        path,
        state,
        prior,
        total,
    )
    .await
}
async fn download_from(
    url: &str,
    part: &Part,
    path: &Path,
    state: &Installer,
    prior: u64,
    total: u64,
) -> Result<(), String> {
    state.check()?;
    if path.is_file() && fs::metadata(path).map_err(|e| e.to_string())?.len() == part.bytes {
        state.report(json!({"status":"running", "phase":"verify", "detail":part.name, "downloadedBytes":prior, "totalBytes":total}));
        if digest(path, state)? == part.sha256 {
            return Ok(());
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let partial = path.with_file_name(format!("{}.partial", part.name));
    let mut offset = fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    if offset >= part.bytes {
        fs::remove_file(&partial).map_err(|e| e.to_string())?;
        offset = 0;
    }
    let mut request = client()?.get(url);
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-"));
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let range = format!("bytes {}-{}/{}", offset, part.bytes - 1, part.bytes);
        if response
            .headers()
            .get("content-range")
            .and_then(|h| h.to_str().ok())
            != Some(range.as_str())
        {
            return Err("下载续传范围不匹配，请重试。".into());
        }
    } else if response.status() == reqwest::StatusCode::OK {
        offset = 0;
    } else {
        return Err("无效的下载响应".into());
    }
    let initial = offset;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(&partial)
        .await
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let mut last = Instant::now() - Duration::from_secs(1);
    loop {
        state.check()?;
        let chunk = response.chunk().await.map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else {
            break;
        };
        offset += chunk.len() as u64;
        if offset > part.bytes {
            return Err("下载大小超过资源清单".into());
        }
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        if last.elapsed() > Duration::from_millis(200) {
            state.report(json!({"status":"running", "phase":"download", "detail":part.name, "downloadedBytes":prior+offset, "totalBytes":total, "progress":(prior+offset) as f64/total.max(1) as f64, "bytesPerSecond":((offset-initial) as f64/start.elapsed().as_secs_f64()) as u64}));
            last = Instant::now();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if offset != part.bytes {
        return Err("下载中断，重试可继续下载。".into());
    }
    state.report(json!({"status":"running", "phase":"verify", "detail":part.name, "downloadedBytes":prior+offset, "totalBytes":total}));
    if digest(&partial, state)? != part.sha256 {
        fs::remove_file(&partial).map_err(|e| e.to_string())?;
        return Err("资源 SHA256 校验失败，请重试。".into());
    }
    fs::rename(partial, path).map_err(|e| e.to_string())
}

fn extract(
    root: &Path,
    cache: &Path,
    name: &str,
    c: &Component,
    state: &Installer,
) -> Result<(), String> {
    let destination = root.join(name);
    let staging = root.join(format!("{name}.staging"));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let archive_path = cache.join(format!("{name}.zip"));
    let result = (|| {
        let mut archive = fs::File::create(&archive_path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 4 * 1024 * 1024];
        let archive_bytes: u64 = c.parts.iter().map(|p| p.bytes).sum();
        let mut merged = 0u64;
        for part in &c.parts {
            let mut file = fs::File::open(cache.join(&part.name)).map_err(|e| e.to_string())?;
            loop {
                state.check()?;
                let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
                archive.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                merged += n as u64;
                state.report(json!({"status":"running","phase":"verify","detail":name,"progress":merged as f64/archive_bytes.max(1) as f64}));
            }
        }
        drop(archive);
        if format!("{:x}", hash.finalize()) != c.sha256 {
            return Err("压缩包校验失败".into());
        }
        let mut zip =
            zip::ZipArchive::new(fs::File::open(&archive_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let mut written = 0u64;
        let mut extracted = 0u64;
        for i in 0..zip.len() {
            state.check()?;
            let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
            if !crate::music_resources::safe_entry(file.name())
                || file.is_dir()
                || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            {
                return Err("资源包包含无效路径".into());
            }
            written = written.checked_add(file.size()).ok_or("解压大小溢出")?;
            if written > c.unpacked_bytes {
                return Err("解压大小超过资源清单".into());
            }
            let path = staging.join(file.name());
            fs::create_dir_all(path.parent().unwrap())
                .map_err(|e| format!("创建资源目录 {}：{e}", path.display()))?;
            let mut target = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|e| format!("解压 {}：{e}", path.display()))?;
            loop {
                state.check()?;
                let n = file
                    .read(&mut buffer)
                    .map_err(|e| format!("读取 {}：{e}", path.display()))?;
                if n == 0 {
                    break;
                }
                target
                    .write_all(&buffer[..n])
                    .map_err(|e| format!("写入 {}：{e}", path.display()))?;
                extracted += n as u64;
                state.report(json!({"status":"running", "phase":"extract", "detail":name, "progress":extracted as f64/c.unpacked_bytes as f64}));
            }
            state.report(json!({"status":"running", "phase":"extract", "detail":name, "progress":written as f64/c.unpacked_bytes as f64}));
        }
        drop(zip);
        if written != c.unpacked_bytes {
            return Err("资源包解压大小不匹配".into());
        }
        for file in required(name) {
            if !staging.join(file).is_file() {
                return Err(format!("资源包缺少 {file}"));
            }
        }
        state.check()?;
        fs::write(
            staging.join(".installed.json"),
            json!({"resourceVersion":spec()["resourceVersion"], "target":spec()["target"], "sha256":c.sha256})
                .to_string(),
        )
        .map_err(|e| e.to_string())?;
        if destination.exists() {
            fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
        }
        // Windows file indexing / scanning can briefly hold a newly extracted
        // DLL open. Retry only activation, without redownloading the archive.
        for attempt in 0..40 {
            state.check()?;
            match fs::rename(&staging, &destination) {
                Ok(()) => return Ok(()),
                Err(error) if attempt == 39 => {
                    return Err(format!("启用资源 {}：{error}", destination.display()));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(250)),
            }
        }
        unreachable!()
    })();
    let _ = fs::remove_file(archive_path);
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

pub async fn install(
    root: PathBuf,
    offline: Option<PathBuf>,
    selected: Vec<String>,
    state: Arc<Installer>,
) -> Result<(), String> {
    state.check()?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let _lock = resource_lock(&root)?;
    if selected.is_empty() || selected.iter().any(|n| !COMPONENTS.contains(&n.as_str())) {
        return Err("请选择需要安装的组件。".into());
    }
    let manifest = if let Some(dir) = &offline {
        validate(
            &fs::read(dir.join(manifest_name()))
                .map_err(|e| format!("请选择包含 {} 及全部分卷的文件夹：{e}", manifest_name()))?,
        )?
    } else {
        fetch_manifest().await?
    };
    state.check()?;
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let cache = root.join("downloads");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let needed: Vec<_> = selected
        .iter()
        .map(String::as_str)
        .filter(|n| !installed(&root, n))
        .collect();
    let total: u64 = needed
        .iter()
        .flat_map(|n| &manifest.components[*n].parts)
        .map(|p| p.bytes)
        .sum();
    let disk_needed = total * 2
        + needed
            .iter()
            .map(|n| manifest.components[*n].unpacked_bytes)
            .sum::<u64>()
        + 512 * 1024 * 1024;
    if crate::music_resources::disk_free(&root).is_some_and(|free| free < disk_needed) {
        return Err(format!(
            "磁盘空间不足，安装时需预留约 {:.1} GiB（含下载缓存）。",
            disk_needed as f64 / 1024f64.powi(3)
        ));
    }
    let mut prior = 0;
    for name in needed {
        let component = &manifest.components[name];
        for part in &component.parts {
            state.check()?;
            let target = cache.join(&part.name);
            if let Some(dir) = &offline {
                state.report(json!({"status":"running", "phase":"verify", "detail":part.name}));
                let source = dir.join(&part.name);
                if fs::metadata(&source).map_err(|e| e.to_string())?.len() != part.bytes
                    || digest(&source, &state)? != part.sha256
                {
                    return Err(format!("离线分卷校验失败：{}", part.name));
                }
                tokio::fs::copy(&source, &target)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                download(part, &target, &state, prior, total).await?;
            }
            prior += part.bytes;
        }
        state.report(json!({"status":"running", "phase":"extract", "detail":name}));
        let (r, c, n, contents, s) = (
            root.clone(),
            cache.clone(),
            name.to_owned(),
            component.clone(),
            state.clone(),
        );
        tokio::task::spawn_blocking(move || extract(&r, &c, &n, &contents, &s))
            .await
            .map_err(|e| e.to_string())??;
        // Successful components are immutable and need no download cache.
        for part in &component.parts {
            let _ = fs::remove_file(cache.join(&part.name));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("levelup-model-native-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> Value {
        let mut m = spec();
        m["components"] = json!({});
        for name in COMPONENTS {
            m["components"][name] = json!({"label":name,"unpackedBytes":7,"sha256":"a".repeat(64),"license":"fixture","sources":["fixture"],
                "parts":[{"name":format!("model-workbench-2026.10.15-windows-x64-cu118-{name}.zip.part001"),"bytes":100,"sha256":"b".repeat(64)}]});
        }
        m
    }
    #[test]
    fn rejects_linux_manifest_bad_hashes_and_part_order() {
        let m = fixture();
        assert!(validate(&serde_json::to_vec(&m).unwrap()).is_ok());
        for (key, value) in [
            ("target", json!("linux-x64-cu118")),
            ("resourceVersion", json!("2026.10.1")),
            ("cuda", json!("12.8")),
            ("releaseTag", json!("other")),
        ] {
            let mut bad = m.clone();
            bad[key] = value;
            assert!(
                validate(&serde_json::to_vec(&bad).unwrap()).is_err(),
                "{key}"
            );
        }
        for (key, value) in [
            ("name", json!("../../evil")),
            (
                "name",
                json!("model-workbench-2026.10.15-windows-x64-cu118-runtime.zip.part002"),
            ),
            ("sha256", json!("bad")),
            ("bytes", json!(2_000_000_000u64)),
        ] {
            let mut bad = m.clone();
            bad["components"]["runtime"]["parts"][0][key] = value;
            assert!(validate(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }
    fn make_zip(path: &Path, files: &[&str]) -> u64 {
        let mut writer = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for name in files {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"fixture").unwrap();
        }
        writer.finish().unwrap();
        files.len() as u64 * 7
    }
    fn write_fixture(offline: &Path) -> Value {
        fs::create_dir_all(offline).unwrap();
        let mut manifest = fixture();
        let state = Installer::default();
        for name in COMPONENTS {
            let part_name = manifest["components"][name]["parts"][0]["name"]
                .as_str()
                .unwrap()
                .to_owned();
            let path = offline.join(part_name);
            let count = make_zip(&path, &required(name));
            let digest = digest(&path, &state).unwrap();
            manifest["components"][name]["unpackedBytes"] = json!(count);
            manifest["components"][name]["sha256"] = json!(digest);
            manifest["components"][name]["parts"][0]["sha256"] = json!(digest);
            manifest["components"][name]["parts"][0]["bytes"] =
                json!(fs::metadata(path).unwrap().len());
        }
        fs::write(offline.join(manifest_name()), manifest.to_string()).unwrap();
        manifest
    }
    #[tokio::test]
    async fn offline_roundtrip_reuses_valid_components_and_repairs_missing_files() {
        let temp = Temp::new();
        let root = temp.0.join("安装 资源");
        let offline = temp.0.join("离线 resources");
        let manifest = write_fixture(&offline);
        let state = Arc::new(Installer::default());
        let selected = || COMPONENTS.iter().map(|n| n.to_string()).collect();
        install(
            root.clone(),
            Some(offline.clone()),
            selected(),
            state.clone(),
        )
        .await
        .unwrap();
        assert!(COMPONENTS.iter().all(|n| installed(&root, n)));
        let marker = root.join("runtime/.installed.json");
        let modified = fs::metadata(&marker).unwrap().modified().unwrap();
        install(
            root.clone(),
            Some(offline.clone()),
            selected(),
            state.clone(),
        )
        .await
        .unwrap();
        assert_eq!(fs::metadata(&marker).unwrap().modified().unwrap(), modified);
        fs::remove_file(root.join("runtime/python/python.exe")).unwrap();
        assert!(!installed(&root, "runtime"));
        install(
            root.clone(),
            Some(offline.clone()),
            vec!["runtime".into()],
            state.clone(),
        )
        .await
        .unwrap();
        assert!(installed(&root, "runtime"));
        // Corruption must fail before any component is activated in a fresh install.
        let part = manifest["components"]["runtime"]["parts"][0]["name"]
            .as_str()
            .unwrap();
        fs::write(offline.join(part), b"corrupted").unwrap();
        let other = temp.0.join("bad");
        assert!(
            install(
                other.clone(),
                Some(offline.clone()),
                vec!["runtime".into()],
                state.clone()
            )
            .await
            .is_err()
        );
        assert!(!installed(&other, "runtime"));
        assert!(COMPONENTS.iter().all(|n| installed(&root, n)));
        state.cancel.store(true, Ordering::Release);
        assert!(
            install(root, Some(offline), selected(), state)
                .await
                .is_err()
        );
    }
    #[test]
    fn extraction_rejects_escapes_aliases_and_incomplete_components() {
        let temp = Temp::new();
        let cache = temp.0.join("downloads");
        fs::create_dir(&cache).unwrap();
        let state = Installer::default();
        for name in [
            "../escaped",
            "C:/outside",
            "file:stream",
            "NUL.txt",
            "a/b.",
            "python/python.exe",
        ] {
            let part = cache.join("fixture.part");
            let size = make_zip(&part, &[name]);
            let hash = digest(&part, &state).unwrap();
            let c = Component {
                label: "fixture".into(),
                unpacked_bytes: size,
                sha256: hash.clone(),
                parts: vec![Part {
                    name: "fixture.part".into(),
                    bytes: fs::metadata(part).unwrap().len(),
                    sha256: hash,
                }],
                license: "fixture".into(),
                sources: vec!["fixture".into()],
            };
            assert!(
                extract(&temp.0, &cache, "runtime", &c, &state).is_err(),
                "{name}"
            );
            assert!(!temp.0.join("runtime/.installed.json").exists());
            assert!(!temp.0.join("escaped").exists());
        }
    }
    #[test]
    fn windows_resource_lock_excludes_another_open() {
        let temp = Temp::new();
        let first = resource_lock(&temp.0).unwrap();
        assert!(resource_lock(&temp.0).is_err());
        drop(first);
        assert!(resource_lock(&temp.0).is_ok());
    }
    #[tokio::test]
    async fn bootstrap_and_old_projects_work_without_a_python_runtime() {
        let temp = Temp::new();
        let project = temp.0.join("projects").join("b".repeat(32));
        fs::create_dir_all(&project).unwrap();
        let record = json!({"id":"b".repeat(32),"name":"existing","updatedAt":1,"stages":{"shape":{"directory":"runs/legacy"}}});
        fs::write(project.join("project.json"), record.to_string()).unwrap();
        let result = status(&temp.0, &Installer::default()).await.unwrap();
        assert_eq!(result["projects"][0], record);
        assert!(COMPONENTS.iter().all(|n| result["components"][n] == false));
        assert_eq!(result["system"]["platform"], "windows-x64-cu118");
    }
    #[tokio::test]
    async fn model_download_resumes_valid_ranges_and_rejects_wrong_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (response, success) in [
            (
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 3-5/6\r\nContent-Length: 3\r\nConnection: close\r\n\r\ndef",
                true,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
                true,
            ),
            (
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-2/6\r\nContent-Length: 3\r\nConnection: close\r\n\r\ndef",
                false,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nxxxxxx",
                false,
            ),
        ] {
            let root =
                std::env::temp_dir().join(format!("model-download-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let target = root.join("asset.part001");
            fs::write(root.join("asset.part001.partial"), b"abc").unwrap();
            let part = Part {
                name: "asset.part001".into(),
                bytes: 6,
                sha256: format!("{:x}", Sha256::digest(b"abcdef")),
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/asset", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let n = stream.read(&mut request).await.unwrap();
                assert!(
                    String::from_utf8_lossy(&request[..n])
                        .to_ascii_lowercase()
                        .contains("range: bytes=3-")
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let result = download_from(&url, &part, &target, &Installer::default(), 0, 6).await;
            assert_eq!(result.is_ok(), success, "{result:?}");
            server.await.unwrap();
            if success {
                assert_eq!(fs::read(&target).unwrap(), b"abcdef");
            } else {
                assert!(!target.exists());
            }
            fs::remove_dir_all(root).unwrap();
        }
    }
}
