use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::SystemTime;

pub struct Metrics {
    pub started_at:              SystemTime,
    pub requests_total:          AtomicU64,
    pub requests_active:         AtomicI64,
    pub requests_errors_4xx:     AtomicU64,
    pub requests_errors_5xx:     AtomicU64,
    pub storage_bytes_uploaded:  AtomicU64,
    pub storage_bytes_downloaded: AtomicU64,
    pub objects_created:         AtomicU64,
    pub objects_deleted:         AtomicU64,
    pub objects_expired:         AtomicU64,
    pub cleanup_stale_removed:   AtomicU64,
    pub cleanup_expired_removed: AtomicU64,
}

impl Metrics {
    pub const fn new() -> Self {
        Self {
            started_at:              SystemTime::UNIX_EPOCH,
            requests_total:          AtomicU64::new(0),
            requests_active:         AtomicI64::new(0),
            requests_errors_4xx:     AtomicU64::new(0),
            requests_errors_5xx:     AtomicU64::new(0),
            storage_bytes_uploaded:  AtomicU64::new(0),
            storage_bytes_downloaded: AtomicU64::new(0),
            objects_created:         AtomicU64::new(0),
            objects_deleted:         AtomicU64::new(0),
            objects_expired:         AtomicU64::new(0),
            cleanup_stale_removed:   AtomicU64::new(0),
            cleanup_expired_removed: AtomicU64::new(0),
        }
    }
}

pub static METRICS: Metrics = Metrics::new();

pub fn snapshot() -> serde_json::Value {
    use serde_json::json;
    let uptime = SystemTime::now()
        .duration_since(METRICS.started_at)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    json!({
        "uptimeSeconds": uptime,
        "requests": {
            "total":    METRICS.requests_total.load(Ordering::Relaxed),
            "active":   METRICS.requests_active.load(Ordering::Relaxed),
            "errors4xx": METRICS.requests_errors_4xx.load(Ordering::Relaxed),
            "errors5xx": METRICS.requests_errors_5xx.load(Ordering::Relaxed),
        },
        "storage": {
            "bytesUploaded":   METRICS.storage_bytes_uploaded.load(Ordering::Relaxed),
            "bytesDownloaded": METRICS.storage_bytes_downloaded.load(Ordering::Relaxed),
        },
        "objects": {
            "created": METRICS.objects_created.load(Ordering::Relaxed),
            "deleted": METRICS.objects_deleted.load(Ordering::Relaxed),
            "expired": METRICS.objects_expired.load(Ordering::Relaxed),
        },
        "cleanup": {
            "staleUploadsRemoved":   METRICS.cleanup_stale_removed.load(Ordering::Relaxed),
            "expiredObjectsRemoved": METRICS.cleanup_expired_removed.load(Ordering::Relaxed),
        },
    })
}
