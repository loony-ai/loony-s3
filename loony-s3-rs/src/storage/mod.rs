use async_trait::async_trait;
use bytes::Bytes;
use futures_util::Stream;
use std::pin::Pin;

pub use local::FsStorageBackend;

pub mod local;

/// A pinned, boxed byte stream — the common currency between the HTTP layer
/// and the storage backends.  Using Box<dyn Stream> avoids generic parameters
/// propagating everywhere while still being zero-copy for large transfers.
pub type ByteStream =
    Pin<Box<dyn Stream<Item = std::io::Result<Bytes>> + Send + 'static>>;

#[async_trait]
pub trait StorageBackend: Send + Sync {
    /// Stream `source` to `storage_key`.  Returns the final byte count and
    /// MD5 ETag once the stream has been fully flushed.
    async fn write(
        &self,
        storage_key: &str,
        source:      ByteStream,
        expected_size: Option<u64>,
    ) -> crate::error::Result<crate::types::StoredObjectInfo>;

    /// Open a readable byte stream for `storage_key`.
    /// `range` is an inclusive byte range `(start, end)`.
    async fn read(
        &self,
        storage_key: &str,
        range:       Option<(u64, u64)>,
    ) -> crate::error::Result<ByteStream>;

    /// Byte size of the object without reading its data.
    async fn stat(&self, storage_key: &str) -> crate::error::Result<u64>;

    /// Remove the object at `storage_key`.
    async fn delete(&self, storage_key: &str) -> crate::error::Result<()>;

    /// Concatenate ordered `part_keys` into `destination_key`.
    /// Each part file is removed after assembly.
    async fn assemble_multipart(
        &self,
        part_keys:       &[String],
        destination_key: &str,
    ) -> crate::error::Result<crate::types::StoredObjectInfo>;

    /// Remove part files (called on abort).
    async fn delete_parts(&self, part_keys: &[String]) -> crate::error::Result<()>;
}
