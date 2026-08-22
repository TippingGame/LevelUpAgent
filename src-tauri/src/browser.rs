//! Isolated local Chrome/CDP sessions for Agent-driven app verification.
//!
//! A session owns a temporary Chrome profile and a loopback-only debugging
//! port.  The Agent receives a small, deterministic action vocabulary (open,
//! navigate, wait, snapshot, click, type, assert, screenshot, viewport, close) instead of a
//! raw shell command or the user's existing browser profile.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::{Value, json};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use crate::filesystem;
use crate::process::hide_console_window;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const ACTION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 8;
const MAX_SNAPSHOT_CHARS: usize = 80_000;
const MAX_EVAL_CHARS: usize = 16_000;
const MAX_INPUT_CHARS: usize = 64_000;
const MAX_SCREENSHOT_BYTES: usize = 16 * 1024 * 1024;

struct BrowserSession {
    id: String,
    port: u16,
    ws_url: Mutex<String>,
    profile_dir: PathBuf,
    allowed_domains: Vec<String>,
    workspace: Option<PathBuf>,
    child: Mutex<Option<Child>>,
}

#[derive(Default)]
pub struct BrowserManager {
    sessions: Mutex<HashMap<String, Arc<BrowserSession>>>,
}

impl BrowserManager {
    pub async fn start(
        &self,
        app_data: &Path,
        initial_url: Option<&str>,
        allowed_domains: Vec<String>,
        workspace: Option<&Path>,
    ) -> Result<String, String> {
        if self.sessions.lock().await.len() >= MAX_SESSIONS {
            return Err(format!(
                "At most {MAX_SESSIONS} isolated browser sessions may be active"
            ));
        }
        if let Some(url) = initial_url {
            validate_browser_url(url, &allowed_domains, workspace)?;
        }
        let executable = browser_executable()?;
        let root = app_data.join("browser").join("sessions");
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create browser session directory: {error}"))?;
        filesystem::restrict_directory(&root)?;
        let id = uuid::Uuid::new_v4().to_string();
        let profile_dir = root.join(&id);
        std::fs::create_dir_all(&profile_dir)
            .map_err(|error| format!("Could not create isolated browser profile: {error}"))?;
        filesystem::restrict_directory(&profile_dir)?;
        let port = free_loopback_port()?;
        let mut command = Command::new(executable);
        command.args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-extensions",
            "--disable-popup-blocking",
            "--remote-allow-origins=*",
            "--remote-debugging-address=127.0.0.1",
        ]);
        command.arg(format!("--remote-debugging-port={port}"));
        command.arg(format!("--user-data-dir={}", profile_dir.display()));
        command.arg("--window-size=1440,1000");
        command.arg(initial_url.unwrap_or("about:blank"));
        hide_console_window(&mut command);
        command.kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&profile_dir);
                return Err(format!(
                    "Could not launch Chrome for browser testing: {error}"
                ));
            }
        };
        let client = match Client::builder().timeout(CONNECT_TIMEOUT).build() {
            Ok(client) => client,
            Err(error) => {
                let _ = tokio::time::timeout(Duration::from_secs(5), child.kill()).await;
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                let _ = std::fs::remove_dir_all(&profile_dir);
                return Err(format!("Could not build browser control client: {error}"));
            }
        };
        let ws_url = match wait_for_page(&client, port).await {
            Ok(url) => url,
            Err(error) => {
                let _ = tokio::time::timeout(Duration::from_secs(5), child.kill()).await;
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                let _ = std::fs::remove_dir_all(&profile_dir);
                return Err(error);
            }
        };
        let session = Arc::new(BrowserSession {
            id: id.clone(),
            port,
            ws_url: Mutex::new(ws_url),
            profile_dir,
            allowed_domains,
            workspace: workspace.map(Path::to_path_buf),
            child: Mutex::new(Some(child)),
        });
        self.sessions
            .lock()
            .await
            .insert(id.clone(), session.clone());
        // Enable the domains once so navigation/screenshot commands behave
        // consistently on the first action.
        let _ = self.command(&session, "Page.enable", json!({})).await;
        let _ = self.command(&session, "Runtime.enable", json!({})).await;
        let _ = self
            .command(
                &session,
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": CONSOLE_CAPTURE_SCRIPT}),
            )
            .await;
        if let Some(url) = initial_url
            && let Err(error) = self.navigate_session(&session, url).await
        {
            let _ = self.close(&id).await;
            return Err(error);
        }
        let _ = self.install_console_capture(&session).await;
        Ok(id)
    }

    pub async fn list(&self) -> Vec<Value> {
        let sessions = self.sessions.lock().await;
        sessions
            .values()
            .map(|session| {
                json!({
                    "id": session.id,
                    "port": session.port,
                    "profile": session.profile_dir,
                    "allowedDomains": session.allowed_domains,
                })
            })
            .collect()
    }

    pub async fn close(&self, id: &str) -> Result<bool, String> {
        let session = self.sessions.lock().await.remove(id);
        let Some(session) = session else {
            return Ok(false);
        };
        if let Some(mut child) = session.child.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), child.kill()).await;
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
        let _ = std::fs::remove_dir_all(&session.profile_dir);
        Ok(true)
    }

    /// Available for host shutdown hooks and test harnesses.
    pub async fn close_all(&self) {
        let ids = self
            .sessions
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.close(&id).await;
        }
    }

    pub async fn navigate(&self, id: &str, url: &str) -> Result<String, String> {
        let session = self.session(id).await?;
        self.navigate_session(&session, url).await
    }

    pub async fn wait(&self, id: &str, milliseconds: u64) -> Result<String, String> {
        let _ = self.session(id).await?;
        let milliseconds = milliseconds.clamp(50, 30_000);
        tokio::time::sleep(Duration::from_millis(milliseconds)).await;
        Ok(format!("Waited {milliseconds} ms"))
    }

    pub async fn set_viewport(
        &self,
        id: &str,
        width: u64,
        height: u64,
        mobile: bool,
    ) -> Result<String, String> {
        let (width, height) = validate_viewport(width, height)?;
        let session = self.session(id).await?;
        self.command(
            &session,
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": width,
                "height": height,
                "deviceScaleFactor": 1,
                "mobile": mobile,
                "screenWidth": width,
                "screenHeight": height
            }),
        )
        .await?;
        Ok(format!("Browser viewport set to {width}x{height}"))
    }

    pub async fn snapshot(&self, id: &str) -> Result<String, String> {
        let session = self.session(id).await?;
        let value = self.evaluate(&session, SNAPSHOT_SCRIPT).await?;
        let result = value
            .get("value")
            .cloned()
            .unwrap_or_else(|| json!({"url":"", "title":"", "text":""}));
        let serialized = serde_json::to_string_pretty(&result)
            .map_err(|error| format!("Could not encode browser snapshot: {error}"))?;
        Ok(format!(
            "[UNTRUSTED BROWSER PAGE]\n{}\n[END UNTRUSTED BROWSER PAGE]",
            truncate(&serialized, MAX_SNAPSHOT_CHARS)
        ))
    }

    pub async fn console(&self, id: &str) -> Result<String, String> {
        let session = self.session(id).await?;
        self.install_console_capture(&session).await?;
        let value = self
            .evaluate(
                &session,
                "JSON.stringify(window.__levelupAgentConsole || [])",
            )
            .await?;
        let serialized = value.get("value").and_then(Value::as_str).unwrap_or("[]");
        let serialized = crate::logging::redact_sensitive(serialized);
        Ok(format!(
            "[UNTRUSTED BROWSER CONSOLE]\n{}\n[END UNTRUSTED BROWSER CONSOLE]",
            truncate(&serialized, MAX_SNAPSHOT_CHARS)
        ))
    }

    pub async fn click(
        &self,
        id: &str,
        selector: Option<&str>,
        text: Option<&str>,
        index: Option<usize>,
    ) -> Result<String, String> {
        let session = self.session(id).await?;
        let selector = serde_json::to_string(selector.unwrap_or("")).unwrap();
        let text = serde_json::to_string(text.unwrap_or("")).unwrap();
        let index = index.unwrap_or(0);
        let script = format!(
            "({{const selector={selector}, text={text}, index={index}; const roots=selector?[...document.querySelectorAll(selector)]:[...document.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button]')]; const matches=roots.filter((el)=>!text || (el.innerText||el.value||el.getAttribute('aria-label')||'').toLowerCase().includes(text.toLowerCase())); const el=matches[index]; if(!el) return {{ok:false,error:'No matching interactive element',count:matches.length}}; el.scrollIntoView({{block:'center',inline:'center'}}); el.click(); return {{ok:true,tag:el.tagName,label:(el.innerText||el.value||el.getAttribute('aria-label')||'').trim().slice(0,300)}};}}}})()"
        );
        let value = self.evaluate(&session, &script).await?;
        let result = value.get("value").cloned().unwrap_or(Value::Null);
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(format!("Browser click failed: {result}"));
        }
        Ok(format!(
            "Clicked {}",
            result
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("element")
        ))
    }

    pub async fn type_text(
        &self,
        id: &str,
        selector: Option<&str>,
        text: &str,
        index: Option<usize>,
        submit: bool,
    ) -> Result<String, String> {
        if text.chars().count() > MAX_INPUT_CHARS {
            return Err(format!(
                "Browser input is limited to {MAX_INPUT_CHARS} characters"
            ));
        }
        let session = self.session(id).await?;
        let selector =
            serde_json::to_string(selector.unwrap_or("input,textarea,[contenteditable=true]"))
                .unwrap();
        let text = serde_json::to_string(text).unwrap();
        let index = index.unwrap_or(0);
        let script = format!(
            "({{const selector={selector}, text={text}, index={index}; const els=[...document.querySelectorAll(selector)]; const el=els[index]; if(!el) return {{ok:false,error:'No matching editable element',count:els.length}}; el.focus(); if(el.isContentEditable) el.textContent=text; else {{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set; if(setter) setter.call(el,text); else el.value=text;}} el.dispatchEvent(new InputEvent('input',{{bubbles:true,inputType:'insertText',data:text}})); el.dispatchEvent(new Event('change',{{bubbles:true}})); return {{ok:true,tag:el.tagName}};}}}})()"
        );
        let value = self.evaluate(&session, &script).await?;
        let result = value.get("value").cloned().unwrap_or(Value::Null);
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(format!("Browser type failed: {result}"));
        }
        if submit {
            let _ = self
                .command(
                    &session,
                    "Input.dispatchKeyEvent",
                    json!({"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13}),
                )
                .await?;
            let _ = self
                .command(
                    &session,
                    "Input.dispatchKeyEvent",
                    json!({"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13}),
                )
                .await?;
        }
        Ok("Typed text into the selected element".to_owned())
    }

    pub async fn assert(&self, id: &str, expression: &str) -> Result<String, String> {
        let expression = validate_assertion_expression(expression)?;
        let session = self.session(id).await?;
        let value = self.evaluate_assertion(&session, &expression).await?;
        let passed = value.get("value").and_then(Value::as_bool).unwrap_or(false);
        if passed {
            Ok("Browser assertion passed".to_owned())
        } else {
            Err(format!("Browser assertion failed: {expression}"))
        }
    }

    pub async fn screenshot(&self, app_data: &Path, id: &str) -> Result<String, String> {
        let session = self.session(id).await?;
        let result = self
            .command(
                &session,
                "Page.captureScreenshot",
                json!({"format":"png","captureBeyondViewport":false}),
            )
            .await?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "Browser did not return a screenshot".to_owned())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| format!("Browser screenshot data is invalid: {error}"))?;
        if bytes.len() > MAX_SCREENSHOT_BYTES {
            return Err(format!(
                "Browser screenshot is larger than {} MiB",
                MAX_SCREENSHOT_BYTES / (1024 * 1024)
            ));
        }
        let root = app_data.join("browser").join("screenshots");
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create screenshot directory: {error}"))?;
        filesystem::restrict_directory(&root)?;
        let path = root.join(format!("{}-{}.png", id, uuid::Uuid::new_v4().simple()));
        std::fs::write(&path, bytes)
            .map_err(|error| format!("Could not save browser screenshot: {error}"))?;
        filesystem::restrict_file(&path)?;
        Ok(path.to_string_lossy().into_owned())
    }

    async fn session(&self, id: &str) -> Result<Arc<BrowserSession>, String> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Browser session does not exist: {id}"))
    }

    async fn navigate_session(
        &self,
        session: &Arc<BrowserSession>,
        raw_url: &str,
    ) -> Result<String, String> {
        validate_browser_url(
            raw_url,
            &session.allowed_domains,
            session.workspace.as_deref(),
        )?;
        let result = self
            .command(session, "Page.navigate", json!({"url": raw_url}))
            .await?;
        if let Some(error) = result
            .get("errorText")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Err(format!("Browser navigation failed: {error}"));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        self.install_console_capture(session).await?;
        Ok(format!("Navigated to {raw_url}"))
    }

    async fn install_console_capture(&self, session: &Arc<BrowserSession>) -> Result<(), String> {
        let _ = self.evaluate(session, CONSOLE_CAPTURE_SCRIPT).await?;
        Ok(())
    }

    async fn evaluate(
        &self,
        session: &Arc<BrowserSession>,
        expression: &str,
    ) -> Result<Value, String> {
        let result = self.command(session, "Runtime.evaluate", json!({"expression":expression,"returnByValue":true,"awaitPromise":true,"userGesture":true})).await?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(format!("Browser JavaScript evaluation failed: {exception}"));
        }
        Ok(result.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn evaluate_assertion(
        &self,
        session: &Arc<BrowserSession>,
        expression: &str,
    ) -> Result<Value, String> {
        let script = format!("Boolean(({expression}))");
        let result = self
            .command(
                session,
                "Runtime.evaluate",
                json!({
                    "expression": script,
                    "returnByValue": true,
                    "awaitPromise": false,
                    "userGesture": false,
                    "throwOnSideEffect": true
                }),
            )
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(format!("Browser assertion evaluation failed: {exception}"));
        }
        Ok(result.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn command(
        &self,
        session: &Arc<BrowserSession>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let ws_url = session.ws_url.lock().await.clone();
        let (mut socket, _) = tokio::time::timeout(ACTION_TIMEOUT, connect_async(&ws_url))
            .await
            .map_err(|_| "Browser CDP connection timed out".to_owned())?
            .map_err(|error| format!("Could not connect to browser CDP: {error}"))?;
        // Each command gets a fresh WebSocket, so a small fixed identifier is
        // sufficient. CDP transports IDs through JavaScript-compatible JSON;
        // arbitrary u64 UUID fragments can lose precision before being echoed.
        let id = 1_u64;
        socket
            .send(Message::Text(
                serde_json::to_string(&json!({"id":id,"method":method,"params":params}))
                    .unwrap()
                    .into(),
            ))
            .await
            .map_err(|error| format!("Could not send browser command: {error}"))?;
        let result = tokio::time::timeout(ACTION_TIMEOUT, async {
            while let Some(message) = socket.next().await {
                let message =
                    message.map_err(|error| format!("Browser CDP read failed: {error}"))?;
                match message {
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(&text).map_err(|error| {
                            format!("Browser CDP returned invalid JSON: {error}")
                        })?;
                        if value.get("id").and_then(Value::as_u64) != Some(id) {
                            continue;
                        }
                        if let Some(error) = value.get("error") {
                            return Err(format!("Browser CDP error: {error}"));
                        }
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    Message::Close(_) => return Err("Browser CDP connection closed".to_owned()),
                    _ => {}
                }
            }
            Err("Browser CDP ended without a response".to_owned())
        })
        .await
        .map_err(|_| "Browser action timed out".to_owned())??;
        let _ = socket.close(None).await;
        Ok(result)
    }
}

async fn wait_for_page(client: &Client, port: u16) -> Result<String, String> {
    let endpoint = format!("http://127.0.0.1:{port}/json/list");
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err("Chrome did not expose a CDP page within 20 seconds".to_owned());
        }
        if let Ok(response) = client.get(&endpoint).send().await
            && let Ok(pages) = response.json::<Vec<Value>>().await
            && let Some(url) = pages
                .iter()
                .filter(|page| page.get("type").and_then(Value::as_str) == Some("page"))
                .find_map(|page| page.get("webSocketDebuggerUrl").and_then(Value::as_str))
        {
            return Ok(url.to_owned());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

fn free_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve browser port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not read browser port: {error}"))
}

fn browser_executable() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("LEVELUP_BROWSER_EXECUTABLE") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(windows)]
    {
        let candidates = [
            std::env::var_os("PROGRAMFILES")
                .map(|root| PathBuf::from(root).join("Google/Chrome/Application/chrome.exe")),
            std::env::var_os("PROGRAMFILES(X86)")
                .map(|root| PathBuf::from(root).join("Google/Chrome/Application/chrome.exe")),
            std::env::var_os("LOCALAPPDATA")
                .map(|root| PathBuf::from(root).join("Google/Chrome/Application/chrome.exe")),
            std::env::var_os("PROGRAMFILES")
                .map(|root| PathBuf::from(root).join("Microsoft/Edge/Application/msedge.exe")),
        ];
        if let Some(path) = candidates.into_iter().flatten().find(|path| path.is_file()) {
            return Ok(path);
        }
    }
    #[cfg(not(windows))]
    {
        for name in [
            "google-chrome",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
        ] {
            if let Ok(output) = std::process::Command::new("sh")
                .args(["-lc", &format!("command -v {name}")])
                .output()
                && output.status.success()
            {
                let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
    }
    Err(
        "No Chrome/Chromium executable found. Set LEVELUP_BROWSER_EXECUTABLE to a Chromium path."
            .to_owned(),
    )
}

fn validate_browser_url(
    raw_url: &str,
    allowed_domains: &[String],
    workspace: Option<&Path>,
) -> Result<(), String> {
    let url = Url::parse(raw_url).map_err(|_| "Browser URL must be absolute".to_owned())?;
    if !matches!(url.scheme(), "http" | "https" | "file" | "about") {
        return Err("Browser supports HTTP(S), file, and about URLs".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Browser URLs cannot contain embedded credentials".to_owned());
    }
    if url.scheme() == "file" {
        let path = url
            .to_file_path()
            .map_err(|_| "Browser file URL is invalid".to_owned())?;
        if let Some(workspace) = workspace {
            let workspace =
                std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
            let target = std::fs::canonicalize(&path).unwrap_or(path);
            if !target.starts_with(&workspace) {
                return Err("Browser file URL must stay inside the task workspace".to_owned());
            }
        } else {
            return Err("Browser file URLs require a task workspace".to_owned());
        }
    }
    if !allowed_domains.is_empty() && matches!(url.scheme(), "http" | "https") {
        let host = url.host_str().unwrap_or_default();
        if !allowed_domains
            .iter()
            .any(|pattern| host_matches(host, pattern))
        {
            return Err(format!(
                "Browser URL is outside the session domain allowlist: {host}"
            ));
        }
    }
    Ok(())
}

fn host_matches(host: &str, pattern: &str) -> bool {
    let pattern = pattern.trim().trim_start_matches("*.");
    host.eq_ignore_ascii_case(pattern) || host.ends_with(&format!(".{pattern}"))
}

fn validate_viewport(width: u64, height: u64) -> Result<(u32, u32), String> {
    if !(320..=3_840).contains(&width) || !(240..=2_400).contains(&height) {
        return Err("Browser viewport must be between 320x240 and 3840x2400".to_owned());
    }
    Ok((width as u32, height as u32))
}

fn validate_assertion_expression(expression: &str) -> Result<String, String> {
    let expression = expression.trim();
    if expression.is_empty() || expression.chars().count() > MAX_EVAL_CHARS {
        return Err("browser_assert requires a bounded JavaScript expression".to_owned());
    }
    let lowered = expression.to_ascii_lowercase();
    // Treat whitespace variants such as `fetch (` and `import (` the same as
    // their compact spellings. Assertions are intentionally conservative:
    // rejecting a string literal that happens to contain one of these tokens
    // is preferable to turning the assertion channel into a script runner.
    let compacted = lowered
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    let has_assignment = expression
        .as_bytes()
        .iter()
        .enumerate()
        .any(|(index, value)| {
            *value == b'='
                && !matches!(
                    expression.as_bytes().get(index.wrapping_sub(1)),
                    Some(b'=') | Some(b'!') | Some(b'<') | Some(b'>')
                )
                && !matches!(expression.as_bytes().get(index + 1), Some(b'='))
        });
    if expression.contains(';')
        || expression.contains('`')
        || expression.contains('[')
        || expression.contains(']')
        || has_assignment
        || [
            "fetch(",
            "xmlhttprequest",
            "websocket",
            "eval(",
            "import(",
            "function",
            "=>",
            "constructor",
            "prototype",
            "__proto__",
            "globalthis",
            "document.cookie",
            "document.location",
            "window",
            "location.href",
            "window.open(",
            "alert(",
            "confirm(",
            "prompt(",
            ".click(",
            ".submit(",
            ".focus(",
            ".blur(",
            ".remove(",
            ".append(",
            ".prepend(",
            ".replacewith(",
            ".insertbefore(",
            ".dispatchevent(",
            "requestanimationframe(",
            "setattribute(",
            "setrangetext(",
            "appendchild(",
            "insertadjacent",
            "defineproperty(",
            "setprototypeof(",
            "history.",
            "document.write(",
            "localstorage",
            "sessionstorage",
            "navigator",
            "clipboard",
            "settimeout(",
            "setinterval(",
            "postmessage(",
            "new ",
        ]
        .iter()
        .any(|marker| lowered.contains(marker) || compacted.contains(marker))
    {
        return Err("browser_assert accepts only a side-effect-free expression".to_owned());
    }
    Ok(expression.to_owned())
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.to_owned()
    } else {
        format!(
            "{}\n… browser output truncated",
            value.chars().take(limit).collect::<String>()
        )
    }
}

const SNAPSHOT_SCRIPT: &str = r#"(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 240);
  const interactive = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]')].filter(visible).slice(0, 250).map((el, index) => ({ index, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', label: label(el), type: el.getAttribute('type') || '', href: el.href || '' }));
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 50000), interactive };
})()"#;

