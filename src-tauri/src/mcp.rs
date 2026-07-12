use std::collections::HashMap;
use std::time::Duration;

use http::{HeaderName, HeaderValue};
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock};

use crate::models::{
    AgentToolDefinition, McpSecretValues, McpServerConfig, McpServerSnapshot, McpTransport,
    ToolExecutionResponse,
};
use crate::process::hide_console_window;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const TOOL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TOOLS_PER_SERVER: usize = 128;
const MAX_SCHEMA_BYTES: usize = 48 * 1024;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_OUTPUT_CHARS: usize = 120_000;

type ClientService = RunningService<RoleClient, ()>;

struct Connection {
    service: ClientService,
    tools: Vec<AgentToolDefinition>,
}

#[derive(Clone)]
struct ToolRoute {
    server_id: String,
    original_name: String,
}

#[derive(Default)]
pub struct McpManager {
    connections: Mutex<HashMap<String, Connection>>,
    routes: RwLock<HashMap<String, ToolRoute>>,
    errors: RwLock<HashMap<String, String>>,
}

impl McpManager {
    pub async fn ensure_tools(
        &self,
        server: &McpServerConfig,
        secrets: &McpSecretValues,
    ) -> Result<Vec<AgentToolDefinition>, String> {
        if !server.enabled {
            return Ok(Vec::new());
        }
        {
            let connections = self.connections.lock().await;
            if let Some(connection) = connections.get(&server.id)
                && !connection.service.is_closed()
            {
                return Ok(connection.tools.clone());
            }
        }
        self.start(server, secrets).await
    }

    pub async fn start(
        &self,
        server: &McpServerConfig,
        secrets: &McpSecretValues,
    ) -> Result<Vec<AgentToolDefinition>, String> {
        validate_server(server, secrets)?;
        self.stop(&server.id).await;

        let result = tokio::time::timeout(CONNECT_TIMEOUT, connect(server, secrets)).await;
        let (service, remote_tools) = match result {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                self.set_error(&server.id, &error).await;
                return Err(error);
            }
            Err(_) => {
                let error = "MCP server connection timed out after 20 seconds".to_owned();
                self.set_error(&server.id, &error).await;
                return Err(error);
            }
        };

        let mut definitions = Vec::new();
        let mut routes = Vec::new();
        for tool in remote_tools.into_iter().take(MAX_TOOLS_PER_SERVER) {
            let schema = serde_json::to_value(tool.input_schema.as_ref())
                .map_err(|error| format!("MCP tool schema is invalid: {error}"))?;
            if serde_json::to_vec(&schema)
                .map(|value| value.len())
                .unwrap_or(usize::MAX)
                > MAX_SCHEMA_BYTES
            {
                continue;
            }
            let exposed_name = exposed_tool_name(&server.id, tool.name.as_ref());
            let description = tool
                .description
                .map(|value| value.into_owned())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("{} tool from {}", tool.name, server.name));
            definitions.push(AgentToolDefinition {
                name: exposed_name.clone(),
                description: description.chars().take(MAX_DESCRIPTION_CHARS).collect(),
                input_schema: schema,
                read_only: false,
            });
            routes.push((
                exposed_name,
                ToolRoute {
                    server_id: server.id.clone(),
                    original_name: tool.name.into_owned(),
                },
            ));
        }

        self.connections.lock().await.insert(
            server.id.clone(),
            Connection {
                service,
                tools: definitions.clone(),
            },
        );
        let mut route_map = self.routes.write().await;
        route_map.retain(|_, route| route.server_id != server.id);
        route_map.extend(routes);
        drop(route_map);
        self.errors.write().await.remove(&server.id);
        Ok(definitions)
    }

    pub async fn stop(&self, server_id: &str) -> bool {
        let connection = self.connections.lock().await.remove(server_id);
        self.routes
            .write()
            .await
            .retain(|_, route| route.server_id != server_id);
        self.errors.write().await.remove(server_id);
        if let Some(mut connection) = connection {
            let _ = connection
                .service
                .close_with_timeout(Duration::from_secs(3))
                .await;
            true
        } else {
            false
        }
    }

    pub async fn snapshot(&self, server: McpServerConfig) -> McpServerSnapshot {
        let (connected, tool_count) = {
            let connections = self.connections.lock().await;
            connections
                .get(&server.id)
                .filter(|connection| !connection.service.is_closed())
                .map(|connection| (true, connection.tools.len()))
                .unwrap_or((false, 0))
        };
        let last_error = self.errors.read().await.get(&server.id).cloned();
        let status = if !server.enabled {
            "disabled"
        } else if connected {
            "connected"
        } else if last_error.is_some() {
            "error"
        } else {
            "stopped"
        };
        McpServerSnapshot {
            server,
            status: status.to_owned(),
            tool_count,
            last_error,
        }
    }

    pub async fn execute(&self, name: &str, arguments: serde_json::Value) -> ToolExecutionResponse {
        let route = self.routes.read().await.get(name).cloned();
        let Some(route) = route else {
            return tool_error(format!("MCP tool is not available: {name}"));
        };
        let peer = {
            let connections = self.connections.lock().await;
            let Some(connection) = connections.get(&route.server_id) else {
                return tool_error("The MCP server is not connected".to_owned());
            };
            if connection.service.is_closed() {
                return tool_error("The MCP server connection is closed".to_owned());
            }
            connection.service.peer().clone()
        };
        let Some(arguments) = arguments.as_object().cloned() else {
            return tool_error("MCP tool arguments must be a JSON object".to_owned());
        };
        let request = CallToolRequestParams::new(route.original_name).with_arguments(arguments);
        let result = tokio::time::timeout(TOOL_TIMEOUT, peer.call_tool(request)).await;
        match result {
            Ok(Ok(result)) => ToolExecutionResponse {
                output: format_result(&result),
                is_error: result.is_error.unwrap_or(false),
            },
            Ok(Err(error)) => {
                let message = format!("MCP tool call failed: {error}");
                self.set_error(&route.server_id, &message).await;
                tool_error(message)
            }
            Err(_) => tool_error("MCP tool call timed out after 120 seconds".to_owned()),
        }
    }

    pub async fn set_error(&self, server_id: &str, error: &str) {
        self.errors
            .write()
            .await
            .insert(server_id.to_owned(), error.to_owned());
    }
}

