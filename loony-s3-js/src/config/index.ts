function requireEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Env var ${key} must be an integer`);
  return n;
}

export const config = {
  port: envInt("PORT", 3000),
  nodeEnv: process.env["NODE_ENV"] ?? "development",
  isDev: (process.env["NODE_ENV"] ?? "development") === "development",

  storage: {
    /** Which storage backend to use: local | nfs */
    backend: (process.env["STORAGE_BACKEND"] ?? "local") as "local" | "nfs",

    // ── Local / NFS ────────────────────────────────────────────────────────
    /** Root directory for the local filesystem backend. */
    root: process.env["STORAGE_ROOT"] ?? "/tmp/loony-s3/data",
    /** Mount path for the NFS backend (the NFS volume must already be mounted). */
    nfsRoot: process.env["NFS_MOUNT_PATH"] ?? "/mnt/nfs/loony-s3",

    // ── SQLite metadata ────────────────────────────────────────────────────
    dbPath: process.env["DB_PATH"] ?? "/tmp/loony-s3/metadata.db",
  },

  auth: {
    jwtSecret: requireEnv("JWT_SECRET", "dev-secret-change-in-production"),
    jwtExpiry: process.env["JWT_EXPIRY"] ?? "24h",
  },

  presigned: {
    secret: requireEnv("PRESIGNED_SECRET", "dev-presigned-secret"),
    maxExpirySeconds: envInt("PRESIGNED_MAX_EXPIRY_SECONDS", 604800), // 7 days
  },

  upload: {
    maxObjectSizeBytes: envInt("MAX_OBJECT_SIZE_BYTES", 5 * 1024 * 1024 * 1024), // 5 GB
    maxPartSizeBytes: envInt("MAX_PART_SIZE_BYTES", 100 * 1024 * 1024), // 100 MB
    minPartSizeBytes: envInt("MIN_PART_SIZE_BYTES", 0), // 0 = disabled; set to 5242880 for S3 compatibility
    maxParts: envInt("MAX_PARTS", 10000),
  },

  baseUrl: process.env["BASE_URL"] ?? "http://localhost:3000",

  // ── Rate limiting ───────────────────────────────────────────────────────────
  rateLimit: {
    windowMs: envInt("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000), // 15 minutes
    auth: { max: envInt("RATE_LIMIT_AUTH_MAX", 20) },
    upload: { max: envInt("RATE_LIMIT_UPLOAD_MAX", 200) },
    download: { max: envInt("RATE_LIMIT_DOWNLOAD_MAX", 600) },
    general: { max: envInt("RATE_LIMIT_GENERAL_MAX", 500) },
  },

  // ── Background cleanup ──────────────────────────────────────────────────────
  cleanup: {
    /** How often to scan for and delete expired objects (ms). */
    expiredObjectsIntervalMs: envInt(
      "CLEANUP_EXPIRED_INTERVAL_MS",
      5 * 60 * 1000,
    ), // 5 min
    /** How often to scan for stale multipart uploads (ms). */
    staleUploadsIntervalMs: envInt(
      "CLEANUP_STALE_UPLOADS_INTERVAL_MS",
      60 * 60 * 1000,
    ), // 1 hr
    /** Multipart uploads older than this are considered abandoned (ms). */
    staleUploadMaxAgeMs: envInt(
      "CLEANUP_STALE_UPLOAD_MAX_AGE_MS",
      24 * 60 * 60 * 1000,
    ), // 24 hr
    /** Max objects deleted per cleanup run (prevents long-lock cycles). */
    batchSize: envInt("CLEANUP_BATCH_SIZE", 100),
  },

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  shutdown: {
    /** Time to wait for in-flight requests before destroying connections (ms). */
    drainTimeoutMs: envInt("SHUTDOWN_DRAIN_TIMEOUT_MS", 10_000),
    /** Hard-kill timeout after drain if process still hasn't exited (ms). */
    forceExitTimeoutMs: envInt("SHUTDOWN_FORCE_EXIT_TIMEOUT_MS", 30_000),
  },

  db: {
    backend: (process.env["DB_BACKEND"] ?? "sqlite") as "sqlite" | "postgres",
    postgresUrl: process.env["DATABASE_URL"] ?? undefined,
  },
} as const;
