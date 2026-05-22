use std::collections::HashMap;
use std::sync::Arc;
use chrono::Utc;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::repositories::ObjectRepository;
use crate::storage::{ByteStream, StorageBackend};
use crate::types::{MultipartUpload, StoredObject, ObjectAcl, UploadPart};

pub struct MultipartService {
    pub repo:    Arc<dyn ObjectRepository>,
    pub storage: Arc<dyn StorageBackend>,
}

impl MultipartService {
    pub fn new(repo: Arc<dyn ObjectRepository>, storage: Arc<dyn StorageBackend>) -> Self {
        Self { repo, storage }
    }

    pub async fn initiate(
        &self,
        bucket_id:   &str,
        bucket_name: &str,
        key:         &str,
        owner_id:    &str,
        metadata:    HashMap<String, String>,
    ) -> Result<MultipartUpload> {
        let upload = MultipartUpload {
            upload_id:   Uuid::new_v4().to_string(),
            bucket_id:   bucket_id.to_string(),
            bucket_name: bucket_name.to_string(),
            key:         key.to_string(),
            owner_id:    owner_id.to_string(),
            metadata,
            parts:       vec![],
            created_at:  Utc::now(),
        };
        self.repo.create_multipart_upload(&upload).await
    }

    pub async fn upload_part(
        &self,
        upload_id:   &str,
        part_number: i32,
        stream:      ByteStream,
    ) -> Result<UploadPart> {
        let upload = self.repo.find_multipart_upload(upload_id).await?
            .ok_or_else(|| AppError::NotFound(format!("Upload '{upload_id}' not found")))?;

        let part_key = format!(
            "{}/__parts/{}/{}",
            upload.bucket_name, upload_id, part_number
        );

        let info = self.storage.write(&part_key, stream, None).await?;

        let part = UploadPart {
            part_number,
            etag:        info.etag,
            size:        info.size,
            storage_key: info.storage_key,
        };

        self.repo.upsert_part(upload_id, &part).await?;
        Ok(part)
    }

    pub async fn complete(
        &self,
        upload_id:   &str,
        part_numbers: Vec<i32>,
        content_type: Option<String>,
        acl:          ObjectAcl,
        ttl_seconds:  Option<i64>,
    ) -> Result<StoredObject> {
        let upload = self.repo.find_multipart_upload(upload_id).await?
            .ok_or_else(|| AppError::NotFound(format!("Upload '{upload_id}' not found")))?;

        let ordered: Vec<UploadPart> = {
            let mut selected: Vec<&UploadPart> = upload.parts.iter()
                .filter(|p| part_numbers.contains(&p.part_number))
                .collect();
            selected.sort_by_key(|p| p.part_number);
            selected.into_iter().cloned().collect()
        };

        if ordered.len() != part_numbers.len() {
            return Err(AppError::BadRequest("Some requested parts were not found".into()));
        }

        let part_keys: Vec<String> = ordered.iter().map(|p| p.storage_key.clone()).collect();
        let version_id  = Uuid::new_v4().to_string();
        let dest_key    = format!("{}/{}/{}", upload.bucket_name, upload.key, version_id);

        let info = self.storage.assemble_multipart(&part_keys, &dest_key).await?;

        let now        = Utc::now();
        let expires_at = ttl_seconds.map(|s| now + chrono::Duration::seconds(s));
        let total_size = ordered.iter().map(|p| p.size).sum();

        let obj = StoredObject {
            id:          Uuid::new_v4().to_string(),
            bucket_id:   upload.bucket_id.clone(),
            bucket_name: upload.bucket_name.clone(),
            key:         upload.key.clone(),
            size:        total_size,
            mime_type:   content_type.unwrap_or_else(|| "application/octet-stream".to_string()),
            etag:        info.etag,
            storage_key: info.storage_key,
            acl,
            version_id,
            is_latest:   true,
            metadata:    upload.metadata.clone(),
            created_at:  now,
            updated_at:  now,
            deleted_at:  None,
            expires_at,
        };

        let saved = self.repo.create(&obj).await?;
        self.repo.delete_multipart_upload(upload_id).await?;

        use std::sync::atomic::Ordering;
        crate::metrics::METRICS.objects_created.fetch_add(1, Ordering::Relaxed);
        crate::metrics::METRICS.storage_bytes_uploaded.fetch_add(saved.size as u64, Ordering::Relaxed);

        Ok(saved)
    }

    pub async fn abort(&self, upload_id: &str) -> Result<()> {
        let upload = self.repo.find_multipart_upload(upload_id).await?
            .ok_or_else(|| AppError::NotFound(format!("Upload '{upload_id}' not found")))?;

        let part_keys: Vec<String> = upload.parts.iter().map(|p| p.storage_key.clone()).collect();
        self.storage.delete_parts(&part_keys).await?;
        self.repo.delete_multipart_upload(upload_id).await?;
        Ok(())
    }

    pub async fn list_parts(&self, upload_id: &str) -> Result<(MultipartUpload, Vec<UploadPart>)> {
        let upload = self.repo.find_multipart_upload(upload_id).await?
            .ok_or_else(|| AppError::NotFound(format!("Upload '{upload_id}' not found")))?;
        let mut parts = upload.parts.clone();
        parts.sort_by_key(|p| p.part_number);
        Ok((upload, parts))
    }
}
