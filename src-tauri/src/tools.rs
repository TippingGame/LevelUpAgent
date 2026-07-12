use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use globset::Glob;
use serde_json::Value;
use tokio::process::Command;
use walkdir::{DirEntry, WalkDir};

use crate::models::{ToolExecutionRequest, ToolExecutionResponse};
use crate::process::hide_console_window;

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
        "read_file" => read_file(&root, required_arg(&request.arguments, "path")?).await,
        "search_files" => search_files(
            &root,
            required_arg(&request.arguments, "query")?,
            string_arg(&request.arguments, "glob"),
        ),
        "write_file" => {
            write_file(
                &root,
                required_arg(&request.arguments, "path")?,
                required_arg(&request.arguments, "content")?,
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

async fn read_file(root: &Path, relative: &str) -> Result<String, String> {
    let path = resolve_existing(root, relative)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("The requested path is not a file".to_owned());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("File is larger than {} KiB", MAX_FILE_BYTES / 1024));
    }
    tokio::fs::read_to_string(path)
        .await
        .map_err(|error| format!("Could not read UTF-8 file: {error}"))
}

fn search_files(root: &Path, query: &str, pattern: Option<&str>) -> Result<String, String> {
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
        .filter(|entry| entry.file_type().is_file())
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
            && let Ok(text) = std::fs::read_to_string(entry.path())
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

async fn write_file(root: &Path, relative: &str, content: &str) -> Result<String, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err("File writes may contain at most 1 MiB".to_owned());
    }
    let path = resolve_for_write(root, relative)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Could not create parent directory: {error}"))?;
    }
    tokio::fs::write(&path, content)
        .await
        .map_err(|error| format!("Could not write file: {error}"))?;
    Ok(format!("Wrote {} bytes to {}", content.len(), relative))
}

async fn delete_file(root: &Path, relative: &str) -> Result<String, String> {
    validate_relative(relative)?;
    let requested = root.join(relative);
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
            command,
        ]);
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(format!(
        "exit code: {}\nstdout:\n{}\nstderr:\n{}",
        output.status.code().unwrap_or(-1),
        stdout,
        stderr
    ))
}

fn resolve_existing(root: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_relative(relative)?;
    let path = std::fs::canonicalize(root.join(relative))
        .map_err(|error| format!("Path is unavailable: {error}"))?;
    ensure_inside(root, &path)?;
    Ok(path)
}

fn resolve_for_write(root: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_relative(relative)?;
    let candidate = root.join(relative);
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

fn validate_relative(relative: &str) -> Result<(), String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Tool paths must stay inside the selected workspace".to_owned());
    }
    Ok(())
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
        assert!(validate_relative("../secret.txt").is_err());
        assert!(validate_relative("safe/../../secret.txt").is_err());
    }

    #[test]
    fn accepts_workspace_relative_paths() {
        assert!(validate_relative("src/main.rs").is_ok());
        assert!(validate_relative(".").is_ok());
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
        let root = std::fs::canonicalize(&root).unwrap();

        assert!(resolve_existing(&root, "linked-file").is_err());
        assert!(resolve_for_write(&root, "linked-directory/new.txt").is_err());

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
}
