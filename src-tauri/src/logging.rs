use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;
use serde::Serialize;

const LOG_FILE_PREFIX: &str = "levelup-agent-";
const MAX_ERROR_CHARS: usize = 4_000;

static LOGGER: OnceLock<Logger> = OnceLock::new();
static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

struct Logger {
    directory: PathBuf,
    process_id: u32,
    session_id: String,
    writer: Mutex<LogWriter>,
}

struct LogWriter {
    path: PathBuf,
    date: String,
    writer: Option<BufWriter<File>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLogInfo {
    pub directory: String,
    pub current_file: String,
}

impl Logger {
    fn open(directory: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create the log directory: {error}"))?;
        let date = current_local_date();
        let path = directory.join(log_file_name(&date));
        cleanup_expired_logs(&directory, &path);
        let file = open_file(&path)?;
        Ok(Self {
            directory,
            process_id: std::process::id(),
            session_id: uuid::Uuid::new_v4().to_string(),
            writer: Mutex::new(LogWriter {
                path,
                date,
                writer: Some(BufWriter::new(file)),
            }),
        })
    }

    fn info(&self) -> AppLogInfo {
        AppLogInfo {
            directory: self.directory.to_string_lossy().into_owned(),
            current_file: self
                .writer
                .lock()
                .map(|state| state.path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| self.directory.to_string_lossy().into_owned()),
        }
    }

    fn write(&self, level: &str, target: &str, event: &str, fields: serde_json::Value) {
        let record = serde_json::json!({
            "timestampMs": now_millis(),
            "processId": self.process_id,
            "sessionId": self.session_id,
            "level": level,
            "target": target,
            "event": event,
            "fields": fields,
        });
        let Ok(mut encoded) = serde_json::to_vec(&record) else {
            return;
        };
        encoded.push(b'\n');

        let Ok(mut state) = self.writer.lock() else {
            return;
        };
        let date = current_local_date();
        if state.date != date && switch_date(&self.directory, &mut state, date).is_err() {
            return;
        }
        let Some(writer) = state.writer.as_mut() else {
            return;
        };
        let _ = writer.write_all(&encoded).and_then(|()| writer.flush());
    }
}

fn current_local_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn log_file_name(date: &str) -> String {
    format!("{LOG_FILE_PREFIX}{date}.log")
}

fn open_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open the application log: {error}"))
}

fn switch_date(directory: &Path, state: &mut LogWriter, date: String) -> Result<(), String> {
    if let Some(mut writer) = state.writer.take() {
        if let Err(error) = writer.flush() {
            state.writer = Some(BufWriter::new(open_file(&state.path)?));
            return Err(format!("Could not flush the application log: {error}"));
        }
    }
    let path = directory.join(log_file_name(&date));
    cleanup_expired_logs(directory, &path);
    state.writer = Some(BufWriter::new(open_file(&path)?));
    state.path = path;
    state.date = date;
    Ok(())
}

fn cleanup_expired_logs(directory: &Path, current_path: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current_path || !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let is_dated_log = name.starts_with(LOG_FILE_PREFIX) && name.ends_with(".log");
        let is_legacy_log = name == "levelup-agent.log"
            || name
                .strip_prefix("levelup-agent.log.")
                .is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit())
                });
        if is_dated_log || is_legacy_log {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub fn init(app_data: &Path) -> Result<AppLogInfo, String> {
    if let Some(logger) = LOGGER.get() {
        return Ok(logger.info());
    }
    let executable_directory = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let logger = match executable_directory {
        Some(directory) => {
            Logger::open(directory.join("logs")).or_else(|_| Logger::open(app_data.join("logs")))?
        }
        None => Logger::open(app_data.join("logs"))?,
    };
    let info = logger.info();
    LOGGER
        .set(logger)
        .map_err(|_| "The application logger was initialized twice".to_owned())?;
    Ok(info)
}

pub fn info() -> Option<AppLogInfo> {
    LOGGER.get().map(Logger::info)
}

pub fn write(level: &str, target: &str, event: &str, fields: serde_json::Value) {
    if let Some(logger) = LOGGER.get() {
        logger.write(level, target, event, fields);
    }
}

pub fn install_panic_hook() {
    if PANIC_HOOK_INSTALLED.set(()).is_err() {
        return;
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| (*value).to_owned())
            .or_else(|| panic_info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Non-string panic payload".to_owned());
        let location = panic_info.location().map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        });
        write(
            "error",
            "rust",
            "panic",
            serde_json::json!({
                "message": safe_error(&message),
                "location": location,
            }),
        );
        default_hook(panic_info);
    }));
}

