use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;

const PILLOW_REQUIREMENT: &str = "Pillow>=10,<13";
const PROBE: &str = r#"
import io, json, sys
result = {"executable": sys.executable, "version": list(sys.version_info[:2]), "ready": False}
if sys.version_info >= (3, 10):
    try:
        from PIL import Image, ImageDraw, ImageFont
        image = Image.new("RGBA", (2, 2), (0, 0, 0, 0))
        ImageDraw.Draw(image).point((0, 0), fill="red")
        image.resize((4, 4), Image.Resampling.LANCZOS)
        data = io.BytesIO()
        image.save(data, format="WEBP", lossless=True)
        data.seek(0)
        Image.open(data).load()
        result["ready"] = True
    except Exception as error:
        result["error"] = str(error)
print(json.dumps(result))
"#;

#[derive(Debug, Deserialize)]
pub(crate) struct PythonProbe {
    pub executable: PathBuf,
    version: [u32; 2],
    pub ready: bool,
    pub error: Option<String>,
}

pub(crate) struct HatchPythonRuntime {
    directory: PathBuf,
    install_lock: tokio::sync::Mutex<()>,
}

impl HatchPythonRuntime {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            install_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn inspect(&self) -> Option<PythonProbe> {
        let managed = venv_python(&self.directory);
        let candidates = [
            (managed.as_path(), &[][..]),
            (Path::new("python"), &[][..]),
            #[cfg(not(windows))]
            (Path::new("python3"), &[][..]),
            #[cfg(windows)]
            (Path::new("py"), &["-3"][..]),
        ];
        select_python(
            candidates
                .into_iter()
                .filter_map(|(path, args)| probe_python(path, args)),
        )
    }

    pub async fn prepare(&self) -> Result<(), String> {
        let _guard = self.install_lock.lock().await;
        let python = self.inspect().ok_or_else(|| {
            "Python 3.10 or newer is required for pet hatching. Install Python and restart LevelUpAgent."
                .to_owned()
        })?;
        if python.ready {
            return Ok(());
        }
        self.install(&python.executable).await
    }

    async fn install(&self, base_python: &Path) -> Result<(), String> {
        std::fs::create_dir_all(&self.directory)
            .map_err(|error| format!("Could not create pet Python environment: {error}"))?;
        crate::filesystem::restrict_directory(&self.directory)?;
        let python = venv_python(&self.directory);
        if probe_python(&python, &[]).is_none() {
            let mut command = tokio::process::Command::new(base_python);
            command.args(["-m", "venv"]).arg(&self.directory);
            setup_command(command, "Create pet Python environment").await?;
        }
        let mut command = tokio::process::Command::new(&python);
        command.args(["-m", "ensurepip", "--upgrade"]);
        setup_command(command, "Prepare pet dependency installer").await?;
        let mut command = tokio::process::Command::new(&python);
        command.args([
            "-m",
            "pip",
            "--isolated",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--only-binary=:all:",
            "--timeout",
            "30",
            "--retries",
            "1",
            "--upgrade",
            PILLOW_REQUIREMENT,
        ]);
        setup_command(command, "Install pet image dependencies (Pillow)").await?;
        if !probe_python(&python, &[]).is_some_and(|probe| probe.ready) {
            return Err("Pet Python environment still cannot load Pillow with WebP support after installation.".to_owned());
        }
        Ok(())
    }
}

pub(crate) async fn run_script(
    python: &Path,
    script: &Path,
    arguments: &[String],
    workdir: &Path,
) -> Result<std::process::Output, String> {
    let mut command = tokio::process::Command::new(python);
    command.arg(script).args(arguments).current_dir(workdir);
    command
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
    command.stdin(Stdio::null()).kill_on_drop(true);
    crate::process::hide_console_window(&mut command);
    tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| "Pet script timed out after 120 seconds".to_owned())?
        .map_err(|error| format!("Could not start pet script: {error}"))
}

fn venv_python(directory: &Path) -> PathBuf {
    if cfg!(windows) {
        directory.join("Scripts").join("python.exe")
    } else {
        directory.join("bin").join("python")
    }
}

fn select_python(candidates: impl IntoIterator<Item = PythonProbe>) -> Option<PythonProbe> {
    let mut fallback = None;
    for candidate in candidates {
        if candidate.ready {
            return Some(candidate);
        }
        if fallback.is_none() {
            fallback = Some(candidate);
        }
    }
    fallback
}

fn parse_probe(bytes: &[u8]) -> Option<PythonProbe> {
    let probe: PythonProbe = serde_json::from_slice(bytes).ok()?;
    (probe.version[0] == 3 && probe.version[1] >= 10 && probe.executable.is_absolute())
        .then_some(probe)
}

