use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_THEME_PACKAGE_BYTES: u64 = 12 * 1024 * 1024;
const MAX_THEME_CSS_BYTES: usize = 10 * 1024 * 1024;
const THEME_EXTENSION: &str = "levelup-theme";

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
    if value.is_empty()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "Theme {label} must contain 1 to {maximum} printable characters"
        ));
    }
    Ok(())
}

fn validate_package(package: &ThemePackage) -> Result<(), String> {
    if package.manifest.schema_version != 1 {
        return Err("Unsupported theme package schema; expected schemaVersion 1".to_owned());
    }
    validate_id(&package.manifest.id)?;
    validate_text(&package.manifest.name, "name", 80)?;
    validate_text(&package.manifest.version, "version", 32)?;
    validate_text(&package.manifest.author, "author", 100)?;
    validate_text(&package.manifest.description, "description", 500)?;
    if package
        .manifest
        .layout
        .as_deref()
        .is_some_and(|layout| !matches!(layout, "standard" | "qq2007"))
    {
        return Err("Theme layout must be standard or qq2007".to_owned());
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
            return Err(format!("Theme CSS contains a forbidden construct: {forbidden}"));
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

fn package_path(storage: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(storage.join(format!("{id}.{THEME_EXTENSION}")))
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
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Could not read theme package: {error}"))?;
    let package: ThemePackage = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Theme package is not valid UTF-8 JSON: {error}"))?;
    validate_package(&package)?;
    Ok(package)
}

fn write_atomic(storage: &Path, package: &ThemePackage) -> Result<(), String> {
    std::fs::create_dir_all(storage)
        .map_err(|error| format!("Could not create theme storage: {error}"))?;
    crate::filesystem::restrict_directory(storage)?;
    let destination = package_path(storage, &package.manifest.id)?;
    let temporary = storage.join(format!(
        ".{}.{}.tmp",
        package.manifest.id,
        uuid::Uuid::new_v4().simple()
    ));
    let bytes = serde_json::to_vec(package)
        .map_err(|error| format!("Could not serialize theme package: {error}"))?;
    let mut file = std::fs::File::create(&temporary)
        .map_err(|error| format!("Could not stage theme package: {error}"))?;
    crate::filesystem::restrict_file(&temporary)?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Could not stage theme package: {error}"));
    }
    let backup = storage.join(format!(
        ".{}.{}.backup",
        package.manifest.id,
        uuid::Uuid::new_v4().simple()
    ));
    let had_previous = match std::fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
        Ok(_) => {
            let _ = std::fs::remove_file(&temporary);
            return Err("Installed theme path is not a regular file".to_owned());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("Could not inspect the existing theme: {error}"));
        }
    };
    if had_previous {
        if let Err(error) = std::fs::rename(&destination, &backup) {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "Could not stage the existing theme for replacement: {error}"
            ));
        }
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        if had_previous {
            let _ = std::fs::rename(&backup, &destination);
        }
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Could not install theme package: {error}"));
    }
    if had_previous {
        let _ = std::fs::remove_file(backup);
    }
    crate::filesystem::restrict_file(&destination)
}

pub fn install(storage: &Path, source: &Path) -> Result<ThemeManifest, String> {
    if source.extension().and_then(|value| value.to_str()) != Some(THEME_EXTENSION) {
        return Err("Select a .levelup-theme package".to_owned());
    }
    let package = read_package(source)?;
    write_atomic(storage, &package)?;
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
        if path.extension().and_then(|value| value.to_str()) != Some(THEME_EXTENSION) {
            continue;
        }
        if let Ok(package) = read_package(&path) {
            themes.push(package.manifest);
        }
    }
    themes.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(themes)
}

pub fn load(storage: &Path, id: &str) -> Result<ThemePackage, String> {
    read_package(&package_path(storage, id)?)
}

pub fn uninstall(storage: &Path, id: &str) -> Result<bool, String> {
    let path = package_path(storage, id)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not uninstall theme: {error}")),
    }
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
        assert_eq!(list(&storage).unwrap().len(), 1);
        assert!(load(&storage, "qq-2007").unwrap().css.contains("--accent"));
        let mut updated = sample();
        updated.manifest.version = "1.1.0".to_owned();
        std::fs::write(&source, serde_json::to_vec(&updated).unwrap()).unwrap();
        assert_eq!(install(&storage, &source).unwrap().version, "1.1.0");
        assert_eq!(
            load(&storage, "qq-2007").unwrap().manifest.version,
            "1.1.0"
        );
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
}
