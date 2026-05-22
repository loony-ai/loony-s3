use std::collections::HashMap;
use std::sync::Arc;
use chrono::Utc;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::metrics::METRICS;
use crate::repositories::ObjectRepository;
use crate::storage::{ByteStream, StorageBackend};
use crate::types::{ListObjectsQuery, ListObjectsResult, ObjectAcl, StoredObject};

pub struct PutObjectOptions {
    pub content_type: Option<String>,
    pub acl:          ObjectAcl,
    pub metadata:     HashMap<String, String>,
    pub ttl_seconds:  Option<i64>,
    pub size_hint:    Option<u64>,
}

pub struct ObjectService {
    pub repo:    Arc<dyn ObjectRepository>,
    pub storage: Arc<dyn StorageBackend>,
}

impl ObjectService {
    pub fn new(repo: Arc<dyn ObjectRepository>, storage: Arc<dyn StorageBackend>) -> Self {
        Self { repo, storage }
    }

    pub async fn put_object(
        &self,
        bucket_id:   &str,
        bucket_name: &str,
        key:         &str,
        stream:      ByteStream,
        opts:        PutObjectOptions,
    ) -> Result<StoredObject> {
        let version_id  = Uuid::new_v4().to_string();
        let storage_key = format!("{bucket_name}/{key}/{version_id}");

        let info = self.storage.write(&storage_key, stream, opts.size_hint).await?;

        let now        = Utc::now();
        let expires_at = opts.ttl_seconds.map(|secs| now + chrono::Duration::seconds(secs));

        let obj = StoredObject {
            id:          Uuid::new_v4().to_string(),
            bucket_id:   bucket_id.to_string(),
            bucket_name: bucket_name.to_string(),
            key:         key.to_string(),
            size:        info.size,
            mime_type:   opts.content_type.unwrap_or_else(|| "application/octet-stream".to_string()),
            etag:        info.etag,
            storage_key: info.storage_key,
            acl:         opts.acl,
            version_id,
            is_latest:   true,
            metadata:    opts.metadata,
            created_at:  now,
            updated_at:  now,
            deleted_at:  None,
            expires_at,
        };

        let saved = self.repo.create(&obj).await?;

        use std::sync::atomic::Ordering;
        METRICS.objects_created.fetch_add(1, Ordering::Relaxed);
        METRICS.storage_bytes_uploaded.fetch_add(saved.size as u64, Ordering::Relaxed);

        Ok(saved)
    }

    pub async fn get_object(
        &self,
        bucket_id: &str,
        key:       &str,
        version_id: Option<&str>,
    ) -> Result<StoredObject> {
        let obj = if let Some(vid) = version_id {
            self.repo.find_version(bucket_id, key, vid).await?
                .ok_or_else(|| AppError::NotFound(format!("Object '{key}' version '{vid}' not found")))?
        } else {
            self.repo.find_latest(bucket_id, key).await?
                .ok_or_else(|| AppError::NotFound(format!("Object '{key}' not found")))?
        };

        if let Some(exp) = obj.expires_at {
            if exp < Utc::now() {
                return Err(AppError::Gone(format!("Object '{key}' has expired")));
            }
        }

        Ok(obj)
    }

    pub async fn stream_object(
        &self,
        storage_key: &str,
        range:       Option<(u64, u64)>,
    ) -> Result<ByteStream> {
        let stream = self.storage.read(storage_key, range).await?;
        use std::sync::atomic::Ordering;
        // byte count is tracked at handler level after sizing from Content-Length
        METRICS.storage_bytes_downloaded.fetch_add(0, Ordering::Relaxed);
        Ok(stream)
    }

    pub async fn list_objects(
        &self,
        bucket_id: &str,
        q:         &ListObjectsQuery,
    ) -> Result<ListObjectsResult> {
        self.repo.list(bucket_id, q).await
    }

    pub async fn list_versions(&self, bucket_id: &str, key: &str) -> Result<Vec<StoredObject>> {
        self.repo.find_versions(bucket_id, key).await
    }

    pub async fn delete_object(
        &self,
        bucket_id:  &str,
        key:        &str,
        version_id: Option<&str>,
    ) -> Result<Vec<String>> {
        let storage_keys = self.repo.hard_delete(bucket_id, key, version_id).await?;

        for sk in &storage_keys {
            self.storage.delete(sk).await?;
        }

        use std::sync::atomic::Ordering;
        METRICS.objects_deleted.fetch_add(storage_keys.len() as u64, Ordering::Relaxed);

        Ok(storage_keys)
    }

    pub async fn head_object(&self, bucket_id: &str, key: &str) -> Result<StoredObject> {
        self.get_object(bucket_id, key, None).await
    }
}