async fn connect(
    server: &McpServerConfig,
    secrets: &McpSecretValues,
) -> Result<(ClientService, Vec<rmcp::model::Tool>), String> {
    let service = match server.transport {
        McpTransport::Stdio => {
            let command_name = server.command.as_deref().unwrap_or_default();
            let mut command = Command::new(command_name);
            command.args(&server.args);
            for (key, value) in &server.environment {
                command.env(key, value);
            }
            for (key, value) in &secrets.environment {
                command.env(key, value);
            }
            hide_console_window(&mut command);
            let transport = TokioChildProcess::new(command)
                .map_err(|error| format!("Could not start MCP server: {error}"))?;
            ().serve(transport)
                .await
                .map_err(|error| format!("MCP initialization failed: {error}"))?
        }
        McpTransport::StreamableHttp => {
            let mut headers = HashMap::new();
            for (key, value) in server.headers.iter().chain(secrets.headers.iter()) {
                let name = HeaderName::from_bytes(key.as_bytes())
                    .map_err(|_| format!("Invalid MCP HTTP header name: {key}"))?;
                let value = HeaderValue::from_str(value)
                    .map_err(|_| format!("Invalid value for MCP HTTP header: {key}"))?;
                headers.insert(name, value);
            }
            let config = StreamableHttpClientTransportConfig::with_uri(
                server.url.as_deref().unwrap_or_default(),
            )
            .custom_headers(headers)
            .reinit_on_expired_session(true);
            let transport = StreamableHttpClientTransport::from_config(config);
            ().serve(transport)
                .await
                .map_err(|error| format!("MCP initialization failed: {error}"))?
        }
    };
    let tools = service
        .peer()
        .list_all_tools()
        .await
        .map_err(|error| format!("Could not list MCP tools: {error}"))?;
    Ok((service, tools))
}

