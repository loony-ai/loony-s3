use std::env;

fn env_str(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_int<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key).as_deref() {
        Ok("true") | Ok("1") => true,
        Ok("false") | Ok("0") => false,
        _ => default,
    }
}

// ── Storage ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum StorageBackendKind { Local, Nfs }

#[derive(Clone, Debug)]
pub struct StorageConfig {
    pub backend:  StorageBackendKind,
    pub root:     String,
    pub nfs_root: String,
}

// ── Database ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum DbBackendKind { Sqlite, Postgres }

#[derive(Clone, Debug)]
pub struct DbConfig {
    pub backend:      DbBackendKind,
    pub sqlite_path:  String,
    pub postgres_url: String,
}

// ── Auth ──────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct AuthConfig {
    pub jwt_secret: String,
    pub jwt_expiry: String,
}

// ── Presigned URLs ────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct PresignedConfig {
    pub secret:              String,
    pub max_expiry_seconds:  u64,
}

// ── Upload limits ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct UploadConfig {
    pub max_object_size_bytes: u64,
    pub min_part_size_bytes:   u64,
    pub max_parts:             u32,
}

// ── Background cleanup ────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct CleanupConfig {
    pub expired_objects_interval_secs:  u64,
    pub stale_uploads_interval_secs:    u64,
    pub stale_upload_max_age_secs:      u64,
    pub batch_size:                     i64,
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct RateLimitConfig {
    pub window_secs:  u64,
    pub auth_max:     u32,
    pub upload_max:   u32,
    pub download_max: u32,
    pub general_max:  u32,
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct ShutdownConfig {
    pub drain_timeout_secs:     u64,
    pub force_exit_timeout_secs: u64,
}

// ── Top-level ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Config {
    pub port:       u16,
    pub node_env:   String,
    pub base_url:   String,
    pub storage:    StorageConfig,
    pub db:         DbConfig,
    pub auth:       AuthConfig,
    pub presigned:  PresignedConfig,
    pub upload:     UploadConfig,
    pub cleanup:    CleanupConfig,
    pub rate_limit: RateLimitConfig,
    pub shutdown:   ShutdownConfig,
}

impl Config {
    pub fn from_env() -> Self {
        let _ = dotenvy::dotenv();

        let storage_backend = match env_str("STORAGE_BACKEND", "local").as_str() {
            "nfs"   => StorageBackendKind::Nfs,
            _       => StorageBackendKind::Local,
        };

        let db_backend = match env_str("DB_BACKEND", "sqlite").as_str() {
            "postgres" => DbBackendKind::Postgres,
            _          => DbBackendKind::Sqlite,
        };

        Config {
            port:     env_int("PORT", 3000u16),
            node_env: env_str("NODE_ENV", "development"),
            base_url: env_str("BASE_URL", "http://localhost:3000"),

            storage: StorageConfig {
                backend:  storage_backend,
                root:     env_str("STORAGE_ROOT", "/tmp/loony-s3-rs/data"),
                nfs_root: env_str("NFS_MOUNT_PATH", "/mnt/nfs/loony-s3"),
            },

            db: DbConfig {
                backend:      db_backend,
                sqlite_path:  env_str("DB_PATH", "/tmp/loony-s3-rs/metadata.db"),
                postgres_url: env_str("DATABASE_URL", "postgresql://localhost:5432/loony_s3"),
            },

            auth: AuthConfig {
                jwt_secret: env_str("JWT_SECRET", "dev-secret-change-in-production"),
                jwt_expiry: env_str("JWT_EXPIRY", "86400"),
            },

            presigned: PresignedConfig {
                secret:             env_str("PRESIGNED_SECRET", "dev-presigned-secret"),
                max_expiry_seconds: env_int("PRESIGNED_MAX_EXPIRY_SECONDS", 604_800u64),
            },

            upload: UploadConfig {
                max_object_size_bytes: env_int("MAX_OBJECT_SIZE_BYTES", 5 * 1024 * 1024 * 1024u64),
                min_part_size_bytes:   env_int("MIN_PART_SIZE_BYTES", 0u64),
                max_parts:             env_int("MAX_PARTS", 10_000u32),
            },

            cleanup: CleanupConfig {
                expired_objects_interval_secs: env_int("CLEANUP_EXPIRED_INTERVAL_SECS", 300u64),
                stale_uploads_interval_secs:   env_int("CLEANUP_STALE_UPLOADS_INTERVAL_SECS", 3600u64),
                stale_upload_max_age_secs:     env_int("CLEANUP_STALE_UPLOAD_MAX_AGE_SECS", 86400u64),
                batch_size:                    env_int("CLEANUP_BATCH_SIZE", 100i64),
            },

            rate_limit: RateLimitConfig {
                window_secs:  env_int("RATE_LIMIT_WINDOW_SECS", 900u64),
                auth_max:     env_int("RATE_LIMIT_AUTH_MAX", 20u32),
                upload_max:   env_int("RATE_LIMIT_UPLOAD_MAX", 200u32),
                download_max: env_int("RATE_LIMIT_DOWNLOAD_MAX", 600u32),
                general_max:  env_int("RATE_LIMIT_GENERAL_MAX", 500u32),
            },

            shutdown: ShutdownConfig {
                drain_timeout_secs:      env_int("SHUTDOWN_DRAIN_TIMEOUT_SECS", 10u64),
                force_exit_timeout_secs: env_int("SHUTDOWN_FORCE_EXIT_TIMEOUT_SECS", 30u64),
            },
        }
    }

    pub fn is_dev(&self) -> bool {
        self.node_env == "development"
    }
}
