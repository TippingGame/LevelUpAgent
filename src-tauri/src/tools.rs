use std::ops::Range;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use globset::Glob;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use walkdir::{DirEntry, WalkDir};

use crate::models::{ToolExecutionRequest, ToolExecutionResponse};
use crate::process::hide_console_window;
use crate::text_encoding::{self, DecodedText};

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_CHARS: usize = 120_000;

pub async fn execute(request: ToolExecutionRequest) -> ToolExecutionResponse {
    let result = execute_inner(&request).await;
    match result {
        Ok(output) => ToolExecutionResponse {
            output: truncate(output),
            is_error: false,
        },
        Err(error) => ToolExecutionResponse {
            output: error,
            is_error: true,
        },
    }
}

async fn execute_inner(request: &ToolExecutionRequest) -> Result<String, String> {
    let root = std::fs::canonicalize(&request.workspace)
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    match request.name.as_str() {
        "list_files" => list_files(&root, string_arg(&request.arguments, "path").unwrap_or(".")),
        "read_file" => {
            read_file(
                &root,
                required_arg(&request.arguments, "path")?,
                optional_encoding(&request.arguments)?,
            )
            .await
        }
        "search_files" => search_files(
            &root,
            required_arg(&request.arguments, "query")?,
            string_arg(&request.arguments, "glob"),
            optional_encoding(&request.arguments)?,
        ),
        "write_file" => {
            write_file(
                &root,
                required_arg(&request.arguments, "path")?,
                required_arg(&request.arguments, "content")?,
                optional_encoding(&request.arguments)?,
            )
            .await
        }
        "edit_file" => {
            edit_file(
                &root,
                required_arg(&request.arguments, "path")?,
                required_arg_any(&request.arguments, &["old_string", "oldText"])?,
                required_arg_any(&request.arguments, &["new_string", "newText"])?,
                optional_encoding(&request.arguments)?,
                request
                    .arguments
                    .get("replace_all")
                    .or_else(|| request.arguments.get("replaceAll"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
            .await
        }
        "delete_file" => delete_file(&root, required_arg(&request.arguments, "path")?).await,
        "run_command" => run_command(&root, required_arg(&request.arguments, "command")?).await,
        _ => Err(format!("Unknown tool: {}", request.name)),
    }
}

fn list_files(root: &Path, relative: &str) -> Result<String, String> {
    let target = resolve_existing(root, relative)?;
    if target.is_file() {
        return Ok(relative.to_owned());
    }
    let mut entries = Vec::new();
    for entry in WalkDir::new(&target)
        .max_depth(4)
        .into_iter()
        .filter_entry(visible_entry)
        .filter_map(Result::ok)
        .take(400)
    {
        if entry.path() == target {
            continue;
        }
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        entries.push(if entry.file_type().is_dir() {
            format!("{}/", relative.display())
        } else {
            relative.display().to_string()
        });
    }
    Ok(entries.join("\n"))
}

async fn read_file(
    root: &Path,
    relative: &str,
    encoding: Option<text_encoding::TextEncoding>,
) -> Result<String, String> {
    let path = resolve_existing(root, relative)?;
    Ok(
        read_text_file_with_encoding(&path, MAX_FILE_BYTES, encoding)
            .await?
            .content,
    )
}

fn search_files(
    root: &Path,
    query: &str,
    pattern: Option<&str>,
    encoding: Option<text_encoding::TextEncoding>,
) -> Result<String, String> {
    let matcher = pattern
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            Glob::new(value)
                .map(|glob| glob.compile_matcher())
                .map_err(|error| format!("Invalid glob: {error}"))
        })
        .transpose()?;
    let needle = query.to_lowercase();
    let mut results = Vec::new();
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(visible_entry)
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && !entry.file_type().is_symlink())
    {
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        if matcher
            .as_ref()
            .is_some_and(|matcher| !matcher.is_match(relative))
        {
            continue;
        }
        if relative.to_string_lossy().to_lowercase().contains(&needle) {
            results.push(format!("{} (path)", relative.display()));
        }
        if entry.metadata().map(|item| item.len()).unwrap_or(u64::MAX) <= MAX_FILE_BYTES
            && let Ok(bytes) = std::fs::read(entry.path())
            && bytes.len() as u64 <= MAX_FILE_BYTES
            && let Ok(text) = encoding
                .map_or_else(
                    || text_encoding::decode(&bytes),
                    |kind| text_encoding::decode_with_hint(&bytes, kind),
                )
                .map(|decoded| decoded.content)
        {
            for (index, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    results.push(format!(
                        "{}:{}: {}",
                        relative.display(),
                        index + 1,
                        line.trim()
                    ));
                    if results.len() >= 100 {
                        return Ok(results.join("\n"));
                    }
                }
            }
        }
        if results.len() >= 100 {
            break;
        }
    }
    Ok(if results.is_empty() {
        "No matches found".to_owned()
    } else {
        results.join("\n")
    })
}

