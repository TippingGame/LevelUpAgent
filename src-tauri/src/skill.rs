use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Client;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::models::{SkillInfo, SkillLocation};
use crate::network;

const MAX_SKILLS: usize = 300;
const MAX_SKILL_FILE_BYTES: u64 = 256 * 1024;
const MAX_NAME_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_OUTPUT_CHARS: usize = 120_000;
const MAX_INSTALL_BYTES: usize = 32 * 1024 * 1024;
const MAX_INSTALL_FILES: usize = 2_000;
const MAX_SKILL_NAME_CHARS: usize = 80;

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
        // Match Codex's repository walk: a nested working directory inherits
        // `.agents/skills` (and compatible Codex/Claude roots) from each
        // parent up to the repository/root boundary.  Canonical-path
        // de-duplication below keeps overlapping roots cheap and predictable.
        let mut current =
            std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        loop {
            roots.extend([
                (current.join(".levelup/skills"), "Workspace".to_owned()),
                (
                    current.join(".codex/skills"),
                    "Workspace · Codex".to_owned(),
                ),
                (
                    current.join(".claude/skills"),
                    "Workspace · Claude".to_owned(),
                ),
                (
                    current.join(".agents/skills"),
                    "Workspace · Agents".to_owned(),
                ),
            ]);
            let Some(parent) = current.parent() else {
                break;
            };
            if parent == current {
                break;
            }
            // Stop after the repository root when one is discoverable.  This
            // avoids scanning unrelated sibling trees while still supporting
            // workspaces launched from deeply nested packages.
            let is_repo_root = current.join(".git").exists();
            current = parent.to_path_buf();
            if is_repo_root {
                break;
            }
        }
    }

    let mut seen_files = HashSet::new();
    let mut skills = Vec::new();
    for (root, source) in roots {
        if skills.len() >= MAX_SKILLS {
            break;
        }
        let source = if root
            .components()
            .any(|component| component.as_os_str().eq_ignore_ascii_case(".system"))
        {
            "Codex system".to_owned()
        } else {
            source
        };
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
    read_selected(skill, relative)
}

/// Read a valid Skill explicitly after a caller has inspected the catalog.
/// This is separate from `read_enabled` so normal Agent context still only
/// exposes Skills the user enabled, while Skill authoring can inspect a
/// disabled draft before updating it.
pub fn read_valid(
    skills: &[SkillInfo],
    skill_id: &str,
    relative: Option<&str>,
) -> Result<String, String> {
    let skill = skills
        .iter()
        .find(|skill| skill.id == skill_id && skill.valid)
        .ok_or_else(|| "The requested Skill is invalid or no longer available".to_owned())?;
    read_selected(skill, relative)
}

