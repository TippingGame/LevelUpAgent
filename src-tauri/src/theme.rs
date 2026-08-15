use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

const MAX_THEME_PACKAGE_BYTES: u64 = 12 * 1024 * 1024;
const MAX_THEME_CSS_BYTES: usize = 10 * 1024 * 1024;
const THEME_EXTENSION: &str = "levelup-theme";
const MANAGED_THEME_FILE: &str = "theme.levelup-theme";
const BUNDLED_THEME_MARKER: &str = ".bundled";
const GENERATED_THEME_DIRECTORY: &str = "generated-themes";
const MAX_GENERATED_BACKGROUND_BYTES: u64 = 5 * 1024 * 1024;
const GENERATED_BACKGROUND_IMAGE_SUFFIX: &str = ".background-image";
const GENERATED_BACKGROUND_METADATA_SUFFIX: &str = ".background.json";
const GENERATED_BACKGROUND_CSS_MARKER: &str = "/* levelup-host-conversation-background-v1 */";
const THEME_GENERATION_SKILL: &str =
    include_str!("../resources/skills/customize-levelup-layout/SKILL.md");
const THEME_LAYOUT_REFERENCE: &str =
    include_str!("../resources/skills/customize-levelup-layout/references/layout-schema.md");

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeGenerationTarget {
    pub relative_path: String,
    pub source_path: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeGenerationBackgroundRequest {
    pub asset_id: String,
    pub fit: String,
    pub focus: String,
    pub readability: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThemeGenerationBackgroundSource {
    pub source_path: PathBuf,
    pub mime_type: String,
    pub fit: String,
    pub focus: String,
    pub readability: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ThemeGenerationBackgroundSidecar {
    schema_version: u32,
    mime_type: String,
    fit: String,
    focus: String,
    readability: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ThemeGenerationValidation {
    Missing,
    Invalid(String),
    Valid(Box<ThemeManifest>),
}

/// Theme generation is application-owned: attach the packaged instructions
/// once instead of exposing `read_skill` to a provider loop. Keeping both the
/// manifest and its only required reference here also makes generation
/// independent from files in the user's selected project.
pub fn generation_guidance() -> String {
    format!(
        "# Packaged customize-levelup-layout Skill\n\n{THEME_GENERATION_SKILL}\n\n# Packaged layout-schema reference\n\n{THEME_LAYOUT_REFERENCE}"
    )
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    #[serde(default)]
    pub layout: Option<ThemeLayout>,
    #[serde(default)]
    pub layout_file: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub bundled: bool,
}

/// A theme may use the legacy named layout or embed a validated layout.json
/// definition directly in the package.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ThemeLayout {
    Legacy(String),
    Embedded(serde_json::Value),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePackage {
    #[serde(flatten)]
    pub manifest: ThemeManifest,
    pub css: String,
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(
            "Theme ID may only contain letters, numbers, dashes, and underscores".to_owned(),
        );
    }
    Ok(())
}

fn validate_text(value: &str, label: &str, maximum: usize) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > maximum || value.chars().any(char::is_control) {
        return Err(format!(
            "Theme {label} must contain 1 to {maximum} printable characters"
        ));
    }
    Ok(())
}

fn contains_legacy_behavior_declaration(css: &str) -> bool {
    let bytes = css.as_bytes();
    let mut index = 0;
    let mut declaration_start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut in_comment = false;
    let mut parentheses = 0_u32;

    while index < bytes.len() {
        let byte = bytes[index];
        if in_comment {
            if byte == b'*' && bytes.get(index + 1) == Some(&b'/') {
                in_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if let Some(delimiter) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == delimiter {
                quote = None;
            }
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            in_comment = true;
            index += 2;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        match byte {
            b'(' => parentheses = parentheses.saturating_add(1),
            b')' => parentheses = parentheses.saturating_sub(1),
            b'{' | b';' | b'}' if parentheses == 0 => declaration_start = index + 1,
            b':' if parentheses == 0 => {
                let candidate = &css[declaration_start..index];
                let mut property = String::with_capacity(candidate.len().min(16));
                let candidate_bytes = candidate.as_bytes();
                let mut candidate_index = 0;
                while candidate_index < candidate_bytes.len() {
                    let candidate_byte = candidate_bytes[candidate_index];
                    if candidate_byte.is_ascii_whitespace() {
                        candidate_index += 1;
                    } else if candidate_byte == b'/'
                        && candidate_bytes.get(candidate_index + 1) == Some(&b'*')
                    {
                        candidate_index += 2;
                        while candidate_index < candidate_bytes.len()
                            && !(candidate_bytes[candidate_index] == b'*'
                                && candidate_bytes.get(candidate_index + 1) == Some(&b'/'))
                        {
                            candidate_index += 1;
                        }
                        candidate_index = (candidate_index + 2).min(candidate_bytes.len());
                    } else if candidate_byte.is_ascii_alphanumeric()
                        || matches!(candidate_byte, b'-' | b'_' | b'*')
                    {
                        property.push(candidate_byte as char);
                        candidate_index += 1;
                    } else {
                        property.clear();
                        break;
                    }
                }
                if matches!(property.as_str(), "behavior" | "*behavior" | "_behavior") {
                    return true;
                }
            }
            _ => {}
        }
        index += 1;
    }
    false
}

fn validate_package(package: &ThemePackage) -> Result<(), String> {
    if !matches!(package.manifest.schema_version, 1 | 2) {
        return Err("Unsupported theme package schema; expected schemaVersion 1 or 2".to_owned());
    }
    validate_id(&package.manifest.id)?;
    validate_text(&package.manifest.name, "name", 80)?;
    validate_text(&package.manifest.version, "version", 32)?;
    validate_text(&package.manifest.author, "author", 100)?;
    validate_text(&package.manifest.description, "description", 500)?;
    if package.manifest.bundled {
        return Err("Theme packages cannot declare themselves as bundled".to_owned());
    }
    if package.manifest.schema_version == 1 {
        if package.manifest.layout_file.is_some() {
            return Err("layoutFile requires theme schemaVersion 2".to_owned());
        }
        if let Some(layout) = &package.manifest.layout {
            match layout {
                ThemeLayout::Legacy(layout) if matches!(layout.as_str(), "standard" | "qq2007") => {
                }
                ThemeLayout::Legacy(_) => {
                    return Err("Legacy theme layout must be standard or qq2007".to_owned());
                }
                ThemeLayout::Embedded(_) => {
                    return Err("Embedded theme layouts require theme schemaVersion 2".to_owned());
                }
            }
        }
    } else {
        if package.manifest.layout.is_some() && package.manifest.layout_file.is_some() {
            return Err("Theme package cannot define both layout and layoutFile".to_owned());
        }
        if let Some(ThemeLayout::Legacy(_)) = &package.manifest.layout {
            return Err("Theme schemaVersion 2 requires an embedded layout object".to_owned());
        }
        if let Some(ThemeLayout::Embedded(layout)) = &package.manifest.layout {
            crate::layout::validate_embedded_definition(layout)?;
        }
        if let Some(layout_file) = &package.manifest.layout_file {
            validate_layout_file_name(layout_file)?;
        }
    }
    if let Some(homepage) = &package.manifest.homepage {
        validate_text(homepage, "homepage", 300)?;
    }
    if let Some(license) = &package.manifest.license {
        validate_text(license, "license", 80)?;
    }
    if package.css.is_empty() || package.css.len() > MAX_THEME_CSS_BYTES {
        return Err("Theme CSS must be between 1 byte and 10 MiB".to_owned());
    }
    let css = package.css.to_ascii_lowercase();
    for forbidden in [
        "@import",
        "javascript:",
        "expression(",
        "-moz-binding",
        "http:",
        "https:",
        "url(//",
    ] {
        if css.contains(forbidden) {
            return Err(format!(
                "Theme CSS contains a forbidden construct: {forbidden}"
            ));
        }
    }
    if contains_legacy_behavior_declaration(&css) {
        return Err("Theme CSS contains a forbidden construct: behavior:".to_owned());
    }
    let required_scope = format!("[data-levelup-theme=\"{}\"]", package.manifest.id);
    if !package.css.contains(&required_scope) {
        return Err(format!(
            "Theme CSS must be scoped with {required_scope} so it cannot affect inactive themes"
        ));
    }
    Ok(())
}

pub(crate) fn validate_layout_file_name(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 120
        || path.file_name().and_then(|name| name.to_str()) != Some(value)
        || !(value == "layout.json" || value.ends_with(".layout.json"))
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(
            "Theme layoutFile must be layout.json or a local filename ending in .layout.json"
                .to_owned(),
        );
    }
    Ok(())
}

fn theme_directory(storage: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(storage.join(id))
}

fn managed_package_path(storage: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(theme_directory(storage, id)?.join(MANAGED_THEME_FILE))
}

fn bundled_marker_path(storage: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(theme_directory(storage, id)?.join(BUNDLED_THEME_MARKER))
}

fn ensure_regular_directory(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(format!(
            "Theme generation {label} is not a regular directory"
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(path)
            .map_err(|error| format!("Could not create theme generation {label}: {error}")),
        Err(error) => Err(format!(
            "Could not inspect theme generation {label}: {error}"
        )),
    }
}

/// Prepare the one managed workspace directory used by the theme generator.
/// The provider receives only the relative path; the absolute path is kept by
/// the host for deterministic import after the Harness operation completes.
#[cfg_attr(not(test), allow(dead_code))]
pub fn prepare_generation_target(workspace: &Path) -> Result<ThemeGenerationTarget, String> {
    prepare_generation_target_with_background(workspace, None)
}

/// Optionally stage one host-generated background beside the model-owned
/// package. The sidecar path is never exposed to the provider and is derived
/// from the application-allocated package name, so Harness still only needs
/// permission to write the single target theme file.
pub fn prepare_generation_target_with_background(
    workspace: &Path,
    background: Option<&ThemeGenerationBackgroundSource>,
) -> Result<ThemeGenerationTarget, String> {
    let root = std::fs::canonicalize(workspace)
        .map_err(|error| format!("Theme workspace is unavailable: {error}"))?;
    let metadata = std::fs::metadata(&root)
        .map_err(|error| format!("Could not inspect theme workspace: {error}"))?;
    if !metadata.is_dir() {
        return Err("Theme workspace is not a directory".to_owned());
    }

    let levelup = root.join(".levelup");
    ensure_regular_directory(&levelup, "root")?;
    let levelup = std::fs::canonicalize(&levelup)
        .map_err(|error| format!("Theme generation root is unavailable: {error}"))?;
    if !levelup.starts_with(&root) {
        return Err("Theme generation root escapes the selected workspace".to_owned());
    }
    let generated = levelup.join(GENERATED_THEME_DIRECTORY);
    ensure_regular_directory(&generated, "output directory")?;
    let generated = std::fs::canonicalize(&generated)
        .map_err(|error| format!("Theme output directory is unavailable: {error}"))?;
    if !generated.starts_with(&root) {
        return Err("Theme output directory escapes the selected workspace".to_owned());
    }

    for _ in 0..8 {
        let file_name = format!("{}.levelup-theme", uuid::Uuid::new_v4().simple());
        let source = generated.join(&file_name);
        match std::fs::symlink_metadata(&source) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let target = ThemeGenerationTarget {
                    relative_path: format!(".levelup/{GENERATED_THEME_DIRECTORY}/{file_name}"),
                    source_path: source.to_string_lossy().into_owned(),
                };
                if let Some(background) = background {
                    stage_generation_background(Path::new(&target.source_path), background)?;
                }
                return Ok(target);
            }
            Ok(_) => continue,
            Err(error) => {
                return Err(format!("Could not inspect generated theme target: {error}"));
            }
        }
    }
    Err("Could not allocate a unique generated theme target".to_owned())
}

fn generation_background_paths(target: &Path) -> Result<(PathBuf, PathBuf), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Theme generation target has no parent directory".to_owned())?;
    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| {
            value.len() == 32 && value.bytes().all(|character| character.is_ascii_hexdigit())
        })
        .ok_or_else(|| "Theme generation target has no managed filename".to_owned())?;
    Ok((
        parent.join(format!(".{stem}{GENERATED_BACKGROUND_IMAGE_SUFFIX}")),
        parent.join(format!(".{stem}{GENERATED_BACKGROUND_METADATA_SUFFIX}")),
    ))
}

