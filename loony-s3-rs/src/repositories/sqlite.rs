use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use std::collections::HashMap;

use crate::error::Result;
use crate::types::*;
use super::{BucketRepository, ObjectRepository};

// ── Schema ────────────────────────────────────────────────────────────────────

pub async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS buckets (
            id          TEXT PRIMARY KEY,
            name        TEXT UNIQUE NOT NULL,
            owner_id    TEXT NOT NULL,
            acl         TEXT NOT NULL DEFAULT 'private',
            region      TEXT NOT NULL DEFAULT 'us-east-1',
            versioning  INTEGER NOT NULL DEFAULT 0,
            metadata    TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_buckets_name     ON buckets(name);
        CREATE INDEX IF NOT EXISTS idx_buckets_owner_id ON buckets(owner_id);

        CREATE TABLE IF NOT EXISTS objects (
            id          TEXT PRIMARY KEY,
            bucket_id   TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
            bucket_name TEXT NOT NULL,
            key         TEXT NOT NULL,
            size        INTEGER NOT NULL DEFAULT 0,
            mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
            etag        TEXT NOT NULL,
            storage_key TEXT NOT NULL UNIQUE,
            acl         TEXT NOT NULL DEFAULT 'private',
            version_id  TEXT NOT NULL,
            is_latest   INTEGER NOT NULL DEFAULT 1,
            metadata    TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            deleted_at  TEXT,
            expires_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_objects_bucket_key
            ON objects(bucket_id, key, is_latest);

        CREATE TABLE IF NOT EXISTS multipart_uploads (
            upload_id   TEXT PRIMARY KEY,
            bucket_id   TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
            bucket_name TEXT NOT NULL,
            key         TEXT NOT NULL,
            owner_id    TEXT NOT NULL,
            metadata    TEXT NOT NULL DEFAULT '{}',
            parts       TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL
        );
    "#).execute(pool).await?;

    // Idempotent column addition for existing databases.
    let _ = sqlx::query("ALTER TABLE objects ADD COLUMN expires_at TEXT")
        .execute(pool).await;

    Ok(())
}

// ── Row structs ───────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct BucketRow {
    id:         String,
    name:       String,
    owner_id:   String,
    acl:        String,
    region:     String,
    versioning: i64,
    metadata:   String,
    created_at: String,
    updated_at: String,
}

impl From<BucketRow> for Bucket {
    fn from(r: BucketRow) -> Self {
        Bucket {
            id:         r.id,
            name:       r.name,
            owner_id:   r.owner_id,
            acl:        r.acl.parse().unwrap_or(BucketAcl::Private),
            region:     r.region,
            versioning: r.versioning != 0,
            metadata:   serde_json::from_str(&r.metadata).unwrap_or_default(),
            created_at: r.created_at.parse::<DateTime<Utc>>().unwrap_or_default(),
            updated_at: r.updated_at.parse::<DateTime<Utc>>().unwrap_or_default(),
        }
    }
}

#[derive(sqlx::FromRow)]
struct ObjectRow {
    id:          String,
    bucket_id:   String,
    bucket_name: String,
    key:         String,
    size:        i64,
    mime_type:   String,
    etag:        String,
    storage_key: String,
    acl:         String,
    version_id:  String,
    is_latest:   i64,
    metadata:    String,
    created_at:  String,
    updated_at:  String,
    deleted_at:  Option<String>,
    expires_at:  Option<String>,
}

impl From<ObjectRow> for StoredObject {
    fn from(r: ObjectRow) -> Self {
        StoredObject {
            id:          r.id,
            bucket_id:   r.bucket_id,
            bucket_name: r.bucket_name,
            key:         r.key,
            size:        r.size,
            mime_type:   r.mime_type,
            etag:        r.etag,
            storage_key: r.storage_key,
            acl:         r.acl.parse().unwrap_or(ObjectAcl::Private),
            version_id:  r.version_id,
            is_latest:   r.is_latest != 0,
            metadata:    serde_json::from_str(&r.metadata).unwrap_or_default(),
            created_at:  r.created_at.parse::<DateTime<Utc>>().unwrap_or_default(),
            updated_at:  r.updated_at.parse::<DateTime<Utc>>().unwrap_or_default(),
            deleted_at:  r.deleted_at.and_then(|s| s.parse().ok()),
            expires_at:  r.expires_at.and_then(|s| s.parse().ok()),
        }
    }
}

