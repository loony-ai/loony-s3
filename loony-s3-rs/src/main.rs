use std::sync::Arc;
use std::time::SystemTime;
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod api;
mod config;
mod error;
mod metrics;
mod repositories;
mod services;
mod storage;
mod types;

use api::state::AppState;
use config::{Config, DbBackendKind, StorageBackendKind};
use repositories::{
    postgres_run_migrations as pg_migrate, sqlite_run_migrations as sqlite_migrate,
    PostgresBucketRepository, PostgresObjectRepository,
    SqliteBucketRepository, SqliteObjectRepository,
    BucketRepository, ObjectRepository,
};
use services::{BucketService, CleanupService, MultipartService, ObjectService, PresignedService};
use storage::FsStorageBackend;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // ── Logging ───────────────────────────────────────────────────────────────
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // ── Config ────────────────────────────────────────────────────────────────
    let cfg = Arc::new(Config::from_env());
    tracing::info!(port = cfg.port, db = ?cfg.db.backend, storage = ?cfg.storage.backend, "starting loony-s3-rs");

    // Record startup time for uptime metric.
    unsafe {
        let m = &metrics::METRICS as *const _ as *mut metrics::Metrics;
        (*m).started_at = SystemTime::now();
    }

    // ── Storage backend ───────────────────────────────────────────────────────
    let storage: Arc<dyn storage::StorageBackend> = match cfg.storage.backend {
        StorageBackendKind::Local => Arc::new(FsStorageBackend::new_local(&cfg.storage.root)),
        StorageBackendKind::Nfs   => Arc::new(FsStorageBackend::new_nfs(&cfg.storage.nfs_root)),
    };

    // ── Database / repositories ───────────────────────────────────────────────
    let (bucket_repo, object_repo): (Arc<dyn BucketRepository>, Arc<dyn ObjectRepository>) =
        match cfg.db.backend {
            DbBackendKind::Sqlite => {
                let opts = sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&cfg.db.sqlite_path)
                    .create_if_missing(true);
                let pool = sqlx::SqlitePool::connect_with(opts).await?;
                sqlite_migrate(&pool).await?;
                (
                    Arc::new(SqliteBucketRepository { pool: pool.clone() }),
                    Arc::new(SqliteObjectRepository { pool }),
                )
            }
            DbBackendKind::Postgres => {
                let pool = sqlx::PgPool::connect(&cfg.db.postgres_url).await?;
                pg_migrate(&pool).await?;
                (
                    Arc::new(PostgresBucketRepository { pool: pool.clone() }),
                    Arc::new(PostgresObjectRepository { pool }),
                )
            }
        };

    // ── Services ──────────────────────────────────────────────────────────────
    let bucket_svc    = Arc::new(BucketService::new(bucket_repo));
    let object_svc    = Arc::new(ObjectService::new(object_repo.clone(), storage.clone()));
    let multipart_svc = Arc::new(MultipartService::new(object_repo.clone(), storage.clone()));
    let presigned_svc = Arc::new(PresignedService::new(cfg.presigned.secret.clone()));
    let cleanup_svc   = Arc::new(CleanupService::new(object_repo.clone(), storage.clone()));

    // ── Background cleanup tasks ──────────────────────────────────────────────
    let cleanup_exp = cleanup_svc.clone();
    let exp_interval = cfg.cleanup.expired_objects_interval_secs;
    let batch = cfg.cleanup.batch_size;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(
            std::time::Duration::from_secs(exp_interval)
        );
        loop {
            ticker.tick().await;
            match cleanup_exp.clean_expired_objects(batch).await {
                Ok(n) if n > 0 => tracing::info!(removed = n, "expired objects cleaned"),
                Err(e)         => tracing::error!(err = %e, "cleanup_expired_objects failed"),
                _              => {}
            }
        }
    });

    let cleanup_stale = cleanup_svc.clone();
    let stale_interval = cfg.cleanup.stale_uploads_interval_secs;
    let max_age_secs   = cfg.cleanup.stale_upload_max_age_secs;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(
            std::time::Duration::from_secs(stale_interval)
        );
        loop {
            ticker.tick().await;
            let max_age = chrono::Duration::seconds(max_age_secs as i64);
            match cleanup_stale.clean_stale_uploads(max_age).await {
                Ok(n) if n > 0 => tracing::info!(removed = n, "stale multipart uploads cleaned"),
                Err(e)         => tracing::error!(err = %e, "cleanup_stale_uploads failed"),
                _              => {}
            }
        }
    });

    // ── Router ────────────────────────────────────────────────────────────────
    let state = AppState {
        config:        cfg.clone(),
        bucket_svc,
        object_svc,
        multipart_svc,
        presigned_svc,
        cleanup_svc,
    };

    let app    = api::build_router(state);
    let addr   = format!("0.0.0.0:{}", cfg.port);
    let listener = TcpListener::bind(&addr).await?;
    tracing::info!(addr, "server listening");

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    let drain_secs  = cfg.shutdown.drain_timeout_secs;
    let force_secs  = cfg.shutdown.force_exit_timeout_secs;

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(drain_secs, force_secs))
        .await?;

    tracing::info!("server stopped");
    Ok(())
}

async fn shutdown_signal(drain_secs: u64, force_secs: u64) {
    use tokio::signal;

    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c   => tracing::info!("received Ctrl-C"),
        _ = terminate => tracing::info!("received SIGTERM"),
    }

    tracing::info!(drain_secs, "draining connections…");

    // Give in-flight requests time to finish.
    tokio::time::sleep(std::time::Duration::from_secs(drain_secs)).await;

    // Force-exit as a safety net.
    let force = force_secs;
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(force)).await;
        tracing::warn!("force-exit timeout reached");
        std::process::exit(1);
    });
}