const CONSOLE_CAPTURE_SCRIPT: &str = r#"(() => {
  if (Array.isArray(window.__levelupAgentConsole)) return true;
  const entries = [];
  Object.defineProperty(window, '__levelupAgentConsole', { value: entries, configurable: false });
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    console[level] = (...args) => {
      try {
        const text = args.map((value) => {
          if (typeof value === 'string') return value;
          try { return JSON.stringify(value); } catch { return String(value); }
        }).join(' ').slice(0, 2000);
        entries.push({ level, text, timestamp: Date.now() });
        if (entries.length > 200) entries.splice(0, entries.length - 200);
      } catch {}
      return original.apply(console, args);
    };
  }
  return true;
})()"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_allowlist_matches_subdomains() {
        assert!(host_matches("app.example.com", "*.example.com"));
        assert!(!host_matches("example.net", "*.example.com"));
    }

    #[test]
    fn browser_url_rejects_unknown_schemes() {
        assert!(validate_browser_url("javascript:alert(1)", &[], None).is_err());
        assert!(validate_browser_url("https://user:pass@example.com", &[], None).is_err());
        assert!(validate_browser_url("http://127.0.0.1:3000", &[], None).is_ok());
    }

    #[test]
    fn browser_url_enforces_allowlists_and_workspace_file_scope() {
        assert!(
            validate_browser_url(
                "https://app.example.com/dashboard",
                &["example.com".to_owned()],
                None,
            )
            .is_ok()
        );
        assert!(
            validate_browser_url(
                "https://outside.example.net",
                &["example.com".to_owned()],
                None,
            )
            .is_err()
        );

        let root =
            std::env::temp_dir().join(format!("levelup-browser-url-{}", uuid::Uuid::new_v4()));
        let nested = root.join("dist");
        std::fs::create_dir_all(&nested).unwrap();
        let page = nested.join("index.html");
        std::fs::write(&page, "<h1>ready</h1>").unwrap();
        let inside = url::Url::from_file_path(&page).unwrap().to_string();
        assert!(validate_browser_url(&inside, &[], Some(&root)).is_ok());

        let outside =
            std::env::temp_dir().join(format!("levelup-browser-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        let outside_page = outside.join("index.html");
        std::fs::write(&outside_page, "<h1>outside</h1>").unwrap();
        let outside_url = url::Url::from_file_path(&outside_page).unwrap().to_string();
        assert!(validate_browser_url(&outside_url, &[], Some(&root)).is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn browser_assertion_filter_rejects_side_effect_escape_hatches() {
        assert!(validate_assertion_expression("document.title.includes('Ready')").is_ok());
        for expression in [
            "document.body.innerHTML = 'changed'",
            "globalThis['fetch']('https://example.com')",
            "document.querySelector('button').click()",
            "import ('https://example.com/module.js')",
            "document.body.dispatchEvent(new Event('change'))",
            "constructor.constructor('return 1')()",
        ] {
            assert!(
                validate_assertion_expression(expression).is_err(),
                "{expression}"
            );
        }
    }

    #[test]
    fn viewport_bounds_are_explicit() {
        assert_eq!(validate_viewport(1280, 720).unwrap(), (1280, 720));
        assert!(validate_viewport(319, 720).is_err());
        assert!(validate_viewport(1280, 2401).is_err());
    }

    #[tokio::test]
    async fn launches_an_isolated_session_when_chromium_is_available() {
        if browser_executable().is_err() {
            return;
        }
        let root =
            std::env::temp_dir().join(format!("levelup-browser-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let manager = BrowserManager::default();
        let session = manager
            .start(&root, Some("about:blank"), Vec::new(), Some(&root))
            .await
            .unwrap();
        let snapshot = manager.snapshot(&session).await.unwrap();
        assert!(snapshot.contains("UNTRUSTED BROWSER PAGE"));
        assert!(snapshot.contains("about:blank"));
        let session_ref = manager.session(&session).await.unwrap();
        manager
            .evaluate(&session_ref, "console.error('browser-qa-fixture')")
            .await
            .unwrap();
        let console = manager.console(&session).await.unwrap();
        assert!(console.contains("UNTRUSTED BROWSER CONSOLE"));
        assert!(console.contains("browser-qa-fixture"));
        let screenshot = manager.screenshot(&root, &session).await.unwrap();
        assert!(Path::new(&screenshot).is_file());
        std::fs::remove_file(screenshot).unwrap();
        assert!(manager.close(&session).await.unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}
