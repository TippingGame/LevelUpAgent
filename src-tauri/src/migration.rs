use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::models::{ExternalConfigCandidate, ProviderProfile, ProviderProtocol};

pub struct ImportMaterial {
    pub candidate: ExternalConfigCandidate,
    pub api_key: Option<String>,
}

pub fn scan(home: &Path) -> Vec<ImportMaterial> {
    let mut candidates = Vec::new();
    if let Some(candidate) = scan_codex_live(home) {
        candidates.push(candidate);
    }
    if let Some(candidate) = scan_claude_live(home) {
        candidates.push(candidate);
    }
    if let Some(candidate) = scan_gemini_live(home) {
        candidates.push(candidate);
    }
    candidates.extend(scan_opencode_live(home));
    candidates.extend(scan_cc_switch(home));
    candidates
}

fn scan_opencode_live(home: &Path) -> Vec<ImportMaterial> {
    let directory = opencode_directory(home);
    let Ok(text) = std::fs::read_to_string(directory.join("opencode.json")) else {
        return Vec::new();
    };
    let Ok(config) = json5::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(providers) = config.get("provider").and_then(Value::as_object) else {
        return Vec::new();
    };
    providers
        .iter()
        .filter_map(|(id, provider)| {
            let npm = provider
                .get("npm")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let options = provider.get("options").unwrap_or(provider);
            let base_url =
                json_string(options, &["baseURL", "base_url"]).or_else(|| match npm {
                    value if value.contains("anthropic") => {
                        Some("https://api.anthropic.com".to_owned())
                    }
                    value if value.contains("google") => {
                        Some("https://generativelanguage.googleapis.com".to_owned())
                    }
                    value if value.contains("openai") => {
                        Some("https://api.openai.com/v1".to_owned())
                    }
                    _ => None,
                })?;
            let api_key = options
                .get("apiKey")
                .and_then(Value::as_str)
                .and_then(resolve_opencode_key);
            let model = provider
                .get("models")
                .and_then(Value::as_object)
                .and_then(|models| models.keys().next().cloned())?;
            let protocol = if npm.contains("anthropic") {
                ProviderProtocol::AnthropicMessages
            } else if npm.contains("google") {
                ProviderProtocol::GeminiGenerateContent
            } else if npm.contains("openai-compatible") {
                ProviderProtocol::OpenaiChat
            } else {
                ProviderProtocol::OpenaiResponses
            };
            Some(material(
                &format!("opencode-live-{}", sanitize_id(id)),
                "OpenCode",
                provider.get("name").and_then(Value::as_str).unwrap_or(id),
                base_url,
                model,
                protocol,
                api_key,
            ))
        })
        .collect()
}

fn resolve_opencode_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if let Some(variable) = trimmed
        .strip_prefix("{env:")
        .and_then(|item| item.strip_suffix('}'))
    {
        std::env::var(variable.trim())
            .ok()
            .filter(|item| !item.trim().is_empty())
    } else {
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    }
}

#[cfg(not(test))]
fn opencode_directory(home: &Path) -> PathBuf {
    std::env::var_os("OPENCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME").map(|root| PathBuf::from(root).join("opencode"))
        })
        .unwrap_or_else(|| home.join(".config").join("opencode"))
}

#[cfg(test)]
fn opencode_directory(home: &Path) -> PathBuf {
    home.join(".config").join("opencode")
}

fn scan_codex_live(home: &Path) -> Option<ImportMaterial> {
    let directory = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let config_path = directory.join("config.toml");
    let text = std::fs::read_to_string(config_path).ok()?;
    let config: toml::Value = toml::from_str(&text).ok()?;
    let provider_id = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .unwrap_or("openai");
    let provider = config
        .get("model_providers")
        .and_then(|value| value.get(provider_id));
    let base_url = provider
        .and_then(|value| value.get("base_url"))
        .or_else(|| config.get("base_url"))
        .and_then(toml::Value::as_str)
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/')
        .to_owned();
    let wire_api = provider
        .and_then(|value| value.get("wire_api"))
        .and_then(toml::Value::as_str)
        .unwrap_or("responses");
    let protocol = if wire_api.to_ascii_lowercase().contains("chat") {
        ProviderProtocol::OpenaiChat
    } else {
        ProviderProtocol::OpenaiResponses
    };
    let model = config
        .get("model")
        .and_then(toml::Value::as_str)
        .unwrap_or("gpt-5.5")
        .to_owned();
    let mut api_key = provider
        .and_then(|value| value.get("experimental_bearer_token"))
        .and_then(toml::Value::as_str)
        .map(str::to_owned);
    if api_key.is_none() {
        api_key = provider
            .and_then(|value| value.get("env_key"))
            .and_then(toml::Value::as_str)
            .and_then(|name| std::env::var(name).ok());
    }
    if api_key.is_none() {
        api_key = read_json(&directory.join("auth.json"))
            .and_then(|auth| json_string(&auth, &["OPENAI_API_KEY"]));
    }
    Some(material(
        "codex-live",
        "Codex",
        format!("Codex · {provider_id}"),
        base_url,
        model,
        protocol,
        api_key,
    ))
}

