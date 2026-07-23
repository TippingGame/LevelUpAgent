use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const MAX_LAYOUT_BYTES: u64 = 512 * 1024;
const MAX_LAYOUT_NODES: usize = 512;
const MAX_LAYOUT_DEPTH: usize = 32;
const MAX_TEXT_CHARS: usize = 2_000;
const DEFAULT_LAYOUT: &str = include_str!("../../layouts/default.layout.json");
const QQ2007_LAYOUT: &str = include_str!("../../layouts/qq2007.layout.json");

const SLOT_NAMES: &[&str] = &[
    "sidebar",
    "workspace",
    "mediaStudio",
    "inspector",
    "qq2007Titlebar",
    "qq2007Toolbar",
    "qq2007RightPanel",
    "qq2007Statusbar",
];

const ACTION_NAMES: &[&str] = &[
    "state.set",
    "state.toggle",
    "thread.new",
    "thread.activate",
    "project.open",
    "view.chat",
    "view.media",
    "panel.toggle",
    "dialog.settings",
    "dialog.themes",
    "dialog.extensions",
    "dialog.skills",
    "dialog.logs",
    "app.website",
    "app.locale.toggle",
    "balance.refresh",
    "window.minimize",
    "window.toggleMaximize",
    "window.close",
];

const ICON_NAMES: &[&str] = &[
    "activity",
    "bot",
    "check",
    "chevron-down",
    "chevron-right",
    "alert",
    "cpu",
    "external",
    "folder",
    "folder-open",
    "media",
    "language",
    "message",
    "panel-close",
    "panel-open",
    "plus",
    "search",
    "settings",
    "shield",
    "sparkles",
    "close",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLayout {
    pub source: String,
    pub definition: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Default)]
struct ValidationState {
    nodes: usize,
    slots: HashSet<String>,
    actions: HashSet<String>,
}

pub fn default_definition() -> Result<Value, String> {
    parse_and_validate(DEFAULT_LAYOUT.as_bytes())
}

pub fn legacy_definition(layout: &str) -> Result<Value, String> {
    match layout {
        "standard" => default_definition(),
        "qq2007" => parse_and_validate(QQ2007_LAYOUT.as_bytes()),
        _ => Err("Unknown legacy layout".to_owned()),
    }
}

pub fn read_and_validate(path: &Path) -> Result<Value, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect layout file: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_LAYOUT_BYTES
    {
        return Err("Layout files must be regular files between 1 byte and 512 KiB".to_owned());
    }
    let bytes =
        std::fs::read(path).map_err(|error| format!("Could not read layout file: {error}"))?;
    parse_and_validate(&bytes)
}

pub fn parse_and_validate(bytes: &[u8]) -> Result<Value, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_LAYOUT_BYTES {
        return Err("Layout files must be between 1 byte and 512 KiB".to_owned());
    }
    let definition: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Layout file is not valid UTF-8 JSON: {error}"))?;
    validate_definition(&definition)?;
    Ok(definition)
}

