//! Optional local RIFE reference-frame inference. No shell or automatic model downloads.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

static GPU_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const PNG_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RifeRequest {
    executable: String,
    model_directory: String,
    first: String,
    last: String,
    fraction: f64,
    gpu: i32,
}

fn png_bytes(data: &str) -> Result<(Vec<u8>, imagesize::ImageSize), String> {
    let data = data.strip_prefix("data:image/png;base64,").ok_or("Expected PNG data URL")?;
    if data.len() > PNG_LIMIT * 4 / 3 + 4 { return Err("RIFE input exceeds 4 MiB".into()); }
    let bytes = STANDARD.decode(data).map_err(|_| "Invalid PNG encoding")?;
    if bytes.len() > PNG_LIMIT { return Err("RIFE input exceeds 4 MiB".into()); }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("Expected PNG".into()); }
    let size = imagesize::blob_size(&bytes).map_err(|_| "Invalid PNG header")?;
    if size.width == 0 || size.height == 0 || size.width > 512 || size.height > 512 {
        return Err("RIFE reference frames must be at most 512 px".into());
    }
    Ok((bytes, size))
}

// ncnn appends "/flownet.param" internally. Windows verbatim paths disable
// slash normalization, so pass canonical drive paths in ordinary Win32 form.
fn cli_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = canonical.components();
        match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) | Prefix::Disk(drive) => {
                    let mut result = PathBuf::from(format!("{}:\\", drive as char));
                    for component in components {
                        if let Component::Normal(value) = component { result.push(value); }
                    }
                    return Ok(result);
                }
                _ => return Err("RIFE executable and model must be on a local drive".into()),
            },
            _ => return Err("Invalid absolute Windows path".into()),
        }
    }
    #[cfg(not(windows))]
    Ok(canonical)
}

fn paths(request: &RifeRequest) -> Result<(PathBuf, PathBuf), String> {
    if !request.fraction.is_finite() || request.fraction <= 0.0 || request.fraction >= 1.0 ||
        !(-1..=7).contains(&request.gpu) {
        return Err("Invalid RIFE fraction or GPU index".into());
    }
    let executable = Path::new(&request.executable);
    let model = Path::new(&request.model_directory);
    let valid_name = if cfg!(windows) { "rife-ncnn-vulkan.exe" } else { "rife-ncnn-vulkan" };
    if !executable.is_absolute() || !executable.is_file() || executable.file_name().and_then(|n| n.to_str()) != Some(valid_name) {
        return Err("Select an existing absolute path to rife-ncnn-vulkan".into());
    }
    if !model.is_absolute() || model.file_name().and_then(|n| n.to_str()) != Some("rife-v4.6") ||
        !model.join("flownet.bin").is_file() || !model.join("flownet.param").is_file() {
        return Err("Select the rife-v4.6 folder containing flownet.bin and flownet.param".into());
    }
    Ok((cli_path(executable)?, cli_path(model)?))
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

async fn run(request: RifeRequest) -> Result<String, String> {
    let _permit = GPU_SLOT.try_acquire().map_err(|_| "Another Spine RIFE frame is running")?;
    let (executable, model) = paths(&request)?;
    let (first, a) = png_bytes(&request.first)?;
    let (last, b) = png_bytes(&request.last)?;
    if a.width != b.width || a.height != b.height { return Err("RIFE endpoint canvases must match".into()); }
    let dir = std::env::temp_dir().join(format!("levelup-spine-rife-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let temporary = Temporary(dir);
    let input0 = temporary.0.join("first.png");
    let input1 = temporary.0.join("last.png");
    let output = temporary.0.join("result.png");
    std::fs::write(&input0, first).map_err(|e| e.to_string())?;
    std::fs::write(&input1, last).map_err(|e| e.to_string())?;
    let mut command = tokio::process::Command::new(&executable);
    command.current_dir(executable.parent().ok_or("Invalid executable directory")?)
        .arg("-0").arg(&input0).arg("-1").arg(&input1).arg("-o").arg(&output)
        .arg("-m").arg(model).arg("-s").arg(request.fraction.to_string())
        .arg("-g").arg(request.gpu.to_string()).args(["-j", "1:1:1"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| format!("Could not start RIFE: {e}"))?;
    let mut stderr = child.stderr.take().ok_or("Missing RIFE stderr")?;
    let reader = tokio::spawn(async move {
        let mut kept = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let n = count.min(16 * 1024 - kept.len());
                    kept.extend_from_slice(&buffer[..n]);
                }
            }
        }
        kept
    });
    let status = match tokio::time::timeout(Duration::from_secs(90), child.wait()).await {
        Ok(status) => status.map_err(|e| e.to_string()),
        Err(_) => { let _ = child.kill().await; Err("RIFE exceeded 90 seconds; process stopped".into()) }
    };
    // Never keep waiting on an inherited stderr pipe after the process exits.
    let mut reader = reader;
    let diagnostic = match tokio::time::timeout(Duration::from_secs(1), &mut reader).await {
        Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).chars().take(2000).collect::<String>(),
        _ => { reader.abort(); String::new() }
    };
    let status = status?;
    if !status.success() { return Err(format!("RIFE failed ({status}): {diagnostic}")); }
    let metadata = std::fs::metadata(&output).map_err(|_| "RIFE did not produce a frame")?;
    if metadata.len() > PNG_LIMIT as u64 { return Err("RIFE output exceeds 4 MiB".into()); }
    let bytes = std::fs::read(output).map_err(|e| e.to_string())?;
    let encoded = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
    let (_, result) = png_bytes(&encoded)?;
    if result.width != a.width || result.height != a.height { return Err("RIFE output canvas changed".into()); }
    Ok(encoded)
}