fn validate_generation_background_options(
    mime_type: &str,
    fit: &str,
    focus: &str,
    readability: &str,
) -> Result<(), String> {
    if !matches!(mime_type, "image/png" | "image/jpeg" | "image/webp") {
        return Err("Generated theme backgrounds must be PNG, JPEG, or WebP images".to_owned());
    }
    if !matches!(fit, "cover" | "contain" | "tile") {
        return Err("Theme background fit must be cover, contain, or tile".to_owned());
    }
    if !matches!(focus, "left" | "center" | "right") {
        return Err("Theme background focus must be left, center, or right".to_owned());
    }
    if !matches!(readability, "soft" | "balanced" | "strong") {
        return Err("Theme background readability must be soft, balanced, or strong".to_owned());
    }
    Ok(())
}

fn stage_generation_background(
    target: &Path,
    background: &ThemeGenerationBackgroundSource,
) -> Result<(), String> {
    validate_generation_background_options(
        background.mime_type.as_str(),
        background.fit.as_str(),
        background.focus.as_str(),
        background.readability.as_str(),
    )?;
    let metadata = std::fs::symlink_metadata(&background.source_path)
        .map_err(|error| format!("Could not inspect generated theme background: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_GENERATED_BACKGROUND_BYTES
    {
        return Err(
            "Generated theme backgrounds must be regular image files between 1 byte and 5 MiB"
                .to_owned(),
        );
    }
    let bytes = std::fs::read(&background.source_path)
        .map_err(|error| format!("Could not read generated theme background: {error}"))?;
    let sidecar = ThemeGenerationBackgroundSidecar {
        schema_version: 1,
        mime_type: background.mime_type.clone(),
        fit: background.fit.clone(),
        focus: background.focus.clone(),
        readability: background.readability.clone(),
    };
    let metadata_bytes = serde_json::to_vec(&sidecar)
        .map_err(|error| format!("Could not serialize theme background settings: {error}"))?;
    let (image_path, metadata_path) = generation_background_paths(target)?;
    stage_file(&image_path, &bytes, "generated theme background")?;
    if let Err(error) = stage_file(
        &metadata_path,
        &metadata_bytes,
        "generated theme background settings",
    ) {
        let _ = std::fs::remove_file(image_path);
        return Err(error);
    }
    Ok(())
}

fn read_generation_background(
    target: &Path,
) -> Result<Option<(ThemeGenerationBackgroundSidecar, Vec<u8>)>, String> {
    let (image_path, metadata_path) = generation_background_paths(target)?;
    let metadata = match std::fs::symlink_metadata(&metadata_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect generated theme background settings: {error}"
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4 * 1024 {
        return Err(
            "Generated theme background settings are not a regular host sidecar".to_owned(),
        );
    }
    let sidecar: ThemeGenerationBackgroundSidecar = serde_json::from_slice(
        &std::fs::read(&metadata_path)
            .map_err(|error| format!("Could not read theme background settings: {error}"))?,
    )
    .map_err(|error| format!("Generated theme background settings are invalid: {error}"))?;
    if sidecar.schema_version != 1 {
        return Err("Generated theme background settings use an unsupported schema".to_owned());
    }
    validate_generation_background_options(
        sidecar.mime_type.as_str(),
        sidecar.fit.as_str(),
        sidecar.focus.as_str(),
        sidecar.readability.as_str(),
    )?;
    let image_metadata = std::fs::symlink_metadata(&image_path)
        .map_err(|error| format!("Could not inspect generated theme background image: {error}"))?;
    if image_metadata.file_type().is_symlink()
        || !image_metadata.is_file()
        || image_metadata.len() == 0
        || image_metadata.len() > MAX_GENERATED_BACKGROUND_BYTES
    {
        return Err(
            "Generated theme background sidecar must be a regular image between 1 byte and 5 MiB"
                .to_owned(),
        );
    }
    let bytes = std::fs::read(image_path)
        .map_err(|error| format!("Could not read generated theme background image: {error}"))?;
    Ok(Some((sidecar, bytes)))
}

fn cleanup_generation_background(target: &Path) {
    if let Ok((image_path, metadata_path)) = generation_background_paths(target) {
        let _ = std::fs::remove_file(metadata_path);
        let _ = std::fs::remove_file(image_path);
    }
}

fn generation_background_css(
    theme_id: &str,
    background: &ThemeGenerationBackgroundSidecar,
    bytes: &[u8],
) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let (size, repeat) = match background.fit.as_str() {
        "contain" => ("contain", "no-repeat"),
        "tile" => ("512px auto", "repeat"),
        _ => ("cover", "no-repeat"),
    };
    let position = match background.focus.as_str() {
        "left" => "left center",
        "right" => "right center",
        _ => "center center",
    };
    let overlay = match background.readability.as_str() {
        "soft" => ".42",
        "strong" => ".78",
        _ => ".62",
    };
    format!(
        "\n{GENERATED_BACKGROUND_CSS_MARKER}\nhtml[data-levelup-theme=\"{theme_id}\"] {{ --levelup-generated-conversation-background: url(\"data:{};base64,{encoded}\"); }}\nhtml[data-levelup-theme=\"{theme_id}\"] .app-shell {{ background-image: none !important; }}\nhtml[data-levelup-theme=\"{theme_id}\"] .conversation-stage {{ isolation: isolate; background-color: var(--canvas) !important; background-image: var(--levelup-generated-conversation-background) !important; background-position: {position} !important; background-size: {size} !important; background-repeat: {repeat} !important; }}\nhtml[data-levelup-theme=\"{theme_id}\"] .conversation-stage::before {{ position: absolute; inset: 0; z-index: 0; background: var(--canvas) !important; opacity: {overlay}; pointer-events: none; content: \"\"; }}\nhtml[data-levelup-theme=\"{theme_id}\"] .conversation {{ position: relative; z-index: 1; background: transparent !important; }}\nhtml[data-levelup-theme=\"{theme_id}\"] .empty-state {{ background: transparent !important; }}\n",
        background.mime_type,
    )
}

/// Resolve only an application-allocated theme target. The model-visible path
/// is deliberately relative, but recovery and validation use the canonical
/// managed directory so neither absolute paths nor prefix-lookalike siblings
/// can redirect the import outside the selected workspace.
pub fn generation_target_path(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(workspace)
        .map_err(|error| format!("Theme workspace is unavailable: {error}"))?;
    let relative = Path::new(relative);
    let expected_parent = Path::new(".levelup").join(GENERATED_THEME_DIRECTORY);
    let file_name = relative
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Theme generation target has no valid filename".to_owned())?;
    let stem = file_name
        .strip_suffix(".levelup-theme")
        .ok_or_else(|| "Theme generation target must end in .levelup-theme".to_owned())?;
    if relative.is_absolute()
        || relative.parent() != Some(expected_parent.as_path())
        || stem.len() != 32
        || !stem.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err("Theme generation target is not an application-managed output path".to_owned());
    }

    let levelup = root.join(".levelup");
    let levelup_metadata = std::fs::symlink_metadata(&levelup)
        .map_err(|error| format!("Theme generation root is unavailable: {error}"))?;
    if levelup_metadata.file_type().is_symlink() || !levelup_metadata.is_dir() {
        return Err("Theme generation root is not a regular directory".to_owned());
    }
    let generated = levelup.join(GENERATED_THEME_DIRECTORY);
    let generated_metadata = std::fs::symlink_metadata(&generated)
        .map_err(|error| format!("Theme output directory is unavailable: {error}"))?;
    if generated_metadata.file_type().is_symlink() || !generated_metadata.is_dir() {
        return Err("Theme output directory is not a regular directory".to_owned());
    }
    let generated = std::fs::canonicalize(generated)
        .map_err(|error| format!("Theme output directory is unavailable: {error}"))?;
    if !generated.starts_with(&root) {
        return Err("Theme output directory escapes the selected workspace".to_owned());
    }
    Ok(generated.join(file_name))
}

/// Run the same package and companion-layout validation used by installation.
/// A missing target is a normal not-yet-generated state; an existing invalid
/// package returns its precise validator error so Harness can ask for one
/// focused correction instead of blindly continuing the provider loop.
pub fn validate_generation_result(
    workspace: &Path,
    relative: &str,
) -> Result<ThemeGenerationValidation, String> {
    let source = generation_target_path(workspace, relative)?;
    match std::fs::symlink_metadata(&source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ThemeGenerationValidation::Missing);
        }
        Err(error) => {
            return Err(format!(
                "Could not inspect generated theme package: {error}"
            ));
        }
        Ok(_) => {}
    }
    normalize_generation_draft(&source)?;
    let package = match read_package(&source) {
        Ok(package) => package,
        Err(error) => return Ok(ThemeGenerationValidation::Invalid(error)),
    };
    if let Err(error) = companion_layout_bytes(&package, &source) {
        return Ok(ThemeGenerationValidation::Invalid(error));
    }
    cleanup_generation_background(&source);
    Ok(ThemeGenerationValidation::Valid(Box::new(package.manifest)))
}

