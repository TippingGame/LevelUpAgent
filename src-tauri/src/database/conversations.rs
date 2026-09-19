use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Database, database_error};
use crate::models::ImageAttachment;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComposerDraft {
    pub content: String,
    pub attachments: Vec<ImageAttachment>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCursor {
    pub updated_at: i64,
    pub id: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListQuery {
    #[serde(default)]
    pub query: String,
    pub before: Option<ThreadCursor>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub workspace: Option<String>,
    pub kind: Option<String>,
    pub pet_id: Option<String>,
    pub updated_at: i64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPage {
    pub threads: Vec<ThreadSummary>,
    pub next_cursor: Option<ThreadCursor>,
}

impl Database {
    pub fn thread_attachment_ids(&self, thread_id: &str) -> Result<Vec<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection.prepare("SELECT attachments_json FROM messages WHERE thread_id = ?1 AND role = 'user' AND attachments_json != '[]'")
            .map_err(database_error)?;
        let rows = statement
            .query_map([thread_id], |row| row.get::<_, String>(0))
            .map_err(database_error)?;
        let mut ids = std::collections::BTreeSet::new();
        for row in rows {
            let attachments: Vec<ImageAttachment> =
                serde_json::from_str(&row.map_err(database_error)?)
                    .map_err(|error| error.to_string())?;
            ids.extend(attachments.into_iter().map(|item| item.id));
        }
        Ok(ids.into_iter().collect())
    }

    pub fn get_composer_draft(&self, thread_id: &str) -> Result<ComposerDraft, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let row = connection
            .query_row(
                "SELECT content, attachments_json FROM composer_drafts WHERE thread_id = ?1",
                [thread_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(database_error)?;
        row.map(|(content, attachments)| {
            Ok(ComposerDraft {
                content,
                attachments: serde_json::from_str(&attachments)
                    .map_err(|error| format!("Could not read draft attachments: {error}"))?,
            })
        })
        .unwrap_or_else(|| Ok(ComposerDraft::default()))
    }

    pub fn save_composer_draft(
        &self,
        thread_id: &str,
        draft: &ComposerDraft,
    ) -> Result<(), String> {
        if thread_id.is_empty() || thread_id.len() > 256 || draft.content.len() > 1024 * 1024 {
            return Err(
                "Invalid conversation draft: invalid thread ID or text exceeds 1 MiB".into(),
            );
        }
        let attachments =
            serde_json::to_string(&draft.attachments).map_err(|error| error.to_string())?;
        if attachments.len() > 1024 * 1024 {
            return Err("Draft attachment metadata exceeds 1 MiB".into());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        if draft.content.is_empty() && draft.attachments.is_empty() {
            connection
                .execute(
                    "DELETE FROM composer_drafts WHERE thread_id = ?1",
                    [thread_id],
                )
                .map_err(database_error)?;
        } else {
            connection.execute(
                "INSERT INTO composer_drafts (thread_id, content, attachments_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT(thread_id) DO UPDATE SET
                 content = excluded.content, attachments_json = excluded.attachments_json, updated_at = excluded.updated_at",
                params![thread_id, draft.content, attachments, super::now_millis()],
            ).map_err(database_error)?;
        }
        Ok(())
    }

    pub fn list_thread_summaries(&self, request: &ThreadListQuery) -> Result<ThreadPage, String> {
        let query = request.query.trim();
        if query.chars().count() > 256 {
            return Err("Conversation search is limited to 256 characters".into());
        }
        let limit = request.limit.unwrap_or(100).clamp(1, 200);
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Could not lock conversation database".to_owned())?;
        let mut statement = connection
            .prepare_cached(
                "SELECT t.id, t.title, t.workspace, t.kind, t.pet_id, t.updated_at,
                    t.input_tokens, t.output_tokens
             FROM threads t
             WHERE (?1 IS NULL OR (t.updated_at, t.id) < (?1, ?2))
               AND (?3 = '' OR instr(lower(t.title), lower(?3)) > 0
                    OR instr(lower(COALESCE(t.workspace, '')), lower(?3)) > 0
                    OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
                               AND m.internal = 0 AND m.role IN ('user', 'assistant')
                               AND instr(lower(m.content), lower(?3)) > 0))
             ORDER BY t.updated_at DESC, t.id DESC LIMIT ?4",
            )
            .map_err(database_error)?;
        let mut threads = statement
            .query_map(
                params![
                    request.before.as_ref().map(|cursor| cursor.updated_at),
                    request.before.as_ref().map(|cursor| cursor.id.as_str()),
                    query,
                    (limit + 1) as i64,
                ],
                |row| {
                    Ok(ThreadSummary {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        workspace: row.get(2)?,
                        kind: row.get(3)?,
                        pet_id: row.get(4)?,
                        updated_at: row.get(5)?,
                        input_tokens: row.get::<_, i64>(6)?.max(0) as u64,
                        output_tokens: row.get::<_, i64>(7)?.max(0) as u64,
                    })
                },
            )
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        let has_more = threads.len() > limit;
        threads.truncate(limit);
        let next_cursor = has_more
            .then(|| {
                threads.last().map(|thread| ThreadCursor {
                    updated_at: thread.updated_at,
                    id: thread.id.clone(),
                })
            })
            .flatten();
        Ok(ThreadPage {
            threads,
            next_cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::tests::sample_thread;
    use rusqlite::Connection;

    #[test]
    fn resource_read_grants_come_only_from_user_messages_in_the_requested_thread() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut thread = sample_thread();
        let item = ImageAttachment {
            id: "selected-resource".into(),
            name: "folder".into(),
            mime_type: "inode/directory".into(),
            size_bytes: 0,
            kind: crate::models::AttachmentKind::Folder,
            data_base64: None,
            text_content: None,
        };
        thread.messages[0].role = "user".into();
        thread.messages[0].attachments = vec![item.clone(), item.clone()];
        database.save_thread(&thread).unwrap();
        database
            .save_composer_draft(
                "draft-only",
                &ComposerDraft {
                    content: String::new(),
                    attachments: vec![item.clone()],
                },
            )
            .unwrap();
        assert_eq!(
            database.thread_attachment_ids(&thread.id).unwrap(),
            [item.id]
        );
        assert!(
            database
                .thread_attachment_ids("draft-only")
                .unwrap()
                .is_empty()
        );
        assert!(
            database
                .thread_attachment_ids("other-thread")
                .unwrap()
                .is_empty()
        );
        thread.messages[0].role = "assistant".into();
        database.save_thread(&thread).unwrap();
        assert!(
            database
                .thread_attachment_ids(&thread.id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn composer_drafts_survive_reopen_and_clear_without_changing_messages() {
        let directory =
            std::env::temp_dir().join(format!("levelup-draft-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join("drafts.sqlite");
        let draft = ComposerDraft {
            content: "  未发送的草稿\n".into(),
            attachments: (0..70)
                .map(|index| ImageAttachment {
                    id: format!("resource-{index}"),
                    name: format!("file-{index}.custom"),
                    mime_type: "application/octet-stream".into(),
                    size_bytes: 0,
                    kind: crate::models::AttachmentKind::File,
                    data_base64: None,
                    text_content: None,
                })
                .collect(),
        };
        {
            let database = Database::open(&path).unwrap();
            database.save_thread(&sample_thread()).unwrap();
            database.save_composer_draft("thread-1", &draft).unwrap();
            database
                .save_composer_draft(
                    "other-thread",
                    &ComposerDraft {
                        content: "Other".into(),
                        attachments: Vec::new(),
                    },
                )
                .unwrap();
        }
        {
            let database = Database::open(&path).unwrap();
            assert_eq!(database.get_composer_draft("thread-1").unwrap(), draft);
            assert_eq!(
                database.get_thread("thread-1").unwrap().unwrap(),
                sample_thread()
            );
            database
                .save_composer_draft("thread-1", &ComposerDraft::default())
                .unwrap();
            assert_eq!(
                database.get_composer_draft("thread-1").unwrap(),
                ComposerDraft::default()
            );
            assert_eq!(
                database.get_composer_draft("other-thread").unwrap().content,
                "Other"
            );
            database.save_composer_draft("thread-1", &draft).unwrap();
            database.delete_thread("thread-1").unwrap();
            assert_eq!(
                database.get_composer_draft("thread-1").unwrap(),
                ComposerDraft::default()
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn catalog_paginates_equal_timestamps_without_loading_messages() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        for index in 0..205 {
            let mut thread = sample_thread();
            thread.id = format!("thread-{index:03}");
            thread.messages[0].id = format!("message-{index}");
            database.save_thread(&thread).unwrap();
        }
        let mut query = ThreadListQuery {
            limit: Some(70),
            ..Default::default()
        };
        let mut ids = std::collections::HashSet::new();
        loop {
            let page = database.list_thread_summaries(&query).unwrap();
            assert!(
                !serde_json::to_string(&page)
                    .unwrap()
                    .contains("Reading README")
            );
            for thread in page.threads {
                assert!(ids.insert(thread.id));
            }
            query.before = page.next_cursor;
            if query.before.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 205);
        assert_eq!(
            database
                .get_thread("thread-000")
                .unwrap()
                .unwrap()
                .messages
                .len(),
            1
        );
        assert!(database.get_thread("missing").unwrap().is_none());
    }

    #[test]
    fn history_search_is_literal_includes_chinese_and_excludes_internal_messages() {
        let database = Database::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut thread = sample_thread();
        thread.messages[0].internal = false;
        thread.messages[0].content = "中文修复 100%_literal and RUST".into();
        database.save_thread(&thread).unwrap();
        for text in [
            "中文修复",
            "100%_literal",
            "rust",
            "Inspect project",
            "C:/workspace",
        ] {
            let page = database
                .list_thread_summaries(&ThreadListQuery {
                    query: text.into(),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(page.threads.len(), 1, "{text}");
        }
        assert!(
            database
                .list_thread_summaries(&ThreadListQuery {
                    query: "100_other".into(),
                    ..Default::default()
                })
                .unwrap()
                .threads
                .is_empty()
        );
        thread.messages[0].internal = true;
        database.save_thread(&thread).unwrap();
        assert!(
            database
                .list_thread_summaries(&ThreadListQuery {
                    query: "中文修复".into(),
                    ..Default::default()
                })
                .unwrap()
                .threads
                .is_empty()
        );
    }
}
