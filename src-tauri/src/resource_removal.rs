//! Delete only desktop-owned resource paths; never follow redirected parents.
use std::{
    fs,
    path::{Component, Path},
};

pub fn remove_owned(base: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(base)
        .map_err(|_| "资源目录超出工作台范围")?;
    if relative.as_os_str().is_empty() {
        return Err("不能移除工作台数据目录".into());
    }
    let mut current = base.to_path_buf();
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err("无效的资源目录".into());
        }
        current.push(part);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        #[cfg(windows)]
        let redirected = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let redirected = metadata.file_type().is_symlink();
        if redirected {
            return Err(format!("资源路径包含链接，未移除：{}", current.display()));
        }
    }
    let result = if current.is_dir() {
        fs::remove_dir_all(&current)
    } else {
        fs::remove_file(&current)
    };
    result.map_err(|e| format!("移除失败（可重试）：{}：{e}", current.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removal_is_scoped_and_retryable() {
        let root = std::env::temp_dir().join(format!("resource-removal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("resources/engine/runtime")).unwrap();
        fs::create_dir_all(root.join("outputs")).unwrap();
        fs::write(root.join("outputs/song.wav"), b"keep").unwrap();
        fs::write(root.join("offline.zip.part001"), b"keep").unwrap();
        remove_owned(&root, &root.join("resources/engine")).unwrap();
        remove_owned(&root, &root.join("resources/engine")).unwrap();
        assert!(remove_owned(&root, &root).is_err());
        assert!(remove_owned(&root, &root.join("../outside")).is_err());
        assert!(root.join("outputs/song.wav").is_file());
        assert!(root.join("offline.zip.part001").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn locked_resource_can_be_removed_after_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!("resource-locked-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("resources/runtime")).unwrap();
        let path = root.join("resources/runtime/in-use.dll");
        fs::write(&path, b"fixture").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(remove_owned(&root, &root.join("resources/runtime")).is_err());
        assert!(path.is_file());
        drop(lock);
        remove_owned(&root, &root.join("resources/runtime")).unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