fn read_selected(skill: &SkillInfo, relative: Option<&str>) -> Result<String, String> {
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

/// Return the stable preference key used by `scan` for a Skill manifest.
///
/// Built-in Skill setup must use the same canonical path normalization as
/// discovery; otherwise a Skill can be marked enabled under a name that the
/// scanner will never recognize.
pub fn id_for_path(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    skill_id(&canonical.to_string_lossy())
}

/// Return the conventional authoring roots shown in the Skills UI.  Discovery
/// and mutation intentionally share these roots so a Skill created from a
/// conversation is immediately visible to the next turn.
pub fn locations(
    app_data: &Path,
    home: &Path,
    built_in: Option<&Path>,
    codex_home: Option<&Path>,
    workspace: Option<&Path>,
) -> Vec<SkillLocation> {
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |scope: &str, label: String, path: PathBuf, writable: bool| {
        let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen.insert(key) {
            return;
        }
        values.push(SkillLocation {
            scope: scope.to_owned(),
            label,
            path: path.to_string_lossy().into_owned(),
            writable,
            exists: path.is_dir(),
        });
    };

    if let Some(root) = built_in {
        add(
            "builtin",
            "LevelUpAgent bundled Skills (read-only)".to_owned(),
            root.to_path_buf(),
            false,
        );
    }
    if let Some(workspace) = workspace {
        let origin = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        let mut current = origin.clone();
        loop {
            let inherited = current != origin;
            let prefix = if inherited { "Inherited" } else { "Workspace" };
            add(
                "workspace",
                format!("{prefix} .agents/skills"),
                current.join(".agents/skills"),
                true,
            );
            add(
                "workspace",
                format!("{prefix} .levelup/skills"),
                current.join(".levelup/skills"),
                true,
            );
            add(
                "workspace",
                format!("{prefix} .codex/skills"),
                current.join(".codex/skills"),
                true,
            );
            add(
                "workspace",
                format!("{prefix} .claude/skills"),
                current.join(".claude/skills"),
                true,
            );
            let is_repo_root = current.join(".git").exists();
            let Some(parent) = current.parent() else {
                break;
            };
            if parent == current || is_repo_root {
                break;
            }
            current = parent.to_path_buf();
        }
    }
    add(
        "user",
        "User .agents/skills".to_owned(),
        home.join(".agents/skills"),
        true,
    );
    add(
        "codex",
        "User .codex/skills".to_owned(),
        home.join(".codex/skills"),
        true,
    );
    add(
        "claude",
        "User .claude/skills".to_owned(),
        home.join(".claude/skills"),
        true,
    );
    add(
        "app",
        "LevelUpAgent app skills".to_owned(),
        app_data.join("skills"),
        true,
    );
    if let Some(codex_home) = codex_home {
        add(
            "codex",
            "CODEX_HOME/skills".to_owned(),
            codex_home.join("skills"),
            true,
        );
    }
    values
}

/// Validate a complete `SKILL.md` and return its normalized metadata.  This is
/// shared by the create/update/install paths so invalid manifests never enter
/// the discovery catalog.
pub fn validate_manifest(content: &str) -> Result<(String, String), String> {
    if content.len() as u64 > MAX_SKILL_FILE_BYTES {
        return Err(format!(
            "SKILL.md is larger than {} KiB",
            MAX_SKILL_FILE_BYTES / 1024
        ));
    }
    let parsed = parse_manifest(content)?;
    Ok((parsed.name, parsed.description))
}

/// Create a user-authored Skill under one of the standard mutable roots.
#[allow(clippy::too_many_arguments)]
pub fn create(
    app_data: &Path,
    home: &Path,
    workspace: Option<&Path>,
    scope: Option<&str>,
    name: &str,
    description: &str,
    instructions: &str,
    overwrite: bool,
) -> Result<PathBuf, String> {
    let root = authoring_root(app_data, home, workspace, scope)?;
    let name = name.trim();
    let description = description.trim();
    let instructions = instructions.trim();
    if name.is_empty() || name.chars().count() > MAX_SKILL_NAME_CHARS {
        return Err(format!(
            "Skill name must be 1-{MAX_SKILL_NAME_CHARS} characters"
        ));
    }
    if description.is_empty() {
        return Err("Skill description is required".to_owned());
    }
    if instructions.is_empty() {
        return Err("Skill instructions are required".to_owned());
    }
    let folder = safe_folder_name(name)?;
    let directory = root.join(folder);
    ensure_mutable_directory(&root)?;
    if directory.exists() && !overwrite {
        return Err(format!(
            "Skill directory already exists: {} (set overwrite to replace it)",
            directory.display()
        ));
    }
    if directory.exists() {
        ensure_no_symlink_chain(&directory)?;
    } else {
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create Skill directory: {error}"))?;
    }
    let content = format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}\n",
        serde_json::to_string(name)
            .map_err(|error| format!("Could not encode Skill name: {error}"))?,
        serde_json::to_string(description)
            .map_err(|error| format!("Could not encode Skill description: {error}"))?,
        instructions
    );
    validate_manifest(&content)?;
    let manifest = directory.join("SKILL.md");
    if manifest.exists() && !overwrite {
        return Err(format!(
            "Skill manifest already exists: {}",
            manifest.display()
        ));
    }
    atomic_write_utf8(&manifest, content.as_bytes())?;
    Ok(manifest)
}