pub fn safe_error(value: &str) -> String {
    let mut result = redact_bearer(value);
    result = redact_assignment(&result, "authorization");
    result = redact_assignment(&result, "api_key");
    result = redact_assignment(&result, "api-key");
    result = redact_assignment(&result, "x-api-key");
    result = redact_assignment(&result, "apikey");
    result = redact_assignment(&result, "access_token");
    truncate_chars(&result, MAX_ERROR_CHARS)
}

pub fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    let mut truncated: String = value.chars().take(limit).collect();
    truncated.push_str("...[truncated]");
    truncated
}

fn redact_assignment(value: &str, label: &str) -> String {
    let mut output = value.to_owned();
    let mut search_from = 0usize;
    loop {
        let lower = output.to_ascii_lowercase();
        let Some(relative) = lower[search_from..].find(label) else {
            break;
        };
        let start = search_from + relative + label.len();
        let bytes = output.as_bytes();
        let mut cursor = start;
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t' | b'"' | b'\'') {
            cursor += 1;
        }
        if cursor >= bytes.len() || !matches!(bytes[cursor], b':' | b'=') {
            search_from = start.min(output.len());
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t' | b'"' | b'\'') {
            cursor += 1;
        }
        let end = output[cursor..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ',' | '}' | '"' | '\'')
            })
            .map(|relative| cursor + relative)
            .unwrap_or(output.len());
        if end > cursor {
            output.replace_range(cursor..end, "[REDACTED]");
        }
        search_from = cursor.saturating_add("[REDACTED]".len()).min(output.len());
    }
    output
}

fn redact_bearer(value: &str) -> String {
    let mut output = value.to_owned();
    let mut search_from = 0usize;
    loop {
        let lower = output.to_ascii_lowercase();
        let Some(relative) = lower[search_from..].find("bearer ") else {
            break;
        };
        let start = search_from + relative + "bearer ".len();
        let end = output[start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ',' | '}' | '"' | '\'')
            })
            .map(|relative| start + relative)
            .unwrap_or(output.len());
        if end > start {
            output.replace_range(start..end, "[REDACTED]");
        }
        search_from = start.saturating_add("[REDACTED]".len()).min(output.len());
    }
    output
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_error_values_are_redacted_and_bounded() {
        let source = format!(
            "authorization: Bearer secret-token api_key=another-secret {}",
            "x".repeat(MAX_ERROR_CHARS + 100)
        );
        let redacted = safe_error(&source);
        assert!(!redacted.contains("secret-token"));
        assert!(!redacted.contains("another-secret"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.ends_with("...[truncated]"));
    }

    #[test]
    fn logger_writes_json_lines() {
        let root = std::env::temp_dir().join(format!("levelup-logging-{}", uuid::Uuid::new_v4()));
        let logger = Logger::open(root.clone()).unwrap();
        logger.write("info", "test", "started", serde_json::json!({ "count": 1 }));
        let content =
            std::fs::read_to_string(root.join(log_file_name(&current_local_date()))).unwrap();
        let record: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(record["event"], "started");
        assert_eq!(record["fields"]["count"], 1);
        assert_eq!(record["processId"], std::process::id());
        assert!(
            record["sessionId"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_removes_expired_and_legacy_logs_only() {
        let root = std::env::temp_dir().join(format!("levelup-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let expired = root.join("levelup-agent-2000-01-01.log");
        let legacy = root.join("levelup-agent.log");
        let legacy_backup = root.join("levelup-agent.log.1");
        let unrelated = root.join("keep-me.txt");
        for path in [&expired, &legacy, &legacy_backup, &unrelated] {
            std::fs::write(path, "test").unwrap();
        }

        let logger = Logger::open(root.clone()).unwrap();
        logger.write("info", "test", "today", serde_json::json!({}));

        assert!(!expired.exists());
        assert!(!legacy.exists());
        assert!(!legacy_backup.exists());
        assert!(unrelated.exists());
        assert!(root.join(log_file_name(&current_local_date())).exists());
        assert_eq!(
            std::fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".log"))
                .count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
