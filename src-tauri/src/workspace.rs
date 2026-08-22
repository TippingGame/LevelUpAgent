//! Git-independent snapshots for per-operation change review.
//!
//! Git remains the source of truth for repository status, rollback and
//! isolated sub-Agent patches.  The conversation-level "turn changes" view
//! only needs a bounded before/after view of ordinary workspace files, so it
//! uses this module instead of invoking Git.

use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use walkdir::{DirEntry, WalkDir};

use crate::models::{WorkspaceFileSnapshot, WorkspaceSnapshot};
use crate::text_encoding;

const MAX_SNAPSHOT_FILE_BYTES: u64 = 512 * 1024;
const MAX_SNAPSHOT_TOTAL_CONTENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SNAPSHOT_FILES: usize = 20_000;
const MAX_SCANNED_ENTRIES: usize = 40_000;

/// Return a bounded content snapshot of a selected workspace.
pub async fn snapshot(workspace: &str) -> Result<WorkspaceSnapshot, String> {
    let root = std::fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err("The selected workspace is not a directory".to_owned());
    }
    tokio::task::spawn_blocking(move || snapshot_sync(root))
        .await
        .map_err(|error| format!("Workspace snapshot task failed: {error}"))?
}

fn snapshot_sync(root: PathBuf) -> Result<WorkspaceSnapshot, String> {
    let mut files = Vec::new();
    let mut remaining_content_bytes = MAX_SNAPSHOT_TOTAL_CONTENT_BYTES;
    let mut truncated = false;
    let mut entries_seen = 0_usize;

    for item in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(visible_entry)
    {
        entries_seen += 1;
        if entries_seen > MAX_SCANNED_ENTRIES {
            truncated = true;
            break;
        }
        let entry = match item {
            Ok(entry) => entry,
            Err(_) => {
                // A disappearing or unreadable entry should not make the
                // entire operation fail.  Mark the snapshot as partial so a
                // caller can avoid presenting it as exhaustive.
                truncated = true;
                continue;
            }
        };
        if entry.file_type().is_dir() {
            continue;
        }
        if files.len() >= MAX_SNAPSHOT_FILES {
            truncated = true;
            break;
        }

        let relative = match entry.path().strip_prefix(&root) {
            Ok(path) if !path.as_os_str().is_empty() => normalize_relative(path),
            _ => continue,
        };
        match snapshot_file(&entry, &relative, &mut remaining_content_bytes) {
            Ok(file) => files.push(file),
            Err(_) => {
                // If the entry itself disappears before metadata can be read,
                // keep the snapshot explicitly partial rather than inventing
                // a file identity.
                truncated = true;
            }
        }
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(WorkspaceSnapshot {
        is_available: true,
        files,
        truncated,
    })
}

fn snapshot_file(
    entry: &DirEntry,
    relative: &str,
    remaining_content_bytes: &mut usize,
) -> Result<WorkspaceFileSnapshot, String> {
    let path = entry.path();
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {relative}: {error}"))?;
    let mut hasher = DefaultHasher::new();
    relative.hash(&mut hasher);
    metadata.file_type().is_symlink().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    if let Ok(modified) = metadata.modified()
        && let Ok(since_epoch) = modified.duration_since(UNIX_EPOCH)
    {
        since_epoch.as_secs().hash(&mut hasher);
        since_epoch.subsec_nanos().hash(&mut hasher);
    }

    let mut content = None;
    let mut content_truncated = false;
    let mut binary = false;
    if metadata.file_type().is_symlink() {
        match std::fs::read_link(path) {
            Ok(target) => {
                target.hash(&mut hasher);
                binary = true;
            }
            Err(_) => mark_unreadable(&mut hasher, &mut content_truncated, &mut binary),
        }
    } else if metadata.is_file() {
        if metadata.len() > MAX_SNAPSHOT_FILE_BYTES {
            if hash_file(path, &mut hasher).is_err() {
                mark_unreadable(&mut hasher, &mut content_truncated, &mut binary);
            } else {
                content_truncated = true;
            }
        } else {
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            match File::open(path).and_then(|mut file| file.read_to_end(&mut bytes)) {
                Ok(_) => {
                    bytes.hash(&mut hasher);
                    match text_encoding::decode(&bytes) {
                        Ok(decoded) if decoded.content.len() <= *remaining_content_bytes => {
                            *remaining_content_bytes -= decoded.content.len();
                            content = Some(decoded.content);
                        }
                        Ok(_) => content_truncated = true,
                        Err(_) => binary = true,
                    }
                }
                Err(_) => mark_unreadable(&mut hasher, &mut content_truncated, &mut binary),
            }
        }
    } else {
        // Special files are not useful in a textual change review, but their
        // metadata still participates in the identity when available.
        metadata.file_type().is_file().hash(&mut hasher);
    }

    Ok(WorkspaceFileSnapshot {
        path: relative.to_owned(),
        fingerprint: format!("{:016x}", hasher.finish()),
        content,
        content_truncated,
        binary,
    })
}

fn mark_unreadable(hasher: &mut DefaultHasher, content_truncated: &mut bool, binary: &mut bool) {
    b"levelup-unreadable-file-v1".hash(hasher);
    *content_truncated = true;
    *binary = true;
}

fn hash_file(path: &Path, hasher: &mut DefaultHasher) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("Could not read file: {error}"))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read file: {error}"))?;
        if read == 0 {
            break;
        }
        buffer[..read].hash(hasher);
    }
    Ok(())
}

fn normalize_relative(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn visible_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".venv"
                | ".cache"
                | "coverage"
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "levelup-workspace-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[tokio::test]
    async fn snapshots_plain_folder_without_git() {
        let root = temp_workspace("plain");
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("notes.txt"), "before\n").unwrap();
        std::fs::write(root.join("node_modules/pkg/ignored.txt"), "ignored\n").unwrap();
        let root_text = root.to_string_lossy().into_owned();

        let before = snapshot(&root_text).await.unwrap();
        assert!(before.is_available);
        assert!(before.files.iter().any(|file| file.path == "notes.txt"));
        assert!(
            !before
                .files
                .iter()
                .any(|file| file.path.contains("node_modules"))
        );

        std::fs::write(root.join("notes.txt"), "after\n").unwrap();
        let modified = snapshot(&root_text).await.unwrap();
        let before_fingerprint = before
            .files
            .iter()
            .find(|file| file.path == "notes.txt")
            .unwrap()
            .fingerprint
            .clone();
        let modified_fingerprint = modified
            .files
            .iter()
            .find(|file| file.path == "notes.txt")
            .unwrap()
            .fingerprint
            .clone();
        assert_ne!(before_fingerprint, modified_fingerprint);

        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        std::fs::remove_file(root.join("notes.txt")).unwrap();
        let after = snapshot(&root_text).await.unwrap();
        assert!(after.files.iter().any(|file| file.path == "new.txt"));
        assert!(!after.files.iter().any(|file| file.path == "notes.txt"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn preserves_legacy_text_for_turn_review() {
        let root = temp_workspace("encoding");
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("这是一个中文文件\n");
        assert!(!had_errors);
        std::fs::write(root.join("legacy.txt"), bytes.as_ref()).unwrap();
        let snapshot = snapshot(&root.to_string_lossy()).await.unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == "legacy.txt")
            .unwrap();
        assert_eq!(file.content.as_deref(), Some("这是一个中文文件\n"));
        assert!(!file.binary);
        let _ = std::fs::remove_dir_all(root);
    }
}
