use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use uuid::Uuid;

use crate::models::{
    ConfigFilePreview, ConfigWritePreview, ConfigWriteResult, ExternalConfigTarget,
    ProviderProfile, ProviderProtocol,
};

struct PlannedFile {
    path: PathBuf,
    content: String,
    diff: String,
}

pub fn preview(
    home: &Path,
    target: ExternalConfigTarget,
    profile: &ProviderProfile,
    api_key: &str,
) -> Result<ConfigWritePreview, String> {
    let plans = plans(home, target, profile, api_key)?;
    Ok(ConfigWritePreview {
        target,
        files: plans
            .into_iter()
            .map(|plan| ConfigFilePreview {
                path: plan.path.to_string_lossy().into_owned(),
                exists: plan.path.exists(),
                diff: plan.diff,
            })
            .collect(),
        confirmation_token: String::new(),
    })
}

pub fn apply(
    home: &Path,
    target: ExternalConfigTarget,
    profile: &ProviderProfile,
    api_key: &str,
) -> Result<ConfigWriteResult, String> {
    let plans = plans(home, target, profile, api_key)?;
    apply_plans(target, plans)
}

fn apply_plans(
    target: ExternalConfigTarget,
    plans: Vec<PlannedFile>,
) -> Result<ConfigWriteResult, String> {
    let backup_id = format!("{}-{}", now_millis(), Uuid::new_v4().simple());
    let mut staged = Vec::new();
    for plan in &plans {
        let Some(parent) = plan.path.parent() else {
            cleanup_files(&staged);
            return Err("Configuration path has no parent directory".to_owned());
        };
        if let Err(error) = std::fs::create_dir_all(parent) {
            cleanup_files(&staged);
            return Err(format!("Could not create configuration directory: {error}"));
        }
        let temp = match sibling(
            &plan.path,
            &format!("levelup-agent-temp-{}", Uuid::new_v4().simple()),
        ) {
            Ok(temp) => temp,
            Err(error) => {
                cleanup_files(&staged);
                return Err(error);
            }
        };
        let mut file = match std::fs::File::create(&temp) {
            Ok(file) => file,
            Err(error) => {
                cleanup_files(&staged);
                return Err(format!("Could not stage configuration: {error}"));
            }
        };
        if let Err(error) = crate::filesystem::restrict_file(&temp) {
            let _ = std::fs::remove_file(&temp);
            cleanup_files(&staged);
            return Err(error);
        }
        if let Err(error) = file
            .write_all(plan.content.as_bytes())
            .and_then(|_| file.sync_all())
        {
            let _ = std::fs::remove_file(&temp);
            cleanup_files(&staged);
            return Err(format!("Could not flush staged configuration: {error}"));
        }
        staged.push(temp);
    }

    let mut committed = Vec::new();
    for (plan, temp) in plans.iter().zip(staged.iter()) {
        let backup = backup_path(&plan.path, &backup_id)?;
        let marker = created_marker_path(&plan.path, &backup_id)?;
        let existed = plan.path.exists();
        if existed {
            if let Err(error) = std::fs::rename(&plan.path, &backup) {
                rollback_committed(&committed, &backup_id);
                cleanup_files(&staged);
                return Err(format!("Could not create configuration backup: {error}"));
            }
        } else {
            if let Err(error) = std::fs::File::create(&marker) {
                rollback_committed(&committed, &backup_id);
                cleanup_files(&staged);
                return Err(format!("Could not create rollback marker: {error}"));
            }
        }
        if let Err(error) = std::fs::rename(temp, &plan.path) {
            if existed {
                let _ = std::fs::rename(&backup, &plan.path);
            } else {
                let _ = std::fs::remove_file(&marker);
            }
            rollback_committed(&committed, &backup_id);
            cleanup_files(&staged);
            return Err(format!("Could not activate staged configuration: {error}"));
        }
        committed.push((plan.path.clone(), existed));
    }
    Ok(ConfigWriteResult {
        target,
        backup_id,
        changed_files: plans
            .into_iter()
            .map(|plan| plan.path.to_string_lossy().into_owned())
            .collect(),
    })
}