/// Providers occasionally emit a structurally sound generated theme while
/// omitting boilerplate metadata. Normalize only application-owned generation
/// drafts so the first valid CSS result can be imported without another model
/// round. User-selected packages still go through strict `read_package`
/// validation unchanged. Values that are present but invalid are deliberately
/// preserved so validation reports the actual provider error.
fn normalize_generation_draft(path: &Path) -> Result<bool, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect generated theme draft: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_THEME_PACKAGE_BYTES
    {
        return Ok(false);
    }

    let bytes = std::fs::read(path)
        .map_err(|error| format!("Could not read generated theme draft: {error}"))?;
    let json_bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let (json_bytes, mut changed) = escape_raw_json_string_controls(json_bytes);
    let Ok(mut draft) = serde_json::from_slice::<serde_json::Value>(&json_bytes) else {
        return Ok(false);
    };
    let Some(object) = draft.as_object_mut() else {
        return Ok(false);
    };

    for (field, default) in [
        ("schemaVersion", serde_json::json!(1)),
        ("version", serde_json::json!("1.0.0")),
        ("author", serde_json::json!("LevelUpAgent")),
        (
            "description",
            serde_json::json!("Generated by LevelUpAgent"),
        ),
    ] {
        if !object.contains_key(field) {
            object.insert(field.to_owned(), default);
            changed = true;
        }
    }
    if let Some(serde_json::Value::String(css)) = object.get_mut("css") {
        // XML namespace identifiers inside an SVG data URL are identifiers,
        // not network dependencies. Percent-encode their scheme delimiter so
        // URL decoding restores the exact namespace for the SVG parser while
        // the theme package still contains no literal HTTP scheme. This is
        // deliberately limited to the two standard W3C SVG namespaces; real
        // remote CSS/image/font URLs remain rejected by validate_package.
        let encoded = css
            .replace("http://www.w3.org/2000/svg", "http%3A//www.w3.org/2000/svg")
            .replace(
                "http://www.w3.org/1999/xlink",
                "http%3A//www.w3.org/1999/xlink",
            );
        if encoded != *css {
            *css = encoded;
            changed = true;
        }
    }
    let theme_id = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| validate_id(id).is_ok())
        .map(str::to_owned);
    if let (Some(theme_id), Some(serde_json::Value::String(css))) =
        (theme_id, object.get_mut("css"))
    {
        let required_scope = format!("[data-levelup-theme=\"{theme_id}\"]");
        if css.contains(&required_scope)
            && !css.contains(GENERATED_BACKGROUND_CSS_MARKER)
            && let Some((background, bytes)) = read_generation_background(path)?
        {
            css.push_str(&generation_background_css(&theme_id, &background, &bytes));
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }

    let normalized = serde_json::to_vec(&draft)
        .map_err(|error| format!("Could not serialize generated theme draft: {error}"))?;
    stage_file(path, &normalized, "generated theme draft")?;
    Ok(true)
}

