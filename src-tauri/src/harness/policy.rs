//! Host-side tool policy. The risk taxonomy mirrors the separation used by
//! grok-build's workspace/tools crates, while the before/after decision shape
//! follows pi's tool preflight hooks.

use crate::models::ToolCall;

use super::types::{HarnessMode, PermissionLevel, PolicyDecision, ToolRisk};

pub fn classify_tool(name: &str) -> ToolRisk {
    match name {
        "list_files" | "read_file" | "search_files" | "get_goal" | "read_skill"
        | "check_media_jobs" | "update_goal" | "skill_locations" | "scan_skills"
        | "inspect_skill" | "web_search" | "web_fetch" | "list_processes" | "process_output"
        | "browser_list" | "browser_snapshot" | "browser_assert" | "browser_screenshot"
        | "browser_wait" | "browser_console" | "mcp_status" | "client_action" => ToolRisk::ReadOnly,
        "write_file" | "edit_file" | "create_skill" | "update_skill" => ToolRisk::WorkspaceWrite,
        "delete_file" | "delete_skill" | "apply_subagent_patch" => ToolRisk::Destructive,
        "run_command" => ToolRisk::Process,
        "browser_start"
        | "browser_navigate"
        | "browser_click"
        | "browser_type"
        | "browser_set_viewport"
        | "browser_close" => ToolRisk::External,
        "start_process" | "stop_process" => ToolRisk::External,
        "install_skill" | "mcp_register" | "mcp_start" | "mcp_stop" => ToolRisk::External,
        "mcp_remove" => ToolRisk::Destructive,
        "delegate_task" => ToolRisk::Delegation,
        "generate_images" | "generate_videos" | "generate_speech" => ToolRisk::Costly,
        name if name.starts_with("mcp_") => ToolRisk::External,
        _ => ToolRisk::CredentialSensitive,
    }
}

pub fn evaluate_tool(
    mode: HarnessMode,
    permission: PermissionLevel,
    risk: &ToolRisk,
    tool_name: &str,
) -> PolicyDecision {
    if !mode.allows_tools() {
        return PolicyDecision::Deny;
    }
    if matches!(mode, HarnessMode::Plan) && !matches!(risk, ToolRisk::ReadOnly) {
        return PolicyDecision::Deny;
    }
    if matches!(risk, ToolRisk::ReadOnly) {
        return PolicyDecision::Allow;
    }
    if matches!(permission, PermissionLevel::Full) && !matches!(risk, ToolRisk::CredentialSensitive)
    {
        return PolicyDecision::Allow;
    }
    if matches!(permission, PermissionLevel::Agent)
        && ((matches!(risk, ToolRisk::WorkspaceWrite)
            && matches!(tool_name, "write_file" | "edit_file" | "update_goal"))
            || (matches!(risk, ToolRisk::Delegation) && tool_name == "delegate_task"))
    {
        return PolicyDecision::Allow;
    }
    PolicyDecision::NeedsApproval
}

pub fn evaluate_tool_call(
    mode: HarnessMode,
    permission: PermissionLevel,
    call: &ToolCall,
) -> PolicyDecision {
    if call.name == "run_command"
        && matches!(permission, PermissionLevel::Agent)
        && safe_process_command(&call.arguments)
    {
        return PolicyDecision::Allow;
    }
    evaluate_tool(mode, permission, &classify_tool(&call.name), &call.name)
}

