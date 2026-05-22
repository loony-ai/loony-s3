import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

let pool: Pool;

export function getPool(): Pool {
  if (!pool) throw new Error('PostgreSQL pool not initialized. Call initPostgres() first.');
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    logger.info('PostgreSQL pool closed');
  }
}

export async function initPostgres(): Promise<void> {
  pool = new Pool({ connectionString: config.db.postgresUrl });

  // Smoke-test the connection.
  await pool.query('SELECT 1');

  await runMigrations();
  logger.info('PostgreSQL initialized', { url: config.db.postgresUrl });
}

async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS buckets (
      id          TEXT PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      owner_id    TEXT NOT NULL,
      acl         TEXT NOT NULL DEFAULT 'private',
      region      TEXT NOT NULL DEFAULT 'us-east-1',
      versioning  BOOLEAN NOT NULL DEFAULT false,
      metadata    JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_buckets_name     ON buckets(name);
    CREATE INDEX IF NOT EXISTS idx_buckets_owner_id ON buckets(owner_id);

    CREATE TABLE IF NOT EXISTS objects (
      id          TEXT PRIMARY KEY,
      bucket_id   TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
      bucket_name TEXT NOT NULL,
      key         TEXT NOT NULL,
      size        BIGINT NOT NULL DEFAULT 0,
      mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
      etag        TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      acl         TEXT NOT NULL DEFAULT 'private',
      version_id  TEXT NOT NULL,
      is_latest   BOOLEAN NOT NULL DEFAULT true,
      metadata    JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL,
      deleted_at  TIMESTAMPTZ,
      expires_at  TIMESTAMPTZ
    );

    ALTER TABLE objects ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_objects_bucket_key
      ON objects(bucket_id, key, is_latest);

    CREATE INDEX IF NOT EXISTS idx_objects_bucket_prefix
      ON objects(bucket_id, key);

    CREATE TABLE IF NOT EXISTS multipart_uploads (
      upload_id   TEXT PRIMARY KEY,
      bucket_id   TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
      bucket_name TEXT NOT NULL,
      key         TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      metadata    JSONB NOT NULL DEFAULT '{}',
      parts       JSONB NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multipart_bucket
      ON multipart_uploads(bucket_id, key);
  `);
}
