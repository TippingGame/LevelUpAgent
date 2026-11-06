use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub pet_id: String,
    pub name: String,
    pub profile_id: String,
    pub persona: String,
    pub enabled: bool,
    #[serde(default)]
    pub revision: i64,
    pub daily_reply_limit: u32,
    pub cooldown_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub app_id: String,
    pub tenant_id: String,
    pub endpoint: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<DesktopConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub version: u32,
    pub window_title: String,
    pub self_names: Vec<String>,
    #[serde(default = "default_desktop_input_mode")]
    pub input_mode: String,
    #[serde(default)]
    pub application: Option<String>,
    #[serde(default)]
    pub process_name: Option<String>,
    #[serde(default)]
    pub window_handle: Option<u64>,
    #[serde(default)]
    pub reference_size: Option<[u32; 2]>,
    #[serde(default)]
    pub editor_placeholder: Option<String>,
    pub layout: DesktopLayout,
}
fn default_desktop_input_mode() -> String {
    "background".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopLayout {
    pub title: [f64; 4],
    pub messages: [f64; 4],
    pub editor: [f64; 4],
    pub sidebar: [f64; 4],
    pub send: [f64; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<[f64; 4]>,
    #[serde(
        default,
        rename = "sendButton",
        skip_serializing_if = "Option::is_none"
    )]
    pub send_button: Option<[f64; 4]>,
}
impl DesktopConfig {
    pub fn validate(&self) -> Result<(), String> {
        let valid_box = |b: &[f64; 4]| {
            b.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)) && b[0] < b[2] && b[1] < b[3]
        };
        if !matches!(self.version, 1 | 2)
            || !matches!(self.input_mode.as_str(), "background" | "foreground")
            || self.window_title.trim().is_empty()
            || self.window_title.len() > 500
            || (self.version == 1 && self.self_names.is_empty())
            || self.self_names.len() > 10
            || self
                .self_names
                .iter()
                .any(|n| n.trim().is_empty() || n.len() > 240)
            || ![
                &self.layout.title,
                &self.layout.messages,
                &self.layout.editor,
                &self.layout.sidebar,
            ]
            .into_iter()
            .all(valid_box)
            || !self
                .layout
                .send
                .iter()
                .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
        {
            return Err(
                "请选择应用窗口并完成区域框选 / Choose a window and calibrate all regions".into(),
            );
        }
        if self.version == 2 {
            let app = self.application.as_deref().unwrap_or("dingtalk");
            if !matches!(app, "dingtalk" | "custom")
                || (app == "custom"
                    && (self.input_mode != "foreground"
                        || !self.process_name.as_ref().is_some_and(|s| {
                            !s.trim().is_empty() && s.len() <= 260 && !s.contains(['/', '\\'])
                        })))
                || !self
                    .reference_size
                    .is_some_and(|s| s[0] > 0 && s[1] > 0 && s[0] <= 16384 && s[1] <= 16384)
                || !self.layout.notification.as_ref().is_some_and(valid_box)
                || !self.layout.send_button.as_ref().is_some_and(valid_box)
                || self
                    .editor_placeholder
                    .as_ref()
                    .is_some_and(|s| s.len() > 500)
            {
                return Err("请完成六个区域框选并绑定应用窗口 / Complete all six regions and bind the app window".into());
            }
            let b = self.layout.send_button.unwrap();
            if (self.layout.send[0] - (b[0] + b[2]) / 2.0).abs() > 0.000001
                || (self.layout.send[1] - (b[1] + b[3]) / 2.0).abs() > 0.000001
            {
                return Err(
                    "发送坐标须位于发送按钮框中心 / Send point must be the button center".into(),
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: String,
    pub bot_id: String,
    pub account_id: String,
    pub chat_type: String,
    /// Exact chat by default for preexisting persisted routes. All is opt-in.
    #[serde(default = "exact_scope")]
    pub scope: String,
    pub chat_id: String,
    pub topic_id: String,
    pub mode: String,
    pub paused: bool,
}
fn exact_scope() -> String {
    "exact".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Knowledge {
    pub id: String,
    pub bot_id: String,
    /// Empty means shared with this bot's explicitly allowlisted chats only.
    pub route_id: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationMemory {
    pub id: String,
    pub bot_id: String,
    pub route_id: String,
    pub sender_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inbound {
    pub message_id: String,
    pub chat_type: String,
    pub chat_id: String,
    #[serde(default)]
    pub topic_id: String,
    pub sender_id: String,
    pub text: String,
    #[serde(default)]
    pub mentioned: bool,
    #[serde(default)]
    pub sender_bot: bool,
    /// Opaque platform delivery context; never included in model requests.
    #[serde(default)]
    pub context: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: String,
    pub bot_id: String,
    pub account_id: String,
    pub route_id: String,
    pub chat_id: String,
    pub chat_type: String,
    pub topic_id: String,
    pub sender_id: String,
    pub text: String,
    pub status: String,
    pub reply: Option<String>,
    pub delivery: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    pub bot: Bot,
    pub route_id: String,
    pub session: String,
    pub inbound: Inbound,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    pub account_id: String,
    pub bot_id: String,
    pub inbound: Inbound,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub account_id: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub bots: Vec<Bot>,
    pub accounts: Vec<Account>,
    pub routes: Vec<Route>,
    pub knowledge: Vec<Knowledge>,
    pub memories: Vec<RelationMemory>,
    pub messages: Vec<MessageRecord>,
    pub connections: Vec<AccountState>,
    pub usage: Vec<Usage>,
    pub runtime_ready: bool,
    pub desktop_runtime_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub bot_id: String,
    pub replies_today: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
}
