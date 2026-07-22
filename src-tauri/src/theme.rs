use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_THEME_PACKAGE_BYTES: u64 = 12 * 1024 * 1024;
const MAX_THEME_CSS_BYTES: usize = 10 * 1024 * 1024;
const THEME_EXTENSION: &str = "levelup-theme";
const MANAGED_THEME_FILE: &str = "theme.levelup-theme";
const BUNDLED_THEME_MARKER: &str = ".bundled";

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
        "behavior:",
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
    if bundled {
        if let Err(error) = stage_file(
            &temporary.join(BUNDLED_THEME_MARKER),
            b"bundled\n",
            "bundled theme marker",
        ) {
            let _ = std::fs::remove_dir_all(&temporary);
            return Err(error);
        }
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
        if let Ok(mut package) = read_package(&path.join(MANAGED_THEME_FILE)) {
            if path.file_name().and_then(|value| value.to_str()) == Some(&package.manifest.id) {
                package.manifest.bundled = is_bundled(storage, &package.manifest.id)?;
                themes.push(package.manifest);
            }
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