pub fn rollback(
    home: &Path,
    target: ExternalConfigTarget,
    backup_id: &str,
) -> Result<Vec<String>, String> {
    rollback_paths(target_paths(home, target), backup_id)
}

fn rollback_paths(paths: Vec<PathBuf>, backup_id: &str) -> Result<Vec<String>, String> {
    validate_backup_id(backup_id)?;
    let mut restored = Vec::new();
    let mut found = false;
    for path in paths {
        let backup = backup_path(&path, backup_id)?;
        let marker = created_marker_path(&path, backup_id)?;
        if backup.exists() {
            found = true;
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|error| format!("Could not remove current configuration: {error}"))?;
            }
            std::fs::rename(&backup, &path)
                .map_err(|error| format!("Could not restore configuration backup: {error}"))?;
            restored.push(path.to_string_lossy().into_owned());
        } else if marker.exists() {
            found = true;
            if path.exists() {
                std::fs::remove_file(&path).map_err(|error| {
                    format!("Could not remove generated configuration: {error}")
                })?;
            }
            std::fs::remove_file(&marker)
                .map_err(|error| format!("Could not remove rollback marker: {error}"))?;
            restored.push(path.to_string_lossy().into_owned());
        }
    }
    if !found {
        return Err("The selected configuration backup no longer exists".to_owned());
    }
    Ok(restored)
}

pub fn prompt_preview(
    home: &Path,
    target: ExternalConfigTarget,
    content: &str,
) -> Result<ConfigWritePreview, String> {
    let plan = prompt_plan(home, target, content)?;
    Ok(ConfigWritePreview {
        target,
        files: vec![ConfigFilePreview {
            path: plan.path.to_string_lossy().into_owned(),
            exists: plan.path.exists(),
            diff: plan.diff,
        }],
        confirmation_token: String::new(),
    })
}

pub fn prompt_apply(
    home: &Path,
    target: ExternalConfigTarget,
    content: &str,
) -> Result<ConfigWriteResult, String> {
    apply_plans(target, vec![prompt_plan(home, target, content)?])
}

pub fn prompt_rollback(
    home: &Path,
    target: ExternalConfigTarget,
    backup_id: &str,
) -> Result<Vec<String>, String> {
    rollback_paths(vec![prompt_path(home, target)], backup_id)
}

fn prompt_plan(
    home: &Path,
    target: ExternalConfigTarget,
    content: &str,
) -> Result<PlannedFile, String> {
    if content.chars().count() > 32_000 {
        return Err("Instructions may contain at most 32,000 characters".to_owned());
    }
    let path = prompt_path(home, target);
    let normalized = content.trim();
    let content = if normalized.is_empty() {
        String::new()
    } else {
        format!("{normalized}\n")
    };
    let mut diff = format!(
        "--- {}\n+++ {}\n@@ synchronized instructions @@\n",
        path.display(),
        path.display()
    );
    for line in normalized.lines() {
        diff.push_str("+ ");
        diff.push_str(line);
        diff.push('\n');
    }
    Ok(PlannedFile {
        path,
        content,
        diff,
    })
}

fn prompt_path(home: &Path, target: ExternalConfigTarget) -> PathBuf {
    match target {
        ExternalConfigTarget::Codex => {
            configured_root(home, "CODEX_HOME", ".codex").join("AGENTS.md")
        }
        ExternalConfigTarget::Claude => {
            configured_root(home, "CLAUDE_CONFIG_DIR", ".claude").join("CLAUDE.md")
        }
        ExternalConfigTarget::Gemini => {
            configured_root(home, "GEMINI_CLI_HOME", ".gemini").join("GEMINI.md")
        }
        ExternalConfigTarget::Opencode => opencode_root(home).join("AGENTS.md"),
    }
}

