use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use reqwest::Client;
use tokio::sync::Mutex as AsyncMutex;

use super::{MediaProvider, get_asset, refresh_asset};
use crate::database::Database;
use crate::models::MediaAsset;

#[derive(Default)]
pub(crate) struct MediaRefreshes {
    locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl MediaRefreshes {
    pub(crate) async fn refresh(
        &self,
        client: &Client,
        storage: &Path,
        database: &Database,
        provider: &MediaProvider,
        asset_id: &str,
    ) -> Result<MediaAsset, String> {
        let lock = {
            let mut locks = self.locks.lock().map_err(|error| error.to_string())?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(asset_id).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    locks.insert(asset_id.to_owned(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        // UI and Agent tools share this lock. Reload after waiting so a completed
        // download is reused and stale pending state cannot overwrite it.
        let _guard = lock.lock().await;
        let asset = get_asset(database, storage, asset_id)?
            .ok_or_else(|| "Media asset was not found".to_owned())?;
        refresh_asset(client, storage, database, provider, asset).await
    }
}
