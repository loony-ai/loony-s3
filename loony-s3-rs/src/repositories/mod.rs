use async_trait::async_trait;
use chrono::{DateTime, Utc};

pub use sqlite::{run_migrations as sqlite_run_migrations, SqliteBucketRepository, SqliteObjectRepository};
pub use postgres::{run_migrations as postgres_run_migrations, PostgresBucketRepository, PostgresObjectRepository};

pub mod sqlite;
pub mod postgres;

use crate::error::Result;
use crate::types::*;

// ── Bucket repository ─────────────────────────────────────────────────────────

#[async_trait]
pub trait BucketRepository: Send + Sync {
    async fn find_by_name(&self, name: &str)        -> Result<Option<Bucket>>;
    async fn find_by_id(&self, id: &str)            -> Result<Option<Bucket>>;
    async fn list_by_owner(&self, owner_id: &str)   -> Result<Vec<Bucket>>;
    async fn create(&self, bucket: &Bucket)         -> Result<Bucket>;
    async fn update(
        &self,
        id:         &str,
        acl:        Option<&BucketAcl>,
        versioning: Option<bool>,
        metadata:   Option<&std::collections::HashMap<String, String>>,
    ) -> Result<Bucket>;
    async fn delete(&self, id: &str)                -> Result<()>;
    async fn exists_by_name(&self, name: &str)      -> Result<bool>;
}

// ── Object repository ─────────────────────────────────────────────────────────

#[async_trait]
pub trait ObjectRepository: Send + Sync {
    async fn find_latest(&self, bucket_id: &str, key: &str)
        -> Result<Option<StoredObject>>;
    async fn find_versions(&self, bucket_id: &str, key: &str)
        -> Result<Vec<StoredObject>>;
    async fn find_version(&self, bucket_id: &str, key: &str, version_id: &str)
        -> Result<Option<StoredObject>>;
    async fn list(&self, bucket_id: &str, q: &ListObjectsQuery)
        -> Result<ListObjectsResult>;
    async fn create(&self, obj: &StoredObject)
        -> Result<StoredObject>;
    async fn hard_delete(&self, bucket_id: &str, key: &str, version_id: Option<&str>)
        -> Result<Vec<String>>;
    async fn count_in_bucket(&self, bucket_id: &str)
        -> Result<i64>;
    async fn find_expired(&self, now: DateTime<Utc>, limit: i64)
        -> Result<Vec<StoredObject>>;

    async fn create_multipart_upload(&self, upload: &MultipartUpload)
        -> Result<MultipartUpload>;
    async fn find_multipart_upload(&self, upload_id: &str)
        -> Result<Option<MultipartUpload>>;
    async fn upsert_part(&self, upload_id: &str, part: &UploadPart)
        -> Result<()>;
    async fn delete_multipart_upload(&self, upload_id: &str)
        -> Result<()>;
    async fn find_stale_multipart_uploads(&self, older_than: DateTime<Utc>)
        -> Result<Vec<MultipartUpload>>;
}
