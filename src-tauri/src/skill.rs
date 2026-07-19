use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use walkdir::WalkDir;

use crate::models::SkillInfo;

const MAX_SKILLS: usize = 300;
const MAX_SKILL_FILE_BYTES: u64 = 256 * 1024;
const MAX_NAME_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_OUTPUT_CHARS: usize = 120_000;

struct SkillFrontmatter {
    name: String,
    description: String,
}

pub fn scan(
    app_data: &Path,
    home: &Path,
    built_in: Option<&Path>,
    codex_home: Option<&Path>,
    workspace: Option<&Path>,
    preferences: &HashMap<(String, String), bool>,
) -> Vec<SkillInfo> {
    let mut roots = Vec::new();
    if let Some(built_in) = built_in {
        roots.push((built_in.to_path_buf(), "LevelUpAgent built-in".to_owned()));
    }
    roots.extend([
        (app_data.join("skills"), "LevelUpAgent".to_owned()),
        (home.join(".codex/skills"), "Codex".to_owned()),
        (home.join(".claude/skills"), "Claude".to_owned()),
        (home.join(".agents/skills"), "Agents".to_owned()),
    ]);
    if let Some(codex_home) = codex_home {
        roots.push((codex_home.join("skills"), "Codex".to_owned()));
    }
    if let Some(workspace) = workspace {
        roots.extend([
            (workspace.join(".levelup/skills"), "Workspace".to_owned()),
            (
                workspace.join(".codex/skills"),
                "Workspace · Codex".to_owned(),
            ),
            (
                workspace.join(".claude/skills"),
                "Workspace · Claude".to_owned(),
            ),
            (
                workspace.join(".agents/skills"),
                "Workspace · Agents".to_owned(),
            ),
        ]);
    }

    let mut seen_files = HashSet::new();
    let mut skills = Vec::new();
    for (root, source) in roots {
        if skills.len() >= MAX_SKILLS {
            break;
        }
        scan_root(&root, &source, preferences, &mut seen_files, &mut skills);
    }
    skills.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.source.cmp(&right.source))
    });
    skills
}

pub fn read_enabled(
    skills: &[SkillInfo],
    skill_id: &str,
    relative: Option<&str>,
) -> Result<String, String> {
    let skill = skills
        .iter()
        .find(|skill| skill.id == skill_id && skill.enabled && skill.valid)
        .ok_or_else(|| "The requested Skill is not enabled or is no longer available".to_owned())?;
    let manifest = std::fs::canonicalize(&skill.path)
        .map_err(|error| format!("Skill manifest is unavailable: {error}"))?;
    let root = manifest
        .parent()
        .ok_or_else(|| "Skill directory is invalid".to_owned())?;
    let relative = relative.unwrap_or("SKILL.md").trim();
    validate_relative(relative)?;
    let target = std::fs::canonicalize(root.join(relative))
        .map_err(|error| format!("Skill file is unavailable: {error}"))?;
    if !target.starts_with(root) {
        return Err("Skill file escapes its Skill directory".to_owned());
    }
    let metadata = std::fs::metadata(&target)
        .map_err(|error| format!("Could not inspect Skill file: {error}"))?;
    if !metadata.is_file() {
        return Err("The requested Skill path is not a file".to_owned());
    }
    if metadata.len() > MAX_SKILL_FILE_BYTES {
        return Err(format!(
            "Skill file is larger than {} KiB",
            MAX_SKILL_FILE_BYTES / 1024
        ));
    }
    let content = std::fs::read_to_string(&target)
        .map_err(|error| format!("Could not read UTF-8 Skill file: {error}"))?;
    let output = format!(
        "Skill: {}\nSkill root: {}\nFile: {}\n\n{}",
        skill.name,
        root.display(),
        relative,
        content
    );
    if output.chars().count() <= MAX_OUTPUT_CHARS {
        Ok(output)
    } else {
        Ok(format!(
            "{}\n… Skill output truncated",
            output.chars().take(MAX_OUTPUT_CHARS).collect::<String>()
        ))
    }
}

