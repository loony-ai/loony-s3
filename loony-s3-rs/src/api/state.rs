use std::sync::Arc;

use crate::config::Config;
use crate::services::{BucketService, CleanupService, MultipartService, ObjectService, PresignedService};

#[derive(Clone)]
pub struct AppState {
    pub config:        Arc<Config>,
    pub bucket_svc:    Arc<BucketService>,
    pub object_svc:    Arc<ObjectService>,
    pub multipart_svc: Arc<MultipartService>,
    pub presigned_svc: Arc<PresignedService>,
    pub cleanup_svc:   Arc<CleanupService>,
}