/// Update an existing manifest after checking that it belongs to a mutable
/// user/workspace root.  Built-in and `.system` Skills are deliberately read
/// only even when a caller has a broad permission profile.
pub fn update(
    app_data: &Path,
    home: &Path,
    workspace: Option<&Path>,
    manifest: &Path,
    content: &str,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    validate_manifest(content)?;
    let manifest = std::fs::canonicalize(manifest)
        .map_err(|error| format!("Skill manifest is unavailable: {error}"))?;
    if manifest.file_name().and_then(|value| value.to_str()) != Some("SKILL.md") {
        return Err("A Skill update must target SKILL.md".to_owned());
    }
    ensure_mutable_skill_path(app_data, home, workspace, &manifest)?;
    let backup = backup_file(app_data, &manifest)?;
    atomic_write_utf8(&manifest, content.as_bytes())?;
    Ok((manifest, Some(backup)))
}

/// Move a mutable Skill directory to the app's recoverable trash area.  This
/// keeps an accidental delete reversible without leaving a second discoverable
/// `SKILL.md` under the workspace root.
pub fn delete(
    app_data: &Path,
    home: &Path,
    workspace: Option<&Path>,
    manifest: &Path,
) -> Result<Option<PathBuf>, String> {
    let manifest = std::fs::canonicalize(manifest)
        .map_err(|error| format!("Skill manifest is unavailable: {error}"))?;
    ensure_mutable_skill_path(app_data, home, workspace, &manifest)?;
    let directory = manifest
        .parent()
        .ok_or_else(|| "Skill directory is invalid".to_owned())?;
    let trash_root = app_data.join("skill-trash");
    ensure_mutable_directory(&trash_root)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let name = directory
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("skill");
    let destination = trash_root.join(format!("{name}-{stamp}-{}", uuid::Uuid::new_v4().simple()));
    if let Err(rename_error) = std::fs::rename(directory, &destination) {
        // Workspace and app-data directories commonly live on different
        // Windows volumes.  Fall back to a bounded copy, then remove the
        // source only after the recoverable copy has completed.
        validate_skill_tree(directory)?;
        if let Err(copy_error) = copy_skill_directory(directory, &destination) {
            let _ = std::fs::remove_dir_all(&destination);
            return Err(format!(
                "Could not move Skill to recoverable trash ({rename_error}); copy fallback failed: {copy_error}"
            ));
        }
        if let Err(remove_error) = std::fs::remove_dir_all(directory) {
            return Err(format!(
                "Skill was copied to recoverable trash but the original could not be removed: {remove_error}"
            ));
        }
    }
    Ok(Some(destination))
}