pub fn validate_definition(definition: &Value) -> Result<(), String> {
    let root = object(definition, "Layout")?;
    ensure_keys(
        root,
        &[
            "schemaVersion",
            "id",
            "name",
            "window",
            "initialState",
            "root",
        ],
        &["schemaVersion", "id", "name", "root"],
        "Layout",
    )?;
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported layout schema; expected schemaVersion 1".to_owned());
    }
    validate_identifier(required_string(root, "id", "Layout")?, "layout id")?;
    validate_text(required_string(root, "name", "Layout")?, "layout name")?;
    if let Some(window) = root.get("window") {
        let window = object(window, "Layout window")?;
        ensure_keys(window, &["decorations"], &[], "Layout window")?;
        if window
            .get("decorations")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err("Layout window decorations must be a boolean".to_owned());
        }
    }
    if let Some(initial_state) = root.get("initialState") {
        let initial_state = object(initial_state, "Layout initialState")?;
        if initial_state.len() > 64 {
            return Err("Layout initialState may contain at most 64 values".to_owned());
        }
        for (key, value) in initial_state {
            validate_path_segment(key, "state key")?;
            if !(value.is_string() || value.is_boolean() || value.is_number() || value.is_null()) {
                return Err(
                    "Layout initialState values must be strings, numbers, booleans, or null"
                        .to_owned(),
                );
            }
        }
    }
    let mut state = ValidationState::default();
    validate_node(
        root.get("root")
            .ok_or_else(|| "Layout root is required".to_owned())?,
        0,
        false,
        &mut state,
    )?;
    if !matches!(
        root.get("root")
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str),
        Some("container")
    ) {
        return Err("Layout root must be a container node".to_owned());
    }
    if !state.slots.contains("workspace") {
        return Err("Layout must expose the workspace slot so approvals and agent controls remain available".to_owned());
    }
    let decorations = root
        .get("window")
        .and_then(Value::as_object)
        .and_then(|window| window.get("decorations"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !decorations
        && !state.slots.contains("qq2007Titlebar")
        && !["window.minimize", "window.toggleMaximize", "window.close"]
            .iter()
            .all(|action| state.actions.contains(*action))
    {
        return Err(
            "Layouts without system decorations must expose minimize, maximize, and close controls"
                .to_owned(),
        );
    }
    Ok(())
}

pub fn validate_embedded_definition(definition: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(definition)
        .map_err(|error| format!("Could not serialize embedded layout: {error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_LAYOUT_BYTES {
        return Err("Embedded layouts must be between 1 byte and 512 KiB".to_owned());
    }
    validate_definition(definition)
}

fn validate_node(
    node: &Value,
    depth: usize,
    conditional_ancestor: bool,
    state: &mut ValidationState,
) -> Result<(), String> {
    if depth > MAX_LAYOUT_DEPTH {
        return Err(format!(
            "Layout nesting may not exceed {MAX_LAYOUT_DEPTH} levels"
        ));
    }
    state.nodes += 1;
    if state.nodes > MAX_LAYOUT_NODES {
        return Err(format!(
            "Layout may not contain more than {MAX_LAYOUT_NODES} nodes"
        ));
    }
    let node = object(node, "Layout node")?;
    let node_type = required_string(node, "type", "Layout node")?;
    let common = ["type", "id", "className", "when"];
    if let Some(id) = node.get("id") {
        validate_identifier(string(id, "Layout node id")?, "node id")?;
    }
    if let Some(classes) = node.get("className") {
        validate_classes(classes)?;
    }
    if let Some(condition) = node.get("when") {
        validate_condition(condition, 0)?;
    }
    let conditional = conditional_ancestor || node.contains_key("when");
    match node_type {
        "container" => {
            ensure_node_keys(
                node,
                &common,
                &["role", "children"],
                &["children"],
                node_type,
            )?;
            if let Some(role) = node.get("role") {
                validate_identifier(string(role, "Container role")?, "container role")?;
            }
            validate_children(node.get("children").unwrap(), depth, conditional, state)?;
        }
        "slot" => {
            ensure_node_keys(node, &common, &["slot"], &["slot"], node_type)?;
            let slot = required_string(node, "slot", "Slot node")?;
            if !SLOT_NAMES.contains(&slot) {
                return Err(format!("Unknown layout slot: {slot}"));
            }
            if !state.slots.insert(slot.to_owned()) {
                return Err(format!("Layout slot may only be used once: {slot}"));
            }
            if slot == "workspace" && conditional {
                return Err("The workspace slot cannot be conditional or repeated".to_owned());
            }
        }
        "text" => {
            ensure_node_keys(node, &common, &["text", "bind"], &[], node_type)?;
            if node.get("text").is_none() && node.get("bind").is_none() {
                return Err("Text node requires text or bind".to_owned());
            }
            if let Some(text) = node.get("text") {
                validate_localized_text(text, "Text node")?;
            }
            if let Some(bind) = node.get("bind") {
                validate_path(string(bind, "Text binding")?)?;
            }
        }
        "button" => {
            ensure_node_keys(
                node,
                &common,
                &[
                    "label",
                    "action",
                    "icon",
                    "activeWhen",
                    "disabledWhen",
                    "children",
                ],
                &["label", "action"],
                node_type,
            )?;
            validate_localized_text(node.get("label").unwrap(), "Button label")?;
            validate_action(node.get("action").unwrap())?;
            if let Some(action) = node
                .get("action")
                .and_then(Value::as_object)
                .and_then(|action| action.get("name"))
                .and_then(Value::as_str)
            {
                state.actions.insert(action.to_owned());
            }
            if let Some(icon) = node.get("icon") {
                validate_icon(string(icon, "Button icon")?)?;
            }
            for key in ["activeWhen", "disabledWhen"] {
                if let Some(condition) = node.get(key) {
                    validate_condition(condition, 0)?;
                }
            }
            if let Some(children) = node.get("children") {
                validate_children(children, depth, conditional, state)?;
            }
        }
        "image" => {
            ensure_node_keys(
                node,
                &common,
                &["source", "alt"],
                &["source", "alt"],
                node_type,
            )?;
            let source = required_string(node, "source", "Image node")?;
            if source.contains("javascript:")
                || source.starts_with("http:")
                || source.starts_with("https:")
                || source.starts_with("//")
                || !(source.starts_with('/') || source.starts_with("data:image/"))
            {
                return Err(
                    "Layout images must use an app-relative path or an embedded data:image URL"
                        .to_owned(),
                );
            }
            validate_localized_text(node.get("alt").unwrap(), "Image alt")?;
        }
        "icon" => {
            ensure_node_keys(node, &common, &["name", "label"], &["name"], node_type)?;
            validate_icon(required_string(node, "name", "Icon node")?)?;
            if let Some(label) = node.get("label") {
                validate_localized_text(label, "Icon label")?;
            }
        }
        "input" => {
            ensure_node_keys(
                node,
                &common,
                &["state", "label", "placeholder"],
                &["state", "label"],
                node_type,
            )?;
            validate_path_segment(required_string(node, "state", "Input node")?, "input state")?;
            validate_localized_text(node.get("label").unwrap(), "Input label")?;
            if let Some(placeholder) = node.get("placeholder") {
                validate_localized_text(placeholder, "Input placeholder")?;
            }
        }
        "repeat" => {
            ensure_node_keys(
                node,
                &common,
                &["source", "item", "children", "empty"],
                &["source", "item", "children"],
                node_type,
            )?;
            validate_path(required_string(node, "source", "Repeat node")?)?;
            validate_path_segment(required_string(node, "item", "Repeat node")?, "repeat item")?;
            validate_children(node.get("children").unwrap(), depth, true, state)?;
            if let Some(empty) = node.get("empty") {
                validate_children(empty, depth, conditional, state)?;
            }
        }
        "spacer" => ensure_node_keys(node, &common, &[], &[], node_type)?,
        _ => return Err(format!("Unknown layout node type: {node_type}")),
    }
    Ok(())
}

fn validate_children(
    value: &Value,
    depth: usize,
    conditional_ancestor: bool,
    state: &mut ValidationState,
) -> Result<(), String> {
    let children = value
        .as_array()
        .ok_or_else(|| "Layout children must be an array".to_owned())?;
    if children.len() > 128 {
        return Err("A layout node may contain at most 128 children".to_owned());
    }
    for child in children {
        validate_node(child, depth + 1, conditional_ancestor, state)?;
    }
    Ok(())
}

fn validate_condition(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 12 {
        return Err("Layout conditions are nested too deeply".to_owned());
    }
    let condition = object(value, "Layout condition")?;
    if let Some(path) = condition.get("path") {
        ensure_keys(
            condition,
            &["path", "equals", "notEquals", "truthy"],
            &["path"],
            "Layout condition",
        )?;
        validate_path(string(path, "Condition path")?)?;
        if condition.get("equals").is_some() && condition.get("notEquals").is_some() {
            return Err("Layout condition cannot use equals and notEquals together".to_owned());
        }
        if condition
            .get("truthy")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err("Layout condition truthy must be a boolean".to_owned());
        }
        return Ok(());
    }
    for operator in ["all", "any"] {
        if let Some(items) = condition.get(operator) {
            ensure_keys(condition, &[operator], &[operator], "Layout condition")?;
            let items = items
                .as_array()
                .ok_or_else(|| format!("Layout condition {operator} must be an array"))?;
            if items.is_empty() || items.len() > 24 {
                return Err(format!(
                    "Layout condition {operator} must contain 1 to 24 items"
                ));
            }
            for item in items {
                validate_condition(item, depth + 1)?;
            }
            return Ok(());
        }
    }
    if let Some(item) = condition.get("not") {
        ensure_keys(condition, &["not"], &["not"], "Layout condition")?;
        return validate_condition(item, depth + 1);
    }
    Err("Layout condition must use path, all, any, or not".to_owned())
}

fn validate_action(value: &Value) -> Result<(), String> {
    let action = object(value, "Layout action")?;
    ensure_keys(action, &["name", "args"], &["name"], "Layout action")?;
    let name = required_string(action, "name", "Layout action")?;
    if !ACTION_NAMES.contains(&name) {
        return Err(format!("Unknown layout action: {name}"));
    }
    if let Some(args) = action.get("args") {
        let args = object(args, "Layout action args")?;
        if args.len() > 16 {
            return Err("Layout action may contain at most 16 arguments".to_owned());
        }
        for (key, value) in args {
            validate_path_segment(key, "action argument")?;
            validate_action_value(value, 0)?;
        }
    }
    if matches!(name, "state.set" | "state.toggle") {
        let target = action
            .get("args")
            .and_then(Value::as_object)
            .and_then(|args| args.get("target"))
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{name} requires a string args.target"))?;
        validate_path_segment(target, "state target")?;
    }
    Ok(())
}

fn validate_action_value(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 4 {
        return Err("Layout action arguments are nested too deeply".to_owned());
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(value) => validate_template(value, "action argument"),
        Value::Array(values) if values.len() <= 32 => values
            .iter()
            .try_for_each(|value| validate_action_value(value, depth + 1)),
        Value::Object(values) if values.len() <= 32 => {
            values.iter().try_for_each(|(key, value)| {
                validate_path_segment(key, "action argument")?;
                validate_action_value(value, depth + 1)
            })
        }
        _ => Err("Layout action arguments contain an unsupported value".to_owned()),
    }
}

fn validate_classes(value: &Value) -> Result<(), String> {
    let classes = value
        .as_array()
        .ok_or_else(|| "Layout className must be an array".to_owned())?;
    if classes.len() > 16 {
        return Err("Layout nodes may use at most 16 classes".to_owned());
    }
    for class_name in classes {
        validate_identifier(string(class_name, "Layout class")?, "class")?;
    }
    Ok(())
}

fn validate_icon(value: &str) -> Result<(), String> {
    if !ICON_NAMES.contains(&value) {
        return Err(format!("Unknown layout icon: {value}"));
    }
    Ok(())
}

fn validate_localized_text(value: &Value, label: &str) -> Result<(), String> {
    match value {
        Value::String(text) => validate_template(text, label),
        Value::Object(values) => {
            ensure_keys(values, &["zh-CN", "en-US"], &["zh-CN", "en-US"], label)?;
            for text in values.values() {
                validate_template(string(text, label)?, label)?;
            }
            Ok(())
        }
        _ => Err(format!("{label} must be a string or a zh-CN/en-US object")),
    }
}

fn validate_template(value: &str, label: &str) -> Result<(), String> {
    validate_text(value, label)?;
    let mut remaining = value;
    while let Some(start) = remaining.find("{{") {
        let tail = &remaining[start + 2..];
        let end = tail
            .find("}}")
            .ok_or_else(|| format!("{label} contains an unclosed binding"))?;
        validate_path(tail[..end].trim())?;
        remaining = &tail[end + 2..];
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 160 {
        return Err("Layout data paths must contain 1 to 160 characters".to_owned());
    }
    for segment in path.split('.') {
        validate_path_segment(segment, "data path")?;
    }
    Ok(())
}

fn validate_path_segment(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || matches!(value, "__proto__" | "prototype" | "constructor")
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(format!("Invalid layout {label}: {value}"));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    validate_path_segment(value, label)
}

fn validate_text(value: &str, label: &str) -> Result<(), String> {
    let count = value.chars().count();
    if value.is_empty() || count > MAX_TEXT_CHARS || value.chars().any(char::is_control) {
        return Err(format!(
            "Layout {label} must contain 1 to {MAX_TEXT_CHARS} printable characters"
        ));
    }
    Ok(())
}

fn ensure_node_keys(
    object: &Map<String, Value>,
    common: &[&str],
    specific: &[&str],
    required: &[&str],
    node_type: &str,
) -> Result<(), String> {
    let mut allowed = common.to_vec();
    allowed.extend_from_slice(specific);
    let mut required_keys = vec!["type"];
    required_keys.extend_from_slice(required);
    ensure_keys(
        object,
        &allowed,
        &required_keys,
        &format!("{node_type} node"),
    )
}

fn ensure_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    required: &[&str],
    label: &str,
) -> Result<(), String> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("{label} contains an unknown field: {key}"));
        }
    }
    for key in required {
        if !object.contains_key(*key) {
            return Err(format!("{label} is missing required field: {key}"));
        }
    }
    Ok(())
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))
}