/// A model may construct the outer theme JSON by placing readable multi-line
/// CSS directly between quotes. JSON permits whitespace between values but
/// requires C0 control characters inside strings to be escaped. Preserve all
/// bytes and structure while converting only those in-string characters to
/// their JSON escape spellings; serde_json remains the authority on every
/// other syntax error.
fn escape_raw_json_string_controls(bytes: &[u8]) -> (Vec<u8>, bool) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut escaped_bytes = Vec::with_capacity(bytes.len());
    let mut in_string = false;
    let mut after_escape = false;
    let mut changed = false;

    for &byte in bytes {
        if !in_string {
            escaped_bytes.push(byte);
            if byte == b'"' {
                in_string = true;
            }
            continue;
        }

        if after_escape {
            if byte < 0x20 {
                // Preserve the preceding backslash as data before escaping the
                // control character itself. This also repairs an accidental
                // backslash followed by a physical line break.
                escaped_bytes.push(b'\\');
                push_json_control_escape(&mut escaped_bytes, byte, HEX);
                changed = true;
            } else {
                escaped_bytes.push(byte);
            }
            after_escape = false;
            continue;
        }

        match byte {
            b'\\' => {
                escaped_bytes.push(byte);
                after_escape = true;
            }
            b'"' => {
                escaped_bytes.push(byte);
                in_string = false;
            }
            0x00..=0x1f => {
                push_json_control_escape(&mut escaped_bytes, byte, HEX);
                changed = true;
            }
            _ => escaped_bytes.push(byte),
        }
    }
    (escaped_bytes, changed)
}

fn push_json_control_escape(output: &mut Vec<u8>, byte: u8, hex: &[u8; 16]) {
    match byte {
        b'\x08' => output.extend_from_slice(b"\\b"),
        b'\t' => output.extend_from_slice(b"\\t"),
        b'\n' => output.extend_from_slice(b"\\n"),
        b'\x0c' => output.extend_from_slice(b"\\f"),
        b'\r' => output.extend_from_slice(b"\\r"),
        _ => {
            output.extend_from_slice(b"\\u00");
            output.push(hex[usize::from(byte >> 4)]);
            output.push(hex[usize::from(byte & 0x0f)]);
        }
    }
}