fn plans(
    home: &Path,
    target: ExternalConfigTarget,
    profile: &ProviderProfile,
    api_key: &str,
) -> Result<Vec<PlannedFile>, String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty".to_owned());
    }
    validate_base_url(&profile.base_url)?;
    match target {
        ExternalConfigTarget::Codex => codex_plans(home, profile, api_key),
        ExternalConfigTarget::Claude => claude_plans(home, profile, api_key),
        ExternalConfigTarget::Gemini => gemini_plans(home, profile, api_key),
        ExternalConfigTarget::Opencode => opencode_plans(home, profile, api_key),
    }
}

fn validate_base_url(value: &str) -> Result<(), String> {
    let url =
        url::Url::parse(value.trim()).map_err(|_| "Provider base URL is invalid".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Provider base URL must be HTTP(S) without credentials, query, or fragment".to_owned(),
        );
    }
    Ok(())
}

fn codex_plans(
    home: &Path,
    profile: &ProviderProfile,
    api_key: &str,
) -> Result<Vec<PlannedFile>, String> {
    if !matches!(
        profile.protocol,
        ProviderProtocol::OpenaiResponses | ProviderProtocol::OpenaiChat
    ) {
        return Err("Codex requires an OpenAI Responses or Chat Completions connection".to_owned());
    }
    let directory = configured_root(home, "CODEX_HOME", ".codex");
    let config_path = directory.join("config.toml");
    let mut config = read_optional(&config_path)?
        .map(|text| {
            toml::from_str::<toml::Value>(&text)
                .map_err(|error| format!("Codex config.toml is invalid: {error}"))
        })
        .transpose()?
        .unwrap_or_else(|| toml::Value::Table(Default::default()));
    let root = config
        .as_table_mut()
        .ok_or_else(|| "Codex config root must be a TOML table".to_owned())?;
    root.insert(
        "model".to_owned(),
        toml::Value::String(profile.model.clone()),
    );
    root.insert(
        "model_provider".to_owned(),
        toml::Value::String("levelup_agent".to_owned()),
    );
    let providers = root
        .entry("model_providers")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or_else(|| "Codex model_providers must be a TOML table".to_owned())?;
    let mut provider = toml::map::Map::new();
    provider.insert("name".to_owned(), toml::Value::String(profile.name.clone()));
    provider.insert(
        "base_url".to_owned(),
        toml::Value::String(profile.base_url.trim_end_matches('/').to_owned()),
    );
    provider.insert(
        "env_key".to_owned(),
        toml::Value::String("OPENAI_API_KEY".to_owned()),
    );
    provider.insert(
        "wire_api".to_owned(),
        toml::Value::String(
            match profile.protocol {
                ProviderProtocol::OpenaiChat => "chat",
                _ => "responses",
            }
            .to_owned(),
        ),
    );
    providers.insert("levelup_agent".to_owned(), toml::Value::Table(provider));
    let config_content = toml::to_string_pretty(&config)
        .map_err(|error| format!("Could not encode Codex config: {error}"))?;

    let auth_path = directory.join("auth.json");
    let mut auth = read_json_object(&auth_path)?;
    auth.insert(
        "OPENAI_API_KEY".to_owned(),
        Value::String(api_key.to_owned()),
    );
    let auth_content = serde_json::to_string_pretty(&Value::Object(auth))
        .map_err(|error| format!("Could not encode Codex auth: {error}"))?
        + "\n";
    Ok(vec![
        PlannedFile {
            path: config_path.clone(),
            content: config_content,
            diff: summary_diff(
                &config_path,
                &[
                    ("model", &profile.model),
                    ("model_provider", "levelup_agent"),
                    ("base_url", &profile.base_url),
                    (
                        "wire_api",
                        match profile.protocol {
                            ProviderProtocol::OpenaiChat => "chat",
                            _ => "responses",
                        },
                    ),
                ],
            ),
        },
        PlannedFile {
            path: auth_path.clone(),
            content: auth_content,
            diff: summary_diff(&auth_path, &[("OPENAI_API_KEY", "••••••••")]),
        },
    ])
}

