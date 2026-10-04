use base64::Engine;
use std::io::Write;
use std::path::Path;

const MAX_ARCHIVE_BYTES: usize = 65 * 1024 * 1024;

fn write_archive(destination: &Path, encoded: &str) -> Result<String, String> {
    if destination
        .extension()
        .and_then(|v| v.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
        != Some("zip")
    {
        return Err("Spine exports must use .zip".into());
    }
    if encoded.len() > MAX_ARCHIVE_BYTES.div_ceil(3) * 4 {
        return Err("Spine archive exceeds 65 MiB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Invalid Spine archive encoding: {e}"))?;
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("Spine archive exceeds 65 MiB".into());
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes))
        .map_err(|e| format!("Invalid Spine ZIP: {e}"))?;
    if archive.len() > 100 {
        return Err("Too many Spine archive files".into());
    }
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        if entry.enclosed_name().is_none() || entry.name().contains('\\') {
            return Err("Invalid Spine archive filename".into());
        }
        total = total.saturating_add(entry.size());
        if total > MAX_ARCHIVE_BYTES as u64 {
            return Err("Spine archive contents exceed 65 MiB".into());
        }
    }
    if archive.by_name("skeleton.json").is_err()
        || archive.by_name("project.levelup-spine.json").is_err()
    {
        return Err("Spine archive is missing its skeleton or editable project".into());
    }
    let parent = destination
        .parent()
        .filter(|p| p.is_dir())
        .ok_or("Export directory does not exist")?;
    let temporary = parent.join(format!(".levelup-spine-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        crate::filesystem::restrict_file(&temporary)?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&temporary, destination)
            .map_err(|e| format!("Could not save Spine archive: {e}"))?;
        Ok(destination.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub async fn export_spine_archive(
    destination: String,
    data_base64: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_archive(Path::new(&destination), &data_base64)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(names: &[&str]) -> String {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for name in names {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"{}").unwrap();
        }
        base64::engine::general_purpose::STANDARD.encode(writer.finish().unwrap().into_inner())
    }
    #[test]
    fn spine_export_validates_and_replaces_complete_archives() {
        let root =
            std::env::temp_dir().join(format!("levelup-spine-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("character.zip");
        let encoded = archive(&[
            "skeleton.json",
            "project.levelup-spine.json",
            "images/part.png",
        ]);
        write_archive(&path, &encoded).unwrap();
        write_archive(&path, &encoded).unwrap();
        let previous = std::fs::read(&path).unwrap();
        assert!(write_archive(&root.join("bad.exe"), &encoded).is_err());
        assert!(write_archive(&path, "not base64").is_err());
        assert!(write_archive(&path, &archive(&["../escape", "skeleton.json"])).is_err());
        assert!(write_archive(&path, &archive(&["skeleton.json"])).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), previous);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