fn scan_root(
    root: &Path,
    source: &str,
    preferences: &HashMap<(String, String), bool>,
    seen_files: &mut HashSet<PathBuf>,
    skills: &mut Vec<SkillInfo>,
) {
    let Ok(root) = std::fs::canonicalize(root) else {
        return;
    };
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .max_depth(5)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
    {
        if skills.len() >= MAX_SKILLS {
            break;
        }
        let Ok(path) = std::fs::canonicalize(entry.path()) else {
            continue;
        };
        if !path.starts_with(&root) || !seen_files.insert(path.clone()) {
            continue;
        }
        skills.push(inspect_skill(&path, source, preferences));
    }
}

fn inspect_skill(
    path: &Path,
    source: &str,
    preferences: &HashMap<(String, String), bool>,
) -> SkillInfo {
    let path_string = path.to_string_lossy().into_owned();
    let id = skill_id(&path_string);
    let fallback_name = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or("Unnamed Skill")
        .to_owned();
    let result = read_manifest(path).and_then(|content| parse_manifest(&content));
    match result {
        Ok(frontmatter) => SkillInfo {
            enabled: preferences
                .get(&(id.clone(), path_string.clone()))
                .copied()
                .unwrap_or(false),
            id,
            name: frontmatter.name,
            description: frontmatter.description,
            path: path_string,
            source: source.to_owned(),
            valid: true,
            warning: None,
        },
        Err(warning) => SkillInfo {
            id,
            name: fallback_name,
            description: String::new(),
            path: path_string,
            source: source.to_owned(),
            enabled: false,
            valid: false,
            warning: Some(warning),
        },
    }
}

fn read_manifest(path: &Path) -> Result<String, String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("Could not inspect SKILL.md: {error}"))?;
    if metadata.len() > MAX_SKILL_FILE_BYTES {
        return Err(format!(
            "SKILL.md is larger than {} KiB",
            MAX_SKILL_FILE_BYTES / 1024
        ));
    }
    std::fs::read_to_string(path).map_err(|error| format!("SKILL.md must be UTF-8: {error}"))
}

fn parse_manifest(content: &str) -> Result<SkillFrontmatter, String> {
    let normalized = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = normalized.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("SKILL.md must start with YAML frontmatter".to_owned());
    }
    let mut yaml = String::new();
    let mut closed = false;
    for line in &mut lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !closed {
        return Err("SKILL.md frontmatter is not closed".to_owned());
    }
    if lines.all(|line| line.trim().is_empty()) {
        return Err("SKILL.md has no instruction body".to_owned());
    }
    let mut frontmatter = parse_frontmatter_fields(&yaml)?;
    frontmatter.name = frontmatter.name.trim().to_owned();
    frontmatter.description = frontmatter.description.trim().to_owned();
    if frontmatter.name.is_empty() || frontmatter.name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("Skill name must be 1-{MAX_NAME_CHARS} characters"));
    }
    if frontmatter.description.is_empty()
        || frontmatter.description.chars().count() > MAX_DESCRIPTION_CHARS
    {
        return Err(format!(
            "Skill description must be 1-{MAX_DESCRIPTION_CHARS} characters"
        ));
    }
    Ok(frontmatter)
}