#[derive(sqlx::FromRow)]
struct MultipartRow {
    upload_id:   String,
    bucket_id:   String,
    bucket_name: String,
    key:         String,
    owner_id:    String,
    metadata:    String,
    parts:       String,
    created_at:  String,
}

impl From<MultipartRow> for MultipartUpload {
    fn from(r: MultipartRow) -> Self {
        MultipartUpload {
            upload_id:   r.upload_id,
            bucket_id:   r.bucket_id,
            bucket_name: r.bucket_name,
            key:         r.key,
            owner_id:    r.owner_id,
            metadata:    serde_json::from_str(&r.metadata).unwrap_or_default(),
            parts:       serde_json::from_str(&r.parts).unwrap_or_default(),
            created_at:  r.created_at.parse::<DateTime<Utc>>().unwrap_or_default(),
        }
    }
}

// ── BucketRepository ──────────────────────────────────────────────────────────

pub struct SqliteBucketRepository { pub pool: SqlitePool }

#[async_trait]
impl BucketRepository for SqliteBucketRepository {
    async fn find_by_name(&self, name: &str) -> Result<Option<Bucket>> {
        let row: Option<BucketRow> =
            sqlx::query_as("SELECT * FROM buckets WHERE name = ?")
                .bind(name).fetch_optional(&self.pool).await?;
        Ok(row.map(Into::into))
    }

    async fn find_by_id(&self, id: &str) -> Result<Option<Bucket>> {
        let row: Option<BucketRow> =
            sqlx::query_as("SELECT * FROM buckets WHERE id = ?")
                .bind(id).fetch_optional(&self.pool).await?;
        Ok(row.map(Into::into))
    }