fn claude_plans(
    home: &Path,
    profile: &ProviderProfile,
    api_key: &str,
) -> Result<Vec<PlannedFile>, String> {
    if !matches!(profile.protocol, ProviderProtocol::AnthropicMessages) {
        return Err("Claude Code requires an Anthropic Messages connection".to_owned());
    }
    let directory = configured_root(home, "CLAUDE_CONFIG_DIR", ".claude");
    let path = directory.join("settings.json");
    let mut root = read_json_object(&path)?;
    let env = root
        .entry("env")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Claude settings env must be a JSON object".to_owned())?;
    env.insert(
        "ANTHROPIC_BASE_URL".to_owned(),
        Value::String(profile.base_url.trim_end_matches('/').to_owned()),
    );
    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_owned(),
        Value::String(api_key.to_owned()),
    );
    env.insert(
        "ANTHROPIC_MODEL".to_owned(),
        Value::String(profile.model.clone()),
    );
    let content = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|error| format!("Could not encode Claude settings: {error}"))?
        + "\n";
    Ok(vec![PlannedFile {
        path: path.clone(),
        content,
        diff: summary_diff(
            &path,
            &[
                ("ANTHROPIC_BASE_URL", &profile.base_url),
                ("ANTHROPIC_AUTH_TOKEN", "••••••••"),
                ("ANTHROPIC_MODEL", &profile.model),
            ],
        ),
    }])
}

fn gemini_plans(
    home: &Path,
    profile: &ProviderProfile,
    api_key: &str,
) -> Result<Vec<PlannedFile>, String> {
    if !matches!(profile.protocol, ProviderProtocol::GeminiGenerateContent) {
        return Err("Gemini CLI requires a Gemini GenerateContent connection".to_owned());
    }
    let directory = configured_root(home, "GEMINI_CLI_HOME", ".gemini");
    let path = directory.join(".env");
    let current = read_optional(&path)?.unwrap_or_default();
    let updates = BTreeMap::from([
        (
            "GOOGLE_GEMINI_BASE_URL",
            profile.base_url.trim_end_matches('/'),
        ),
        ("GEMINI_API_KEY", api_key),
        ("GEMINI_MODEL", profile.model.as_str()),
    ]);
    let content = update_env(&current, &updates);
    Ok(vec![PlannedFile {
        path: path.clone(),
        content,
        diff: summary_diff(
            &path,
            &[
                ("GOOGLE_GEMINI_BASE_URL", &profile.base_url),
                ("GEMINI_API_KEY", "••••••••"),
                ("GEMINI_MODEL", &profile.model),
            ],
        ),
    }])
}

fn opencode_plans(
    home: &Path,
    profile: &ProviderProfile,
    api_key: &str,
) -> Result<Vec<PlannedFile>, String> {
    let directory = opencode_root(home);
    let path = directory.join("opencode.json");
    let mut root = read_json5_object(&path)?;
    root.entry("$schema")
        .or_insert_with(|| Value::String("https://opencode.ai/config.json".to_owned()));
    let providers = root
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "OpenCode provider must be a JSON object".to_owned())?;
    let npm = match profile.protocol {
        ProviderProtocol::OpenaiResponses => "@ai-sdk/openai",
        ProviderProtocol::OpenaiChat => "@ai-sdk/openai-compatible",
        ProviderProtocol::AnthropicMessages => "@ai-sdk/anthropic",
        ProviderProtocol::GeminiGenerateContent => "@ai-sdk/google",
    };
    providers.insert(
        "levelup_agent".to_owned(),
        serde_json::json!({
            "npm": npm,
            "name": profile.name,
            "options": {
                "baseURL": profile.base_url.trim_end_matches('/'),
                "apiKey": api_key,
            },
            "models": {
                profile.model.clone(): { "name": profile.model }
            }
        }),
    );
    let content = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|error| format!("Could not encode OpenCode config: {error}"))?
        + "\n";
    Ok(vec![PlannedFile {
        path: path.clone(),
        content,
        diff: summary_diff(
            &path,
            &[
                ("provider", "levelup_agent"),
                ("npm", npm),
                ("baseURL", &profile.base_url),
                ("apiKey", "••••••••"),
                ("model", &profile.model),
            ],
        ),
    }])
}