fn is_bundled(storage: &Path, id: &str) -> Result<bool, String> {
    let marker = bundled_marker_path(storage, id)?;
    match std::fs::symlink_metadata(marker) {
        Ok(metadata) => Ok(metadata.is_file() && !metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect bundled theme marker: {error}")),
    }
}

fn read_package(path: &Path) -> Result<ThemePackage, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect theme package: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_THEME_PACKAGE_BYTES
    {
        return Err("Theme packages must be regular files between 1 byte and 12 MiB".to_owned());
    }
    let bytes =
        std::fs::read(path).map_err(|error| format!("Could not read theme package: {error}"))?;
    let json_bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let package: ThemePackage = serde_json::from_slice(json_bytes)
        .map_err(|error| format!("Theme package is not valid UTF-8 JSON: {error}"))?;
    validate_package(&package)?;
    Ok(package)
}

fn stage_file(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let mut file =
        std::fs::File::create(path).map_err(|error| format!("Could not stage {label}: {error}"))?;
    crate::filesystem::restrict_file(path)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not stage {label}: {error}"))
}

fn restore_directory_backup(backup: &Path, destination: &Path) {
    if backup.exists() {
        let _ = std::fs::rename(backup, destination);
    }
}

fn write_atomic(
    storage: &Path,
    package: &ThemePackage,
    layout_bytes: Option<&[u8]>,
    bundled: bool,
) -> Result<(), String> {
    std::fs::create_dir_all(storage)
        .map_err(|error| format!("Could not create theme storage: {error}"))?;
    crate::filesystem::restrict_directory(storage)?;
    let destination = theme_directory(storage, &package.manifest.id)?;
    let transaction = uuid::Uuid::new_v4().simple().to_string();
    let temporary = storage.join(format!(".{}.{}.tmp", package.manifest.id, transaction));
    std::fs::create_dir(&temporary)
        .map_err(|error| format!("Could not stage theme directory: {error}"))?;
    crate::filesystem::restrict_directory(&temporary)?;
    let bytes = serde_json::to_vec(package)
        .map_err(|error| format!("Could not serialize theme package: {error}"))?;
    if let Err(error) = stage_file(&temporary.join(MANAGED_THEME_FILE), &bytes, "theme package") {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }
    if let Some(layout_bytes) = layout_bytes {
        let layout_file = package
            .manifest
            .layout_file
            .as_deref()
            .ok_or_else(|| "Theme layout bytes require layoutFile".to_owned())?;
        if let Err(error) = stage_file(&temporary.join(layout_file), layout_bytes, "layout file") {
            let _ = std::fs::remove_dir_all(&temporary);
            return Err(error);
        }
    }
    if bundled
        && let Err(error) = stage_file(
            &temporary.join(BUNDLED_THEME_MARKER),
            b"bundled\n",
            "bundled theme marker",
        )
    {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }
    let backup = storage.join(format!(".{}.{}.backup", package.manifest.id, transaction));
    let had_previous = match std::fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => true,
        Ok(_) => {
            let _ = std::fs::remove_dir_all(&temporary);
            return Err("Installed theme directory is not a regular directory".to_owned());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&temporary);
            return Err(format!(
                "Could not inspect existing theme directory: {error}"
            ));
        }
    };
    if had_previous && let Err(error) = std::fs::rename(&destination, &backup) {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(format!("Could not stage existing theme directory: {error}"));
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        restore_directory_backup(&backup, &destination);
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(format!("Could not install theme directory: {error}"));
    }
    if had_previous {
        let _ = std::fs::remove_dir_all(backup);
    }
    Ok(())
}

fn companion_layout_bytes(
    package: &ThemePackage,
    source: &Path,
) -> Result<Option<Vec<u8>>, String> {
    let Some(layout_file) = &package.manifest.layout_file else {
        return Ok(None);
    };
    let source_layout = source
        .parent()
        .ok_or_else(|| "Theme package has no parent directory".to_owned())?
        .join(layout_file);
    match std::fs::symlink_metadata(&source_layout) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "Theme package is missing companion layout file: {layout_file}"
            ));
        }
        Err(error) => {
            return Err(format!("Could not inspect companion layout file: {error}"));
        }
    }
    let definition = crate::layout::read_and_validate(&source_layout)?;
    serde_json::to_vec(&definition)
        .map(Some)
        .map_err(|error| format!("Could not serialize layout: {error}"))
}

pub fn install(storage: &Path, source: &Path) -> Result<ThemeManifest, String> {
    if !source
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(THEME_EXTENSION))
    {
        return Err("Select a .levelup-theme package".to_owned());
    }
    let package = read_package(source)?;
    let layout_bytes = companion_layout_bytes(&package, source)?;
    write_atomic(storage, &package, layout_bytes.as_deref(), false)?;
    Ok(package.manifest)
}

pub fn sync_bundled(storage: &Path, bundled_root: &Path) -> Result<usize, String> {
    let metadata = match std::fs::symlink_metadata(bundled_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("Could not inspect bundled themes: {error}")),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Bundled themes must be stored in a regular directory".to_owned());
    }

    let entries = std::fs::read_dir(bundled_root)
        .map_err(|error| format!("Could not read bundled themes: {error}"))?;
    let mut synchronized = 0;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read bundled theme entry: {error}"))?;
        let directory = entry.path();
        let metadata = std::fs::symlink_metadata(&directory)
            .map_err(|error| format!("Could not inspect bundled theme directory: {error}"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let files = std::fs::read_dir(&directory)
            .map_err(|error| format!("Could not read bundled theme directory: {error}"))?;
        for file in files {
            let file =
                file.map_err(|error| format!("Could not read bundled theme file: {error}"))?;
            let source = file.path();
            if source.extension().and_then(|value| value.to_str()) != Some(THEME_EXTENSION) {
                continue;
            }
            let package = read_package(&source)?;
            if directory.file_name().and_then(|value| value.to_str())
                != Some(package.manifest.id.as_str())
            {
                return Err(format!(
                    "Bundled theme {} must be stored in a directory with the same name",
                    package.manifest.id
                ));
            }
            let destination = theme_directory(storage, &package.manifest.id)?;
            let installed_is_bundled = is_bundled(storage, &package.manifest.id)?;
            if destination.exists() && !installed_is_bundled {
                continue;
            }
            if installed_is_bundled
                && read_package(&managed_package_path(storage, &package.manifest.id)?)
                    .is_ok_and(|installed| installed.manifest.version == package.manifest.version)
            {
                continue;
            }
            let layout_bytes = companion_layout_bytes(&package, &source)?;
            write_atomic(storage, &package, layout_bytes.as_deref(), true)?;
            synchronized += 1;
        }
    }
    Ok(synchronized)
}

pub fn list(storage: &Path) -> Result<Vec<ThemeManifest>, String> {
    let entries = match std::fs::read_dir(storage) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not read installed themes: {error}")),
    };
    let mut themes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        if let Ok(mut package) = read_package(&path.join(MANAGED_THEME_FILE))
            && path.file_name().and_then(|value| value.to_str()) == Some(&package.manifest.id)
        {
            package.manifest.bundled = is_bundled(storage, &package.manifest.id)?;
            themes.push(package.manifest);
        }
    }
    themes.sort_by_key(|theme| theme.name.to_lowercase());
    Ok(themes)
}

