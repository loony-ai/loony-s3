use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

// ── ACL types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BucketAcl {
    Private,
    PublicRead,
    PublicReadWrite,
}

impl fmt::Display for BucketAcl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BucketAcl::Private        => write!(f, "private"),
            BucketAcl::PublicRead     => write!(f, "public-read"),
            BucketAcl::PublicReadWrite => write!(f, "public-read-write"),
        }
    }
}

impl std::str::FromStr for BucketAcl {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "public-read"       => Ok(BucketAcl::PublicRead),
            "public-read-write" => Ok(BucketAcl::PublicReadWrite),
            _                   => Ok(BucketAcl::Private),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectAcl {
    Private,
    PublicRead,
}

impl fmt::Display for ObjectAcl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ObjectAcl::Private    => write!(f, "private"),
            ObjectAcl::PublicRead => write!(f, "public-read"),
        }
    }
}

impl std::str::FromStr for ObjectAcl {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "public-read" => Ok(ObjectAcl::PublicRead),
            _             => Ok(ObjectAcl::Private),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PresignedOperation { GET, PUT, DELETE }

impl fmt::Display for PresignedOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PresignedOperation::GET    => write!(f, "GET"),
            PresignedOperation::PUT    => write!(f, "PUT"),
            PresignedOperation::DELETE => write!(f, "DELETE"),
        }
    }
}

impl std::str::FromStr for PresignedOperation {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "GET"    => Ok(PresignedOperation::GET),
            "PUT"    => Ok(PresignedOperation::PUT),
            "DELETE" => Ok(PresignedOperation::DELETE),
            _        => Err(()),
        }
    }
}

// ── Domain types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub id:         String,
    pub name:       String,
    pub owner_id:   String,
    pub acl:        BucketAcl,
    pub region:     String,
    pub versioning: bool,
    pub metadata:   HashMap<String, String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredObject {
    pub id:          String,
    pub bucket_id:   String,
    pub bucket_name: String,
    pub key:         String,
    pub size:        i64,
    pub mime_type:   String,
    pub etag:        String,
    pub storage_key: String,
    pub acl:         ObjectAcl,
    pub version_id:  String,
    pub is_latest:   bool,
    pub metadata:    HashMap<String, String>,
    pub created_at:  DateTime<Utc>,
    pub updated_at:  DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at:  Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at:  Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPart {
    pub part_number: i32,
    pub etag:        String,
    pub size:        i64,
    pub storage_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartUpload {
    pub upload_id:   String,
    pub bucket_id:   String,
    pub bucket_name: String,
    pub key:         String,
    pub owner_id:    String,
    pub metadata:    HashMap<String, String>,
    pub parts:       Vec<UploadPart>,
    pub created_at:  DateTime<Utc>,
}

// ── Storage info returned from backend ────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct StoredObjectInfo {
    pub storage_key: String,
    pub size:        i64,
    pub etag:        String,
}

// ── Query types ───────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectsQuery {
    pub prefix:             Option<String>,
    pub delimiter:          Option<String>,
    pub max_keys:           Option<i64>,
    pub continuation_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectsResult {
    pub objects:                Vec<StoredObject>,
    pub common_prefixes:        Vec<String>,
    pub is_truncated:           bool,
    pub next_continuation_token: Option<String>,
    pub key_count:              usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignedUrl {
    pub operation:   PresignedOperation,
    pub bucket_name: String,
    pub key:         String,
    pub expires_at:  u64,
    pub signature:   String,
}