/// Install one or more Skills from a local directory/archive or an HTTPS URL.
/// The archive extractor rejects absolute/parent paths and limits both bytes
/// and file count before anything is copied into an authoring root.
pub async fn install(
    app_data: &Path,
    home: &Path,
    workspace: Option<&Path>,
    scope: Option<&str>,
    source: &str,
    overwrite: bool,
) -> Result<Vec<PathBuf>, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("Skill source is required".to_owned());
    }
    let destination = authoring_root(app_data, home, workspace, scope)?;
    ensure_mutable_directory(&destination)?;
    if let Ok(path) = std::fs::canonicalize(source) {
        if path.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
        {
            let metadata = std::fs::metadata(&path)
                .map_err(|error| format!("Could not inspect Skill archive: {error}"))?;
            if metadata.len() > MAX_INSTALL_BYTES as u64 {
                return Err(format!(
                    "Skill archive is larger than {} MiB",
                    MAX_INSTALL_BYTES / (1024 * 1024)
                ));
            }
            let bytes = std::fs::read(&path)
                .map_err(|error| format!("Could not read Skill archive: {error}"))?;
            return install_zip(&destination, &bytes, overwrite)
                .map_err(|error| format!("Could not install {}: {error}", path.display()));
        }
        return install_local(&destination, &path, overwrite);
    }
    let url = normalize_install_url(source)?;
    let client = Client::builder()
        .user_agent("LevelUpAgent Skill Installer")
        .timeout(std::time::Duration::from_secs(45))
        .dns_resolver(crate::network::resolver())
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or_default();
            let blocked = host.eq_ignore_ascii_case("localhost")
                || host.ends_with(".local")
                || host.ends_with(".internal")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(network::is_private_or_loopback);
            if blocked {
                attempt.stop()
            } else if attempt.previous().len() >= 5 {
                attempt.error(std::io::Error::other("too many Skill redirects"))
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| format!("Could not build Skill installer client: {error}"))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("Could not download Skill source: {error}"))?;
    if response
        .remote_addr()
        .is_some_and(|address| network::is_private_or_loopback(address.ip()))
    {
        return Err("Skill download resolved to a local or private network address".to_owned());
    }
    if !response.status().is_success() {
        return Err(format!("Skill source returned HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_INSTALL_BYTES as u64)
    {
        return Err(format!(
            "Skill archive is larger than {} MiB",
            MAX_INSTALL_BYTES / (1024 * 1024)
        ));
    }
    let bytes = bounded_download(response).await?;
    install_zip(&destination, &bytes, overwrite)
        .map_err(|error| format!("Could not install {url}: {error}"))
}

async fn bounded_download(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read Skill archive: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_INSTALL_BYTES {
            return Err(format!(
                "Skill archive is larger than {} MiB",
                MAX_INSTALL_BYTES / (1024 * 1024)
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn authoring_root(
    app_data: &Path,
    home: &Path,
    workspace: Option<&Path>,
    scope: Option<&str>,
) -> Result<PathBuf, String> {
    match scope.unwrap_or(if workspace.is_some() {
        "workspace"
    } else {
        "user"
    }) {
        "workspace" => workspace
            .map(|path| path.join(".agents/skills"))
            .ok_or_else(|| "A workspace is required for workspace-scoped Skills".to_owned()),
        "user" | "agents" => Ok(home.join(".agents/skills")),
        "codex" => Ok(codex_skill_root(home)),
        "claude" => Ok(home.join(".claude/skills")),
        "app" => Ok(app_data.join("skills")),
        value => Err(format!("Unknown Skill scope '{value}'")),
    }
}

fn safe_folder_name(name: &str) -> Result<String, String> {
    let mut output = String::new();
    for character in name.chars() {
        if character.is_alphanumeric() || character == '-' || character == '_' {
            output.push(character.to_ascii_lowercase());
        } else if character.is_whitespace() {
            output.push('-');
        } else {
            return Err(
                "Skill name may contain only letters, numbers, spaces, dashes, or underscores"
                    .to_owned(),
            );
        }
    }
    let output = output.trim_matches('-').to_owned();
    if output.is_empty() {
        return Err("Skill name must contain an alphanumeric character".to_owned());
    }
    Ok(output)
}

fn ensure_mutable_directory(root: &Path) -> Result<(), String> {
    if root.exists() {
        ensure_no_symlink_chain(root)?;
        if !root.is_dir() {
            return Err(format!("Skill root is not a directory: {}", root.display()));
        }
    } else {
        let mut ancestor = root.parent();
        while let Some(path) = ancestor {
            if path.exists() {
                ensure_no_symlink_chain(path)?;
                break;
            }
            ancestor = path.parent();
        }
        std::fs::create_dir_all(root)
            .map_err(|error| format!("Could not create Skill root: {error}"))?;
    }
    Ok(())
}

fn ensure_no_symlink_chain(path: &Path) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if let Ok(metadata) = std::fs::symlink_metadata(candidate)
            && metadata.file_type().is_symlink()
        {
            return Err(format!(
                "Skill path contains a symbolic link: {}",
                candidate.display()
            ));
        }
        current = candidate.parent();
    }
    Ok(())
}

fn ensure_mutable_skill_path(
    app_data: &Path,
    home: &Path,
    workspace: Option<&Path>,
    manifest: &Path,
) -> Result<(), String> {
    ensure_no_symlink_chain(manifest)?;
    if manifest.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".system")
    }) {
        return Err("Codex system Skills are read-only".to_owned());
    }
    let roots = mutable_skill_roots(app_data, home, workspace);
    let Some(root) = roots.iter().find(|root| manifest.starts_with(root)) else {
        return Err("Only user, app, or workspace Skills may be modified".to_owned());
    };
    if manifest.parent().is_some_and(|parent| parent == root) {
        return Err("A Skill must live in its own directory below the Skill root".to_owned());
    }
    Ok(())
}

fn mutable_skill_roots(app_data: &Path, home: &Path, workspace: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = [
        app_data.join("skills"),
        home.join(".agents/skills"),
        home.join(".codex/skills"),
        codex_skill_root(home),
        home.join(".claude/skills"),
    ]
    .into_iter()
    .map(|root| std::fs::canonicalize(&root).unwrap_or(root))
    .collect::<Vec<_>>();
    if let Some(workspace) = workspace {
        let mut current =
            std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        loop {
            roots.extend(
                [
                    ".agents/skills",
                    ".levelup/skills",
                    ".codex/skills",
                    ".claude/skills",
                ]
                .into_iter()
                .map(|suffix| {
                    let root = current.join(suffix);
                    std::fs::canonicalize(&root).unwrap_or(root)
                }),
            );
            let is_repo_root = current.join(".git").exists();
            let Some(parent) = current.parent() else {
                break;
            };
            if parent == current || is_repo_root {
                break;
            }
            current = parent.to_path_buf();
        }
    }
    roots
}

fn codex_skill_root(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".codex"))
        .join("skills")
}