fn string<'a>(value: &'a Value, label: &str) -> Result<&'a str, String> {
    value
        .as_str()
        .ok_or_else(|| format!("{label} must be a string"))
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a str, String> {
    string(
        object
            .get(key)
            .ok_or_else(|| format!("{label} is missing required field: {key}"))?,
        &format!("{label} {key}"),
    )
}

pub fn resolve(
    custom_layout: Option<&Path>,
    legacy_layout: Option<&str>,
) -> Result<ResolvedLayout, String> {
    if let Some(custom_layout) = custom_layout {
        match read_and_validate(custom_layout) {
            Ok(definition) => {
                return Ok(ResolvedLayout {
                    source: "theme".to_owned(),
                    definition,
                    warning: None,
                });
            }
            Err(error) => {
                return Ok(ResolvedLayout {
                    source: "default".to_owned(),
                    definition: default_definition()?,
                    warning: Some(format!(
                        "Custom layout could not be loaded; using default: {error}"
                    )),
                });
            }
        }
    }
    if let Some(layout) = legacy_layout.filter(|layout| *layout != "standard") {
        return Ok(ResolvedLayout {
            source: "legacy".to_owned(),
            definition: legacy_definition(layout)?,
            warning: None,
        });
    }
    Ok(ResolvedLayout {
        source: "default".to_owned(),
        definition: default_definition()?,
        warning: None,
    })
}

