use std::sync::Arc;
use chrono::{Duration, Utc};

use crate::error::Result;
use crate::repositories::ObjectRepository;
use crate::storage::StorageBackend;

pub struct CleanupService {
    pub repo:    Arc<dyn ObjectRepository>,
    pub storage: Arc<dyn StorageBackend>,
}

impl CleanupService {
    pub fn new(repo: Arc<dyn ObjectRepository>, storage: Arc<dyn StorageBackend>) -> Self {
        Self { repo, storage }
    }

    pub async fn clean_expired_objects(&self, batch: i64) -> Result<u64> {
        let expired = self.repo.find_expired(Utc::now(), batch).await?;
        let count   = expired.len() as u64;

        for obj in expired {
            self.storage.delete(&obj.storage_key).await.ok();
            self.repo.hard_delete(&obj.bucket_id, &obj.key, Some(&obj.version_id)).await.ok();
        }

        use std::sync::atomic::Ordering;
        crate::metrics::METRICS.cleanup_expired_removed.fetch_add(count, Ordering::Relaxed);
        crate::metrics::METRICS.objects_expired.fetch_add(count, Ordering::Relaxed);

        Ok(count)
    }

    pub async fn clean_stale_uploads(&self, max_age: Duration) -> Result<u64> {
        let cutoff = Utc::now() - max_age;
        let stale  = self.repo.find_stale_multipart_uploads(cutoff).await?;
        let count  = stale.len() as u64;

        for upload in stale {
            let part_keys: Vec<String> = upload.parts.iter().map(|p| p.storage_key.clone()).collect();
            self.storage.delete_parts(&part_keys).await.ok();
            self.repo.delete_multipart_upload(&upload.upload_id).await.ok();
        }

        use std::sync::atomic::Ordering;
        crate::metrics::METRICS.cleanup_stale_removed.fetch_add(count, Ordering::Relaxed);

        Ok(count)
    }
}
