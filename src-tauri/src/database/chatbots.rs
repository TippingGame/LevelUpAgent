//! Durable, account-bound bot inbox/outbox. All state transitions share SQLite's lock.
use super::{Database, database_error};
use crate::chatbots::types::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
#[cfg(test)]
#[path = "chatbots_tests.rs"]
mod tests;

type ChatContext = (Vec<(String, String)>, Vec<Knowledge>);

pub(super) fn migrate(c: &Connection) -> Result<(), String> {
    c.execute_batch("
        CREATE TABLE IF NOT EXISTS chat_bots(id TEXT PRIMARY KEY, pet_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_accounts(id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_routes(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES chat_bots(id), account_id TEXT NOT NULL REFERENCES chat_accounts(id), chat_type TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(account_id,chat_type,chat_id,topic_id));
        CREATE TABLE IF NOT EXISTS chat_knowledge(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES chat_bots(id), route_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_inbox(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, message_id TEXT NOT NULL, bot_id TEXT NOT NULL, route_id TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(account_id,message_id));
        CREATE TABLE IF NOT EXISTS chat_outbox(id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL UNIQUE REFERENCES chat_inbox(id), text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS chat_inbox_work ON chat_inbox(status,created_at);
        CREATE INDEX IF NOT EXISTS chat_inbox_session ON chat_inbox(session,created_at);
        CREATE TABLE IF NOT EXISTS chat_seen(account_id TEXT NOT NULL,message_id TEXT NOT NULL,inbox_id TEXT NOT NULL,PRIMARY KEY(account_id,message_id));
        INSERT OR IGNORE INTO chat_seen SELECT account_id,message_id,id FROM chat_inbox;
        CREATE TABLE IF NOT EXISTS chat_relation_memory(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES chat_bots(id),route_id TEXT NOT NULL REFERENCES chat_routes(id),sender_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(bot_id,route_id,sender_id));
        CREATE TABLE IF NOT EXISTS chat_attempts(inbox_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,started_at INTEGER NOT NULL,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0);
    ").map_err(database_error)
}
fn encode<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}
fn decode<T: DeserializeOwned>(value: String) -> Result<T, String> {
    serde_json::from_str(&value).map_err(|e| e.to_string())
}
fn all<T: DeserializeOwned>(c: &Connection, table: &str) -> Result<Vec<T>, String> {
    let mut q = c
        .prepare(&format!("SELECT data FROM {table} ORDER BY rowid"))
        .map_err(database_error)?;
    q.query_map([], |r| r.get::<_, String>(0))
        .map_err(database_error)?
        .map(|r| decode(r.map_err(database_error)?))
        .collect()
}
fn one<T: DeserializeOwned>(c: &Connection, table: &str, id: &str) -> Result<Option<T>, String> {
    c.query_row(&format!("SELECT data FROM {table} WHERE id=?"), [id], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .map_err(database_error)?
    .map(decode)
    .transpose()
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn cancel(c: &Connection, column: &str, id: &str) -> Result<(), String> {
    c.execute(&format!("UPDATE chat_outbox SET status='cancelled' WHERE status='pending' AND inbox_id IN (SELECT id FROM chat_inbox WHERE {column}=?)"), [id]).map_err(database_error)?;
    c.execute(&format!("UPDATE chat_inbox SET status='cancelled' WHERE status IN ('queued','generating','generated') AND {column}=?"), [id]).map_err(database_error)?;
    Ok(())
}
fn resolve_route(
    c: &Connection,
    account: &str,
    inbound: &Inbound,
) -> Result<Option<Route>, String> {
    let candidates = all::<Route>(c, "chat_routes")?;
    let matches = |r: &&Route| r.account_id == account && r.chat_type == inbound.chat_type;
    Ok(candidates
        .iter()
        .filter(matches)
        .find(|r| {
            r.scope == "exact" && r.chat_id == inbound.chat_id && r.topic_id == inbound.topic_id
        })
        .or_else(|| candidates.iter().filter(matches).find(|r| r.scope == "all"))
        .cloned())
}
fn active(c: &Connection, inbox: &str) -> Result<bool, String> {
    let ids = c
        .query_row(
            "SELECT bot_id,route_id,account_id,status,payload FROM chat_inbox WHERE id=?",
            [inbox],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(database_error)?;
    let inbound: Inbound = decode(ids.4)?;
    Ok(
        resolve_route(c, &ids.2, &inbound)?.is_some_and(|r| r.id == ids.1 && !r.paused)
            && ids.3 != "cancelled"
            && one::<Bot>(c, "chat_bots", &ids.0)?.is_some_and(|b| b.enabled)
            && one::<Route>(c, "chat_routes", &ids.1)?.is_some_and(|r| !r.paused)
            && one::<Account>(c, "chat_accounts", &ids.2)?.is_some_and(|a| a.enabled),
    )
}

fn save_route(c: &Connection, mut route: Route) -> Result<Route, String> {
    if !["exact", "all"].contains(&route.scope.as_str()) {
        return Err("Invalid chat scope".into());
    }
    if route.scope == "all" {
        route.chat_id = "*".into();
        if !route.topic_id.is_empty() {
            return Err("All-chat rules cannot specify a topic".into());
        }
    } else if route.chat_id == "*" {
        return Err("Choose all-chat scope explicitly".into());
    }
    if !["direct", "group", "guild"].contains(&route.chat_type.as_str())
        || !["mention", "all"].contains(&route.mode.as_str())
        || route.chat_id.trim().is_empty()
        || route.chat_id.len() > 256
        || route.topic_id.len() > 256
    {
        return Err("Use an exact chat ID and a valid trigger".into());
    }
    let account =
        one::<Account>(c, "chat_accounts", &route.account_id)?.ok_or("Account missing")?;
    if route.chat_type == "group"
        && route.mode == "all"
        && ["qq", "dingtalk"].contains(&account.platform.as_str())
    {
        return Err("This official adapter receives group bot mentions only".into());
    }
    if account.platform == "dingtalk_desktop" {
        if route.scope == "all" {
            return Err(
                "Desktop mode cannot discover every chat; select registered titles instead".into(),
            );
        }
        if !route.topic_id.is_empty() || route.chat_id.trim() != route.chat_id {
            return Err("Desktop routes use an exact full title without topic IDs".into());
        }
        if all::<Route>(c, "chat_routes")?.iter().any(|r| {
            r.id != route.id
                && r.account_id == route.account_id
                && r.chat_id.split_whitespace().collect::<String>()
                    == route.chat_id.split_whitespace().collect::<String>()
        }) {
            return Err("A desktop chat title can belong to only one route".into());
        }
    }
    if route.chat_type == "guild" {
        return Err("Guild channels are not enabled in this adapter version".into());
    }
    if route.id.is_empty() {
        route.id = uuid::Uuid::new_v4().to_string();
    }
    if let Some(old) = one::<Route>(c, "chat_routes", &route.id)?
        && (old.scope != route.scope
            || old.bot_id != route.bot_id
            || old.account_id != route.account_id
            || old.chat_id != route.chat_id
            || old.chat_type != route.chat_type
            || old.topic_id != route.topic_id)
    {
        return Err("Delete and recreate a route to change its identity".into());
    }
    c.execute("INSERT INTO chat_routes VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![route.id,route.bot_id,route.account_id,route.chat_type,route.chat_id,route.topic_id,encode(&route)?]).map_err(|_|"This chat already belongs to a bot, or its bot/account no longer exists".to_string())?;
    cancel(c, "route_id", &route.id)?;
    Ok(route)
}

impl Database {
    pub fn chat_account_disconnected(&self, account: &str) -> Result<(), String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        c.execute("UPDATE chat_outbox SET status='delivery_unknown',error='Gateway disconnected during send; verify in platform' WHERE status='sending' AND inbox_id IN (SELECT id FROM chat_inbox WHERE account_id=?)",[account]).map_err(database_error)?;
        Ok(())
    }
    pub fn chat_save_bot(&self, mut bot: Bot) -> Result<Bot, String> {
        if bot.name.trim().is_empty()
            || bot.name.len() > 120
            || bot.persona.len() > 16000
            || bot.daily_reply_limit == 0
            || bot.daily_reply_limit > 10000
            || bot.cooldown_seconds > 3600
        {
            return Err("Invalid bot name, persona or limits".into());
        }
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        if bot.id.is_empty() {
            bot.id = uuid::Uuid::new_v4().to_string();
        }
        let previous = one::<Bot>(&c, "chat_bots", &bot.id)?;
        if previous.as_ref().is_some_and(|b| b.pet_id != bot.pet_id) {
            return Err("A bot's pet identity cannot be reassigned".into());
        }
        bot.revision = previous.map_or(1, |b| b.revision + 1);
        c.execute("INSERT INTO chat_bots VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![bot.id,bot.pet_id,encode(&bot)?]).map_err(database_error)?;
        cancel(&c, "bot_id", &bot.id)?;
        Ok(bot)
    }
    pub fn chat_save_account(&self, mut account: Account) -> Result<Account, String> {
        if !["feishu", "dingtalk", "qq", "onebot", "dingtalk_desktop"]
            .contains(&account.platform.as_str())
            || account.app_id.trim().is_empty()
            || account.app_id.len() > 200
            || account.name.len() > 120
            || account.tenant_id.len() > 200
        {
            return Err("Invalid account".into());
        }
        if account.platform == "dingtalk_desktop" {
            account
                .desktop
                .as_ref()
                .ok_or("Desktop configuration missing")?
                .validate()?;
            if !account.endpoint.is_empty() || !account.tenant_id.is_empty() {
                return Err("Desktop accounts do not use platform endpoints or tenant IDs".into());
            }
        } else if account.desktop.is_some() {
            return Err("Desktop settings only apply to desktop accounts".into());
        }
        if account.platform == "onebot" {
            let url = url::Url::parse(&account.endpoint)
                .map_err(|_| "OneBot needs a ws://127.0.0.1:port URL")?;
            if url.scheme() != "ws"
                || ![Some("127.0.0.1"), Some("[::1]")].contains(&url.host_str())
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("OneBot must use an authenticated loopback WebSocket endpoint without URL credentials".into());
            }
        } else if !account.endpoint.is_empty() {
            return Err("Official platform endpoints are fixed".into());
        }
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        if account.id.is_empty() {
            account.id = uuid::Uuid::new_v4().to_string();
        }
        if account.platform == "dingtalk_desktop"
            && all::<Account>(&c, "chat_accounts")?
                .iter()
                .any(|a| a.id != account.id && a.platform == "dingtalk_desktop")
        {
            return Err(
                "Only one DingTalk desktop controller is allowed; bind multiple chats to it".into(),
            );
        }
        if let Some(old) = one::<Account>(&c, "chat_accounts", &account.id)?
            && (old.platform != account.platform
                || old.app_id != account.app_id
                || old.tenant_id != account.tenant_id)
        {
            return Err("Create a new account to change platform identity".into());
        }
        let identity = encode(&(account.platform.clone(), account.app_id.clone()))?;
        c.execute("INSERT INTO chat_accounts VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![account.id,identity,encode(&account)?]).map_err(database_error)?;
        cancel(&c, "account_id", &account.id)?;
        Ok(account)
    }
    pub fn chat_save_route(&self, route: Route) -> Result<Route, String> {
        self.chat_save_routes(vec![route])?
            .pop()
            .ok_or("Route missing".into())
    }
    pub fn chat_save_routes(&self, routes: Vec<Route>) -> Result<Vec<Route>, String> {
        if routes.is_empty() || routes.len() > 500 {
            return Err("Select between 1 and 500 chat rules".into());
        }
        let mut c = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = c.transaction().map_err(database_error)?;
        let mut saved = Vec::new();
        for route in routes {
            saved.push(save_route(&tx, route)?);
        }
        for account in all::<Account>(&tx, "chat_accounts")?
            .iter()
            .filter(|a| a.platform == "dingtalk_desktop")
        {
            let count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM chat_routes WHERE account_id=?",
                    [&account.id],
                    |r| r.get(0),
                )
                .map_err(database_error)?;
            if count > 100 {
                return Err(
                    "Desktop mode supports at most 100 registered chats per account".into(),
                );
            }
        }
        // A new exact override must also invalidate work claimed by a fallback.
        // Recheck all pending matches before commit; never let a paused override
        // fall through to the all-chat rule.
        let pending: Vec<String> = {
            let mut q = tx
                .prepare(
                    "SELECT id FROM chat_inbox WHERE status IN ('queued','generating','generated')",
                )
                .map_err(database_error)?;
            q.query_map([], |r| r.get(0))
                .map_err(database_error)?
                .collect::<Result<_, _>>()
                .map_err(database_error)?
        };
        for id in pending {
            if !active(&tx, &id)? {
                cancel(&tx, "id", &id)?;
            }
        }
        tx.commit().map_err(database_error)?;
        Ok(saved)
    }
    pub fn chat_save_knowledge(&self, mut item: Knowledge) -> Result<Knowledge, String> {
        if item.title.trim().is_empty()
            || item.title.len() > 300
            || item.content.trim().is_empty()
            || item.content.len() > 100000
        {
            return Err("Knowledge requires a title and 1–100,000 bytes of text".into());
        }
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        if let Some(old) = one::<Knowledge>(&c, "chat_knowledge", &item.id)?
            && old.bot_id != item.bot_id
        {
            return Err("Knowledge cannot be reassigned to another bot".into());
        }
        let size:i64=c.query_row("SELECT COALESCE(SUM(length(data)),0) FROM chat_knowledge WHERE bot_id=?1 AND id!=?2",params![item.bot_id,item.id],|r|r.get(0)).map_err(database_error)?;
        if size + item.content.len() as i64 > 20_000_000 {
            return Err("This bot's text knowledge limit is 20 MB".into());
        }
        if !item.route_id.is_empty()
            && one::<Route>(&c, "chat_routes", &item.route_id)?
                .is_none_or(|r| r.bot_id != item.bot_id)
        {
            return Err("Knowledge route belongs to another bot".into());
        }
        if item.id.is_empty() {
            item.id = uuid::Uuid::new_v4().to_string();
        }
        c.execute("INSERT INTO chat_knowledge VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET bot_id=excluded.bot_id,route_id=excluded.route_id,data=excluded.data",params![item.id,item.bot_id,item.route_id,encode(&item)?]).map_err(database_error)?;
        cancel(&c, "bot_id", &item.bot_id)?;
        Ok(item)
    }
    pub fn chat_save_memory(&self, mut item: RelationMemory) -> Result<RelationMemory, String> {
        if item.sender_id.is_empty()
            || item.sender_id.len() > 256
            || item.content.trim().is_empty()
            || item.content.len() > 4000
        {
            return Err(
                "A relation memory requires a sender ID and up to 4000 bytes of text".into(),
            );
        }
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        if !one::<Route>(&c, "chat_routes", &item.route_id)?
            .is_some_and(|r| r.bot_id == item.bot_id && r.scope == "exact")
        {
            return Err("Memory requires a specific chat belonging to this bot".into());
        }
        if let Some(old) = one::<RelationMemory>(&c, "chat_relation_memory", &item.id)?
            && (old.bot_id != item.bot_id
                || old.route_id != item.route_id
                || old.sender_id != item.sender_id)
        {
            return Err("Delete and recreate memory to change its identity".into());
        }
        if item.id.is_empty() {
            item.id = uuid::Uuid::new_v4().to_string();
        }
        c.execute("INSERT INTO chat_relation_memory VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![item.id,item.bot_id,item.route_id,item.sender_id,encode(&item)?]).map_err(database_error)?;
        cancel(&c, "route_id", &item.route_id)?;
        Ok(item)
    }
    pub fn chat_memory_context(&self, job: &Job) -> Result<Vec<RelationMemory>, String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        let mut q=c.prepare("SELECT data FROM chat_relation_memory WHERE bot_id=?1 AND route_id=?2 AND sender_id=?3").map_err(database_error)?;
        q.query_map(
            params![job.bot.id, job.route_id, job.inbound.sender_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(database_error)?
        .map(|s| decode(s.map_err(database_error)?))
        .collect()
    }
    pub fn chat_delete(&self, kind: &str, id: &str) -> Result<(), String> {
        let mut c = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = c.transaction().map_err(database_error)?;
        match kind {
            "memory" => {
                let item = one::<RelationMemory>(&tx, "chat_relation_memory", id)?
                    .ok_or("Memory missing")?;
                cancel(&tx, "route_id", &item.route_id)?;
                tx.execute("DELETE FROM chat_relation_memory WHERE id=?", [id])
                    .map_err(database_error)?;
            }
            "knowledge" => {
                let k = one::<Knowledge>(&tx, "chat_knowledge", id)?.ok_or("Knowledge missing")?;
                cancel(&tx, "bot_id", &k.bot_id)?;
                tx.execute("DELETE FROM chat_knowledge WHERE id=?", [id])
                    .map_err(database_error)?;
            }
            "route" => {
                cancel(&tx, "route_id", id)?;
                tx.execute("DELETE FROM chat_relation_memory WHERE route_id=?", [id])
                    .map_err(database_error)?;
                tx.execute("DELETE FROM chat_knowledge WHERE route_id=?", [id])
                    .map_err(database_error)?;
                tx.execute("DELETE FROM chat_routes WHERE id=?", [id])
                    .map_err(database_error)?;
            }
            "history" => {
                cancel(&tx, "bot_id", id)?;
                tx.execute("DELETE FROM chat_outbox WHERE inbox_id IN (SELECT id FROM chat_inbox WHERE bot_id=?)",[id]).map_err(database_error)?;
                tx.execute("DELETE FROM chat_inbox WHERE bot_id=?", [id])
                    .map_err(database_error)?;
            }
            "account" => {
                let account = one::<Account>(&tx, "chat_accounts", id)?.ok_or("Account missing")?;
                if account.enabled {
                    return Err("Disconnect this account before removing it".into());
                }
                cancel(&tx, "account_id", id)?;
                tx.execute("DELETE FROM chat_relation_memory WHERE route_id IN (SELECT id FROM chat_routes WHERE account_id=?)",[id]).map_err(database_error)?;
                tx.execute("DELETE FROM chat_knowledge WHERE route_id IN (SELECT id FROM chat_routes WHERE account_id=?)",[id]).map_err(database_error)?;
                tx.execute("DELETE FROM chat_routes WHERE account_id=?", [id])
                    .map_err(database_error)?;
                tx.execute("DELETE FROM chat_outbox WHERE inbox_id IN (SELECT id FROM chat_inbox WHERE account_id=?)",[id]).map_err(database_error)?;
                tx.execute("DELETE FROM chat_inbox WHERE account_id=?", [id])
                    .map_err(database_error)?;
                tx.execute("DELETE FROM chat_accounts WHERE id=?", [id])
                    .map_err(database_error)?;
            }
            _ => return Err("Unsupported deletion".into()),
        }
        tx.commit().map_err(database_error)
    }
    pub fn chat_accounts(&self) -> Result<Vec<Account>, String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        all(&c, "chat_accounts")
    }
    pub fn chat_dashboard(&self) -> Result<Dashboard, String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        // Unresolved sends block their session and must remain actionable even
        // when newer traffic pushes them outside the recent-message window.
        let mut q=c.prepare("SELECT i.id,i.bot_id,i.account_id,i.route_id,i.payload,i.status,o.text,o.status,COALESCE(o.error,i.error),i.created_at FROM chat_inbox i LEFT JOIN chat_outbox o ON o.inbox_id=i.id WHERE i.rowid IN (SELECT rowid FROM chat_inbox ORDER BY rowid DESC LIMIT 200) OR o.status='delivery_unknown' ORDER BY CASE WHEN o.status='delivery_unknown' THEN 0 ELSE 1 END,i.rowid DESC").map_err(database_error)?;
        let records = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)?,
                ))
            })
            .map_err(database_error)?;
        let mut messages = Vec::new();
        for row in records {
            let r = row.map_err(database_error)?;
            let i: Inbound = decode(r.4)?;
            messages.push(MessageRecord {
                id: r.0,
                bot_id: r.1,
                account_id: r.2,
                route_id: r.3,
                chat_id: i.chat_id,
                chat_type: i.chat_type,
                topic_id: i.topic_id,
                sender_id: i.sender_id,
                text: i.text,
                status: r.5,
                reply: r.6,
                delivery: r.7,
                error: r.8,
                created_at: r.9,
            });
        }
        let mut q=c.prepare("SELECT bot_id,SUM(CASE WHEN started_at>=?1 THEN 1 ELSE 0 END),SUM(input_tokens),SUM(output_tokens) FROM chat_attempts GROUP BY bot_id").map_err(database_error)?;
        let usage = q
            .query_map([now() - now().rem_euclid(86400000)], |r| {
                Ok(Usage {
                    bot_id: r.get(0)?,
                    replies_today: r.get(1)?,
                    input_tokens: r.get(2)?,
                    output_tokens: r.get(3)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(Dashboard {
            bots: all(&c, "chat_bots")?,
            accounts: all(&c, "chat_accounts")?,
            routes: all(&c, "chat_routes")?,
            knowledge: all(&c, "chat_knowledge")?,
            memories: all(&c, "chat_relation_memory")?,
            messages,
            connections: vec![],
            usage,
            runtime_ready: false,
            desktop_runtime_ready: false,
        })
    }
    pub fn chat_receive(&self, account_id: &str, mut inbound: Inbound) -> Result<String, String> {
        if inbound.message_id.is_empty()
            || inbound.message_id.len() > 256
            || inbound.chat_id.is_empty()
            || inbound.chat_id.len() > 256
            || inbound.sender_id.is_empty()
            || inbound.sender_id.len() > 256
            || inbound.topic_id.len() > 256
            || inbound.text.len() > 16000
        {
            return Err("Invalid or oversized platform message".into());
        }
        // Platform authorization context, URLs and arbitrary fields never enter storage or prompts.
        inbound.context = serde_json::Value::Null;
        let mut c = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = c.transaction().map_err(database_error)?;
        let account = one::<Account>(&tx, "chat_accounts", account_id)?.ok_or("Unknown account")?;
        if let Some(id) = tx
            .query_row(
                "SELECT inbox_id FROM chat_seen WHERE account_id=?1 AND message_id=?2",
                params![account_id, inbound.message_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
        {
            return Ok(id);
        }
        let route = resolve_route(&tx, account_id, &inbound)?;
        let bot = route
            .as_ref()
            .map(|r| one::<Bot>(&tx, "chat_bots", &r.bot_id))
            .transpose()?
            .flatten();
        let bot_id = bot.as_ref().map(|b| b.id.clone()).unwrap_or_default();
        let route_id = route.as_ref().map(|r| r.id.clone()).unwrap_or_default();
        let session = format!(
            "{:x}",
            Sha256::digest(
                encode(&(
                    &bot_id,
                    &account.tenant_id,
                    account_id,
                    &inbound.chat_type,
                    &inbound.chat_id,
                    &inbound.topic_id
                ))?
                .as_bytes()
            )
        );
        let known_bot = all::<Account>(&tx, "chat_accounts")?
            .iter()
            .any(|a| a.platform == account.platform && a.app_id == inbound.sender_id);
        let status = if inbound.sender_bot || known_bot {
            "ignored_bot"
        } else if inbound.text.trim().is_empty() {
            "unsupported_media"
        } else if route.is_none() {
            "unrouted"
        } else if !account.enabled
            || !bot.as_ref().is_some_and(|b| b.enabled)
            || route.as_ref().is_some_and(|r| r.paused)
        {
            "paused"
        } else if inbound.chat_type != "direct"
            && route.as_ref().is_some_and(|r| r.mode == "mention")
            && !inbound.mentioned
        {
            "ignored_trigger"
        } else {
            "queued"
        };
        let pending: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM chat_inbox WHERE status IN ('queued','generating')",
                [],
                |r| r.get(0),
            )
            .map_err(database_error)?;
        let status = if status == "queued" && pending >= 500 {
            "queue_full"
        } else {
            status
        };
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO chat_seen VALUES(?1,?2,?3)",
            params![account_id, inbound.message_id, id],
        )
        .map_err(database_error)?;
        tx.execute("INSERT INTO chat_inbox(id,account_id,message_id,bot_id,route_id,session,payload,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,account_id,inbound.message_id,bot_id,route_id,session,encode(&inbound)?,status,now()]).map_err(database_error)?;
        tx.commit().map_err(database_error)?;
        Ok(id)
    }
    pub fn chat_recover(&self) -> Result<(), String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        c.execute_batch("UPDATE chat_inbox SET status='interrupted',error='Application stopped during generation; not automatically regenerated' WHERE status='generating'; UPDATE chat_outbox SET status='delivery_unknown',error='Process stopped after send was claimed; verify in platform' WHERE status='sending';").map_err(database_error)
    }
    pub fn chat_claim(&self) -> Result<Option<Job>, String> {
        let mut c = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = c.transaction().map_err(database_error)?;
        let row=tx.query_row("SELECT i.id,i.bot_id,i.route_id,i.session,i.payload FROM chat_inbox i WHERE i.status='queued' AND NOT EXISTS(SELECT 1 FROM chat_inbox x LEFT JOIN chat_outbox o ON o.inbox_id=x.id WHERE x.session=i.session AND x.rowid<i.rowid AND (x.status IN ('queued','generating') OR o.status IN ('pending','sending','delivery_unknown'))) ORDER BY i.rowid LIMIT 1",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).optional().map_err(database_error)?;
        let Some((id, bot_id, route_id, session, payload)) = row else {
            return Ok(None);
        };
        let bot = one::<Bot>(&tx, "chat_bots", &bot_id)?.ok_or("Bot missing")?;
        let count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM chat_attempts WHERE bot_id=?1 AND started_at>=?2",
                params![bot_id, now() - now().rem_euclid(86400000)],
                |r| r.get(0),
            )
            .map_err(database_error)?;
        let recent: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM chat_attempts WHERE bot_id=?1 AND started_at>?2",
                params![bot_id, now() - i64::from(bot.cooldown_seconds) * 1000],
                |r| r.get(0),
            )
            .map_err(database_error)?;
        let status = if !active(&tx, &id)? {
            "cancelled"
        } else if count >= i64::from(bot.daily_reply_limit) || recent > 0 {
            "rate_limited"
        } else {
            "generating"
        };
        tx.execute(
            "UPDATE chat_inbox SET status=?1 WHERE id=?2",
            params![status, id],
        )
        .map_err(database_error)?;
        if status == "generating" {
            tx.execute(
                "INSERT INTO chat_attempts(inbox_id,bot_id,started_at) VALUES(?1,?2,?3)",
                params![id, bot_id, now()],
            )
            .map_err(database_error)?;
        }
        tx.commit().map_err(database_error)?;
        if status != "generating" {
            return Ok(None);
        }
        Ok(Some(Job {
            id,
            bot,
            route_id,
            session,
            inbound: decode(payload)?,
        }))
    }
    pub fn chat_job_active(&self, id: &str) -> Result<bool, String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        Ok(active(&c, id)?
            && c.query_row(
                "SELECT status='generating' FROM chat_inbox WHERE id=?",
                [id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(database_error)?)
    }
    pub fn chat_context(&self, job: &Job) -> Result<ChatContext, String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        let mut q=c.prepare("SELECT i.payload,o.text FROM chat_inbox i JOIN chat_outbox o ON o.inbox_id=i.id WHERE i.session=? AND o.status='sent' ORDER BY i.rowid DESC LIMIT 12").map_err(database_error)?;
        let mut history = Vec::new();
        for r in q
            .query_map([&job.session], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(database_error)?
        {
            let (s, reply) = r.map_err(database_error)?;
            let m: Inbound = decode(s)?;
            history.push((format!("{}: {}", m.sender_id, m.text), reply));
        }
        history.reverse();
        // ACL is applied in SQL, before scoring or text extraction.
        let mut q = c
            .prepare(
                "SELECT data FROM chat_knowledge WHERE bot_id=?1 AND (route_id='' OR route_id=?2)",
            )
            .map_err(database_error)?;
        let documents = q
            .query_map(params![job.bot.id, job.route_id], |r| r.get::<_, String>(0))
            .map_err(database_error)?
            .map(|s| decode::<Knowledge>(s.map_err(database_error)?))
            .collect::<Result<Vec<_>, String>>()?;
        let mut knowledge = Vec::new();
        for document in documents {
            let chars: Vec<char> = document.content.chars().collect();
            for chunk in chars.chunks(1200) {
                let mut excerpt = document.clone();
                excerpt.content = chunk.iter().collect();
                knowledge.push(excerpt);
            }
        }
        let query = job.inbound.text.to_lowercase();
        let chars: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).collect();
        let terms: Vec<String> = chars
            .windows(2)
            .map(|w| w.iter().collect())
            .take(200)
            .collect();
        knowledge.sort_by_cached_key(|k| {
            let content = format!("{} {}", k.title, k.content).to_lowercase();
            std::cmp::Reverse(
                terms
                    .iter()
                    .filter(|t| content.contains(t.as_str()))
                    .count(),
            )
        });
        knowledge.truncate(5);
        Ok((history, knowledge))
    }
    pub fn chat_generated(
        &self,
        job: &Job,
        text: &str,
        input: u64,
        output: u64,
    ) -> Result<(), String> {
        let mut c = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = c.transaction().map_err(database_error)?;
        if active(&tx, &job.id)?
            && tx
                .query_row(
                    "SELECT status='generating' FROM chat_inbox WHERE id=?",
                    [&job.id],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(database_error)?
        {
            tx.execute(
                "INSERT INTO chat_outbox VALUES(?1,?2,?3,'pending',NULL,?4)",
                params![uuid::Uuid::new_v4().to_string(), job.id, text, now()],
            )
            .map_err(database_error)?;
            tx.execute("UPDATE chat_inbox SET status='generated',input_tokens=?1,output_tokens=?2 WHERE id=?3",params![input,output,job.id]).map_err(database_error)?;
        }
        tx.execute(
            "UPDATE chat_attempts SET input_tokens=?1,output_tokens=?2 WHERE inbox_id=?3",
            params![input, output, job.id],
        )
        .map_err(database_error)?;
        tx.commit().map_err(database_error)
    }
    pub fn chat_failed(&self, id: &str, error: &str) -> Result<(), String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        c.execute(
            "UPDATE chat_inbox SET status='failed',error=?1 WHERE id=?2 AND status='generating'",
            params![error, id],
        )
        .map_err(database_error)?;
        Ok(())
    }
    pub fn chat_delivery(&self, account: &str) -> Result<Option<Delivery>, String> {
        let mut c = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = c.transaction().map_err(database_error)?;
        let row=tx.query_row("SELECT o.id,i.id,i.bot_id,i.payload,o.text FROM chat_outbox o JOIN chat_inbox i ON i.id=o.inbox_id WHERE i.account_id=? AND o.status='pending' ORDER BY o.rowid LIMIT 1",[account],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).optional().map_err(database_error)?;
        let Some((id, inbox, bot_id, payload, text)) = row else {
            return Ok(None);
        };
        let permitted = active(&tx, &inbox)?;
        tx.execute(
            "UPDATE chat_outbox SET status=?1 WHERE id=?2",
            params![if permitted { "sending" } else { "cancelled" }, id],
        )
        .map_err(database_error)?;
        tx.commit().map_err(database_error)?;
        if !permitted {
            return Ok(None);
        }
        Ok(Some(Delivery {
            id,
            account_id: account.into(),
            bot_id,
            inbound: decode(payload)?,
            text,
        }))
    }
    /// Only desktop pre-input deferrals can return an unchanged reply to pending.
    /// Never reuse this for an uncertain click, official API retry or reconnect.
    pub fn chat_delivery_deferred(&self, account: &str, id: &str) -> Result<(), String> {
        let mut c = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = c.transaction().map_err(database_error)?;
        let a = one::<Account>(&tx, "chat_accounts", account)?.ok_or("Account missing")?;
        if a.platform != "dingtalk_desktop" {
            return Err("Only desktop pre-input deferrals can be queued again".into());
        }
        let inbox: Option<String> = tx.query_row(
            "SELECT o.inbox_id FROM chat_outbox o JOIN chat_inbox i ON i.id=o.inbox_id WHERE o.id=?1 AND o.status='sending' AND i.account_id=?2",
            params![id, account], |r| r.get(0),
        ).optional().map_err(database_error)?;
        if let Some(inbox) = inbox {
            let state = if active(&tx, &inbox)? {
                "pending"
            } else {
                "cancelled"
            };
            tx.execute(
                "UPDATE chat_outbox SET status=?1,error=NULL WHERE id=?2 AND status='sending'",
                params![state, id],
            )
            .map_err(database_error)?;
        }
        tx.commit().map_err(database_error)
    }

    pub fn chat_delivery_result(
        &self,
        account: &str,
        id: &str,
        status: &str,
    ) -> Result<(), String> {
        if !["sent", "failed", "delivery_unknown", "cancelled"].contains(&status) {
            return Err("Invalid delivery state".into());
        }
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        let error = match status {
            "failed" => {
                Some("Platform rejected the send before confirmation; inspect account settings")
            }
            "delivery_unknown" => {
                Some("Delivery may have succeeded; verify in platform before resolving")
            }
            _ => None,
        };
        c.execute("UPDATE chat_outbox SET status=?1,error=?2 WHERE id=?3 AND status='sending' AND inbox_id IN (SELECT id FROM chat_inbox WHERE account_id=?4)",params![status,error,id,account]).map_err(database_error)?;
        c.execute("UPDATE chat_inbox SET status='sent' WHERE id IN (SELECT inbox_id FROM chat_outbox WHERE id=?1 AND status='sent')",[id]).map_err(database_error)?;
        Ok(())
    }
    pub fn chat_resolve_delivery(&self, inbox_id: &str, sent: bool) -> Result<(), String> {
        let c = self.connection.lock().map_err(|e| e.to_string())?;
        c.execute("UPDATE chat_outbox SET status=?1,error=NULL WHERE inbox_id=?2 AND status IN ('delivery_unknown','failed')",params![if sent{"sent"}else{"cancelled"},inbox_id]).map_err(database_error)?;
        if sent {
            c.execute("UPDATE chat_inbox SET status='sent' WHERE id=? AND EXISTS (SELECT 1 FROM chat_outbox WHERE inbox_id=chat_inbox.id AND status='sent')",[inbox_id]).map_err(database_error)?;
        }
        Ok(())
    }
}