async fn write_file(
    root: &Path,
    relative: &str,
    content: &str,
    encoding_hint: Option<text_encoding::TextEncoding>,
) -> Result<String, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err("File writes may contain at most 1 MiB".to_owned());
    }
    let path = resolve_for_write(root, relative)?;
    let existing = if path.is_file() {
        Some(read_text_file_snapshot(&path, MAX_WRITE_BYTES as u64, encoding_hint).await?)
    } else if path.exists() {
        return Err("The destination path is not a regular file".to_owned());
    } else {
        None
    };
    let existing_metadata = existing.as_ref().map(|(_, metadata)| metadata);
    let initialize_utf16_bom = existing
        .as_ref()
        .is_some_and(|(original, _)| original.is_empty())
        && matches!(
            encoding_hint,
            Some(text_encoding::TextEncoding::Utf16Le | text_encoding::TextEncoding::Utf16Be)
        );
    let content = strip_transport_bom(content, existing_metadata, initialize_utf16_bom);
    if let Some(metadata) = existing_metadata
        && !initialize_utf16_bom
        && text_encoding::normalize_line_endings(content) == metadata.content
    {
        return Ok(format!(
            "No changes to {relative}; preserved encoding={}, line endings={}, and original bytes",
            metadata.encoding.label(),
            metadata.line_ending.label()
        ));
    }
    let (encoding, bom, line_ending) = existing
        .as_ref()
        .map(|(original, metadata)| {
            // A zero-byte file has no observable BOM or encoding to preserve.
            // When the caller explicitly selects UTF-16, use the same BOM
            // default as a newly created UTF-16 file so the next reader can
            // identify even all-CJK content reliably.
            let bom = metadata.bom || (original.is_empty() && initialize_utf16_bom);
            (metadata.encoding, bom, metadata.line_ending)
        })
        .unwrap_or_else(|| {
            let encoding = encoding_hint.unwrap_or(text_encoding::TextEncoding::Utf8);
            let bom = matches!(
                encoding,
                text_encoding::TextEncoding::Utf16Le | text_encoding::TextEncoding::Utf16Be
            );
            (encoding, bom, text_encoding::LineEnding::Lf)
        });
    let bytes = text_encoding::encode(content, encoding, bom, line_ending)
        .map_err(|error| format!("Could not encode {relative}: {error}"))?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err("File writes may contain at most 1 MiB".to_owned());
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Could not create parent directory: {error}"))?;
    }
    let expected = existing.as_ref().map(|(original, _)| original.as_slice());
    write_bytes_atomic(&path, &bytes, expected).await?;
    Ok(format!(
        "Wrote {} bytes to {} (encoding={}, line endings={})",
        bytes.len(),
        relative,
        encoding.label(),
        line_ending.label()
    ))
}

/// Replace one exact model-supplied span while retaining the source file's
/// encoding, BOM, and dominant line-ending style.  This is the safe path for
/// normal code edits: unchanged Chinese text never has to be serialized by
/// the model again.
async fn edit_file(
    root: &Path,
    relative: &str,
    old_string: &str,
    new_string: &str,
    encoding_hint: Option<text_encoding::TextEncoding>,
    replace_all: bool,
) -> Result<String, String> {
    if old_string.is_empty() {
        return Err(
            "edit_file requires a non-empty old_string; use write_file to create a file".to_owned(),
        );
    }
    if old_string.len().saturating_add(new_string.len()) > MAX_WRITE_BYTES {
        return Err("An edit request may contain at most 1 MiB of old/new text".to_owned());
    }
    let path = resolve_existing(root, relative)?;
    let (original_bytes, metadata) =
        read_text_file_snapshot(&path, MAX_FILE_BYTES, encoding_hint).await?;
    let old_string = text_encoding::normalize_line_endings(old_string);
    let new_string = text_encoding::normalize_line_endings(new_string);
    let mut match_ranges = metadata
        .content
        .match_indices(&old_string)
        .map(|(start, matched)| start..start + matched.len())
        .collect::<Vec<_>>();
    let matches = match_ranges.len();
    if matches == 0 {
        return Err(format!(
            "String to replace was not found in {relative}. Read the file again and provide the exact old_string."
        ));
    }
    if matches > 1 && !replace_all {
        return Err(format!(
            "Found {matches} matches in {relative}; set replace_all=true or include more context so the edit is unambiguous"
        ));
    }
    if !replace_all {
        match_ranges.truncate(1);
    }
    if old_string == new_string {
        return Ok(format!(
            "No changes to {relative}; the requested replacement already matches (encoding={}, line endings={})",
            metadata.encoding.label(),
            metadata.line_ending.label()
        ));
    }
    let source_ranges =
        text_encoding::map_normalized_ranges_to_source(&original_bytes, &metadata, &match_ranges)
            .map_err(|error| format!("Could not map the edit in {relative}: {error}"))?;
    let replacement =
        text_encoding::encode(&new_string, metadata.encoding, false, metadata.line_ending)
            .map_err(|error| {
                format!("Could not encode {relative} without changing its format: {error}")
            })?;
    let bytes = splice_source_ranges(&original_bytes, &source_ranges, &replacement)?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err("The edited file would exceed the 1 MiB workspace-tool limit".to_owned());
    }
    // A formatter, editor, or another Agent may have changed the file while
    // the model was preparing the replacement.  Do not apply a stale edit.
    let current_link_metadata = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect {relative} before writing: {error}"))?;
    if current_link_metadata.file_type().is_symlink() {
        return Err(format!(
            "File {relative} became a symbolic link during the edit"
        ));
    }
    let current_metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect {relative} before writing: {error}"))?;
    if !current_metadata.is_file() || current_metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "File {relative} is no longer a regular file within the edit size limit"
        ));
    }
    let current_bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("Could not re-read {relative} before writing: {error}"))?;
    if current_bytes != original_bytes {
        return Err(format!(
            "File {relative} changed while the edit was being prepared; read it again before retrying"
        ));
    }
    write_bytes_atomic(&path, &bytes, Some(&original_bytes)).await?;
    Ok(format!(
        "Edited {relative}: {matches} replacement(s), encoding={}, line endings={}, {} bytes",
        metadata.encoding.label(),
        metadata.line_ending.label(),
        bytes.len()
    ))
}

