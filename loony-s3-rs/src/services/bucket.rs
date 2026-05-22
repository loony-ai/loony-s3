use std::collections::HashMap;
use std::sync::Arc;
use chrono::Utc;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::repositories::BucketRepository;
use crate::types::{Bucket, BucketAcl};

pub struct BucketService {
    pub repo: Arc<dyn BucketRepository>,
}

impl BucketService {
    pub fn new(repo: Arc<dyn BucketRepository>) -> Self {
        Self { repo }
    }

    pub async fn create_bucket(
        &self,
        name:     &str,
        owner_id: &str,
        acl:      BucketAcl,
        region:   Option<String>,
    ) -> Result<Bucket> {
        validate_bucket_name(name)?;

        if self.repo.exists_by_name(name).await? {
            return Err(AppError::Conflict(format!("Bucket '{name}' already exists")));
        }

        let now = Utc::now();
        let bucket = Bucket {
            id:         Uuid::new_v4().to_string(),
            name:       name.to_string(),
            owner_id:   owner_id.to_string(),
            acl,
            region:     region.unwrap_or_else(|| "us-east-1".to_string()),
            versioning: false,
            metadata:   HashMap::new(),
            created_at: now,
            updated_at: now,
        };

        self.repo.create(&bucket).await
    }

    pub async fn get_bucket(&self, name: &str) -> Result<Bucket> {
        self.repo.find_by_name(name).await?
            .ok_or_else(|| AppError::NotFound(format!("Bucket '{name}' not found")))
    }

    pub async fn list_buckets(&self, owner_id: &str) -> Result<Vec<Bucket>> {
        self.repo.list_by_owner(owner_id).await
    }

    pub async fn update_bucket(
        &self,
        name:       &str,
        owner_id:   &str,
        acl:        Option<&BucketAcl>,
        versioning: Option<bool>,
        metadata:   Option<&HashMap<String, String>>,
    ) -> Result<Bucket> {
        let bucket = self.get_bucket(name).await?;
        assert_owner(&bucket, owner_id)?;
        self.repo.update(&bucket.id, acl, versioning, metadata).await
    }

    pub async fn delete_bucket(&self, name: &str, owner_id: &str) -> Result<()> {
        let bucket = self.get_bucket(name).await?;
        assert_owner(&bucket, owner_id)?;
        self.repo.delete(&bucket.id).await
    }

    pub fn assert_read_access(&self, bucket: &Bucket, requester_id: Option<&str>) -> Result<()> {
        match bucket.acl {
            BucketAcl::Private => {
                match requester_id {
                    Some(id) if id == bucket.owner_id => Ok(()),
                    _ => Err(AppError::Forbidden("Access denied".into())),
                }
            }
            BucketAcl::PublicRead | BucketAcl::PublicReadWrite => Ok(()),
        }
    }

    pub fn assert_write_access(&self, bucket: &Bucket, requester_id: Option<&str>) -> Result<()> {
        match bucket.acl {
            BucketAcl::PublicReadWrite => Ok(()),
            _ => {
                match requester_id {
                    Some(id) if id == bucket.owner_id => Ok(()),
                    _ => Err(AppError::Forbidden("Access denied".into())),
                }
            }
        }
    }
}

fn assert_owner(bucket: &Bucket, requester_id: &str) -> Result<()> {
    if bucket.owner_id != requester_id {
        return Err(AppError::Forbidden("Only the bucket owner can perform this action".into()));
    }
    Ok(())
}

fn validate_bucket_name(name: &str) -> Result<()> {
    if name.len() < 3 || name.len() > 63 {
        return Err(AppError::BadRequest("Bucket name must be 3–63 characters".into()));
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(AppError::BadRequest(
            "Bucket name may only contain lowercase letters, digits, and hyphens".into()
        ));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err(AppError::BadRequest("Bucket name cannot start or end with a hyphen".into()));
    }
    Ok(())
}