fn atomic_write_utf8(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not determine Skill manifest directory".to_owned())?;
    ensure_mutable_directory(parent)?;
    let temporary = parent.join(format!(
        ".levelup-skill-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not create temporary Skill file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Could not write Skill file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not flush Skill file: {error}"))?;
    }
    let previous = if path.exists() {
        Some(parent.join(format!(
            ".levelup-skill-{}.previous",
            uuid::Uuid::new_v4().simple()
        )))
    } else {
        None
    };
    let result = if let Some(previous) = previous.as_ref() {
        std::fs::rename(path, previous).and_then(|()| match std::fs::rename(&temporary, path) {
            Ok(()) => {
                let _ = std::fs::remove_file(previous);
                Ok(())
            }
            Err(error) => {
                let _ = std::fs::rename(previous, path);
                Err(error)
            }
        })
    } else {
        std::fs::rename(&temporary, path)
    };
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "Could not atomically install Skill manifest: {error}"
        ));
    }
    Ok(())
}

fn backup_file(app_data: &Path, source: &Path) -> Result<PathBuf, String> {
    let root = app_data.join("skill-backups");
    ensure_mutable_directory(&root)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let name = source
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or("skill");
    let destination = root.join(format!(
        "{name}-{stamp}-{}.SKILL.md",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::copy(source, &destination)
        .map_err(|error| format!("Could not back up Skill manifest: {error}"))?;
    Ok(destination)
}

fn install_local(
    destination: &Path,
    source: &Path,
    overwrite: bool,
) -> Result<Vec<PathBuf>, String> {
    ensure_no_symlink_chain(source)?;
    let mut manifests = Vec::new();
    if source.is_file() && source.file_name().and_then(|value| value.to_str()) == Some("SKILL.md") {
        manifests.push(source.to_path_buf());
    } else if source.is_dir() {
        for entry in WalkDir::new(source)
            .follow_links(false)
            .max_depth(5)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        {
            manifests.push(entry.path().to_path_buf());
        }
    } else {
        return Err("Skill source must be a directory or SKILL.md file".to_owned());
    }
    if manifests.is_empty() {
        return Err("No SKILL.md was found in the source".to_owned());
    }
    let mut installed = Vec::new();
    for manifest in manifests {
        let source_directory = manifest
            .parent()
            .ok_or_else(|| "Skill source directory is invalid".to_owned())?;
        validate_skill_tree(source_directory)?;
        ensure_no_symlink_chain(&manifest)?;
        let content = std::fs::read_to_string(&manifest)
            .map_err(|error| format!("Could not read {}: {error}", manifest.display()))?;
        let (name, _) = validate_manifest(&content)?;
        let folder = safe_folder_name(&name)?;
        let target = destination.join(folder);
        if target.exists() {
            let source_root = std::fs::canonicalize(source_directory)
                .unwrap_or_else(|_| source_directory.to_path_buf());
            let target_root = std::fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
            if source_root == target_root {
                // Installing an already-installed Skill is a harmless no-op;
                // never delete the source before attempting to copy it.
                installed.push(target.join("SKILL.md"));
                continue;
            }
            if !overwrite {
                return Err(format!("Skill already exists: {}", target.display()));
            }
            ensure_no_symlink_chain(&target)?;
        }
        let staging = destination.join(format!(
            ".levelup-skill-install-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let result = (|| {
            copy_skill_directory(source_directory, &staging)?;
            if target.exists() {
                let previous = destination.join(format!(
                    ".levelup-skill-previous-{}",
                    uuid::Uuid::new_v4().simple()
                ));
                std::fs::rename(&target, &previous).map_err(|error| {
                    format!("Could not stage existing Skill for replacement: {error}")
                })?;
                match std::fs::rename(&staging, &target) {
                    Ok(()) => {
                        let _ = std::fs::remove_dir_all(&previous);
                        Ok(())
                    }
                    Err(error) => {
                        let _ = std::fs::rename(&previous, &target);
                        Err(format!("Could not replace existing Skill: {error}"))
                    }
                }
            } else {
                std::fs::rename(&staging, &target)
                    .map_err(|error| format!("Could not install Skill directory: {error}"))
            }
        })();
        let _ = std::fs::remove_dir_all(&staging);
        result?;
        installed.push(target.join("SKILL.md"));
    }
    Ok(installed)
}

fn validate_skill_tree(source: &Path) -> Result<(), String> {
    let mut files = 0_usize;
    let mut bytes = 0_usize;
    for entry in WalkDir::new(source)
        .follow_links(false)
        .max_depth(5)
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Skill source contains a symbolic link: {}",
                entry.path().display()
            ));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        files = files.saturating_add(1);
        if files > MAX_INSTALL_FILES {
            return Err(format!(
                "Skill source contains more than {MAX_INSTALL_FILES} files"
            ));
        }
        let length = entry
            .metadata()
            .map_err(|error| format!("Could not inspect Skill source file: {error}"))?
            .len() as usize;
        bytes = bytes.saturating_add(length);
        if bytes > MAX_INSTALL_BYTES {
            return Err(format!(
                "Skill source expands beyond {} MiB",
                MAX_INSTALL_BYTES / (1024 * 1024)
            ));
        }
    }
    Ok(())
}