fn splice_source_ranges(
    original: &[u8],
    ranges: &[Range<usize>],
    replacement: &[u8],
) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(original.len());
    let mut cursor = 0;
    for range in ranges {
        if range.start < cursor || range.end < range.start || range.end > original.len() {
            return Err("The edit ranges are invalid or overlap".to_owned());
        }
        output.extend_from_slice(&original[cursor..range.start]);
        output.extend_from_slice(replacement);
        cursor = range.end;
    }
    output.extend_from_slice(&original[cursor..]);
    Ok(output)
}

async fn read_text_file_with_encoding(
    path: &Path,
    limit: u64,
    encoding: Option<text_encoding::TextEncoding>,
) -> Result<DecodedText, String> {
    Ok(read_text_file_snapshot(path, limit, encoding).await?.1)
}

async fn read_text_file_snapshot(
    path: &Path,
    limit: u64,
    encoding: Option<text_encoding::TextEncoding>,
) -> Result<(Vec<u8>, DecodedText), String> {
    let link_metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|error| format!("Could not inspect file: {error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("The requested path is a symbolic link".to_owned());
    }
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("Could not inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("The requested path is not a regular file".to_owned());
    }
    if metadata.len() > limit {
        return Err(format!("File is larger than {} KiB", limit / 1024));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("Could not read file: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("File is larger than {} KiB", limit / 1024));
    }
    let decoded = encoding
        .map_or_else(
            || text_encoding::decode(&bytes),
            |kind| text_encoding::decode_with_hint(&bytes, kind),
        )
        .map_err(|error| format!("Could not decode {} as text: {error}", path.display()))?;
    Ok((bytes, decoded))
}

/// Write through a same-directory temporary file and rename it into place.
/// The rename is atomic on supported filesystems, so a failed write cannot
/// leave a half-written source file. Existing permission bits are copied to
/// the temporary file before replacement. Optionally assert that the destination still
/// contains the exact bytes observed before the edit.  The assertion is made
/// after the temporary file is fully flushed and immediately before rename, so
/// a full-file write cannot silently overwrite a concurrent editor's update.
async fn write_bytes_atomic(
    path: &Path,
    bytes: &[u8],
    expected: Option<&[u8]>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not determine the destination directory".to_owned())?;
    if let Ok(metadata) = tokio::fs::symlink_metadata(path).await
        && metadata.file_type().is_symlink()
    {
        return Err("Refusing to atomically replace a symbolic link".to_owned());
    }
    let temporary = parent.join(format!(
        ".levelup-agent-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let permissions = match tokio::fs::metadata(path).await {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Could not inspect destination: {error}")),
    };

    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|error| format!("Could not create temporary file: {error}"))?;
        file.write_all(bytes)
            .await
            .map_err(|error| format!("Could not write temporary file: {error}"))?;
        file.sync_all()
            .await
            .map_err(|error| format!("Could not flush temporary file: {error}"))?;
        drop(file);

        if let Some(permissions) = permissions {
            tokio::fs::set_permissions(&temporary, permissions)
                .await
                .map_err(|error| format!("Could not preserve file permissions: {error}"))?;
        }
        match expected {
            Some(expected) => {
                let current_link_metadata = tokio::fs::symlink_metadata(path)
                    .await
                    .map_err(|error| format!("Could not recheck destination: {error}"))?;
                if current_link_metadata.file_type().is_symlink() {
                    return Err("The destination became a symbolic link while writing".to_owned());
                }
                let current_metadata = tokio::fs::metadata(path)
                    .await
                    .map_err(|error| format!("Could not recheck destination: {error}"))?;
                if !current_metadata.is_file() || current_metadata.len() != expected.len() as u64 {
                    return Err(
                        "The destination changed while the file was being prepared; read it again before retrying"
                            .to_owned(),
                    );
                }
                let current = tokio::fs::read(path)
                    .await
                    .map_err(|error| format!("Could not recheck destination: {error}"))?;
                if current != expected {
                    return Err(
                        "The destination changed while the file was being prepared; read it again before retrying"
                            .to_owned(),
                    );
                }
            }
            None => match tokio::fs::symlink_metadata(path).await {
                Ok(_) => {
                    return Err(
                        "The destination appeared while the new file was being prepared; retry the write"
                            .to_owned(),
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Could not recheck destination: {error}"));
                }
            },
        }
        tokio::fs::rename(&temporary, path)
            .await
            .map_err(|error| format!("Could not replace file atomically: {error}"))
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

fn strip_transport_bom<'a>(
    content: &'a str,
    existing: Option<&DecodedText>,
    initialize_utf16_bom: bool,
) -> &'a str {
    if initialize_utf16_bom || existing.is_none_or(|metadata| metadata.bom) {
        content.strip_prefix('\u{feff}').unwrap_or(content)
    } else {
        content
    }
}