    async fn list_by_owner(&self, owner_id: &str) -> Result<Vec<Bucket>> {
        let rows: Vec<BucketRow> =
            sqlx::query_as("SELECT * FROM buckets WHERE owner_id = ? ORDER BY created_at ASC")
                .bind(owner_id).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn create(&self, b: &Bucket) -> Result<Bucket> {
        sqlx::query(
            "INSERT INTO buckets (id, name, owner_id, acl, region, versioning, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&b.id).bind(&b.name).bind(&b.owner_id).bind(b.acl.to_string())
        .bind(&b.region).bind(if b.versioning { 1i64 } else { 0 })
        .bind(serde_json::to_string(&b.metadata).unwrap())
        .bind(b.created_at.to_rfc3339()).bind(b.updated_at.to_rfc3339())
        .execute(&self.pool).await?;
        Ok(b.clone())
    }

    async fn update(
        &self, id: &str,
        acl: Option<&BucketAcl>, versioning: Option<bool>,
        metadata: Option<&HashMap<String, String>>,
    ) -> Result<Bucket> {
        let existing = self.find_by_id(id).await?
            .ok_or_else(|| crate::error::AppError::NotFound(format!("Bucket {id} not found")))?;

        let new_acl        = acl.map(|a| a.to_string()).unwrap_or_else(|| existing.acl.to_string());
        let new_versioning = versioning.unwrap_or(existing.versioning);
        let new_metadata   = metadata.unwrap_or(&existing.metadata);
        let now            = Utc::now().to_rfc3339();

        sqlx::query(
            "UPDATE buckets SET acl = ?, versioning = ?, metadata = ?, updated_at = ? WHERE id = ?"
        )
        .bind(&new_acl).bind(if new_versioning { 1i64 } else { 0 })
        .bind(serde_json::to_string(new_metadata).unwrap())
        .bind(&now).bind(id)
        .execute(&self.pool).await?;

        self.find_by_id(id).await?.ok_or_else(|| crate::error::AppError::Internal("update failed".into()))
    }

    async fn delete(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM buckets WHERE id = ?").bind(id).execute(&self.pool).await?;
        Ok(())
    }

    async fn exists_by_name(&self, name: &str) -> Result<bool> {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM buckets WHERE name = ?")
            .bind(name).fetch_one(&self.pool).await?;
        Ok(n > 0)
    }
}

// ── ObjectRepository ──────────────────────────────────────────────────────────

pub struct SqliteObjectRepository { pub pool: SqlitePool }

#[async_trait]
impl ObjectRepository for SqliteObjectRepository {
    async fn find_latest(&self, bucket_id: &str, key: &str) -> Result<Option<StoredObject>> {
        let row: Option<ObjectRow> = sqlx::query_as(
            "SELECT * FROM objects WHERE bucket_id = ? AND key = ? AND is_latest = 1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"
        ).bind(bucket_id).bind(key).fetch_optional(&self.pool).await?;
        Ok(row.map(Into::into))
    }

    async fn find_versions(&self, bucket_id: &str, key: &str) -> Result<Vec<StoredObject>> {
        let rows: Vec<ObjectRow> = sqlx::query_as(
            "SELECT * FROM objects WHERE bucket_id = ? AND key = ? ORDER BY created_at DESC"
        ).bind(bucket_id).bind(key).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn find_version(&self, bucket_id: &str, key: &str, version_id: &str) -> Result<Option<StoredObject>> {
        let row: Option<ObjectRow> = sqlx::query_as(
            "SELECT * FROM objects WHERE bucket_id = ? AND key = ? AND version_id = ?"
        ).bind(bucket_id).bind(key).bind(version_id).fetch_optional(&self.pool).await?;
        Ok(row.map(Into::into))
    }

    async fn list(&self, bucket_id: &str, q: &ListObjectsQuery) -> Result<ListObjectsResult> {
        let limit = q.max_keys.unwrap_or(1000).min(1000);
        let prefix = q.prefix.as_deref().unwrap_or("");
        let like_pat = format!("{prefix}%");

        let rows: Vec<ObjectRow> = if let Some(token) = &q.continuation_token {
            sqlx::query_as(
                "SELECT * FROM objects WHERE bucket_id = ? AND key LIKE ? AND key > ? AND is_latest = 1 AND deleted_at IS NULL ORDER BY key ASC LIMIT ?"
            ).bind(bucket_id).bind(&like_pat).bind(token).bind(limit + 1).fetch_all(&self.pool).await?
        } else {
            sqlx::query_as(
                "SELECT * FROM objects WHERE bucket_id = ? AND key LIKE ? AND is_latest = 1 AND deleted_at IS NULL ORDER BY key ASC LIMIT ?"
            ).bind(bucket_id).bind(&like_pat).bind(limit + 1).fetch_all(&self.pool).await?
        };

        build_list_result(rows, prefix, q.delimiter.as_deref(), limit as usize)
    }

    async fn create(&self, obj: &StoredObject) -> Result<StoredObject> {
        sqlx::query("UPDATE objects SET is_latest = 0 WHERE bucket_id = ? AND key = ? AND is_latest = 1")
            .bind(&obj.bucket_id).bind(&obj.key).execute(&self.pool).await?;

        sqlx::query(
            "INSERT INTO objects (id, bucket_id, bucket_name, key, size, mime_type, etag, storage_key, acl, version_id, is_latest, metadata, created_at, updated_at, deleted_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&obj.id).bind(&obj.bucket_id).bind(&obj.bucket_name).bind(&obj.key)
        .bind(obj.size).bind(&obj.mime_type).bind(&obj.etag).bind(&obj.storage_key)
        .bind(obj.acl.to_string()).bind(&obj.version_id).bind(if obj.is_latest { 1i64 } else { 0 })
        .bind(serde_json::to_string(&obj.metadata).unwrap())
        .bind(obj.created_at.to_rfc3339()).bind(obj.updated_at.to_rfc3339())
        .bind(obj.deleted_at.map(|d| d.to_rfc3339()))
        .bind(obj.expires_at.map(|d| d.to_rfc3339()))
        .execute(&self.pool).await?;

        Ok(obj.clone())
    }

    async fn hard_delete(&self, bucket_id: &str, key: &str, version_id: Option<&str>) -> Result<Vec<String>> {
        if let Some(vid) = version_id {
            let keys: Vec<(String,)> = sqlx::query_as(
                "SELECT storage_key FROM objects WHERE bucket_id = ? AND key = ? AND version_id = ?"
            ).bind(bucket_id).bind(key).bind(vid).fetch_all(&self.pool).await?;
            sqlx::query("DELETE FROM objects WHERE bucket_id = ? AND key = ? AND version_id = ?")
                .bind(bucket_id).bind(key).bind(vid).execute(&self.pool).await?;
            Ok(keys.into_iter().map(|(k,)| k).collect())
        } else {
            let keys: Vec<(String,)> = sqlx::query_as(
                "SELECT storage_key FROM objects WHERE bucket_id = ? AND key = ?"
            ).bind(bucket_id).bind(key).fetch_all(&self.pool).await?;
            sqlx::query("DELETE FROM objects WHERE bucket_id = ? AND key = ?")
                .bind(bucket_id).bind(key).execute(&self.pool).await?;
            Ok(keys.into_iter().map(|(k,)| k).collect())
        }
    }

    async fn count_in_bucket(&self, bucket_id: &str) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM objects WHERE bucket_id = ? AND deleted_at IS NULL"
        ).bind(bucket_id).fetch_one(&self.pool).await?;
        Ok(n)
    }

    async fn find_expired(&self, now: DateTime<Utc>, limit: i64) -> Result<Vec<StoredObject>> {
        let rows: Vec<ObjectRow> = sqlx::query_as(
            "SELECT * FROM objects WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL ORDER BY expires_at ASC LIMIT ?"
        ).bind(now.to_rfc3339()).bind(limit).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn create_multipart_upload(&self, u: &MultipartUpload) -> Result<MultipartUpload> {
        sqlx::query(
            "INSERT INTO multipart_uploads (upload_id, bucket_id, bucket_name, key, owner_id, metadata, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&u.upload_id).bind(&u.bucket_id).bind(&u.bucket_name).bind(&u.key)
        .bind(&u.owner_id).bind(serde_json::to_string(&u.metadata).unwrap())
        .bind(serde_json::to_string(&u.parts).unwrap()).bind(u.created_at.to_rfc3339())
        .execute(&self.pool).await?;
        Ok(u.clone())
    }

    async fn find_multipart_upload(&self, upload_id: &str) -> Result<Option<MultipartUpload>> {
        let row: Option<MultipartRow> = sqlx::query_as(
            "SELECT * FROM multipart_uploads WHERE upload_id = ?"
        ).bind(upload_id).fetch_optional(&self.pool).await?;
        Ok(row.map(Into::into))
    }

    async fn upsert_part(&self, upload_id: &str, part: &UploadPart) -> Result<()> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT parts FROM multipart_uploads WHERE upload_id = ?"
        ).bind(upload_id).fetch_optional(&self.pool).await?;

        let Some((parts_json,)) = row else {
            return Err(crate::error::AppError::NotFound(format!("Upload {upload_id} not found")));
        };

        let mut parts: Vec<UploadPart> = serde_json::from_str(&parts_json).unwrap_or_default();
        match parts.iter().position(|p| p.part_number == part.part_number) {
            Some(idx) => parts[idx] = part.clone(),
            None      => { parts.push(part.clone()); parts.sort_by_key(|p| p.part_number); }
        }

        sqlx::query("UPDATE multipart_uploads SET parts = ? WHERE upload_id = ?")
            .bind(serde_json::to_string(&parts).unwrap()).bind(upload_id)
            .execute(&self.pool).await?;
        Ok(())
    }

    async fn delete_multipart_upload(&self, upload_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM multipart_uploads WHERE upload_id = ?")
            .bind(upload_id).execute(&self.pool).await?;
        Ok(())
    }

    async fn find_stale_multipart_uploads(&self, older_than: DateTime<Utc>) -> Result<Vec<MultipartUpload>> {
        let rows: Vec<MultipartRow> = sqlx::query_as(
            "SELECT * FROM multipart_uploads WHERE created_at < ?"
        ).bind(older_than.to_rfc3339()).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

// ── Shared list builder ───────────────────────────────────────────────────────

fn build_list_result(
    rows:      Vec<ObjectRow>,
    prefix:    &str,
    delimiter: Option<&str>,
    limit:     usize,
) -> Result<ListObjectsResult> {
    let is_truncated = rows.len() > limit;
    let page: Vec<StoredObject> = rows.into_iter().take(limit).map(Into::into).collect();
    let next_token = if is_truncated { page.last().map(|o| o.key.clone()) } else { None };

    let mut objects = Vec::new();
    let mut prefixes = std::collections::BTreeSet::new();

    for obj in page {
        if let Some(delim) = delimiter {
            let after_prefix = &obj.key[prefix.len()..];
            if let Some(idx) = after_prefix.find(delim) {
                prefixes.insert(format!("{}{}", prefix, &after_prefix[..idx + delim.len()]));
                continue;
            }
        }
        objects.push(obj);
    }

    let common_prefixes: Vec<String> = prefixes.into_iter().collect();
    let key_count = objects.len() + common_prefixes.len();
    Ok(ListObjectsResult { objects, common_prefixes, is_truncated, next_continuation_token: next_token, key_count })
}