fn install_zip(destination: &Path, bytes: &[u8], overwrite: bool) -> Result<Vec<PathBuf>, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Skill source is not a valid zip archive: {error}"))?;
    if archive.len() > MAX_INSTALL_FILES {
        return Err(format!(
            "Skill archive contains more than {MAX_INSTALL_FILES} files"
        ));
    }
    let staging = destination
        .parent()
        .ok_or_else(|| "Could not determine Skill staging directory".to_owned())?
        .join(format!(
            ".levelup-skill-staging-{}",
            uuid::Uuid::new_v4().simple()
        ));
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("Could not create Skill staging directory: {error}"))?;
    let result = (|| {
        let mut total = 0_usize;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("Could not inspect archive entry: {error}"))?;
            let Some(path) = entry.enclosed_name() else {
                return Err("Skill archive contains an unsafe path".to_owned());
            };
            if path.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            }) {
                return Err("Skill archive contains an unsafe path".to_owned());
            }
            if entry.is_dir() {
                continue;
            }
            if entry.is_symlink() {
                return Err("Skill archive contains a symbolic link".to_owned());
            }
            total = total.saturating_add(entry.size() as usize);
            if total > MAX_INSTALL_BYTES {
                return Err(format!(
                    "Skill archive expands beyond {} MiB",
                    MAX_INSTALL_BYTES / (1024 * 1024)
                ));
            }
            let target = staging.join(&path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not stage Skill archive: {error}"))?;
            }
            let mut output = std::fs::File::create(&target)
                .map_err(|error| format!("Could not create staged Skill file: {error}"))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| format!("Could not extract Skill archive: {error}"))?;
        }
        install_local(destination, &staging, overwrite)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn copy_skill_directory(source: &Path, destination: &Path) -> Result<(), String> {
    ensure_no_symlink_chain(source)?;
    std::fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create Skill directory: {error}"))?;
    for entry in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| format!("Could not map Skill path: {error}"))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(relative);
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Skill source contains a symbolic link: {}",
                entry.path().display()
            ));
        }
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|error| format!("Could not copy Skill directory: {error}"))?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not copy Skill file: {error}"))?;
            }
            std::fs::copy(entry.path(), &target)
                .map_err(|error| format!("Could not copy Skill file: {error}"))?;
        }
    }
    Ok(())
}