async fn delete_file(root: &Path, relative: &str) -> Result<String, String> {
    let requested = requested_path(root, relative)?;
    let link_metadata = tokio::fs::symlink_metadata(&requested)
        .await
        .map_err(|error| format!("Could not inspect file: {error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("Deleting symbolic links is not allowed".to_owned());
    }
    let path = resolve_existing(root, relative)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("Only regular files may be deleted".to_owned());
    }
    tokio::fs::remove_file(path)
        .await
        .map_err(|error| format!("Could not delete file: {error}"))?;
    Ok(format!("Deleted {relative}"))
}

async fn run_command(root: &Path, command: &str) -> Result<String, String> {
    let mut process = if cfg!(target_os = "windows") {
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
    };
    hide_console_window(&mut process);
    process.kill_on_drop(true);
    process.current_dir(root);
    let output = tokio::time::timeout(Duration::from_secs(120), process.output())
        .await
        .map_err(|_| "Command timed out after 120 seconds".to_owned())?
        .map_err(|error| format!("Could not start command: {error}"))?;
    let stdout = text_encoding::decode_command_output(&output.stdout);
    let stderr = text_encoding::decode_command_output(&output.stderr);
    Ok(format!(
        "exit code: {}\nstdout:\n{}\nstderr:\n{}",
        output.status.code().unwrap_or(-1),
        stdout,
        stderr
    ))
}

fn resolve_existing(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(requested_path(root, relative)?)
        .map_err(|error| format!("Path is unavailable: {error}"))?;
    ensure_inside(root, &path)?;
    Ok(path)
}

fn resolve_for_write(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = requested_path(root, relative)?;
    if let Ok(metadata) = std::fs::symlink_metadata(&candidate)
        && metadata.file_type().is_symlink()
    {
        // Resolve existing links so an external target is rejected; a
        // dangling link must not be silently replaced by an atomic rename.
        return resolve_existing(root, relative);
    }
    if candidate.exists() {
        return resolve_existing(root, relative);
    }
    let mut ancestor = candidate.parent();
    while let Some(path) = ancestor {
        if path.exists() {
            let canonical = std::fs::canonicalize(path)
                .map_err(|error| format!("Could not resolve parent path: {error}"))?;
            ensure_inside(root, &canonical)?;
            return Ok(candidate);
        }
        ancestor = path.parent();
    }
    Err("Could not resolve destination path".to_owned())
}

fn requested_path(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let path = Path::new(requested);
    let has_parent = path
        .components()
        .any(|part| matches!(part, Component::ParentDir));
    let has_root_or_prefix = path
        .components()
        .any(|part| matches!(part, Component::RootDir | Component::Prefix(_)));
    if has_parent || (!path.is_absolute() && has_root_or_prefix) {
        return Err("Tool paths must stay inside the selected workspace".to_owned());
    }
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
}

fn ensure_inside(root: &Path, path: &Path) -> Result<(), String> {
    if path.starts_with(root) {
        Ok(())
    } else {
        Err("Resolved path escapes the selected workspace".to_owned())
    }
}

fn visible_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(".git" | "node_modules" | "target" | "dist" | ".next" | ".venv")
    )
}

fn string_arg<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

fn required_arg<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    string_arg(arguments, key).ok_or_else(|| format!("Missing string argument: {key}"))
}

