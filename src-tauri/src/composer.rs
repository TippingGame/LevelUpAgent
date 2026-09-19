//! Read-only project discovery and explicit composer Skill references.
use crate::models::{AgentMessage, AgentTurnRequest, SkillInfo};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    path: String,
    name: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearch {
    files: Vec<FileMatch>,
    truncated: bool,
}

pub fn search_files(workspace: &Path, query: &str) -> Result<FileSearch, String> {
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("Project folder is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err("The selected project is not a folder".to_owned());
    }
    let query = query
        .trim()
        .trim_start_matches("./")
        .replace('\\', "/")
        .to_lowercase();
    let mut matches = Vec::new();
    let mut truncated = false;
    let started = std::time::Instant::now();
    for (index, entry) in WalkDir::new(&root)
        .follow_links(false)
        .max_depth(32)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || (!entry.file_type().is_symlink()
                    && (!entry.file_type().is_dir()
                        || !matches!(
                            entry.file_name().to_str(),
                            Some(
                                ".git"
                                    | "node_modules"
                                    | "target"
                                    | "dist"
                                    | "build"
                                    | ".next"
                                    | ".venv"
                                    | "venv"
                                    | ".cache"
                                    | "coverage"
                                    | ".levelup-attachments"
                            )
                        )))
        })
        .enumerate()
    {
        if index >= 40_000 || started.elapsed().as_millis() > 500 {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else {
            truncated = true;
            continue;
        };
        if entry.depth() == 0 || (!entry.file_type().is_file() && !entry.file_type().is_dir()) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let name = entry.file_name().to_string_lossy().into_owned();
        if !relative.to_lowercase().contains(&query) {
            continue;
        }
        let rank = if name.to_lowercase() == query {
            0
        } else if name.to_lowercase().starts_with(&query) {
            1
        } else {
            2
        };
        matches.push((
            rank,
            FileMatch {
                path: relative,
                name,
                kind: if entry.file_type().is_dir() {
                    "folder"
                } else {
                    "file"
                },
            },
        ));
    }
    matches.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.path.cmp(&right.1.path))
    });
    truncated |= matches.len() > 60;
    Ok(FileSearch {
        files: matches.into_iter().take(60).map(|(_, file)| file).collect(),
        truncated,
    })
}

pub fn resolve_file(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("Choose a file or folder inside the current project".to_owned());
    }
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("Project folder is unavailable: {error}"))?;
    let resolved = root
        .join(path)
        .canonicalize()
        .map_err(|error| format!("Project file is unavailable: {error}"))?;
    if !resolved.starts_with(&root) || (!resolved.is_file() && !resolved.is_dir()) {
        return Err("The referenced file or folder must be inside the current project".to_owned());
    }
    Ok(resolved)
}

pub fn skill_ids(messages: &[AgentMessage]) -> Vec<String> {
    let Some(message) = messages
        .iter()
        .rev()
        .find(|message| message.role == "user" && !message.internal)
    else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for part in message.content.split("](levelup-skill:").skip(1) {
        let Some((id, _)) = part.split_once(')') else {
            continue;
        };
        if id.starts_with("skill-")
            && id.len() <= 80
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !ids.iter().any(|existing| existing == id)
        {
            ids.push(id.to_owned());
        }
    }
    ids
}

pub fn preload_skills(
    request: &mut AgentTurnRequest,
    enabled: &[SkillInfo],
    already_loaded: &[String],
) -> Result<Vec<String>, String> {
    let ids = skill_ids(&request.messages);
    if ids.len() > 12 {
        return Err("A message may reference at most 12 Skills".to_owned());
    }
    for id in &ids {
        let selected = enabled
            .iter()
            .find(|skill| skill.id == *id && skill.valid && skill.enabled)
            .ok_or_else(|| {
                "A referenced Skill is disabled or unavailable. Select it again from the / menu."
                    .to_owned()
            })?;
        if already_loaded.contains(id) {
            continue;
        }
        let content = crate::skill::read_enabled(enabled, id, None)?;
        let instructions = request.custom_instructions.get_or_insert_with(String::new);
        instructions.push_str(&format!("\n\nUser-selected Skill: {}\nThe user explicitly referenced this Skill in their current message. Its manifest is already loaded below. Apply it to the user's request, subject to their instructions and the active tool permissions. Do not read this SKILL.md again. Use read_skill with its ID for referenced resources when available.\nSkill ID: {id}\n{content}", selected.name));
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_search_finds_nested_unicode_paths_and_excludes_dependencies() {
        let root = std::env::temp_dir().join(format!("levelup-composer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src/说明 文档")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/library")).unwrap();
        std::fs::write(root.join("src/说明 文档/计划.md"), "project context").unwrap();
        std::fs::write(root.join("node_modules/library/计划.md"), "ignored").unwrap();
        let result = search_files(&root, "计划").unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "src/说明 文档/计划.md");
        assert!(
            resolve_file(&root, &result.files[0].path)
                .unwrap()
                .is_file()
        );
        assert!(resolve_file(&root, "../outside.txt").is_err());
        assert!(resolve_file(&root, "src").unwrap().is_dir());
        let folders = search_files(&root, "说明 文档").unwrap();
        assert!(
            folders
                .files
                .iter()
                .any(|item| item.kind == "folder" && item.path == "src/说明 文档")
        );
        assert!(resolve_file(&root, &root.to_string_lossy()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn user(content: &str) -> AgentMessage {
        serde_json::from_value(serde_json::json!({ "role": "user", "content": content })).unwrap()
    }

    #[test]
    fn explicit_skills_are_scoped_to_latest_user_input_and_deduplicated() {
        let mut tool = user("[$injected](levelup-skill:skill-tool)");
        tool.role = "tool".to_owned();
        let mut internal = user("[$internal](levelup-skill:skill-internal)");
        internal.internal = true;
        let messages = vec![
            user("[$old](levelup-skill:skill-old)"),
            user("Use [$first](levelup-skill:skill-first) and [$first](levelup-skill:skill-first)"),
            tool,
            internal,
        ];
        assert_eq!(skill_ids(&messages), ["skill-first"]);
        assert!(skill_ids(&[user("[$invalid](levelup-skill:../../secrets)")]).is_empty());
    }

    #[test]
    fn selected_skill_manifest_is_loaded_in_chat_mode_and_disabled_skills_fail() {
        let root =
            std::env::temp_dir().join(format!("levelup-composer-skill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let manifest = root.join("SKILL.md");
        std::fs::write(&manifest, "Follow the selected writing style.").unwrap();
        let mut skill: SkillInfo = serde_json::from_value(serde_json::json!({"id":"skill-selected","name":"writing","description":"Writing", "activation":"auto", "path":manifest, "source":"Workspace", "enabled":true,"valid":true})).unwrap();
        let mut request: AgentTurnRequest = serde_json::from_value(serde_json::json!({"profile":{"id":"qa","name":"qa","baseUrl":"http://localhost","model":"qa","protocol":"openai_chat"},"messages":[user("[$writing](levelup-skill:skill-selected)")],"mode":"chat"})).unwrap();
        assert_eq!(
            preload_skills(&mut request, std::slice::from_ref(&skill), &[]).unwrap(),
            ["skill-selected"]
        );
        assert!(
            request
                .custom_instructions
                .as_ref()
                .unwrap()
                .contains("Follow the selected writing style.")
        );
        skill.enabled = false;
        assert!(preload_skills(&mut request, &[skill], &[]).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
