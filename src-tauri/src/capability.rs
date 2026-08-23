//! Versioned, host-owned client capability contracts.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::models::AgentToolDefinition;

const CLIENT_ACTION_MANIFEST: &str = include_str!("../../capabilities/client-actions.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientActionManifest {
    schema_version: u32,
    capability_id: String,
    version: u32,
    tool_name: String,
    event: String,
    actions: Vec<ClientActionSpec>,
}

#[derive(Debug, Clone, Deserialize)]
struct ClientActionSpec {
    id: String,
    description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientActionEvent {
    pub capability_id: String,
    pub contract_version: u32,
    pub action: String,
}

pub struct ClientActionDispatch {
    pub event: String,
    pub payload: ClientActionEvent,
}

fn manifest() -> Result<ClientActionManifest, String> {
    let manifest: ClientActionManifest = serde_json::from_str(CLIENT_ACTION_MANIFEST)
        .map_err(|error| format!("Client capability manifest is invalid JSON: {error}"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &ClientActionManifest) -> Result<(), String> {
    if manifest.schema_version != 1 || manifest.version == 0 {
        return Err("Client capability manifest uses an unsupported version".to_owned());
    }
    if manifest.capability_id != "client.ui"
        || manifest.tool_name != "client_action"
        || manifest.event != "levelup://client-action"
    {
        return Err("Client capability manifest identity is invalid".to_owned());
    }
    if manifest.actions.is_empty() || manifest.actions.len() > 64 {
        return Err("Client capability manifest must contain 1 to 64 actions".to_owned());
    }
    let mut seen = HashSet::new();
    for action in &manifest.actions {
        let valid_id = !action.id.is_empty()
            && action.id.len() <= 64
            && action.id.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            });
        if !valid_id || !seen.insert(action.id.as_str()) {
            return Err(format!(
                "Client action ID is invalid or duplicated: {}",
                action.id
            ));
        }
        if action.description.trim().is_empty() || action.description.chars().count() > 240 {
            return Err(format!(
                "Client action description is invalid: {}",
                action.id
            ));
        }
    }
    Ok(())
}

pub fn client_action_tool() -> Result<AgentToolDefinition, String> {
    let manifest = manifest()?;
    let action_ids = manifest
        .actions
        .iter()
        .map(|action| action.id.clone())
        .collect::<Vec<_>>();
    let action_help = manifest
        .actions
        .iter()
        .map(|action| format!("{}: {}", action.id, action.description))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(AgentToolDefinition {
        name: manifest.tool_name,
        description: format!(
            "Control reversible LevelUpAgent client UI state directly instead of asking the user to click through the application. Supported actions: {action_help}"
        ),
        input_schema: json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": action_ids,
                    "description": "A registered LevelUpAgent client action"
                }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
        read_only: true,
    })
}

pub fn client_action_dispatch(
    arguments: &serde_json::Value,
) -> Result<ClientActionDispatch, String> {
    let manifest = manifest()?;
    let action = arguments
        .get("action")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "client_action requires a string action".to_owned())?;
    if !manifest.actions.iter().any(|item| item.id == action) {
        return Err(format!("Unknown LevelUpAgent client action: {action}"));
    }
    Ok(ClientActionDispatch {
        event: manifest.event,
        payload: ClientActionEvent {
            capability_id: manifest.capability_id,
            contract_version: manifest.version,
            action: action.to_owned(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_client_action_manifest_builds_a_bounded_tool_contract() {
        let tool = client_action_tool().unwrap();
        assert_eq!(tool.name, "client_action");
        assert!(tool.read_only);
        let actions = tool
            .input_schema
            .pointer("/properties/action/enum")
            .and_then(serde_json::Value::as_array)
            .unwrap();
        assert!(actions.iter().any(|action| action == "dialog.skills"));
        assert!(actions.iter().any(|action| action == "view.media"));
    }

    #[test]
    fn client_action_dispatch_rejects_unregistered_ui_commands() {
        assert!(client_action_dispatch(&json!({ "action": "window.destroy" })).is_err());
        let dispatch = client_action_dispatch(&json!({ "action": "dialog.skills" })).unwrap();
        assert_eq!(dispatch.event, "levelup://client-action");
        assert_eq!(dispatch.payload.contract_version, 1);
    }
}