fn probe_python(executable: &Path, arguments: &[&str]) -> Option<PythonProbe> {
    let mut command = Command::new(executable);
    command.args(arguments).args(["-c", PROBE]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::process::hide_console_window_std(&mut command);
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return parse_probe(&child.wait_with_output().ok()?.stdout);
            }
            Ok(Some(_)) => return None,
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

async fn setup_command(mut command: tokio::process::Command, step: &str) -> Result<(), String> {
    crate::process::hide_console_window(&mut command);
    command.stdin(Stdio::null()).kill_on_drop(true);
    command
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
    let output = tokio::time::timeout(Duration::from_secs(180), command.output())
        .await
        .map_err(|_| {
            format!("{step} timed out. Check your network connection and retry hatching.")
        })?
        .map_err(|error| format!("{step} failed: {error}"))?;
    if !output.status.success() {
        let detail = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        return Err(format!(
            "{step} failed. Check Python's venv/pip support and your network connection, then retry hatching.\n{}",
            detail.trim().chars().take(2_000).collect::<String>()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(version: [u32; 2], ready: bool) -> serde_json::Value {
        serde_json::json!({
            "executable": std::env::temp_dir().join("Python with spaces").join("python.exe"),
            "version": version,
            "ready": ready,
            "error": if ready { None } else { Some("No module named 'PIL'") },
        })
    }

    fn parsed(version: [u32; 2], ready: bool) -> Option<PythonProbe> {
        parse_probe(&serde_json::to_vec(&result(version, ready)).unwrap())
    }

    #[test]
    fn missing_pillow_is_a_repairable_python_not_a_ready_runtime() {
        let probe = parsed([3, 10], false).unwrap();
        assert!(!probe.ready);
        assert_eq!(probe.error.as_deref(), Some("No module named 'PIL'"));
        assert!(probe.executable.is_absolute());
    }

    #[test]
    fn unsupported_python_and_launcher_aliases_are_rejected() {
        assert!(parsed([3, 9], true).is_none());
        assert!(parsed([2, 7], true).is_none());
        let mut value = result([3, 12], true);
        value["executable"] = serde_json::json!("py -3");
        assert!(parse_probe(&serde_json::to_vec(&value).unwrap()).is_none());
        assert!(parse_probe(b"Python 3.12").is_none());
    }

    #[test]
    fn detection_prefers_a_ready_interpreter_and_preserves_a_repair_candidate() {
        let selected = select_python([
            parsed([3, 10], false).unwrap(),
            parsed([3, 12], true).unwrap(),
        ])
        .unwrap();
        assert_eq!(selected.version, [3, 12]);
        assert!(selected.ready);
        assert!(
            !select_python([parsed([3, 10], false).unwrap()])
                .unwrap()
                .ready
        );
        assert!(select_python([]).is_none());
    }

    #[tokio::test]
    #[ignore = "Requires Python 3.10+ and network access to install Pillow in a temporary venv"]
    async fn clean_environment_installs_pillow_and_prepares_a_real_hatch_run() {
        let root =
            std::env::temp_dir().join(format!("levelup-hatch-python-{}", uuid::Uuid::new_v4()));
        let app_data = root.join("app with spaces");
        let runtime = HatchPythonRuntime::new(app_data.join("pet-python"));
        let base = runtime.inspect().expect("Python 3.10+ must be installed");
        std::fs::create_dir_all(&root).unwrap();
        let mut command = tokio::process::Command::new(&base.executable);
        command.args(["-m", "venv"]).arg(&runtime.directory);
        setup_command(command, "Create clean test environment")
            .await
            .unwrap();
        let python = venv_python(&runtime.directory);
        let clean = probe_python(&python, &[]).unwrap();
        assert!(!clean.ready);
        assert!(clean.error.unwrap().contains("PIL"));

        let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills");
        let scripts = skills.join("hatch-pet/scripts");
        let workdir = app_data.join("pet-hatch");
        std::fs::create_dir_all(&workdir).unwrap();
        let run = workdir.join("hatch run");
        let prepare = scripts.join("prepare_pet_run.py");
        let output = run_script(
            &python,
            &prepare,
            &["--output-dir".to_owned(), run.display().to_string()],
            &workdir,
        )
        .await
        .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("No module named 'PIL'"));

        runtime.install(&base.executable).await.unwrap();
        let configured = runtime.inspect().unwrap();
        assert!(configured.ready);
        assert_eq!(configured.executable, python);
        runtime.prepare().await.unwrap();

        let manager =
            crate::pet::PetManager::open_with_skills(&app_data, &root.join("home"), Some(&skills))
                .unwrap();
        assert!(manager.hatch_environment().configured);
        let mut request: crate::models::ToolExecutionRequest = serde_json::from_value(serde_json::json!({
            "name": "run_command", "workspace": workdir, "hatch": true, "hatchBootstrap": true,
            "arguments": {
                "command": format!("& '{}' '{}' --pet-name 'Runtime Test' --output-dir '{}'",
                    root.join("missing interpreter/python.exe").display(), prepare.display(), run.display()),
                "hatchBootstrap": {"kind": "prepare", "scriptPath": prepare, "runDirectory": run}
            }
        })).unwrap();
        assert!(crate::bundled_hatch_bootstrap_call_allowed(
            &request, &manager
        ));
        let response = crate::execute_hatch_command(&request, &manager)
            .await
            .unwrap();
        assert!(!response.is_error, "{}", response.output);
        assert!(response.output.contains("\"ok\": true"));
        assert!(run.join("imagegen-jobs.json").is_file());

        request.arguments["command"] = serde_json::json!(format!(
            "python '{}' --run-dir '{}'",
            scripts.join("pet_job_status.py").display(),
            run.display()
        ));
        assert!(
            !crate::execute_hatch_command(&request, &manager)
                .await
                .unwrap()
                .is_error
        );
        request.arguments["command"] = serde_json::json!(format!(
            "python '{}' --run-dir '{}'",
            scripts.join("pet_job_status.py").display(),
            workdir.join("missing-run").display()
        ));
        assert!(
            crate::execute_hatch_command(&request, &manager)
                .await
                .unwrap()
                .is_error
        );
        for entry in std::fs::read_dir(&scripts).unwrap().flatten() {
            if entry.path().extension().is_some_and(|ext| ext == "py") {
                let output = tokio::process::Command::new(&python)
                    .arg(entry.path())
                    .arg("--help")
                    .output()
                    .await
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}: {}",
                    entry.path().display(),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