#[tauri::command]
pub async fn spine_rife_frame(request: RifeRequest) -> Result<String, String> { run(request).await }

#[cfg(test)]
mod tests {
    use super::*;
    fn request(executable: &Path, model: &Path) -> RifeRequest {
        RifeRequest { executable: executable.to_string_lossy().into(), model_directory: model.to_string_lossy().into(),
            first: String::new(), last: String::new(), fraction: 0.5, gpu: 0 }
    }
    #[test]
    fn validates_local_paths_and_gpu_without_executing() {
        let dir = std::env::temp_dir().join(format!("levelup-rife-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let tmp = Temporary(dir);
        let exe = tmp.0.join(if cfg!(windows) { "rife-ncnn-vulkan.exe" } else { "rife-ncnn-vulkan" });
        let model = tmp.0.join("rife-v4.6");
        std::fs::write(&exe, []).unwrap();
        std::fs::create_dir(&model).unwrap();
        let mut req = request(&exe, &model);
        assert!(paths(&req).is_err(), "Missing model files");
        for name in ["flownet.bin", "flownet.param"] { std::fs::write(model.join(name), []).unwrap(); }
        let (selected_exe, selected_model) = paths(&req).unwrap();
        assert!(selected_exe.is_file() && selected_model.join("flownet.param").is_file());
        #[cfg(windows)]
        assert!(!selected_model.to_string_lossy().starts_with(r"\\?\"), "ncnn cannot append forward slashes to verbatim paths");
        for gpu in [-2, 8, i32::MAX] { req.gpu = gpu; assert!(paths(&req).is_err()); }
        req.gpu = -1;
        assert!(paths(&req).is_ok());
        let wrong = tmp.0.join("other.exe");
        std::fs::write(&wrong, []).unwrap();
        req.executable = wrong.to_string_lossy().into();
        assert!(paths(&req).is_err());
        req.executable = "rife-ncnn-vulkan.exe".into();
        assert!(paths(&req).is_err(), "Relative executable");
        req.executable = exe.to_string_lossy().into();
        req.model_directory = "rife-v4.6".into();
        assert!(paths(&req).is_err(), "Relative model");
    }

    #[tokio::test]
    #[ignore = "Requires explicitly configured local RIFE binary, model and PNG fixtures"]
    async fn real_local_rife_frame() {
        let setting = |name| std::env::var(name).expect(name);
        let mut req = request(Path::new(&setting("SPINE_RIFE_EXE")), Path::new(&setting("SPINE_RIFE_MODEL")));
        let data = |name| format!("data:image/png;base64,{}", STANDARD.encode(std::fs::read(setting(name)).unwrap()));
        req.first = data("SPINE_RIFE_FIRST");
        req.last = data("SPINE_RIFE_LAST");
        let result = run(req).await.expect("Real RIFE inference");
        let (bytes, size) = png_bytes(&result).unwrap();
        assert!(size.width > 0 && size.height > 0);
        std::fs::write(setting("SPINE_RIFE_OUTPUT"), bytes).unwrap();
    }
    #[test]
    fn validates_png_and_settings() {
        assert!(png_bytes("data:image/jpeg;base64,YQ==").is_err());
        assert!(png_bytes("data:image/png;base64,YQ==").is_err());
        let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        header.extend_from_slice(&513_u32.to_be_bytes());
        header.extend_from_slice(&512_u32.to_be_bytes());
        header.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
        assert!(png_bytes(&format!("data:image/png;base64,{}", STANDARD.encode(header))).is_err());
        for fraction in [0.0, 1.0, f64::NAN, -1.0] {
            assert!(paths(&RifeRequest { executable: "rife-ncnn-vulkan.exe".into(), model_directory: "rife-v4.6".into(),
                first: String::new(), last: String::new(), fraction, gpu: 0 }).is_err());
        }
    }
}
