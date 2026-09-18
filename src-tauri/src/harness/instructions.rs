//! Bounded project conventions from the explicitly selected workspace.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Read;
use std::path::Path;

const MAX_INSTRUCTION_BYTES: usize = 32 * 1024;

pub struct ProjectInstructions {
    pub source: String,
    pub content: String,
    pub fingerprint: String,
}

pub fn load(workspace: &Path) -> Result<Option<ProjectInstructions>, String> {
    let root = std::fs::canonicalize(workspace)
        .map_err(|error| format!("Could not resolve project instructions workspace: {error}"))?;
    for name in ["AGENTS.override.md", "AGENTS.md"] {
        let path = root.join(name);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not inspect {name}: {error}")),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || std::fs::canonicalize(&path)
                .map_err(|error| error.to_string())?
                .parent()
                != Some(root.as_path())
        {
            return Err(format!(
                "{name} must be a regular file inside the selected workspace"
            ));
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&path)
            .map_err(|error| format!("Could not open {name}: {error}"))?
            .take((MAX_INSTRUCTION_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Could not read {name}: {error}"))?;
        if bytes.len() > MAX_INSTRUCTION_BYTES {
            return Err(format!(
                "{name} exceeds the 32 KiB project instruction limit"
            ));
        }
        let content = std::str::from_utf8(&bytes)
            .map_err(|_| format!("{name} must contain UTF-8 text"))?
            .trim_start_matches('\u{feff}')
            .to_owned();
        if content.trim().is_empty() {
            continue;
        }
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        return Ok(Some(ProjectInstructions {
            source: path.to_string_lossy().into_owned(),
            content,
            fingerprint: format!("{:016x}", hasher.finish()),
        }));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_instructions_have_deterministic_precedence_and_provenance() {
        let root =
            std::env::temp_dir().join(format!("levelup-instructions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("AGENTS.md"), "Repository rules").unwrap();
        assert!(load(&root.join("nested")).unwrap().is_none());
        let original = load(&root).unwrap().unwrap();
        assert_eq!(original.content, "Repository rules");
        assert!(original.source.ends_with("AGENTS.md"));
        std::fs::write(root.join("AGENTS.override.md"), "\u{feff}Specific rules").unwrap();
        let overridden = load(&root).unwrap().unwrap();
        assert_eq!(overridden.content, "Specific rules");
        assert_ne!(overridden.fingerprint, original.fingerprint);
        std::fs::write(root.join("AGENTS.override.md"), " \n").unwrap();
        assert_eq!(
            load(&root).unwrap().unwrap().fingerprint,
            original.fingerprint
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_instructions_reject_invalid_or_oversized_files() {
        let root =
            std::env::temp_dir().join(format!("levelup-instructions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("AGENTS.md"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(load(&root).err().unwrap().contains("UTF-8"));
        std::fs::write(
            root.join("AGENTS.md"),
            vec![b'x'; MAX_INSTRUCTION_BYTES + 1],
        )
        .unwrap();
        assert!(load(&root).err().unwrap().contains("32 KiB"));
        std::fs::remove_file(root.join("AGENTS.md")).unwrap();
        std::fs::create_dir(root.join("AGENTS.md")).unwrap();
        assert!(load(&root).err().unwrap().contains("regular file"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
