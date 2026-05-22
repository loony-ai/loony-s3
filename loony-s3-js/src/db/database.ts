// Node 24's built-in SQLite — no native addon required.
// Enable with: NODE_OPTIONS='--experimental-sqlite'
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    logger.info('SQLite database closed');
  }
}

export function initDb(): void {
  const dbDir = path.dirname(config.storage.dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  db = new DatabaseSync(config.storage.dbPath);

  // WAL mode: concurrent reads + single writer, non-blocking.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  runMigrations(db);
  addMissingColumns(db);
  logger.info('Database initialized', { path: config.storage.dbPath });
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS buckets (
      id           TEXT PRIMARY KEY,
      name         TEXT UNIQUE NOT NULL,
      owner_id     TEXT NOT NULL,
      acl          TEXT NOT NULL DEFAULT 'private',
      region       TEXT NOT NULL DEFAULT 'us-east-1',
      versioning   INTEGER NOT NULL DEFAULT 0,
      metadata     TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_buckets_name     ON buckets(name);
    CREATE INDEX IF NOT EXISTS idx_buckets_owner_id ON buckets(owner_id);

    CREATE TABLE IF NOT EXISTS objects (
      id           TEXT PRIMARY KEY,
      bucket_id    TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
      bucket_name  TEXT NOT NULL,
      key          TEXT NOT NULL,
      size         INTEGER NOT NULL DEFAULT 0,
      mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      etag         TEXT NOT NULL,
      storage_key  TEXT NOT NULL UNIQUE,
      acl          TEXT NOT NULL DEFAULT 'private',
      version_id   TEXT NOT NULL,
      is_latest    INTEGER NOT NULL DEFAULT 1,
      metadata     TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      deleted_at   TEXT,
      expires_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_objects_bucket_key
      ON objects(bucket_id, key, is_latest);

    CREATE INDEX IF NOT EXISTS idx_objects_bucket_prefix
      ON objects(bucket_id, key);

    CREATE TABLE IF NOT EXISTS multipart_uploads (
      upload_id    TEXT PRIMARY KEY,
      bucket_id    TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
      bucket_name  TEXT NOT NULL,
      key          TEXT NOT NULL,
      owner_id     TEXT NOT NULL,
      metadata     TEXT NOT NULL DEFAULT '{}',
      parts        TEXT NOT NULL DEFAULT '[]',
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multipart_bucket
      ON multipart_uploads(bucket_id, key);
  `);
}

function addMissingColumns(db: DatabaseSync): void {
  // SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so we
  // attempt the ALTER and silently swallow the "duplicate column" error.
  try {
    db.exec('ALTER TABLE objects ADD COLUMN expires_at TEXT');
  } catch {
    // column already exists — ignore
  }
}