fn normalize_install_url(source: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(source)
        .map_err(|_| "Skill source must be a local path or HTTPS URL".to_owned())?;
    if url.scheme() != "https" {
        return Err("Remote Skill sources must use HTTPS".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Skill sources cannot contain embedded credentials".to_owned());
    }
    let original_host = url.host_str().map(str::to_owned);
    if let Some(host) = original_host.as_deref() {
        if host.eq_ignore_ascii_case("github.com") {
            let segments = url
                .path_segments()
                .map(|segments| segments.collect::<Vec<_>>())
                .unwrap_or_default();
            if segments.len() >= 2 && !segments[0].is_empty() && !segments[1].is_empty() {
                url = url::Url::parse(&format!(
                    "https://api.github.com/repos/{}/{}/zipball/HEAD",
                    segments[0],
                    segments[1].trim_end_matches(".git")
                ))
                .map_err(|error| format!("Invalid GitHub Skill source: {error}"))?;
            }
        }
        if host.eq_ignore_ascii_case("localhost")
            || host.ends_with(".local")
            || host.ends_with(".internal")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(network::is_private_or_loopback)
        {
            return Err(
                "Skill downloads cannot target local or private network addresses".to_owned(),
            );
        }
    }
    Ok(url)
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
    let id = id_for_path(path);
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
        assert!(
            read_valid(&skills, &skills[0].id, Some("references/checks.md"))
                .unwrap()
                .contains("Check boundaries.")
        );
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
    fn id_for_path_matches_discovered_canonical_manifest_id() {
        let root = temp_root();
        let manifest = root.join("skills/review/SKILL.md");
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(
            &manifest,
            "---\nname: review\ndescription: Review source changes.\n---\n\n# Review\n",
        )
        .unwrap();
        let discovered = scan(&root, &root, None, None, None, &HashMap::new());
        assert_eq!(discovered.len(), 1);
        assert_eq!(id_for_path(&manifest), discovered[0].id);
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

    #[test]
    fn locations_include_bundled_and_inherited_skill_roots() {
        let root = temp_root();
        let repository = root.join("repository");
        let workspace = repository.join("packages/app");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir(repository.join(".git")).unwrap();
        let values = locations(
            &root.join("app-data"),
            &root.join("home"),
            Some(&root.join("bundled/skills")),
            Some(&root.join("codex-home")),
            Some(&workspace),
        );
        assert!(
            values
                .iter()
                .any(|value| value.scope == "builtin" && !value.writable)
        );
        assert!(
            values
                .iter()
                .any(|value| value.label == "Workspace .agents/skills")
        );
        assert!(
            values
                .iter()
                .any(|value| value.label == "Inherited .agents/skills")
        );
        assert!(
            values
                .iter()
                .any(|value| value.label == "CODEX_HOME/skills")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_updates_and_recoverably_deletes_a_user_skill() {
        let root = temp_root();
        let app_data = root.join("app-data");
        let home = root.join("home");
        let manifest = create(
            &app_data,
            &home,
            None,
            Some("app"),
            "Release Helper",
            "Use for release checks.",
            "# Release\n\nRun the bounded checks.",
            false,
        )
        .unwrap();
        assert!(manifest.ends_with("release-helper/SKILL.md"));
        let first = std::fs::read_to_string(&manifest).unwrap();
        assert!(first.contains("name: \"Release Helper\""));
        let (updated, backup) = update(
            &app_data,
            &home,
            None,
            &manifest,
            "---\nname: \"Release Helper\"\ndescription: \"Use for release checks.\"\n---\n\n# Updated\n",
        )
        .unwrap();
        assert_eq!(updated, std::fs::canonicalize(&manifest).unwrap());
        assert!(backup.unwrap().is_file());
        let trash = delete(&app_data, &home, None, &manifest).unwrap().unwrap();
        assert!(trash.is_dir());
        assert!(!manifest.exists());

        let localized = create(
            &app_data,
            &home,
            None,
            Some("app"),
            "发布助手",
            "用于发布检查。",
            "# 检查\n",
            false,
        )
        .unwrap();
        assert!(localized.ends_with("发布助手/SKILL.md"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reinstalling_an_existing_skill_does_not_delete_its_source() {
        let root = temp_root();
        let destination = root.join("skills");
        let source = destination.join("review");
        std::fs::create_dir_all(&source).unwrap();
        let manifest = source.join("SKILL.md");
        std::fs::write(
            &manifest,
            "---\nname: review\ndescription: Review source changes.\n---\n\n# Review\n",
        )
        .unwrap();
        let installed = install_local(&destination, &source, false).unwrap();
        assert_eq!(installed, vec![manifest.clone()]);
        assert!(source.is_dir());
        assert!(
            std::fs::read_to_string(&manifest)
                .unwrap()
                .contains("# Review")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn installs_a_local_zip_without_removing_the_archive() {
        let root = temp_root();
        let archive_path = root.join("review-skill.zip");
        let bytes = {
            let mut output = Cursor::new(Vec::new());
            let mut archive = zip::ZipWriter::new(&mut output);
            let options = zip::write::SimpleFileOptions::default();
            archive.start_file("review/SKILL.md", options).unwrap();
            archive
                .write_all(
                    b"---\nname: review\ndescription: Review source changes.\n---\n\n# Review\n",
                )
                .unwrap();
            archive.finish().unwrap();
            output.into_inner()
        };
        std::fs::write(&archive_path, bytes).unwrap();
        let destination = root.join("app-data/skills");
        let installed = install(
            &root.join("app-data"),
            &root.join("home"),
            None,
            Some("app"),
            archive_path.to_str().unwrap(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(installed.len(), 1);
        assert!(installed[0].ends_with("review/SKILL.md"));
        assert!(archive_path.is_file());
        assert!(destination.join("review/SKILL.md").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_private_remote_skill_sources_and_oversized_manifests() {
        assert!(normalize_install_url("https://127.0.0.1/skill.zip").is_err());
        assert!(normalize_install_url("https://user:pass@example.com/skill.zip").is_err());
        assert!(normalize_install_url("http://example.com/skill.zip").is_err());
        assert!(network::is_private_or_loopback(
            "::ffff:127.0.0.1".parse().unwrap()
        ));
        let oversized = format!(
            "---\nname: x\ndescription: y\n---\n{}",
            "x".repeat(MAX_SKILL_FILE_BYTES as usize)
        );
        assert!(validate_manifest(&oversized).is_err());
    }

    #[test]
    fn refuses_to_move_a_skill_root_when_manifest_is_at_root_level() {
        let root = temp_root();
        let app_data = root.join("app-data");
        let home = root.join("home");
        let skill_root = app_data.join("skills");
        std::fs::create_dir_all(&skill_root).unwrap();
        let manifest = skill_root.join("SKILL.md");
        std::fs::write(
            &manifest,
            "---\nname: root\ndescription: root\n---\n\n# Root\n",
        )
        .unwrap();
        assert!(delete(&app_data, &home, None, &manifest).is_err());
        assert!(skill_root.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inherited_repository_skills_can_be_updated_from_a_nested_workspace() {
        let root = temp_root();
        let repository = root.join("repository");
        let workspace = repository.join("packages/app");
        let manifest = repository.join(".agents/skills/release/SKILL.md");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::create_dir(repository.join(".git")).unwrap();
        std::fs::write(
            &manifest,
            "---\nname: release\ndescription: Release checks\n---\n\n# Release\n",
        )
        .unwrap();
        let discovered = scan(
            &root.join("app-data"),
            &root.join("home"),
            None,
            None,
            Some(&workspace),
            &HashMap::new(),
        );
        assert_eq!(discovered.len(), 1);
        let canonical_manifest = std::fs::canonicalize(&manifest).unwrap();
        let (updated, backup) = update(
            &root.join("app-data"),
            &root.join("home"),
            Some(&workspace),
            &canonical_manifest,
            "---\nname: release\ndescription: Updated release checks\n---\n\n# Updated\n",
        )
        .unwrap();
        assert_eq!(updated, canonical_manifest);
        assert!(backup.unwrap().is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
}