pub fn resolve_definition(
    custom_layout: Option<&Value>,
    legacy_layout: Option<&str>,
) -> Result<ResolvedLayout, String> {
    if let Some(custom_layout) = custom_layout {
        match validate_embedded_definition(custom_layout) {
            Ok(()) => {
                return Ok(ResolvedLayout {
                    source: "theme".to_owned(),
                    definition: custom_layout.clone(),
                    warning: None,
                });
            }
            Err(error) => {
                return Ok(ResolvedLayout {
                    source: "default".to_owned(),
                    definition: default_definition()?,
                    warning: Some(format!(
                        "Custom layout could not be loaded; using default: {error}"
                    )),
                });
            }
        }
    }
    resolve(None, legacy_layout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_built_in_layouts() {
        validate_definition(&default_definition().unwrap()).unwrap();
        validate_definition(&legacy_definition("qq2007").unwrap()).unwrap();
    }

    #[test]
    fn rejects_scripts_unknown_actions_and_missing_workspace() {
        let script = br#"{"schemaVersion":1,"id":"bad","name":"Bad","root":{"type":"container","children":[{"type":"image","source":"javascript:alert(1)","alt":"x"},{"type":"slot","slot":"workspace"}]}}"#;
        assert!(parse_and_validate(script).is_err());
        let action = br#"{"schemaVersion":1,"id":"bad","name":"Bad","root":{"type":"container","children":[{"type":"button","label":"x","action":{"name":"shell.run"}},{"type":"slot","slot":"workspace"}]}}"#;
        assert!(parse_and_validate(action).is_err());
        let missing = br#"{"schemaVersion":1,"id":"bad","name":"Bad","root":{"type":"container","children":[]}}"#;
        assert!(parse_and_validate(missing).is_err());
        let conditional = br#"{"schemaVersion":1,"id":"bad","name":"Bad","root":{"type":"container","when":{"path":"profile.connected"},"children":[{"type":"slot","slot":"workspace"}]}}"#;
        assert!(parse_and_validate(conditional).is_err());
        let stranded_window = br#"{"schemaVersion":1,"id":"bad","name":"Bad","window":{"decorations":false},"root":{"type":"container","children":[{"type":"slot","slot":"workspace"}]}}"#;
        assert!(parse_and_validate(stranded_window).is_err());
        let icon = br#"{"schemaVersion":1,"id":"bad","name":"Bad","root":{"type":"container","children":[{"type":"icon","name":"invented"},{"type":"slot","slot":"workspace"}]}}"#;
        assert!(parse_and_validate(icon).is_err());
    }

    #[test]
    fn accepts_declarative_state_data_and_actions() {
        let layout = r#"{
          "schemaVersion":1,
          "id":"custom",
          "name":"Custom",
          "initialState":{"panel":"details"},
          "root":{"type":"container","children":[
            {"type":"button","label":{"zh-CN":"新建 {{app.name}}","en-US":"New {{app.name}}"},"action":{"name":"thread.new"}},
            {"type":"text","bind":"thread.title","when":{"path":"thread.running","truthy":false}},
            {"type":"slot","slot":"workspace"}
          ]}
        }"#;
        parse_and_validate(layout.as_bytes()).unwrap();
    }

    #[test]
    fn falls_back_when_an_installed_layout_is_corrupt() {
        let root = std::env::temp_dir().join(format!("levelup-layout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let custom_layout = root.join("layout.json");
        std::fs::write(&custom_layout, b"not json").unwrap();
        let resolved = resolve(Some(&custom_layout), None).unwrap();
        assert_eq!(resolved.source, "default");
        assert!(resolved.warning.is_some());
        let _ = std::fs::remove_dir_all(root);
    }
}
