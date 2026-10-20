//! Discover an existing interpreter without installing Python or changing PATH.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

const PROBE: &str = r#"
import json, platform, struct, sys, sysconfig
try:
    import venv, ensurepip
    ensurepip.version()
    has_venv = True
except Exception:
    has_venv = False
print(json.dumps(dict(executable=sys.executable, version=list(sys.version_info[:3]),
    bits=struct.calcsize('P') * 8, platform=sysconfig.get_platform(),
    implementation=platform.python_implementation(), venv=has_venv)))
"#;

#[derive(Debug, Deserialize)]
struct Probe {
    executable: PathBuf,
    version: [u32; 3],
    bits: u32,
    platform: String,
    implementation: String,
    venv: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Python {
    pub executable: PathBuf,
    pub version: String,
    pub bits: u32,
}

pub fn requirement(desktop: bool) -> &'static str {
    if desktop {
        "Windows CPython 3.10–3.12 (x64), with venv/ensurepip"
    } else {
        "Python 3.10+, with venv/ensurepip"
    }
}

fn parse(bytes: &[u8], desktop: bool) -> Result<Python, String> {
    let p: Probe =
        serde_json::from_slice(bytes).map_err(|_| "Python probe returned invalid output")?;
    if !p.executable.is_absolute() || !p.executable.is_file() {
        return Err("Python did not report an existing absolute executable path".into());
    }
    let version = format!("{}.{}.{}", p.version[0], p.version[1], p.version[2]);
    if p.version[0] != 3
        || p.version[1] < 10
        || !p.venv
        || (desktop
            && (p.version[1] > 12
                || p.bits != 64
                || p.platform != "win-amd64"
                || p.implementation != "CPython"))
    {
        return Err(format!(
            "Python {version} / {} / {}-bit is incompatible. Required: {}. An existing working runtime has not been changed.",
            p.platform,
            p.bits,
            requirement(desktop)
        ));
    }
    Ok(Python {
        executable: p.executable,
        version,
        bits: p.bits,
    })
}

async fn probe(path: &Path, args: &[&str], desktop: bool) -> Result<Python, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .args(["-I", "-c", PROBE])
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHON_MANAGER_AUTOMATIC_INSTALL", "false")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::process::hide_console_window(&mut command);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "Python detection timed out")?
        .map_err(|e| format!("Cannot run Python: {e}"))?;
    if !output.status.success() {
        return Err("Python could not run the compatibility check".into());
    }
    parse(&output.stdout, desktop)
}

pub async fn inspect(path: &Path, desktop: bool) -> Result<Python, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err(format!(
            "Choose an existing python.exe using its absolute path. Required: {}",
            requirement(desktop)
        ));
    }
    probe(path, &[], desktop).await
}

pub async fn detect(managed: Option<&Path>, desktop: bool) -> Option<Python> {
    if desktop && !cfg!(windows) {
        return None;
    }
    if let Some(path) = managed
        && let Ok(p) = inspect(path, desktop).await
    {
        return Some(p);
    }
    let mut seen = HashSet::new();
    for path in installed_paths() {
        let key = if cfg!(windows) {
            path.to_string_lossy().to_lowercase()
        } else {
            path.to_string_lossy().into_owned()
        };
        if seen.insert(key)
            && let Ok(p) = inspect(&path, desktop).await
        {
            return Some(p);
        }
    }
    // The launcher's default may be 3.13+ or 32-bit; ask for each supported
    // desktop version explicitly. Disallow automatic installs in new launchers.
    let launchers = if desktop {
        vec!["-3.12", "-3.11", "-3.10", "-3"]
    } else {
        vec!["-3", "-3.12", "-3.11", "-3.10"]
    };
    #[cfg(windows)]
    for launcher in on_path("py") {
        for arg in &launchers {
            if let Ok(p) = probe(&launcher, &[arg], desktop).await {
                return Some(p);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = launchers;
    for name in ["python", "python3"] {
        for path in on_path(name) {
            if let Ok(p) = probe(&path, &[], desktop).await {
                return Some(p);
            }
        }
    }
    None
}

fn on_path(name: &str) -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .filter(|dir| dir.is_absolute())
                // Windows Store aliases may open the Store instead of a Python process.
                .filter(|dir| {
                    !cfg!(windows)
                        || !dir
                            .to_string_lossy()
                            .to_lowercase()
                            .contains("\\microsoft\\windowsapps")
                })
                .map(|dir| {
                    dir.join(if cfg!(windows) {
                        format!("{name}.exe")
                    } else {
                        name.into()
                    })
                })
                .filter(|path| path.is_file())
                .collect()
        })
        .unwrap_or_default()
}

