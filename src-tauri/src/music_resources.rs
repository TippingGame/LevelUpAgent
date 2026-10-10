//! Immutable, independently versioned audio resources. Bootstrap needs no Python.
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

pub const SPEC: &str = include_str!("../../modules/music_workbench/resources.json");
pub const COMPONENTS: [&str; 2] = ["runtime", "musicgen-small"];
pub fn spec() -> Value {
    serde_json::from_str(SPEC).expect("audio resource spec")
}
pub fn manifest_name() -> String {
    let s = spec();
    format!(
        "music-workbench-{}-{}.json",
        s["resourceVersion"].as_str().unwrap(),
        s["target"].as_str().unwrap()
    )
}
fn base_url() -> String {
    let s = spec();
    format!(
        "https://github.com/{}/releases/download/{}",
        s["repository"].as_str().unwrap(),
        s["releaseTag"].as_str().unwrap()
    )
}
pub fn resources(root: &Path) -> PathBuf {
    root.join("resources")
        .join(spec()["resourceVersion"].as_str().unwrap())
}
pub fn installed(root: &Path, name: &str) -> bool {
    let dir = resources(root).join(name);
    let marker: Value = fs::read(dir.join(".installed.json"))
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or(Value::Null);
    marker["resourceVersion"] == spec()["resourceVersion"]
        && dir
            .join(if name == "runtime" {
                "python.exe"
            } else {
                "model.safetensors"
            })
            .is_file()
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
    pub repository: String,
    pub target: String,
    pub model_revision: String,
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
        "repository",
        "target",
        "modelRevision",
    ] {
        if value[key] != spec()[key] {
            return Err(format!("音频资源版本不兼容：{key}"));
        }
    }
    if manifest.components.len() != 2
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
                "music-workbench-{}-{}-{}.zip.part{:03}",
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
        .user_agent("LevelUpAgent-Audio/1")
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
        return Err("此版本的音频资源尚未发布，请稍后重试，或导入离线资源包。".into());
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
    pub busy: AtomicBool,
    pub cancel: AtomicBool,
    pub operation: Mutex<Value>,
}
impl Installer {
    pub fn report(&self, value: Value) {
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
    let mut file = fs::File::open(file).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut block = vec![0; 4 * 1024 * 1024];
    loop {
        state.check()?;
        let n = file.read(&mut block).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&block[..n]);
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
            state.report(json!({"status":"running", "phase":"download", "detail":part.name, "downloadedBytes":prior+offset, "totalBytes":total, "bytesPerSecond":((offset-initial) as f64/start.elapsed().as_secs_f64()) as u64}));
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

// Reject Windows aliases, ADS, traversal and symlinks before extracting. Each
// archive contains only relative regular files under its component directory.
pub fn safe_entry(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':'])
        && !name.starts_with('/')
        && name.split('/').all(|p| {
            let stem = p.split('.').next().unwrap_or("").to_ascii_uppercase();
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.ends_with([' ', '.'])
                && !p.chars().any(char::is_control)
                && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
}
fn extract(
    root: &Path,
    cache: &Path,
    name: &str,
    c: &Component,
    state: &Installer,
) -> Result<(), String> {
    let destination = resources(root).join(name);
    let staging = resources(root).join(format!("{name}.staging"));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let archive_path = cache.join(format!("{name}.zip"));
    let result = (|| {
        let mut archive = fs::File::create(&archive_path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 4 * 1024 * 1024];
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
        for i in 0..zip.len() {
            state.check()?;
            let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
            if !safe_entry(file.name())
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
            }
            state.report(json!({"status":"running", "phase":"extract", "detail":name, "progress":written as f64/c.unpacked_bytes as f64}));
        }
        drop(zip);
        if written != c.unpacked_bytes {
            return Err("资源包解压大小不匹配".into());
        }
        for file in if name == "runtime" {
            vec![
                "python.exe",
                "ready.json",
                "Lib/site-packages/torch/__init__.py",
            ]
        } else {
            vec!["model.safetensors", "manifest.json", "config.json"]
        } {
            if !staging.join(file).is_file() {
                return Err(format!("资源包缺少 {file}"));
            }
        }
        state.check()?;
        fs::write(
            staging.join(".installed.json"),
            json!({"resourceVersion":spec()["resourceVersion"], "sha256":c.sha256}).to_string(),
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
    state: Arc<Installer>,
) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let manifest = if let Some(dir) = &offline {
        validate(&fs::read(dir.join(manifest_name())).map_err(|e| e.to_string())?)?
    } else {
        fetch_manifest().await?
    };
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let cache = root.join("downloads");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let needed: Vec<_> = COMPONENTS
        .into_iter()
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
    if disk_free(&root).is_some_and(|free| free < disk_needed) {
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

pub fn disk_free(root: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0;
        unsafe {
            windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                windows::core::PCWSTR(wide.as_ptr()),
                Some(&mut free),
                None,
                None,
            )
            .ok()?;
        }
        Some(free)
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        None
    }
}
pub fn memory() -> Value {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if unsafe { GlobalMemoryStatusEx(&mut status) }.is_ok() {
            return json!({"totalMiB": status.ullTotalPhys/1048576, "availableMiB":status.ullAvailPhys/1048576});
        }
    }
    json!({"totalMiB":null, "availableMiB":null})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn music_archive_paths_reject_windows_aliases_and_traversal() {
        for path in [
            "../outside",
            "/outside",
            "C:/outside",
            "file:stream",
            "folder\\file",
            "NUL.txt",
            "a/COM1",
            "a/../b",
            "a//b",
            "a./b",
            "a/b ",
        ] {
            assert!(!safe_entry(path), "{path}");
        }
        for path in [
            "Lib/site-packages/torch/__init__.py",
            "model.safetensors",
            "许可证.txt",
        ] {
            assert!(safe_entry(path), "{path}");
        }
    }
    fn fixture() -> Value {
        let mut m = spec();
        m["components"] = json!({});
        for name in COMPONENTS {
            m["components"][name] = json!({"unpackedBytes":100,"sha256":"a".repeat(64),"license":"test","sources":["test"],"parts":[{"name":format!("music-workbench-2026.10.1-windows-x64-cu128-{name}.zip.part001"),"bytes":100,"sha256":"b".repeat(64)}]});
        }
        m
    }
    #[test]
    fn music_manifest_requires_pinned_identity_and_bounded_parts() {
        let m = fixture();
        assert!(validate(&serde_json::to_vec(&m).unwrap()).is_ok());
        for (key, value) in [
            ("resourceVersion", json!("other")),
            ("target", json!("linux")),
            ("repository", json!("other/repo")),
            ("modelRevision", json!("main")),
        ] {
            let mut bad = m.clone();
            bad[key] = value;
            assert!(validate(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
        for (key, value) in [
            ("name", json!("../../evil")),
            ("bytes", json!(2_000_000_000u64)),
            ("sha256", json!("bad")),
        ] {
            let mut bad = m.clone();
            bad["components"]["runtime"]["parts"][0][key] = value;
            assert!(validate(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }
    #[test]
    fn music_extraction_is_staged_and_never_marks_incomplete_install_ready() {
        let root = std::env::temp_dir().join(format!("music-resources-{}", uuid::Uuid::new_v4()));
        let cache = root.join("downloads");
        fs::create_dir_all(&cache).unwrap();
        let state = Installer::default();
        for (index, name) in ["../escaped", "python.exe"].iter().enumerate() {
            let part = cache.join(format!("part{index}"));
            let mut zip = zip::ZipWriter::new(fs::File::create(&part).unwrap());
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"test").unwrap();
            zip.finish().unwrap();
            let hash = digest(&part, &state).unwrap();
            let c = Component {
                unpacked_bytes: 4,
                sha256: hash.clone(),
                parts: vec![Part {
                    name: format!("part{index}"),
                    bytes: fs::metadata(part).unwrap().len(),
                    sha256: hash,
                }],
                license: "test".into(),
                sources: vec!["test".into()],
            };
            assert!(extract(&root, &cache, "runtime", &c, &state).is_err());
            assert!(!installed(&root, "runtime"));
            assert!(!root.join("escaped").exists());
        }
        state.cancel.store(true, Ordering::Release);
        assert!(state.check().is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn music_download_resumes_valid_ranges_and_rejects_wrong_bytes() {
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
                std::env::temp_dir().join(format!("music-download-{}", uuid::Uuid::new_v4()));
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