fn target_paths(home: &Path, target: ExternalConfigTarget) -> Vec<PathBuf> {
    match target {
        ExternalConfigTarget::Codex => {
            let root = configured_root(home, "CODEX_HOME", ".codex");
            vec![root.join("config.toml"), root.join("auth.json")]
        }
        ExternalConfigTarget::Claude => {
            vec![configured_root(home, "CLAUDE_CONFIG_DIR", ".claude").join("settings.json")]
        }
        ExternalConfigTarget::Gemini => {
            vec![configured_root(home, "GEMINI_CLI_HOME", ".gemini").join(".env")]
        }
        ExternalConfigTarget::Opencode => vec![opencode_root(home).join("opencode.json")],
    }
}

#[cfg(not(test))]
fn configured_root(home: &Path, variable: &str, fallback: &str) -> PathBuf {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(fallback))
}

#[cfg(test)]
fn configured_root(home: &Path, _variable: &str, fallback: &str) -> PathBuf {
    home.join(fallback)
}

#[cfg(not(test))]
fn opencode_root(home: &Path) -> PathBuf {
    std::env::var_os("OPENCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME").map(|root| PathBuf::from(root).join("opencode"))
        })
        .unwrap_or_else(|| home.join(".config").join("opencode"))
}

#[cfg(test)]
fn opencode_root(home: &Path) -> PathBuf {
    home.join(".config").join("opencode")
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    let Some(text) = read_optional(path)? else {
        return Ok(Map::new());
    };
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("{} is invalid JSON: {error}", path.display()))?
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))
}

fn read_json5_object(path: &Path) -> Result<Map<String, Value>, String> {
    let Some(text) = read_optional(path)? else {
        return Ok(Map::new());
    };
    json5::from_str::<Value>(&text)
        .map_err(|error| format!("{} is invalid JSON5: {error}", path.display()))?
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))
}

fn update_env(current: &str, updates: &BTreeMap<&str, &str>) -> String {
    let mut seen = BTreeMap::new();
    let mut lines = Vec::new();
    for line in current.lines() {
        let key = line.split_once('=').map(|(key, _)| key.trim());
        if let Some((key, value)) = key.and_then(|key| updates.get_key_value(key)) {
            lines.push(format!("{key}={}", quote_env(value)));
            seen.insert(*key, true);
        } else {
            lines.push(line.to_owned());
        }
    }
    for (key, value) in updates {
        if !seen.contains_key(key) {
            lines.push(format!("{key}={}", quote_env(value)));
        }
    }
    format!("{}\n", lines.join("\n").trim_start_matches('\n'))
}

fn quote_env(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

fn summary_diff(path: &Path, values: &[(&str, &str)]) -> String {
    let mut output = format!(
        "--- {}\n+++ {}\n@@ LevelUpAgent managed fields @@\n",
        path.display(),
        path.display()
    );
    for (key, value) in values {
        output.push_str(&format!("+ {key} = {value}\n"));
    }
    output
}

fn sibling(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Configuration filename is invalid".to_owned())?;
    Ok(path.with_file_name(format!("{name}.{suffix}")))
}

fn backup_path(path: &Path, backup_id: &str) -> Result<PathBuf, String> {
    sibling(path, &format!("levelup-agent-backup-{backup_id}"))
}

fn created_marker_path(path: &Path, backup_id: &str) -> Result<PathBuf, String> {
    sibling(path, &format!("levelup-agent-created-{backup_id}"))
}

fn validate_backup_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Configuration backup ID is invalid".to_owned());
    }
    Ok(())
}

fn rollback_committed(committed: &[(PathBuf, bool)], backup_id: &str) {
    for (path, existed) in committed.iter().rev() {
        let _ = std::fs::remove_file(path);
        if *existed {
            if let Ok(backup) = backup_path(path, backup_id) {
                let _ = std::fs::rename(backup, path);
            }
        } else if let Ok(marker) = created_marker_path(path, backup_id) {
            let _ = std::fs::remove_file(marker);
        }
    }
}

