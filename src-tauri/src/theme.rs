use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_THEME_PACKAGE_BYTES: u64 = 12 * 1024 * 1024;
const MAX_THEME_CSS_BYTES: usize = 10 * 1024 * 1024;
const THEME_EXTENSION: &str = "levelup-theme";
const MANAGED_THEME_FILE: &str = "theme.levelup-theme";

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
    pub layout: Option<String>,
    #[serde(default)]
    pub layout_file: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
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
    if package.manifest.schema_version == 1 {
        if package.manifest.layout_file.is_some() {
            return Err("layoutFile requires theme schemaVersion 2".to_owned());
        }
        if package
            .manifest
            .layout
            .as_deref()
            .is_some_and(|layout| !matches!(layout, "standard" | "qq2007"))
        {
            return Err("Legacy theme layout must be standard or qq2007".to_owned());
        }
    } else {
        if package.manifest.layout.is_some() {
            return Err("Theme schemaVersion 2 uses layoutFile instead of layout".to_owned());
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

fn validate_layout_file_name(value: &str) -> Result<(), String> {
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
    let package: ThemePackage = serde_json::from_slice(&bytes)
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
    if had_previous {
        if let Err(error) = std::fs::rename(&destination, &backup) {
            let _ = std::fs::remove_dir_all(&temporary);
            return Err(format!("Could not stage existing theme directory: {error}"));
        }
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

pub fn install(storage: &Path, source: &Path) -> Result<ThemeManifest, String> {
    if source.extension().and_then(|value| value.to_str()) != Some(THEME_EXTENSION) {
        return Err("Select a .levelup-theme package".to_owned());
    }
    let package = read_package(source)?;
    let layout_bytes = if let Some(layout_file) = &package.manifest.layout_file {
        let source_layout = source
            .parent()
            .ok_or_else(|| "Theme package has no parent directory".to_owned())?
            .join(layout_file);
        let definition = crate::layout::read_and_validate(&source_layout)?;
        Some(
            serde_json::to_vec(&definition)
                .map_err(|error| format!("Could not serialize layout: {error}"))?,
        )
    } else {
        None
    };
    write_atomic(storage, &package, layout_bytes.as_deref())?;
    Ok(package.manifest)
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
        if let Ok(package) = read_package(&path.join(MANAGED_THEME_FILE)) {
            if path.file_name().and_then(|value| value.to_str()) == Some(&package.manifest.id) {
                themes.push(package.manifest);
            }
        }
    }
    themes.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
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
    crate::layout::resolve(custom_layout.as_deref(), package.manifest.layout.as_deref())
}

pub fn uninstall(storage: &Path, id: &str) -> Result<bool, String> {
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
        assert!(install(&storage, &source).is_err());
        package.manifest.layout_file = Some("../escape.layout.json".to_owned());
        assert!(validate_package(&package).is_err());
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