pub fn load(storage: &Path, id: &str) -> Result<ThemePackage, String> {
    read_package(&managed_package_path(storage, id)?)
}

pub fn load_layout(storage: &Path, id: &str) -> Result<crate::layout::ResolvedLayout, String> {
    if id == "default" {
        return crate::layout::resolve(None, None);
    }
    let package_path = managed_package_path(storage, id)?;
    let package = read_package(&package_path)?;
    let custom_layout = package
        .manifest
        .layout_file
        .as_deref()
        .map(|layout_file| {
            theme_directory(storage, id).map(|directory| directory.join(layout_file))
        })
        .transpose()?;
    match package.manifest.layout.as_ref() {
        Some(ThemeLayout::Embedded(definition)) => {
            crate::layout::resolve_definition(Some(definition), None)
        }
        Some(ThemeLayout::Legacy(layout)) => crate::layout::resolve(None, Some(layout)),
        None => crate::layout::resolve(custom_layout.as_deref(), None),
    }
}

pub fn uninstall(storage: &Path, id: &str) -> Result<bool, String> {
    if is_bundled(storage, id)? {
        return Err("Bundled themes cannot be uninstalled".to_owned());
    }
    let directory = theme_directory(storage, id)?;
    let removed = match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            std::fs::remove_dir_all(&directory)
                .map_err(|error| format!("Could not uninstall theme directory: {error}"))?;
            true
        }
        Ok(_) => return Err("Installed theme directory is not a regular directory".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Could not inspect theme directory: {error}")),
    };
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ThemePackage {
        ThemePackage {
            manifest: ThemeManifest {
                schema_version: 1,
                id: "qq-2007".to_owned(),
                name: "QQ 2007".to_owned(),
                version: "1.0.0".to_owned(),
                author: "Theme author".to_owned(),
                description: "A scoped test theme".to_owned(),
                layout: None,
                layout_file: None,
                homepage: None,
                license: None,
                bundled: false,
            },
            css: "html[data-levelup-theme=\"qq-2007\"] { --accent: #2878d0; }".to_owned(),
        }
    }

    #[test]
    fn installs_lists_loads_and_uninstalls_packages() {
        let root = std::env::temp_dir().join(format!("levelup-theme-{}", uuid::Uuid::new_v4()));
        let source = root.join("source.levelup-theme");
        let storage = root.join("installed");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&source, serde_json::to_vec(&sample()).unwrap()).unwrap();
        assert_eq!(install(&storage, &source).unwrap().id, "qq-2007");
        assert!(storage.join("qq-2007/theme.levelup-theme").is_file());
        assert_eq!(list(&storage).unwrap().len(), 1);
        assert!(load(&storage, "qq-2007").unwrap().css.contains("--accent"));
        let mut updated = sample();
        updated.manifest.version = "1.1.0".to_owned();
        std::fs::write(&source, serde_json::to_vec(&updated).unwrap()).unwrap();
        assert_eq!(install(&storage, &source).unwrap().version, "1.1.0");
        assert_eq!(load(&storage, "qq-2007").unwrap().manifest.version, "1.1.0");
        let uppercase_source = root.join("source.LEVELUP-THEME");
        let mut bom_package = vec![0xEF, 0xBB, 0xBF];
        bom_package.extend(serde_json::to_vec(&updated).unwrap());
        std::fs::write(&uppercase_source, bom_package).unwrap();
        assert_eq!(install(&storage, &uppercase_source).unwrap().id, "qq-2007");
        assert!(uninstall(&storage, "qq-2007").unwrap());
        assert!(list(&storage).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn prepares_a_managed_generation_target_before_the_agent_runs() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-generate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = prepare_generation_target(&root).unwrap();
        assert!(
            target
                .relative_path
                .starts_with(".levelup/generated-themes/")
        );
        assert!(target.relative_path.ends_with(".levelup-theme"));
        let source = PathBuf::from(&target.source_path);
        assert!(source.parent().unwrap().is_dir());
        assert!(!source.exists());
        assert!(
            std::fs::canonicalize(source.parent().unwrap())
                .unwrap()
                .starts_with(std::fs::canonicalize(&root).unwrap())
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn embeds_one_host_generated_background_and_cleans_the_sidecar() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-background-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let background_path = root.join("managed-background.webp");
        std::fs::write(&background_path, b"small-managed-webp").unwrap();
        let background = ThemeGenerationBackgroundSource {
            source_path: background_path,
            mime_type: "image/webp".to_owned(),
            fit: "cover".to_owned(),
            focus: "right".to_owned(),
            readability: "strong".to_owned(),
        };
        let target = prepare_generation_target_with_background(&root, Some(&background)).unwrap();
        let source = PathBuf::from(&target.source_path);
        let (image_sidecar, metadata_sidecar) = generation_background_paths(&source).unwrap();
        assert!(image_sidecar.is_file());
        assert!(metadata_sidecar.is_file());

        let draft = serde_json::json!({
            "schemaVersion": 1,
            "id": "generated-background",
            "name": "Generated background",
            "version": "1.0.0",
            "author": "LevelUpAgent",
            "description": "Host background injection",
            "css": "html[data-levelup-theme=\"generated-background\"] { --canvas: #10131a; }"
        });
        std::fs::write(&source, serde_json::to_vec(&draft).unwrap()).unwrap();
        assert!(matches!(
            validate_generation_result(&root, &target.relative_path).unwrap(),
            ThemeGenerationValidation::Valid(manifest) if manifest.id == "generated-background"
        ));
        let package = read_package(&source).unwrap();
        assert!(package.css.contains(GENERATED_BACKGROUND_CSS_MARKER));
        assert!(package.css.contains("data:image/webp;base64,"));
        assert!(package.css.contains("right center"));
        assert!(package.css.contains("opacity: .78"));
        assert!(package.css.contains(".conversation-stage"));
        assert!(!image_sidecar.exists());
        assert!(!metadata_sidecar.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn validates_only_the_prepared_generation_target_and_package() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-generate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = prepare_generation_target(&root).unwrap();
        assert_eq!(
            validate_generation_result(&root, &target.relative_path).unwrap(),
            ThemeGenerationValidation::Missing
        );

        std::fs::write(&target.source_path, serde_json::to_vec(&sample()).unwrap()).unwrap();
        assert!(matches!(
            validate_generation_result(&root, &target.relative_path).unwrap(),
            ThemeGenerationValidation::Valid(manifest) if manifest.id == "qq-2007"
        ));
        std::fs::write(&target.source_path, b"not json").unwrap();
        assert!(matches!(
            validate_generation_result(&root, &target.relative_path).unwrap(),
            ThemeGenerationValidation::Invalid(error) if error.contains("valid UTF-8 JSON")
        ));
        assert!(validate_generation_result(&root, "../outside.levelup-theme").is_err());
        assert!(
            validate_generation_result(
                &root,
                &PathBuf::from(&target.source_path).to_string_lossy(),
            )
            .is_err()
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn generation_normalizes_only_missing_boilerplate_metadata() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-defaults-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = prepare_generation_target(&root).unwrap();
        let draft = serde_json::json!({
            "id": "generated-defaults",
            "name": "Generated defaults",
            "css": "html[data-levelup-theme=\"generated-defaults\"] { --accent: #3366ff; --icon: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E\"); }"
        });
        std::fs::write(&target.source_path, serde_json::to_vec(&draft).unwrap()).unwrap();

        let ThemeGenerationValidation::Valid(manifest) =
            validate_generation_result(&root, &target.relative_path).unwrap()
        else {
            panic!("a draft with complete semantic fields should be normalized");
        };
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(manifest.author, "LevelUpAgent");
        assert_eq!(manifest.description, "Generated by LevelUpAgent");

        let normalized = read_package(Path::new(&target.source_path)).unwrap();
        assert_eq!(normalized.manifest.id, "generated-defaults");
        assert_eq!(normalized.manifest.version, "1.0.0");
        assert!(
            normalized
                .css
                .contains("xmlns='http%3A//www.w3.org/2000/svg'")
        );
        assert!(!normalized.css.contains("http:"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn generation_escapes_physical_line_breaks_inside_the_css_json_string() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-controls-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = prepare_generation_target(&root).unwrap();
        let draft = r#"{
  "schemaVersion": 1,
  "id": "generated-controls",
  "name": "Generated controls",
  "version": "1.0.0",
  "author": "LevelUpAgent",
  "description": "Physical CSS line breaks",
  "css": "html[data-levelup-theme=\"generated-controls\"] {
	--accent: #3366ff;
}"
}"#;
        assert!(serde_json::from_str::<serde_json::Value>(draft).is_err());
        std::fs::write(&target.source_path, draft.as_bytes()).unwrap();

        assert!(matches!(
            validate_generation_result(&root, &target.relative_path).unwrap(),
            ThemeGenerationValidation::Valid(manifest) if manifest.id == "generated-controls"
        ));
        let normalized_text = std::fs::read_to_string(&target.source_path).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&normalized_text).is_ok());
        assert!(normalized_text.contains("\\n"));
        assert!(normalized_text.contains("\\t"));
        let normalized = read_package(Path::new(&target.source_path)).unwrap();
        assert!(normalized.css.contains('\n'));
        assert!(normalized.css.contains('\t'));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn generation_keeps_core_fields_and_invalid_values_strict() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-strict-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = prepare_generation_target(&root).unwrap();
        let missing_core = serde_json::json!({
            "name": "Missing ID",
            "css": "html[data-levelup-theme=\"missing-id\"] { --accent: #3366ff; }"
        });
        std::fs::write(
            &target.source_path,
            serde_json::to_vec(&missing_core).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            validate_generation_result(&root, &target.relative_path).unwrap(),
            ThemeGenerationValidation::Invalid(error) if error.contains("missing field `id`")
        ));
        let normalized: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&target.source_path).unwrap()).unwrap();
        assert!(normalized.get("id").is_none());
        assert_eq!(normalized["version"], "1.0.0");

        let invalid_value = serde_json::json!({
            "schemaVersion": 1,
            "id": "invalid-version",
            "name": "Invalid version",
            "version": "",
            "author": "Theme author",
            "description": "Invalid values must not be replaced",
            "css": "html[data-levelup-theme=\"invalid-version\"] { --accent: #3366ff; }"
        });
        std::fs::write(
            &target.source_path,
            serde_json::to_vec(&invalid_value).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            validate_generation_result(&root, &target.relative_path).unwrap(),
            ThemeGenerationValidation::Invalid(error) if error.contains("Theme version")
        ));
        let preserved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&target.source_path).unwrap()).unwrap();
        assert_eq!(preserved["version"], "");

        let remote_asset = serde_json::json!({
            "schemaVersion": 1,
            "id": "remote-asset",
            "name": "Remote asset",
            "version": "1.0.0",
            "author": "Theme author",
            "description": "Remote URLs must remain forbidden",
            "css": "html[data-levelup-theme=\"remote-asset\"] { background: url(http://example.test/image.png); }"
        });
        std::fs::write(
            &target.source_path,
            serde_json::to_vec(&remote_asset).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            validate_generation_result(&root, &target.relative_path).unwrap(),
            ThemeGenerationValidation::Invalid(error) if error.contains("forbidden construct: http:")
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn regular_theme_installation_does_not_normalize_missing_fields() {
        let root = std::env::temp_dir().join(format!(
            "levelup-theme-install-strict-{}",
            uuid::Uuid::new_v4()
        ));
        let source = root.join("strict.levelup-theme");
        let storage = root.join("installed");
        std::fs::create_dir_all(&root).unwrap();
        let draft = serde_json::json!({
            "schemaVersion": 1,
            "id": "strict-install",
            "name": "Strict install",
            "author": "Theme author",
            "description": "Missing version",
            "css": "html[data-levelup-theme=\"strict-install\"] { --accent: #3366ff; }"
        });
        std::fs::write(&source, serde_json::to_vec(&draft).unwrap()).unwrap();

        assert!(
            install(&storage, &source)
                .unwrap_err()
                .contains("missing field `version`")
        );
        let unchanged: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&source).unwrap()).unwrap();
        assert!(unchanged.get("version").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn regular_theme_installation_rejects_raw_controls_inside_json_strings() {
        let root = std::env::temp_dir().join(format!(
            "levelup-theme-controls-strict-{}",
            uuid::Uuid::new_v4()
        ));
        let source = root.join("strict-controls.levelup-theme");
        let storage = root.join("installed");
        std::fs::create_dir_all(&root).unwrap();
        let draft = r#"{
  "schemaVersion": 1,
  "id": "strict-controls",
  "name": "Strict controls",
  "version": "1.0.0",
  "author": "Theme author",
  "description": "Raw CSS line break",
  "css": "html[data-levelup-theme=\"strict-controls\"] {
  --accent: #3366ff;
}"
}"#;
        std::fs::write(&source, draft.as_bytes()).unwrap();

        assert!(
            install(&storage, &source)
                .unwrap_err()
                .contains("control character")
        );
        assert_eq!(std::fs::read_to_string(&source).unwrap(), draft);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn generation_guidance_packages_the_manifest_and_layout_reference_once() {
        let guidance = generation_guidance();
        assert!(guidance.contains("# Customize LevelUpAgent Layout"));
        assert!(guidance.contains("# LevelUpAgent layout.json reference"));
        assert!(guidance.contains("workspace"));
        assert_eq!(
            guidance
                .matches("# Packaged customize-levelup-layout Skill")
                .count(),
            1
        );
        assert_eq!(
            guidance
                .matches("# Packaged layout-schema reference")
                .count(),
            1
        );
    }

    #[test]
    fn generation_rejects_a_non_directory_managed_root() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-generate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".levelup"), b"not a directory").unwrap();
        assert!(prepare_generation_target(&root).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unscoped_or_remote_css() {
        let mut package = sample();
        package.css = ":root { --accent: red; }".to_owned();
        assert!(validate_package(&package).is_err());
        package.css =
            "html[data-levelup-theme=\"qq-2007\"] { background: url(https://example.test/x); }"
                .to_owned();
        assert!(validate_package(&package).is_err());
    }

    #[test]
    fn allows_modern_behavior_properties_but_rejects_legacy_ie_behavior() {
        let mut package = sample();
        package.css = concat!(
            "html[data-levelup-theme=\"qq-2007\"] { ",
            "scroll-behavior: smooth; overscroll-behavior: contain; ",
            "--behavior: allowed; }",
        )
        .to_owned();
        assert!(validate_package(&package).is_ok());

        for declaration in [
            "behavior: url(local.htc)",
            "behavior : url(local.htc)",
            "/* legacy */ behavior/**/: url(local.htc)",
            "*behavior: url(local.htc)",
            "_behavior: url(local.htc)",
        ] {
            package.css = format!("html[data-levelup-theme=\"qq-2007\"] {{ {declaration}; }}");
            assert!(matches!(
                validate_package(&package),
                Err(error) if error.contains("forbidden construct: behavior:")
            ));
        }
    }

    #[test]
    fn installs_and_removes_a_companion_layout() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-layout-{}", uuid::Uuid::new_v4()));
        let source = root.join("source.levelup-theme");
        let source_layout = root.join("layout.json");
        let storage = root.join("installed");
        std::fs::create_dir_all(&root).unwrap();
        let mut package = sample();
        package.manifest.schema_version = 2;
        package.manifest.layout_file = Some("layout.json".to_owned());
        std::fs::write(&source, serde_json::to_vec(&package).unwrap()).unwrap();
        std::fs::write(
            &source_layout,
            include_bytes!("../../layouts/default.layout.json"),
        )
        .unwrap();
        install(&storage, &source).unwrap();
        assert_eq!(load_layout(&storage, "qq-2007").unwrap().source, "theme");
        assert!(storage.join("qq-2007/layout.json").is_file());
        package.manifest.schema_version = 1;
        package.manifest.layout_file = None;
        std::fs::write(&source, serde_json::to_vec(&package).unwrap()).unwrap();
        install(&storage, &source).unwrap();
        assert!(!storage.join("qq-2007/layout.json").exists());
        assert_eq!(load_layout(&storage, "qq-2007").unwrap().source, "default");
        uninstall(&storage, "qq-2007").unwrap();
        assert!(!storage.join("qq-2007").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_missing_or_unsafe_companion_layouts() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-layout-{}", uuid::Uuid::new_v4()));
        let source = root.join("source.levelup-theme");
        let storage = root.join("installed");
        std::fs::create_dir_all(&root).unwrap();
        let mut package = sample();
        package.manifest.schema_version = 2;
        package.manifest.layout_file = Some("missing.layout.json".to_owned());
        std::fs::write(&source, serde_json::to_vec(&package).unwrap()).unwrap();
        let error = install(&storage, &source).unwrap_err();
        assert!(error.contains("missing companion layout file"));
        package.manifest.layout_file = Some("../escape.layout.json".to_owned());
        assert!(validate_package(&package).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn installs_and_loads_an_embedded_layout() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-embedded-{}", uuid::Uuid::new_v4()));
        let source = root.join("source.levelup-theme");
        let storage = root.join("installed");
        std::fs::create_dir_all(&root).unwrap();
        let mut package = sample();
        package.manifest.schema_version = 2;
        package.manifest.layout = Some(ThemeLayout::Embedded(
            serde_json::from_slice(include_bytes!("../../layouts/default.layout.json")).unwrap(),
        ));
        std::fs::write(&source, serde_json::to_vec(&package).unwrap()).unwrap();
        install(&storage, &source).unwrap();
        assert_eq!(load_layout(&storage, "qq-2007").unwrap().source, "theme");
        assert!(!storage.join("qq-2007/layout.json").exists());
        assert!(load(&storage, "qq-2007").unwrap().manifest.layout.is_some());
        uninstall(&storage, "qq-2007").unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn synchronizes_bundled_themes_without_overwriting_user_versions() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-bundled-{}", uuid::Uuid::new_v4()));
        let bundled = root.join("bundled/qq-2007");
        let source = bundled.join("qq-2007.levelup-theme");
        let user_source = root.join("user.levelup-theme");
        let storage = root.join("installed");
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(&source, serde_json::to_vec(&sample()).unwrap()).unwrap();

        assert_eq!(sync_bundled(&storage, &root.join("bundled")).unwrap(), 1);
        assert_eq!(sync_bundled(&storage, &root.join("bundled")).unwrap(), 0);
        assert!(list(&storage).unwrap()[0].bundled);
        assert!(uninstall(&storage, "qq-2007").is_err());

        let mut updated = sample();
        updated.manifest.version = "1.1.0".to_owned();
        std::fs::write(&source, serde_json::to_vec(&updated).unwrap()).unwrap();
        assert_eq!(sync_bundled(&storage, &root.join("bundled")).unwrap(), 1);
        assert_eq!(load(&storage, "qq-2007").unwrap().manifest.version, "1.1.0");

        let mut user = sample();
        user.manifest.version = "9.0.0".to_owned();
        std::fs::write(&user_source, serde_json::to_vec(&user).unwrap()).unwrap();
        install(&storage, &user_source).unwrap();
        assert!(!list(&storage).unwrap()[0].bundled);
        assert_eq!(sync_bundled(&storage, &root.join("bundled")).unwrap(), 0);
        assert_eq!(load(&storage, "qq-2007").unwrap().manifest.version, "9.0.0");
        assert!(uninstall(&storage, "qq-2007").unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_obsolete_flat_theme_files() {
        let root =
            std::env::temp_dir().join(format!("levelup-theme-flat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("qq-2007.levelup-theme"),
            serde_json::to_vec(&sample()).unwrap(),
        )
        .unwrap();
        assert!(list(&root).unwrap().is_empty());
        assert!(load(&root, "qq-2007").is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