fn optional_encoding(arguments: &Value) -> Result<Option<text_encoding::TextEncoding>, String> {
    let Some(raw) = arguments
        .get("encoding")
        .or_else(|| arguments.get("encodingHint"))
    else {
        return Ok(None);
    };
    let Some(value) = raw.as_str() else {
        return Err("encoding must be a string".to_owned());
    };
    text_encoding::TextEncoding::parse(value)
        .map(Some)
        .ok_or_else(|| {
            format!(
                "Unsupported encoding '{value}'. Use utf-8, utf-16le, utf-16be, gbk (or gb2312), gb18030, big5, shift-jis, or windows-1252"
            )
        })
}

fn required_arg_any<'a>(arguments: &'a Value, keys: &[&str]) -> Result<&'a str, String> {
    keys.iter()
        .find_map(|key| string_arg(arguments, key))
        .ok_or_else(|| format!("Missing string argument: {}", keys.join(" or ")))
}

fn truncate(value: String) -> String {
    if value.chars().count() <= MAX_OUTPUT_CHARS {
        value
    } else {
        format!(
            "{}\n… output truncated",
            value.chars().take(MAX_OUTPUT_CHARS).collect::<String>()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_directory_components() {
        let root = Path::new("workspace");
        assert!(requested_path(root, "../secret.txt").is_err());
        assert!(requested_path(root, "safe/../../secret.txt").is_err());
    }

    #[test]
    fn accepts_workspace_relative_paths() {
        let root = Path::new("workspace");
        assert_eq!(
            requested_path(root, "src/main.rs").unwrap(),
            root.join("src/main.rs")
        );
        assert_eq!(requested_path(root, ".").unwrap(), root.join("."));
    }

    #[test]
    fn accepts_only_workspace_internal_absolute_paths() {
        let suite =
            std::env::temp_dir().join(format!("levelup-absolute-path-{}", uuid::Uuid::new_v4()));
        let root = suite.join("workspace");
        let prefix_match = suite.join("workspace-outside");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::create_dir_all(&prefix_match).unwrap();
        std::fs::write(root.join("nested/existing.txt"), "inside").unwrap();
        std::fs::write(prefix_match.join("outside.txt"), "outside").unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let inside = root.join("nested/existing.txt");
        let new_inside = root.join("nested/new.txt");
        let outside = std::fs::canonicalize(prefix_match.join("outside.txt")).unwrap();

        assert_eq!(
            resolve_existing(&root, &inside.to_string_lossy()).unwrap(),
            inside
        );
        assert_eq!(
            resolve_for_write(&root, &new_inside.to_string_lossy()).unwrap(),
            new_inside
        );
        assert!(resolve_existing(&root, &outside.to_string_lossy()).is_err());
        assert!(
            resolve_for_write(&root, &prefix_match.join("new.txt").to_string_lossy(),).is_err()
        );

        let _ = std::fs::remove_dir_all(suite);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_link_escapes_for_reads_and_writes() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("levelup-path-root-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("levelup-path-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("linked-file")).unwrap();
        symlink(&outside, root.join("linked-directory")).unwrap();
        symlink(outside.join("does-not-exist"), root.join("dangling-link")).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();

        assert!(resolve_existing(&root, "linked-file").is_err());
        assert!(resolve_for_write(&root, "linked-directory/new.txt").is_err());
        assert!(resolve_for_write(&root, "dangling-link").is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn deletes_only_a_regular_workspace_file() {
        let root = std::env::temp_dir().join(format!("levelup-delete-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("remove.txt"), "temporary").unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        assert_eq!(
            delete_file(&canonical, "remove.txt").await.unwrap(),
            "Deleted remove.txt"
        );
        assert!(!root.join("remove.txt").exists());
        assert!(delete_file(&canonical, ".").await.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_preserves_utf8_bom_and_crlf() {
        let root = std::env::temp_dir().join(format!("levelup-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("中文.ts");
        let mut original = vec![0xef, 0xbb, 0xbf];
        original.extend_from_slice("const 标题 = '中文';\r\nconst 保留 = true;\r\n".as_bytes());
        std::fs::write(&path, &original).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        let result = edit_file(&canonical, "中文.ts", "'中文'", "'修改后'", None, false)
            .await
            .unwrap();
        assert!(result.contains("encoding=UTF-8"));
        assert!(result.contains("line endings=CRLF"));

        let mut expected = vec![0xef, 0xbb, 0xbf];
        expected.extend_from_slice("const 标题 = '修改后';\r\nconst 保留 = true;\r\n".as_bytes());
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_preserves_mixed_line_endings_outside_the_replacement() {
        let root =
            std::env::temp_dir().join(format!("levelup-mixed-endings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("mixed.txt");
        let original = "第一行\r\n第二行\n第三行\r\n第四行\n";
        std::fs::write(&path, original.as_bytes()).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        edit_file(&canonical, "mixed.txt", "第二行", "修改行", None, false)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            "第一行\r\n修改行\n第三行\r\n第四行\n".as_bytes()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_maps_standalone_cr_in_utf8_without_rewriting_other_bytes() {
        let root =
            std::env::temp_dir().join(format!("levelup-edit-cr-utf8-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("cr.txt");
        let original = "前置\r中文\r后置\n".as_bytes().to_vec();
        std::fs::write(&path, &original).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        edit_file(&canonical, "cr.txt", "中文", "汉字", None, false)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            "前置\r汉字\r后置\n".as_bytes()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_preserves_utf16_source_bytes_outside_the_replacement() {
        let root =
            std::env::temp_dir().join(format!("levelup-edit-utf16-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("legacy.ps1");
        let mut original = vec![0xff, 0xfe];
        for segment in ["Write-Output '中文'\r\n", "Write-Output '保留'\n"] {
            original.extend(segment.encode_utf16().flat_map(u16::to_le_bytes));
        }
        std::fs::write(&path, &original).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        edit_file(&canonical, "legacy.ps1", "中文", "修改", None, false)
            .await
            .unwrap();
        let mut expected = vec![0xff, 0xfe];
        for segment in ["Write-Output '修改'\r\n", "Write-Output '保留'\n"] {
            expected.extend(segment.encode_utf16().flat_map(u16::to_le_bytes));
        }
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_preserves_utf16be_and_cr_only_source_bytes() {
        let root =
            std::env::temp_dir().join(format!("levelup-edit-utf16be-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("legacy-be.txt");
        let original = text_encoding::encode(
            "第一行\r第二行\r保留😀",
            text_encoding::TextEncoding::Utf16Be,
            true,
            text_encoding::LineEnding::Cr,
        )
        .unwrap();
        std::fs::write(&path, &original).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        edit_file(&canonical, "legacy-be.txt", "第二行", "修改行", None, false)
            .await
            .unwrap();
        let expected = text_encoding::encode(
            "第一行\r修改行\r保留😀",
            text_encoding::TextEncoding::Utf16Be,
            true,
            text_encoding::LineEnding::Cr,
        )
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        assert_eq!(&std::fs::read(&path).unwrap()[..2], &[0xfe, 0xff]);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_preserves_gbk_bytes() {
        let root = std::env::temp_dir().join(format!("levelup-gbk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("legacy.txt");
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("标题=中文\r\n");
        assert!(!had_errors);
        std::fs::write(&path, bytes.as_ref()).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        edit_file(
            &canonical,
            "legacy.txt",
            "中文",
            "汉字",
            Some(text_encoding::TextEncoding::Gbk),
            false,
        )
        .await
        .unwrap();
        let (expected, _, expected_errors) = encoding_rs::GBK.encode("标题=汉字\r\n");
        assert!(!expected_errors);
        assert_eq!(std::fs::read(&path).unwrap(), expected.as_ref());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_file_preserves_existing_utf16_format() {
        let root = std::env::temp_dir().join(format!("levelup-write-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("legacy.ps1");
        let original = text_encoding::encode(
            "Write-Output '中文'\r\n",
            text_encoding::TextEncoding::Utf16Le,
            true,
            text_encoding::LineEnding::CrLf,
        )
        .unwrap();
        std::fs::write(&path, original).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        write_file(&canonical, "legacy.ps1", "Write-Output '更新后'\n", None)
            .await
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let decoded = text_encoding::decode(&bytes).unwrap();
        assert_eq!(decoded.encoding, text_encoding::TextEncoding::Utf16Le);
        assert!(decoded.bom);
        assert_eq!(decoded.line_ending, text_encoding::LineEnding::CrLf);
        assert_eq!(decoded.content, "Write-Output '更新后'\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_file_preserves_an_auto_detected_gbk_file() {
        let root = std::env::temp_dir().join(format!("levelup-write-gbk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("legacy.ini");
        let (original, _, original_errors) =
            encoding_rs::GBK.encode("这是一个较长的中文配置文件，用于自动检测\r\n标题=中文\r\n");
        assert!(!original_errors);
        std::fs::write(&path, original.as_ref()).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        write_file(
            &canonical,
            "legacy.ini",
            "这是一个较长的中文配置文件，用于自动检测\n标题=汉字\n",
            None,
        )
        .await
        .unwrap();

        let (expected, _, expected_errors) =
            encoding_rs::GBK.encode("这是一个较长的中文配置文件，用于自动检测\r\n标题=汉字\r\n");
        assert!(!expected_errors);
        assert_eq!(std::fs::read(&path).unwrap(), expected.as_ref());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_file_noop_keeps_mixed_source_bytes_exactly() {
        let root =
            std::env::temp_dir().join(format!("levelup-write-noop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("mixed.txt");
        let original = "第一行\r\n第二行\n第三行\r\n".as_bytes().to_vec();
        std::fs::write(&path, &original).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        let result = write_file(&canonical, "mixed.txt", "第一行\n第二行\n第三行\n", None)
            .await
            .unwrap();
        assert!(result.contains("No changes"));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn atomic_write_rejects_a_stale_full_file_snapshot() {
        let root =
            std::env::temp_dir().join(format!("levelup-write-stale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("source.txt");
        std::fs::write(&path, b"original").unwrap();

        std::fs::write(&path, b"changed by editor").unwrap();
        let error = write_bytes_atomic(&path, b"agent replacement", Some(b"original"))
            .await
            .unwrap_err();
        assert!(error.contains("changed while the file was being prepared"));
        assert_eq!(std::fs::read(&path).unwrap(), b"changed by editor");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn atomic_write_rejects_a_destination_that_appears_for_a_new_file() {
        let root =
            std::env::temp_dir().join(format!("levelup-write-appeared-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("new.txt");
        std::fs::write(&path, b"created by another writer").unwrap();

        let error = write_bytes_atomic(&path, b"agent replacement", None)
            .await
            .unwrap_err();
        assert!(error.contains("destination appeared"));
        assert_eq!(std::fs::read(&path).unwrap(), b"created by another writer");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_file_defaults_new_files_to_utf8_without_bom() {
        let root = std::env::temp_dir().join(format!("levelup-new-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        write_file(&canonical, "nested/new.txt", "\u{feff}中文\r\n", None)
            .await
            .unwrap();
        let bytes = std::fs::read(root.join("nested/new.txt")).unwrap();
        assert_eq!(bytes, "中文\n".as_bytes());
        let decoded = text_encoding::decode(&bytes).unwrap();
        assert_eq!(decoded.encoding, text_encoding::TextEncoding::Utf8);
        assert!(!decoded.bom);
        assert_eq!(decoded.line_ending, text_encoding::LineEnding::Lf);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_file_rejects_oversized_transport_text_before_encoding() {
        let root =
            std::env::temp_dir().join(format!("levelup-write-oversized-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        let content = "中".repeat(MAX_WRITE_BYTES / "中".len() + 1);
        let error = write_file(&canonical, "too-large.txt", &content, None)
            .await
            .unwrap_err();
        assert!(error.contains("1 MiB"));
        assert!(!root.join("too-large.txt").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_file_honors_explicit_utf16_encoding_for_new_files() {
        let root = std::env::temp_dir().join(format!("levelup-new-utf16-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        write_file(
            &canonical,
            "new.ps1",
            "Write-Output '中文'\n",
            Some(text_encoding::TextEncoding::Utf16Le),
        )
        .await
        .unwrap();
        let decoded = text_encoding::decode(&std::fs::read(root.join("new.ps1")).unwrap()).unwrap();
        assert_eq!(decoded.encoding, text_encoding::TextEncoding::Utf16Le);
        assert!(decoded.bom);
        assert_eq!(decoded.content, "Write-Output '中文'\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_file_adds_a_bom_to_an_empty_file_with_explicit_utf16() {
        let root =
            std::env::temp_dir().join(format!("levelup-empty-utf16-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("empty.ps1");
        std::fs::write(&path, []).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        write_file(
            &canonical,
            "empty.ps1",
            "\u{feff}中文\n",
            Some(text_encoding::TextEncoding::Utf16Le),
        )
        .await
        .unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(&[0xff, 0xfe]));
        let decoded = text_encoding::decode(&bytes).unwrap();
        assert_eq!(decoded.encoding, text_encoding::TextEncoding::Utf16Le);
        assert!(decoded.bom);
        assert_eq!(decoded.content, "中文\n");

        let format_only = root.join("format-only.ps1");
        std::fs::write(&format_only, []).unwrap();
        write_file(
            &canonical,
            "format-only.ps1",
            "\u{feff}",
            Some(text_encoding::TextEncoding::Utf16Le),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(format_only).unwrap(), [0xff, 0xfe]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_rejects_ambiguous_replacements() {
        let root = std::env::temp_dir().join(format!("levelup-ambiguous-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("repeat.txt"), "中文\n中文\n").unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        let error = edit_file(&canonical, "repeat.txt", "中文", "汉字", None, false)
            .await
            .unwrap_err();
        assert!(error.contains("2 matches"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_rejects_unrepresentable_characters_without_corruption() {
        let root =
            std::env::temp_dir().join(format!("levelup-unrepresentable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("legacy.txt");
        let (original, _, had_errors) = encoding_rs::GBK.encode("标题=中文\r\n");
        assert!(!had_errors);
        std::fs::write(&path, original.as_ref()).unwrap();
        let before = std::fs::read(&path).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        let error = edit_file(
            &canonical,
            "legacy.txt",
            "中文",
            "😀",
            Some(text_encoding::TextEncoding::Gbk),
            false,
        )
        .await
        .unwrap_err();
        assert!(error.contains("cannot represent"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn decodes_legacy_command_output_without_replacement_characters() {
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("命令输出\r\n");
        assert!(!had_errors);
        assert_eq!(
            text_encoding::decode_command_output(bytes.as_ref()),
            "命令输出\n"
        );
    }

    #[tokio::test]
    async fn edit_file_accepts_an_explicit_legacy_encoding_hint() {
        let root = std::env::temp_dir().join(format!("levelup-hint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("japanese.txt");
        let (original, _, had_errors) = encoding_rs::SHIFT_JIS.encode("日本語\r\n");
        assert!(!had_errors);
        std::fs::write(&path, original.as_ref()).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        edit_file(
            &canonical,
            "japanese.txt",
            "日本語",
            "日本語更新",
            Some(text_encoding::TextEncoding::ShiftJis),
            false,
        )
        .await
        .unwrap();
        let decoded = text_encoding::decode_with_hint(
            &std::fs::read(&path).unwrap(),
            text_encoding::TextEncoding::ShiftJis,
        )
        .unwrap();
        assert_eq!(decoded.content, "日本語更新\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_uses_a_legacy_hint_when_ascii_source_has_no_encoding_signal() {
        let root =
            std::env::temp_dir().join(format!("levelup-ascii-hint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("legacy.cpp");
        std::fs::write(&path, b"// project title\r\nint main() {}\r\n").unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        edit_file(
            &canonical,
            "legacy.cpp",
            "// project title",
            "// 中文标题",
            Some(text_encoding::TextEncoding::Gbk),
            false,
        )
        .await
        .unwrap();

        let (expected, _, had_errors) = encoding_rs::GBK.encode("// 中文标题\r\nint main() {}\r\n");
        assert!(!had_errors);
        assert_eq!(std::fs::read(&path).unwrap(), expected.as_ref());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_file_uses_a_legacy_hint_when_ascii_source_has_no_encoding_signal() {
        let root =
            std::env::temp_dir().join(format!("levelup-ascii-write-hint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("legacy.ini");
        std::fs::write(&path, b"title=english\r\n").unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();

        write_file(
            &canonical,
            "legacy.ini",
            "title=中文\n",
            Some(text_encoding::TextEncoding::Gbk),
        )
        .await
        .unwrap();

        let (expected, _, had_errors) = encoding_rs::GBK.encode("title=中文\r\n");
        assert!(!had_errors);
        assert_eq!(std::fs::read(&path).unwrap(), expected.as_ref());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_file_splices_all_supported_multibyte_legacy_codecs() {
        let root = std::env::temp_dir().join(format!(
            "levelup-edit-legacy-codecs-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        let samples = [
            (
                "gb18030.txt",
                encoding_rs::GB18030,
                text_encoding::TextEncoding::Gb18030,
                "前置𠀀内容\r\n保留",
                "前置𠀀修改\r\n保留",
                "内容",
                "修改",
            ),
            (
                "big5.txt",
                encoding_rs::BIG5,
                text_encoding::TextEncoding::Big5,
                "前置繁體內容\r\n保留",
                "前置繁體修改\r\n保留",
                "內容",
                "修改",
            ),
            (
                "sjis.txt",
                encoding_rs::SHIFT_JIS,
                text_encoding::TextEncoding::ShiftJis,
                "前置日本語テキスト\r\n保留",
                "前置日本語変更テキスト\r\n保留",
                "テキスト",
                "変更テキスト",
            ),
        ];
        for (name, codec, encoding, before, after, old_string, new_string) in samples {
            let (bytes, _, had_errors) = codec.encode(before);
            assert!(!had_errors, "{name}");
            std::fs::write(root.join(name), bytes.as_ref()).unwrap();
            edit_file(
                &canonical,
                name,
                old_string,
                new_string,
                Some(encoding),
                false,
            )
            .await
            .unwrap();
            let (expected, _, expected_errors) = codec.encode(after);
            assert!(!expected_errors, "{name}");
            assert_eq!(
                std::fs::read(root.join(name)).unwrap(),
                expected.as_ref(),
                "{name}"
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn search_files_accepts_an_explicit_legacy_encoding_hint() {
        let root =
            std::env::temp_dir().join(format!("levelup-search-hint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("中文\n");
        assert!(!had_errors);
        std::fs::write(root.join("legacy.txt"), bytes.as_ref()).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        let result = search_files(
            &canonical,
            "中文",
            None,
            Some(text_encoding::TextEncoding::Gbk),
        )
        .unwrap();
        assert!(result.contains("legacy.txt:1"), "{result}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn powershell_command_output_keeps_chinese_text() {
        let root = std::env::temp_dir().join(format!("levelup-command-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let output = run_command(&root, "Write-Output '中文命令输出'")
            .await
            .unwrap();
        assert!(output.contains("中文命令输出"));
        let _ = std::fs::remove_dir_all(root);
    }
}