fn cleanup_files(paths: &[PathBuf]) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(protocol: ProviderProtocol) -> ProviderProfile {
        ProviderProfile {
            id: "levelup".to_owned(),
            name: "LevelUpAPI".to_owned(),
            base_url: "http://127.0.0.1:8080/v1".to_owned(),
            model: "test-model".to_owned(),
            protocol,
            allow_unauthenticated: false,
            priority: 10,
            failover_enabled: true,
        }
    }

    #[test]
    fn preview_never_contains_the_api_key() {
        let root = std::env::temp_dir().join(format!("levelup-write-preview-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let preview = preview(
            &root,
            ExternalConfigTarget::Claude,
            &profile(ProviderProtocol::AnthropicMessages),
            "super-secret",
        )
        .unwrap();
        assert!(!preview.files[0].diff.contains("super-secret"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn configuration_export_rejects_secrets_embedded_in_base_urls() {
        let root = std::env::temp_dir().join(format!("levelup-write-url-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut unsafe_profile = profile(ProviderProtocol::AnthropicMessages);
        unsafe_profile.base_url = "https://user:password@relay.example/v1".to_owned();
        assert!(
            preview(
                &root,
                ExternalConfigTarget::Claude,
                &unsafe_profile,
                "secret"
            )
            .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn apply_creates_timestamped_backups_and_rollback_restores_originals() {
        let root = std::env::temp_dir().join(format!("levelup-write-rollback-{}", Uuid::new_v4()));
        let directory = root.join(".claude");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        std::fs::write(&path, "{\"custom\":true}\n").unwrap();
        let result = apply(
            &root,
            ExternalConfigTarget::Claude,
            &profile(ProviderProtocol::AnthropicMessages),
            "secret",
        )
        .unwrap();
        let changed = std::fs::read_to_string(&path).unwrap();
        assert!(changed.contains("ANTHROPIC_BASE_URL"));
        rollback(&root, ExternalConfigTarget::Claude, &result.backup_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"custom\":true}\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opencode_json5_is_preserved_as_valid_json_and_secret_is_redacted() {
        let root = std::env::temp_dir().join(format!("levelup-write-opencode-{}", Uuid::new_v4()));
        let directory = root.join(".config/opencode");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("opencode.json"),
            "{ custom: true, provider: {}, }\n",
        )
        .unwrap();
        let profile = profile(ProviderProtocol::OpenaiChat);
        let preview = preview(
            &root,
            ExternalConfigTarget::Opencode,
            &profile,
            "open-secret",
        )
        .unwrap();
        assert!(!preview.files[0].diff.contains("open-secret"));
        let result = apply(
            &root,
            ExternalConfigTarget::Opencode,
            &profile,
            "open-secret",
        )
        .unwrap();
        let value: Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(value["custom"], Value::Bool(true));
        assert_eq!(
            value["provider"]["levelup_agent"]["options"]["apiKey"],
            "open-secret"
        );
        rollback(&root, ExternalConfigTarget::Opencode, &result.backup_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.join("opencode.json")).unwrap(),
            "{ custom: true, provider: {}, }\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn synchronized_prompt_is_previewed_backed_up_and_restored() {
        let root = std::env::temp_dir().join(format!("levelup-prompt-sync-{}", Uuid::new_v4()));
        let directory = root.join(".codex");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("AGENTS.md");
        std::fs::write(&path, "Original instructions\n").unwrap();
        let preview = prompt_preview(
            &root,
            ExternalConfigTarget::Codex,
            "Prefer evidence.\nRun tests.",
        )
        .unwrap();
        assert!(preview.files[0].diff.contains("+ Prefer evidence."));
        let result = prompt_apply(
            &root,
            ExternalConfigTarget::Codex,
            "Prefer evidence.\nRun tests.",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "Prefer evidence.\nRun tests.\n"
        );
        prompt_rollback(&root, ExternalConfigTarget::Codex, &result.backup_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "Original instructions\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