fn safe_process_command(arguments: &serde_json::Value) -> bool {
    let Some(command) = arguments.get("command").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    // A command that writes through shell redirection or a text-aware command
    // is not safe to auto-run in `agent` permission.  The model should use
    // edit_file/write_file so the host can preserve the source encoding; an
    // explicit user approval still allows legitimate build/tooling workflows.
    if contains_unquoted_redirection(command) {
        return false;
    }
    let command = command.to_ascii_lowercase();
    if contains_indirect_writer_invocation(&command) {
        return false;
    }
    [
        "rm ",
        "rmdir ",
        "del ",
        "erase ",
        "remove-item",
        "clear-content",
        "format ",
        "diskpart",
        "shutdown",
        "restart-computer",
        "stop-computer",
        "reboot",
        "halt",
        "stop-process",
        "taskkill",
        "kill ",
        "pkill",
        "git reset --hard",
        "git clean",
        "git restore",
        "git checkout --",
        "git push",
        "git fetch",
        "git pull",
        "git clone",
        "git remote",
        "git submodule",
        "git rebase",
        "git apply",
        "git am ",
        "git commit",
        "git merge",
        "git cherry-pick",
        "git revert",
        "git mv ",
        "git rm ",
        "sudo ",
        "runas ",
        "invoke-expression",
        "iex ",
        "start-process",
        "reg add",
        "reg delete",
        "sc create",
        "sc delete",
        "sc stop",
        "setx ",
        "set-content",
        "out-file",
        "add-content",
        "tee-object",
        "export-csv",
        "copy-item",
        "move-item",
        "rename-item",
        "new-item",
        "touch ",
        "sed -i",
        "perl -i",
        "python -c",
        "python3 -c",
        "node -e",
        "ruby -e",
        "rustfmt",
        "cargo fmt",
        "dotnet format",
        "clang-format -i",
        "curl ",
        "wget ",
        "invoke-webrequest",
        "invoke-restmethod",
        "start-bitstransfer",
        "certutil",
        "ssh ",
        "scp ",
        "ftp ",
        " gh ",
        "az ",
        "aws ",
        "gcloud ",
        "npm install",
        "npm add",
        "npm remove",
        "npm uninstall",
        "npm publish",
        "npm update",
        "pnpm install",
        "pnpm add",
        "pnpm remove",
        "pnpm uninstall",
        "pnpm publish",
        "pnpm update",
        "yarn install",
        "yarn add",
        "yarn remove",
        "yarn uninstall",
        "yarn publish",
        "yarn update",
        "cargo install",
        "cargo add",
        "cargo remove",
        "cargo publish",
        "cargo update",
    ]
    .iter()
    .all(|pattern| !command.contains(pattern))
}

fn contains_indirect_writer_invocation(command: &str) -> bool {
    // PowerShell exposes short aliases for text-writing cmdlets (`sc` for
    // Set-Content, `ac` for Add-Content, and `tee` for Tee-Object). They bypass
    // a check for the long cmdlet name and are especially likely to rewrite a
    // legacy file with the shell's default encoding. Nested shells are also an
    // approval boundary: redirection quoted for the outer shell becomes active
    // when `cmd /c`, `bash -lc`, or a similar interpreter parses it again. Only
    // inspect command positions (start or after a shell separator) so an
    // ordinary argument containing one of these short words does not trigger
    // approval.
    command
        .split(['|', ';', '&', '\n', '\r', '{', '}'])
        .any(|segment| {
            let mut tokens = segment
                .trim_start_matches([' ', '\t', '('])
                .split_whitespace();
            let Some(raw_name) = tokens.next() else {
                return false;
            };
            let name = raw_name
                .trim_matches(['\'', '"'])
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or(raw_name);
            if matches!(
                name,
                "tee"
                    | "sc"
                    | "ac"
                    | "powershell"
                    | "powershell.exe"
                    | "pwsh"
                    | "pwsh.exe"
                    | "cmd"
                    | "cmd.exe"
                    | "bash"
                    | "sh"
                    | "zsh"
                    | "fish"
            ) {
                return true;
            }
            let inline_interpreter = matches!(
                name,
                "python"
                    | "python.exe"
                    | "python3"
                    | "python3.exe"
                    | "py"
                    | "py.exe"
                    | "node"
                    | "node.exe"
                    | "ruby"
                    | "ruby.exe"
                    | "perl"
                    | "perl.exe"
            );
            inline_interpreter
                && tokens.any(|argument| {
                    matches!(argument, "-" | "-c" | "-e" | "--eval" | "--print")
                        || argument.starts_with("-c")
                        || argument.starts_with("-e")
                        || (matches!(name, "perl" | "perl.exe")
                            && argument.starts_with('-')
                            && argument.contains('i'))
                })
        })
}

