use async_trait::async_trait;
use bytes::Bytes;
use digest::Digest;
use futures_util::StreamExt;
use md5::Md5;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use crate::error::{AppError, Result};
use crate::types::StoredObjectInfo;
use super::{ByteStream, StorageBackend};

/// Filesystem storage backend used for both the "local" and "nfs" modes.
///
/// When `use_fsync` is `true` (NFS mode), the write method calls
/// `fsync` on the temp file before the atomic rename.  This prevents
/// NFS page-cache reordering from exposing a partial file to other nodes.
pub struct FsStorageBackend {
    root:      PathBuf,
    use_fsync: bool,
}

impl FsStorageBackend {
    pub fn new_local(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        std::fs::create_dir_all(&root).expect("failed to create storage root");
        std::fs::create_dir_all(root.join("__tmp")).expect("failed to create __tmp dir");
        tracing::info!(?root, "LocalStorageBackend initialized");
        Self { root, use_fsync: false }
    }

    pub fn new_nfs(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        std::fs::create_dir_all(&root).expect("failed to create NFS root");
        std::fs::create_dir_all(root.join("__tmp")).expect("failed to create __tmp dir");
        tracing::info!(?root, "NfsStorageBackend initialized");
        Self { root, use_fsync: true }
    }

    fn resolve(&self, storage_key: &str) -> PathBuf {
        self.root.join(storage_key)
    }

    async fn write_stream(
        &self,
        dest:          &Path,
        mut source:    ByteStream,
        expected_size: Option<u64>,
    ) -> Result<StoredObjectInfo> {
        fs::create_dir_all(dest.parent().unwrap()).await?;

        let tmp = dest.with_extension(format!(
            "tmp.{}",
            uuid::Uuid::new_v4().simple()
        ));

        let mut file = fs::File::create(&tmp).await?;
        let mut hasher = Md5::new();
        let mut size: u64 = 0;

        while let Some(chunk) = source.next().await {
            let buf: Bytes = chunk?;
            hasher.update(&buf);
            size += buf.len() as u64;
            file.write_all(&buf).await?;
        }

        file.flush().await?;

        if let Some(expected) = expected_size {
            if size != expected {
                fs::remove_file(&tmp).await.ok();
                return Err(AppError::Internal(format!(
                    "Size mismatch: expected {expected}, received {size}"
                )));
            }
        }

        if self.use_fsync {
            file.sync_all().await?;
        }
        drop(file);

        fs::rename(&tmp, dest).await?;

        let etag = hex::encode(hasher.finalize());
        let storage_key = dest
            .strip_prefix(&self.root)
            .unwrap()
            .to_string_lossy()
            .to_string();

        Ok(StoredObjectInfo { storage_key, size: size as i64, etag })
    }
}

#[async_trait]
impl StorageBackend for FsStorageBackend {
    async fn write(
        &self,
        storage_key:   &str,
        source:        ByteStream,
        expected_size: Option<u64>,
    ) -> Result<StoredObjectInfo> {
        let dest = self.resolve(storage_key);
        self.write_stream(&dest, source, expected_size).await
    }

    async fn read(&self, storage_key: &str, range: Option<(u64, u64)>) -> Result<ByteStream> {
        let path = self.resolve(storage_key);
        let mut file = fs::File::open(&path).await.map_err(|_| {
            AppError::NotFound(format!("Object not found in storage: {storage_key}"))
        })?;

        if let Some((start, end)) = range {
            file.seek(std::io::SeekFrom::Start(start)).await?;
            let limited = file.take(end - start + 1);
            return Ok(Box::pin(ReaderStream::new(limited)));
        }

        Ok(Box::pin(ReaderStream::new(file)))
    }

    async fn stat(&self, storage_key: &str) -> Result<u64> {
        let meta = fs::metadata(self.resolve(storage_key)).await?;
        Ok(meta.len())
    }

    async fn delete(&self, storage_key: &str) -> Result<()> {
        fs::remove_file(self.resolve(storage_key)).await.ok();
        Ok(())
    }

    async fn assemble_multipart(
        &self,
        part_keys:       &[String],
        destination_key: &str,
    ) -> Result<StoredObjectInfo> {
        let dest = self.resolve(destination_key);
        fs::create_dir_all(dest.parent().unwrap()).await?;

        let tmp = dest.with_extension(format!("tmp.{}", uuid::Uuid::new_v4().simple()));
        let mut out = fs::File::create(&tmp).await?;
        let mut hasher = Md5::new();
        let mut total: u64 = 0;

        for key in part_keys {
            let mut part = fs::File::open(self.resolve(key)).await?;
            let n = tokio::io::copy(&mut part, &mut out).await?;
            // Rehash by re-reading the bytes we just wrote — for correctness
            // without buffering we read a second time from the part file.
            let part_bytes = fs::read(self.resolve(key)).await?;
            hasher.update(&part_bytes);
            total += n;
        }

        if self.use_fsync {
            out.sync_all().await?;
        }
        drop(out);

        fs::rename(&tmp, &dest).await?;
        self.delete_parts(part_keys).await?;

        Ok(StoredObjectInfo {
            storage_key: destination_key.to_string(),
            size:        total as i64,
            etag:        hex::encode(hasher.finalize()),
        })
    }

    async fn delete_parts(&self, part_keys: &[String]) -> Result<()> {
        for key in part_keys {
            fs::remove_file(self.resolve(key)).await.ok();
        }
        Ok(())
    }
}
