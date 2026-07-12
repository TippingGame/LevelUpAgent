use std::path::Path;

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let permissions = std::fs::Permissions::from_mode(mode);
    std::fs::set_permissions(path, permissions).map_err(|error| {
        format!(
            "Could not restrict permissions for {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    // Windows files inherit the user's ACL from the application/configuration directory.
    Ok(())
}

pub fn restrict_file(path: &Path) -> Result<(), String> {
    set_mode(path, 0o600)
}

pub fn restrict_directory(path: &Path) -> Result<(), String> {
    set_mode(path, 0o700)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn private_modes_are_applied_to_sensitive_storage() {
        let root =
            std::env::temp_dir().join(format!("levelup-permissions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("secret.bin");
        std::fs::write(&file, "secret").unwrap();
        restrict_directory(&root).unwrap();
        restrict_file(&file).unwrap();
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
