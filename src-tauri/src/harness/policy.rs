//! Host-side tool policy. The risk taxonomy mirrors the separation used by
//! grok-build's workspace/tools crates, while the before/after decision shape
//! follows pi's tool preflight hooks.

use crate::models::ToolCall;

use super::types::{HarnessMode, PermissionLevel, PolicyDecision, ToolRisk};

pub fn classify_tool(name: &str) -> ToolRisk {
    match name {
        "list_files" | "read_file" | "search_files" | "get_goal" | "read_skill"
        | "check_media_jobs" | "update_goal" => ToolRisk::ReadOnly,
        "write_file" => ToolRisk::WorkspaceWrite,
        "delete_file" | "apply_subagent_patch" => ToolRisk::Destructive,
        "run_command" => ToolRisk::Process,
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
            && matches!(tool_name, "write_file" | "update_goal"))
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
    let command = command.trim().to_ascii_lowercase();
    if command.is_empty() {
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
}