fn scan_claude_live(home: &Path) -> Option<ImportMaterial> {
    let directory = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let settings = read_json(&directory.join("settings.json"))
        .or_else(|| read_json(&directory.join("claude.json")))?;
    material_from_claude_value("claude-live", "Claude", "Claude Code", &settings)
}

fn scan_gemini_live(home: &Path) -> Option<ImportMaterial> {
    let directory = std::env::var_os("GEMINI_CLI_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".gemini"));
    let env = parse_env_file(&directory.join(".env"))?;
    material_from_gemini_env("gemini-live", "Gemini", "Gemini CLI", &env)
}

fn scan_cc_switch(home: &Path) -> Vec<ImportMaterial> {
    let path = home.join(".cc-switch").join("cc-switch.db");
    if !path.exists() {
        return Vec::new();
    }
    let Ok(connection) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT id, app_type, name, settings_config
         FROM providers
         WHERE app_type IN ('codex', 'claude', 'gemini')
         ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .filter_map(|(id, app_type, name, settings)| {
            let value = serde_json::from_str::<Value>(&settings).ok()?;
            let candidate_id = format!("cc-switch-{app_type}-{}", sanitize_id(&id));
            let source = format!("cc-switch/{app_type}");
            match app_type.as_str() {
                "codex" => material_from_codex_value(
                    &candidate_id,
                    &source,
                    &format!("{name} · cc-switch"),
                    &value,
                ),
                "claude" => material_from_claude_value(
                    &candidate_id,
                    &source,
                    &format!("{name} · cc-switch"),
                    &value,
                ),
                "gemini" => material_from_gemini_value(
                    &candidate_id,
                    &source,
                    &format!("{name} · cc-switch"),
                    &value,
                ),
                _ => None,
            }
        })
        .collect()
}

fn material_from_codex_value(
    id: &str,
    source: &str,
    name: &str,
    value: &Value,
) -> Option<ImportMaterial> {
    let config_text = value.get("config").and_then(Value::as_str);
    let config = config_text.and_then(|text| toml::from_str::<toml::Value>(text).ok());
    let provider_id = config
        .as_ref()
        .and_then(|item| item.get("model_provider"))
        .and_then(toml::Value::as_str);
    let provider = provider_id
        .and_then(|provider_id| config.as_ref()?.get("model_providers")?.get(provider_id));
    let base_url = json_string(value, &["base_url", "baseURL"])
        .or_else(|| {
            value
                .get("config")
                .and_then(|item| json_string(item, &["base_url", "baseURL"]))
        })
        .or_else(|| {
            provider
                .and_then(|item| item.get("base_url"))
                .and_then(toml::Value::as_str)
                .map(str::to_owned)
        })?;
    let api_key = value
        .pointer("/env/OPENAI_API_KEY")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/auth/OPENAI_API_KEY")
                .and_then(Value::as_str)
        })
        .map(str::to_owned)
        .or_else(|| json_string(value, &["apiKey", "api_key"]))
        .or_else(|| {
            provider
                .and_then(|item| item.get("experimental_bearer_token"))
                .and_then(toml::Value::as_str)
                .map(str::to_owned)
        });
    let wire_api = json_string(value, &["api_format", "apiFormat"])
        .or_else(|| {
            provider
                .and_then(|item| item.get("wire_api"))
                .and_then(toml::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "responses".to_owned());
    let protocol = if wire_api.to_ascii_lowercase().contains("chat") {
        ProviderProtocol::OpenaiChat
    } else {
        ProviderProtocol::OpenaiResponses
    };
    let model = config
        .as_ref()
        .and_then(|item| item.get("model"))
        .and_then(toml::Value::as_str)
        .unwrap_or("gpt-5.5")
        .to_owned();
    Some(material(
        id, source, name, base_url, model, protocol, api_key,
    ))
}

fn material_from_claude_value(
    id: &str,
    source: &str,
    name: &str,
    value: &Value,
) -> Option<ImportMaterial> {
    let env = value.get("env").unwrap_or(value);
    let base_url = json_string(env, &["ANTHROPIC_BASE_URL"])
        .unwrap_or_else(|| "https://api.anthropic.com".to_owned());
    let api_key = json_string(env, &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    let model =
        json_string(env, &["ANTHROPIC_MODEL"]).unwrap_or_else(|| "claude-sonnet-4-5".to_owned());
    Some(material(
        id,
        source,
        name,
        base_url,
        model,
        ProviderProtocol::AnthropicMessages,
        api_key,
    ))
}

fn material_from_gemini_value(
    id: &str,
    source: &str,
    name: &str,
    value: &Value,
) -> Option<ImportMaterial> {
    let env_value = value.get("env").unwrap_or(value);
    let env = env_value
        .as_object()?
        .iter()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
        .collect::<BTreeMap<_, _>>();
    material_from_gemini_env(id, source, name, &env)
}

fn material_from_gemini_env(
    id: &str,
    source: &str,
    name: &str,
    env: &BTreeMap<String, String>,
) -> Option<ImportMaterial> {
    let base_url = env
        .get("GOOGLE_GEMINI_BASE_URL")
        .cloned()
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_owned());
    let api_key = env
        .get("GEMINI_API_KEY")
        .or_else(|| env.get("GOOGLE_API_KEY"))
        .cloned();
    let model = env
        .get("GEMINI_MODEL")
        .cloned()
        .unwrap_or_else(|| "gemini-2.5-pro".to_owned());
    Some(material(
        id,
        source,
        name,
        base_url,
        model,
        ProviderProtocol::GeminiGenerateContent,
        api_key,
    ))
}

fn material(
    id: &str,
    source: &str,
    name: impl Into<String>,
    base_url: String,
    model: String,
    protocol: ProviderProtocol,
    api_key: Option<String>,
) -> ImportMaterial {
    let api_key = api_key.filter(|value| !value.trim().is_empty());
    ImportMaterial {
        candidate: ExternalConfigCandidate {
            id: id.to_owned(),
            source: source.to_owned(),
            name: name.into(),
            base_url: base_url.trim().trim_end_matches('/').to_owned(),
            model,
            protocol,
            has_secret: api_key.is_some(),
            warning: api_key
                .is_none()
                .then(|| "配置存在，但没有可导入的 API Key".to_owned()),
        },
        api_key,
    }
}

pub fn profile_from_candidate(candidate: &ExternalConfigCandidate) -> ProviderProfile {
    ProviderProfile {
        id: format!("import-{}", sanitize_id(&candidate.id)),
        name: candidate.name.clone(),
        base_url: candidate.base_url.clone(),
        model: candidate.model.clone(),
        protocol: candidate.protocol.clone(),
        priority: 100,
        failover_enabled: true,
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn json_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn parse_env_file(path: &Path) -> Option<BTreeMap<String, String>> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut values = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim().trim_matches(['\'', '"']).to_owned();
        values.insert(key.to_owned(), value);
    }
    Some(values)
}

fn sanitize_id(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
        } else if !output.ends_with('-') {
            output.push('-');
        }
    }
    let output = output.trim_matches('-');
    if output.is_empty() {
        "provider".to_owned()
    } else {
        output.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn scans_codex_claude_gemini_and_cc_switch_without_exposing_keys() {
        let root = std::env::temp_dir().join(format!("levelup-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".codex")).unwrap();
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::create_dir_all(root.join(".gemini")).unwrap();
        std::fs::create_dir_all(root.join(".cc-switch")).unwrap();
        std::fs::create_dir_all(root.join(".config/opencode")).unwrap();
        std::fs::write(
            root.join(".codex/config.toml"),
            "model = \"gpt-test\"\nmodel_provider = \"relay\"\n[model_providers.relay]\nbase_url = \"https://relay.example/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"codex-secret\"\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".claude/settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://claude.example","ANTHROPIC_AUTH_TOKEN":"claude-secret","ANTHROPIC_MODEL":"claude-test"}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join(".gemini/.env"),
            "GOOGLE_GEMINI_BASE_URL=https://gemini.example\nGEMINI_API_KEY=gemini-secret\nGEMINI_MODEL=gemini-test\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".config/opencode/opencode.json"),
            r#"{
              provider: {
                levelup: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "OpenCode Relay",
                  options: { baseURL: "https://opencode.example/v1", apiKey: "opencode-secret", },
                  models: { "gpt-opencode": { name: "GPT OpenCode" } },
                },
              },
            }"#,
        )
        .unwrap();
        let db_path = root.join(".cc-switch/cc-switch.db");
        let connection = Connection::open(&db_path).unwrap();
        connection.execute_batch("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, sort_index INTEGER, created_at INTEGER);").unwrap();
        connection
            .execute(
                "INSERT INTO providers VALUES (?1, 'codex', 'CCS Relay', ?2, 1, 1)",
                params![
                    "relay",
                    serde_json::json!({"base_url":"https://ccs.example/v1","apiKey":"ccs-secret"})
                        .to_string()
                ],
            )
            .unwrap();
        drop(connection);

        let candidates = scan(&root);
        assert_eq!(candidates.len(), 5);
        assert!(candidates.iter().all(|item| item.candidate.has_secret));
        let serialized = serde_json::to_string(
            &candidates
                .iter()
                .map(|item| &item.candidate)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(!serialized.contains("secret"));
        assert!(candidates.iter().any(|item| matches!(
            item.candidate.protocol,
            ProviderProtocol::GeminiGenerateContent
        )));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_secret_is_reported_without_fabricating_one() {
        let value = serde_json::json!({
            "env": { "ANTHROPIC_BASE_URL": "https://claude.example" }
        });
        let material = material_from_claude_value("id", "source", "Claude", &value).unwrap();
        assert!(!material.candidate.has_secret);
        assert!(material.candidate.warning.is_some());
        assert!(material.api_key.is_none());
    }
}