fn installed_paths() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut paths = registry::interpreters();
        // Covers a normal per-user install even when its optional launcher,
        // PATH entries, and registry registration were omitted.
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            for version in ["312", "311", "310"] {
                paths.push(
                    PathBuf::from(&local)
                        .join("Programs/Python")
                        .join(format!("Python{version}/python.exe")),
                );
            }
        }
        for base in ["ProgramW6432", "ProgramFiles"] {
            if let Some(dir) = std::env::var_os(base) {
                for version in ["312", "311", "310"] {
                    paths.push(PathBuf::from(&dir).join(format!("Python{version}/python.exe")));
                }
            }
        }
        paths
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
mod registry {
    use super::*;
    use windows::{
        Win32::System::Registry::*,
        core::{PCWSTR, PWSTR},
    };

    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn open(parent: HKEY, name: &str, view: REG_SAM_FLAGS) -> Option<Key> {
        let mut handle = HKEY::default();
        let name = wide(name);
        if unsafe {
            RegOpenKeyExW(
                parent,
                PCWSTR(name.as_ptr()),
                None,
                KEY_READ | view,
                &mut handle,
            )
            .is_ok()
        } {
            Some(Key(handle))
        } else {
            None
        }
    }
    fn children(key: &Key) -> Vec<String> {
        let mut names = Vec::new();
        for i in 0..512 {
            let mut buf = [0u16; 256];
            let mut len = buf.len() as u32;
            let result = unsafe {
                RegEnumKeyExW(
                    key.0,
                    i,
                    Some(PWSTR(buf.as_mut_ptr())),
                    &mut len,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if result.is_err() {
                break;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        names
    }
    fn value(key: &Key, name: &str) -> Option<String> {
        let name = wide(name);
        let mut kind = REG_VALUE_TYPE::default();
        let mut bytes = 0;
        unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name.as_ptr()),
                None,
                Some(&mut kind),
                None,
                Some(&mut bytes),
            )
            .ok()
            .ok()?;
        }
        if kind != REG_SZ || !(2..=65536).contains(&bytes) {
            return None;
        }
        let mut buf = vec![0u16; (bytes as usize).div_ceil(2)];
        unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name.as_ptr()),
                None,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut bytes),
            )
            .ok()
            .ok()?;
        }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        String::from_utf16(&buf[..end])
            .ok()
            .filter(|s| !s.is_empty())
    }
    pub fn interpreters() -> Vec<PathBuf> {
        let mut paths = Vec::new();
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                let Some(root) = open(hive, "Software\\Python", view) else {
                    continue;
                };
                for company in children(&root) {
                    let Some(company) = open(root.0, &company, view) else {
                        continue;
                    };
                    let mut versions = children(&company);
                    versions.sort_by(|a, b| b.cmp(a));
                    for version in versions {
                        let Some(install) =
                            open(company.0, &format!("{version}\\InstallPath"), view)
                        else {
                            continue;
                        };
                        if let Some(exe) = value(&install, "ExecutablePath") {
                            paths.push(PathBuf::from(exe));
                        }
                        if let Some(dir) = value(&install, "") {
                            paths.push(PathBuf::from(dir).join("python.exe"));
                        }
                    }
                }
            }
        }
        paths
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> serde_json::Value {
        serde_json::json!({ "executable": std::env::current_exe().unwrap(), "version": [3,12,8], "bits":64, "platform":"win-amd64", "implementation":"CPython", "venv":true })
    }
    fn parse_value(value: &serde_json::Value, desktop: bool) -> Result<Python, String> {
        parse(&serde_json::to_vec(value).unwrap(), desktop)
    }
    #[test]
    fn desktop_accepts_only_supported_cpython_windows_x64_with_venv() {
        let mut v = fixture();
        for minor in [10, 11, 12] {
            v["version"] = serde_json::json!([3, minor, 1]);
            assert!(parse_value(&v, true).is_ok());
        }
        for (key, value) in [
            ("version", serde_json::json!([3, 13, 0])),
            ("version", serde_json::json!([3, 9, 9])),
            ("bits", serde_json::json!(32)),
            ("platform", serde_json::json!("win-arm64")),
            ("implementation", serde_json::json!("PyPy")),
            ("venv", serde_json::json!(false)),
        ] {
            let mut v = fixture();
            v[key] = value;
            assert!(parse_value(&v, true).is_err(), "{key}");
        }
    }
    #[test]
    fn official_runtime_allows_newer_python_but_still_requires_venv() {
        let mut v = fixture();
        v["version"] = serde_json::json!([3, 14, 0]);
        v["platform"] = serde_json::json!("linux-x86_64");
        assert!(parse_value(&v, false).is_ok());
        v["venv"] = serde_json::json!(false);
        assert!(parse_value(&v, false).is_err());
    }
    #[test]
    fn launcher_commands_relative_and_missing_executables_are_not_interpreters() {
        for path in [
            "py -3",
            "python.exe",
            "C:/missing-levelup-python-qa/python.exe",
        ] {
            let mut v = fixture();
            v["executable"] = serde_json::json!(path);
            assert!(parse_value(&v, false).is_err());
        }
        assert!(parse(b"Python 3.12", true).is_err());
    }
}