fn contains_unquoted_redirection(command: &str) -> bool {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Quote {
        None,
        Single,
        Double,
    }

    let mut quote = Quote::None;
    let mut escaped = false;
    let mut characters = command.chars().peekable();
    while let Some(character) = characters.next() {
        if escaped {
            escaped = false;
            continue;
        }
        match quote {
            Quote::None => match character {
                '\'' => quote = Quote::Single,
                '"' => quote = Quote::Double,
                '>' | '<' => return true,
                _ => {}
            },
            Quote::Single => {
                if character == '\'' {
                    // PowerShell represents a literal quote inside a
                    // single-quoted string as two adjacent quotes.
                    if characters.peek() == Some(&'\'') {
                        characters.next();
                    } else {
                        quote = Quote::None;
                    }
                }
            }
            Quote::Double => match character {
                '"' => quote = Quote::None,
                '`' => escaped = true,
                _ => {}
            },
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: "test-call".into(),
            name: name.into(),
            arguments: json!({}),
        }
    }

    #[test]
    fn chat_and_plan_cannot_execute_side_effects() {
        assert_eq!(
            evaluate_tool_call(HarnessMode::Chat, PermissionLevel::Full, &call("read_file")),
            PolicyDecision::Deny
        );
        assert_eq!(
            evaluate_tool_call(
                HarnessMode::Plan,
                PermissionLevel::Full,
                &call("write_file")
            ),
            PolicyDecision::Deny
        );
    }

    #[test]
    fn request_requires_approval_for_every_side_effect() {
        for name in [
            "write_file",
            "edit_file",
            "delete_file",
            "run_command",
            "mcp_server_call",
        ] {
            assert_eq!(
                evaluate_tool_call(HarnessMode::Agent, PermissionLevel::Request, &call(name)),
                PolicyDecision::NeedsApproval
            );
        }
    }

    #[test]
    fn agent_mode_allows_only_the_narrow_safe_subset() {
        assert_eq!(
            evaluate_tool_call(
                HarnessMode::Agent,
                PermissionLevel::Agent,
                &call("write_file")
            ),
            PolicyDecision::Allow
        );
        assert_eq!(
            evaluate_tool_call(
                HarnessMode::Agent,
                PermissionLevel::Agent,
                &call("edit_file")
            ),
            PolicyDecision::Allow
        );
        assert_eq!(
            evaluate_tool_call(
                HarnessMode::Agent,
                PermissionLevel::Agent,
                &call("delegate_task")
            ),
            PolicyDecision::Allow
        );
        assert_eq!(
            evaluate_tool_call(
                HarnessMode::Agent,
                PermissionLevel::Agent,
                &call("run_command")
            ),
            PolicyDecision::NeedsApproval
        );
        let safe = ToolCall {
            id: "safe-command".into(),
            name: "run_command".into(),
            arguments: json!({"command": "cargo test --lib"}),
        };
        assert_eq!(
            evaluate_tool_call(HarnessMode::Agent, PermissionLevel::Agent, &safe),
            PolicyDecision::Allow
        );

        for command in [
            "echo '中文' > source.cpp",
            "echo '中文'>source.cpp",
            r#"Write-Output "a\" > source.cpp"#,
            "Set-Content -Path source.cpp -Value $text",
            "Get-Content source.cpp | tee source.cpp",
            "sc source.cpp '中文'",
            "ac source.cpp '中文'",
            "cmd /c \"echo 中文 > source.cpp\"",
            r#"C:\Windows\System32\cmd.exe /c "echo 中文 > source.cpp""#,
            "bash -lc \"printf 中文 > source.cpp\"",
            "pwsh -EncodedCommand AAAA",
            "@'Path('source.cpp').write_text('中文')'@ | python -",
            "python -X utf8 -c \"Path('source.cpp').write_text('中文')\"",
            "node --input-type=module -e \"writeFileSync('source.cpp', '中文')\"",
            "git apply change.patch",
            "python -c \"from pathlib import Path; Path('source.cpp').write_text('x')\"",
            "cargo fmt",
        ] {
            let mut call = safe.clone();
            call.id = command.to_owned();
            call.arguments = serde_json::json!({"command": command});
            assert_eq!(
                evaluate_tool_call(HarnessMode::Agent, PermissionLevel::Agent, &call),
                PolicyDecision::NeedsApproval,
                "command={command}"
            );
        }

        for command in [
            "rg 'Vec<T>' src",
            "Write-Output \"a > b\"",
            "rg \"Result<T, E>\" src-tauri/src",
        ] {
            let mut call = safe.clone();
            call.id = command.to_owned();
            call.arguments = serde_json::json!({"command": command});
            assert_eq!(
                evaluate_tool_call(HarnessMode::Agent, PermissionLevel::Agent, &call),
                PolicyDecision::Allow,
                "command={command}"
            );
        }
    }

    #[test]
    fn full_never_grants_unknown_credential_sensitive_tools() {
        assert_eq!(
            evaluate_tool_call(
                HarnessMode::Agent,
                PermissionLevel::Full,
                &call("unknown_tool")
            ),
            PolicyDecision::NeedsApproval
        );
    }

    #[test]
    fn full_allows_known_local_and_external_tools() {
        for name in [
            "run_command",
            "create_skill",
            "install_skill",
            "mcp_register",
            "browser_start",
        ] {
            assert_eq!(
                evaluate_tool_call(HarnessMode::Agent, PermissionLevel::Full, &call(name)),
                PolicyDecision::Allow,
                "tool={name}"
            );
        }
    }
}