fn validate_server(server: &McpServerConfig, secrets: &McpSecretValues) -> Result<(), String> {
    if server.id.trim().is_empty() || server.name.trim().is_empty() {
        return Err("MCP server ID and name are required".to_owned());
    }
    match server.transport {
        McpTransport::Stdio
            if server
                .command
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty() =>
        {
            Err("A command is required for an stdio MCP server".to_owned())
        }
        McpTransport::StreamableHttp => {
            let url = server.url.as_deref().unwrap_or_default();
            let parsed =
                url::Url::parse(url).map_err(|_| "MCP server URL is invalid".to_owned())?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("MCP server URL must use HTTP or HTTPS".to_owned());
            }
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err(
                    "MCP server credentials must use secret headers, not URL userinfo".to_owned(),
                );
            }
            let carries_secrets =
                !server.secret_header_keys.is_empty() || !secrets.headers.is_empty();
            let loopback = parsed.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
            if parsed.scheme() == "http" && carries_secrets && !loopback {
                return Err(
                    "Remote MCP servers with secret headers must use HTTPS; plain HTTP is allowed only for loopback development"
                        .to_owned(),
                );
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn exposed_tool_name(server_id: &str, original_name: &str) -> String {
    let alias = sanitize(server_id, 8);
    let stem = sanitize(original_name, 28);
    let hash = fnv1a(format!("{server_id}\0{original_name}").as_bytes());
    format!("mcp_{alias}_{stem}_{hash:016x}")
}

fn sanitize(value: &str, limit: usize) -> String {
    let value: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(limit)
        .collect();
    if value.is_empty() {
        "tool".to_owned()
    } else {
        value
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn format_result(result: &rmcp::model::CallToolResult) -> String {
    let mut parts: Vec<String> = result
        .content
        .iter()
        .filter_map(|content| content.as_text().map(|text| text.text.clone()))
        .collect();
    if parts.is_empty() {
        if let Some(value) = &result.structured_content {
            parts.push(serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()));
        } else if !result.content.is_empty() {
            parts.push(
                serde_json::to_string_pretty(&result.content)
                    .unwrap_or_else(|_| "MCP tool returned non-text content".to_owned()),
            );
        }
    }
    if parts.is_empty() {
        "MCP tool completed without content".to_owned()
    } else {
        truncate_output(parts.join("\n"))
    }
}

fn truncate_output(value: String) -> String {
    if value.chars().count() <= MAX_OUTPUT_CHARS {
        value
    } else {
        format!(
            "{}\n… MCP output truncated",
            value.chars().take(MAX_OUTPUT_CHARS).collect::<String>()
        )
    }
}

fn tool_error(output: String) -> ToolExecutionResponse {
    ToolExecutionResponse {
        output,
        is_error: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn fixture_server() -> McpServerConfig {
        McpServerConfig {
            id: "fixture".to_owned(),
            name: "Fixture".to_owned(),
            enabled: true,
            transport: McpTransport::Stdio,
            command: Some("node".to_owned()),
            args: vec![
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/mcp_server.cjs")
                    .to_string_lossy()
                    .into_owned(),
            ],
            url: None,
            environment: BTreeMap::new(),
            headers: BTreeMap::new(),
            secret_environment_keys: Vec::new(),
            secret_header_keys: Vec::new(),
        }
    }

    #[test]
    fn exposed_names_are_stable_bounded_and_distinct() {
        let first = exposed_tool_name("server-with-a-long-id", "read/something complicated");
        let same = exposed_tool_name("server-with-a-long-id", "read/something complicated");
        let other = exposed_tool_name("server-with-a-long-id", "read_something complicated");
        assert_eq!(first, same);
        assert_ne!(first, other);
        assert!(first.len() <= 64);
        assert!(
            first
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        );
    }

    #[test]
    fn validates_transport_specific_fields() {
        let mut server = fixture_server();
        server.command = None;
        let secrets = McpSecretValues::default();
        assert!(validate_server(&server, &secrets).is_err());
        server.transport = McpTransport::StreamableHttp;
        server.url = Some("file:///tmp/server".to_owned());
        assert!(validate_server(&server, &secrets).is_err());
        server.url = Some("https://example.com/mcp".to_owned());
        assert!(validate_server(&server, &secrets).is_ok());
    }

    #[test]
    fn secret_headers_require_https_except_on_loopback() {
        let mut server = fixture_server();
        server.transport = McpTransport::StreamableHttp;
        server.command = None;
        server.secret_header_keys = vec!["Authorization".to_owned()];
        let secrets = McpSecretValues {
            environment: BTreeMap::new(),
            headers: BTreeMap::from([("Authorization".to_owned(), "Bearer secret".to_owned())]),
        };

        server.url = Some("http://mcp.example.test/rpc".to_owned());
        assert!(validate_server(&server, &secrets).is_err());
        server.url = Some("http://127.0.0.1:3210/rpc".to_owned());
        assert!(validate_server(&server, &secrets).is_ok());
        server.url = Some("https://mcp.example.test/rpc".to_owned());
        assert!(validate_server(&server, &secrets).is_ok());
        server.url = Some("https://user:password@mcp.example.test/rpc".to_owned());
        assert!(validate_server(&server, &secrets).is_err());
    }

    #[tokio::test]
    async fn connects_lists_and_calls_a_real_stdio_server() {
        let manager = McpManager::default();
        let server = fixture_server();
        let tools = manager
            .start(&server, &McpSecretValues::default())
            .await
            .unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].description,
            "Echo a value from the integration fixture."
        );
        let response = manager
            .execute(&tools[0].name, serde_json::json!({ "value": "ready" }))
            .await;
        assert!(!response.is_error);
        assert_eq!(response.output, "echo:ready");
        assert!(manager.stop(&server.id).await);
    }
}