fn parse_frontmatter_fields(yaml: &str) -> Result<SkillFrontmatter, String> {
    let lines: Vec<_> = yaml.lines().collect();
    let mut name = None;
    let mut description = None;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            index += 1;
            continue;
        }
        let Some((key, raw_value)) = trimmed.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim();
        if !matches!(key, "name" | "description") {
            index += 1;
            continue;
        }
        let raw_value = raw_value.trim();
        let value = if matches!(raw_value, "|" | ">" | "|-" | ">-" | "|+" | ">+") {
            let folded = raw_value.starts_with('>');
            let base_indent = line.len() - line.trim_start().len();
            let mut parts = Vec::new();
            index += 1;
            while index < lines.len() {
                let continuation = lines[index];
                let indent = continuation.len() - continuation.trim_start().len();
                if !continuation.trim().is_empty() && indent <= base_indent {
                    break;
                }
                parts.push(continuation.trim());
                index += 1;
            }
            if folded {
                parts.join(" ")
            } else {
                parts.join("\n")
            }
        } else {
            index += 1;
            unquote_yaml_scalar(raw_value)?
        };
        match key {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    Ok(SkillFrontmatter {
        name: name.ok_or_else(|| "Skill frontmatter is missing name".to_owned())?,
        description: description
            .ok_or_else(|| "Skill frontmatter is missing description".to_owned())?,
    })
}

fn unquote_yaml_scalar(value: &str) -> Result<String, String> {
    if value.starts_with('"') {
        return serde_json::from_str(value)
            .map_err(|error| format!("Invalid quoted Skill frontmatter value: {error}"));
    }
    if value.starts_with('\'') {
        if value.len() < 2 || !value.ends_with('\'') {
            return Err("Invalid quoted Skill frontmatter value".to_owned());
        }
        return Ok(value[1..value.len() - 1].replace("''", "'"));
    }
    let without_comment = value
        .split_once(" #")
        .map(|(value, _)| value)
        .unwrap_or(value);
    Ok(without_comment.trim().to_owned())
}

fn validate_relative(relative: &str) -> Result<(), String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Skill paths must stay inside the selected Skill directory".to_owned());
    }
    Ok(())
}

fn skill_id(path: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in path.to_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("skill-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("levelup-skill-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn discovers_valid_and_invalid_skills_and_preserves_preference() {
        let root = temp_root();
        let valid_dir = root.join("skills/review");
        let invalid_dir = root.join("skills/broken");
        std::fs::create_dir_all(&valid_dir).unwrap();
        std::fs::create_dir_all(&invalid_dir).unwrap();
        std::fs::write(
            valid_dir.join("SKILL.md"),
            "---\nname: review\ndescription: Review source changes.\n---\n\n# Review\nInspect first.\n",
        )
        .unwrap();
        std::fs::write(invalid_dir.join("SKILL.md"), "# Missing frontmatter").unwrap();

        let first = scan(&root, &root, None, None, None, &HashMap::new());
        assert_eq!(first.len(), 2);
        let valid = first.iter().find(|skill| skill.valid).unwrap();
        let preferences = [((valid.id.clone(), valid.path.clone()), true)].into();
        let second = scan(&root, &root, None, None, None, &preferences);
        assert!(second.iter().find(|skill| skill.valid).unwrap().enabled);
        assert!(
            second
                .iter()
                .find(|skill| !skill.valid)
                .unwrap()
                .warning
                .is_some()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_references_but_rejects_directory_escape() {
        let root = temp_root();
        let skill_dir = root.join("skills/review");
        std::fs::create_dir_all(skill_dir.join("references")).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: review\ndescription: Review source changes.\n---\n\n# Review\n",
        )
        .unwrap();
        std::fs::write(skill_dir.join("references/checks.md"), "Check boundaries.").unwrap();
        let mut skills = scan(&root, &root, None, None, None, &HashMap::new());
        skills[0].enabled = true;
        assert!(
            read_enabled(&skills, &skills[0].id, Some("references/checks.md"))
                .unwrap()
                .contains("Check boundaries.")
        );
        assert!(read_enabled(&skills, &skills[0].id, Some("../secret.txt")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_quoted_and_folded_frontmatter_values() {
        let parsed = parse_manifest(
            "---\nname: \"review\"\ndescription: >\n  Review changes\n  with evidence.\n---\n\n# Review\n",
        )
        .unwrap();
        assert_eq!(parsed.name, "review");
        assert_eq!(parsed.description, "Review changes with evidence.");
    }
}
