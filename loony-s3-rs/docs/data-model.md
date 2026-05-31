# Data Model

## Overview

loony-s3 separates persistence into two independent concerns:

- **Metadata** — structured, relational data (bucket config, object attributes, multipart upload state) stored in SQLite
- **Blob storage** — raw bytes stored on the local filesystem (swappable via the `StorageBackend` interface)

---

## Metadata Schema (SQLite)

SQLite is configured in WAL (Write-Ahead Logging) mode, which allows concurrent readers while a writer holds the lock — critical for serving downloads while uploads are in progress.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
```

---

### `buckets`

```sql
CREATE TABLE buckets (
  id           TEXT PRIMARY KEY,
  name         TEXT UNIQUE NOT NULL,
  owner_id     TEXT NOT NULL,
  acl          TEXT NOT NULL DEFAULT 'private',
  region       TEXT NOT NULL DEFAULT 'us-east-1',
  versioning   INTEGER NOT NULL DEFAULT 0,      -- 0 = off, 1 = on
  metadata     TEXT NOT NULL DEFAULT '{}',       -- JSON string
  created_at   TEXT NOT NULL,                    -- ISO 8601
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_buckets_name     ON buckets(name);
CREATE INDEX idx_buckets_owner_id ON buckets(owner_id);
```

**Key constraints:**
- `name` is globally unique (like S3 bucket names). Validated to be 3–63 chars, lowercase alphanumeric with hyphens and dots; must start and end with alphanumeric; no `..`, `.-`, or `-.` sequences.
- `acl` is one of `'private'`, `'public-read'`, `'public-read-write'`
- `metadata` is stored as a JSON string (e.g. `{"team":"backend","env":"prod"}`)

---

### `objects`

```sql
CREATE TABLE objects (
  id           TEXT PRIMARY KEY,
  bucket_id    TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  bucket_name  TEXT NOT NULL,
  key          TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
  etag         TEXT NOT NULL,           -- MD5 hex of the full object content
  storage_key  TEXT NOT NULL UNIQUE,    -- opaque path within StorageBackend
  acl          TEXT NOT NULL DEFAULT 'private',
  version_id   TEXT NOT NULL,           -- random hex, unique per PUT
  is_latest    INTEGER NOT NULL DEFAULT 1,  -- 1 = current, 0 = superseded
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT                         -- NULL until deleted
);

CREATE INDEX idx_objects_bucket_key    ON objects(bucket_id, key, is_latest);
CREATE INDEX idx_objects_bucket_prefix ON objects(bucket_id, key);
```

**Versioning mechanics:**

Every PUT to an existing key:
1. Sets `is_latest = 0` on all existing rows for `(bucket_id, key)`
2. Inserts a new row with `is_latest = 1` and a fresh `version_id`

This means multiple rows share the same `key`. Only the row with `is_latest = 1` is returned by normal `GET` and `LIST` operations. Specific versions are accessible via `?versionId=<version_id>`.

```
key = "photo.jpg"

id   version_id  is_latest  created_at
───  ──────────  ─────────  ────────────────────
001  aaaa...     0          2026-01-01T10:00:00Z   ← v1
002  bbbb...     0          2026-01-10T14:00:00Z   ← v2
003  cccc...     1          2026-04-18T09:00:00Z   ← latest (v3)
```

**Soft vs hard delete:**

`ObjectService.deleteObject()` performs a hard delete — removes the row from the DB and deletes the file from storage. The metadata disappears immediately; the storage cleanup is fire-and-forget (the object is already logically gone).

> To add soft delete (delete markers, like S3 versioning), add a `is_delete_marker` column and set it on DELETE instead of removing the row.

**`storage_key` format:**
```
{bucket-name}/{2-char-shard}/{version-id-hex}

Example: my-bucket/a3/a3f8e2c9d14b47...
```

The `bucket_name` is denormalised into this table to avoid a join on every presigned URL validation, which only has the name (not the id) available.

---

### `multipart_uploads`

```sql
CREATE TABLE multipart_uploads (
  upload_id    TEXT PRIMARY KEY,
  bucket_id    TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  bucket_name  TEXT NOT NULL,
  key          TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  metadata     TEXT NOT NULL DEFAULT '{}',
  parts        TEXT NOT NULL DEFAULT '[]',  -- JSON array of UploadPart
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_multipart_bucket ON multipart_uploads(bucket_id, key);
```

The `parts` column stores a JSON array that grows with every uploaded part:

```json
[
  { "partNumber": 1, "etag": "b3b0cbd1...", "size": 104857600, "storageKey": "__tmp/abc123/1" },
  { "partNumber": 2, "etag": "19278e6b...", "size": 153600,    "storageKey": "__tmp/abc123/2" }
]
```

Parts are sorted by `partNumber` after every upsert so the `complete` handler can iterate them in order without extra sorting.

> For high-throughput systems, replace the JSON array with a dedicated `multipart_parts` table and use `INSERT OR REPLACE` for idempotent re-uploads.

---

## Blob Storage Layout

```
$STORAGE_ROOT/
│
├── {bucket-name}/
│   ├── {shard}/                ← first 2 hex chars of version_id
│   │   └── {version_id_hex}    ← actual object bytes
│   └── ...
│
└── __tmp/
    └── {upload_id}/
        ├── 1                   ← part 1 bytes
        ├── 2                   ← part 2 bytes
        └── ...
```

**Sharding rationale:** A `BLOB` with 10M objects and no subdirectory structure would have a 10M-entry root directory — ext4 and most filesystems slow to a crawl past ~100K entries. The 2-char hex shard distributes objects across 256 subdirectories (16² = 256), capping each directory at ~39K entries at 10M total objects.

**Atomic writes:** Every object is written to `{dest}.tmp.{timestamp}` first. Only after the stream is fully flushed does `fs.renameSync(tmp, dest)` commit it. If the process crashes mid-upload, the `.tmp.*` file is left behind but the final path never exists — the client gets an error and can retry safely.

---

## Type Definitions

```typescript
// src/types/index.ts

interface Bucket {
  id: string;
  name: string;
  ownerId: string;
  acl: 'private' | 'public-read' | 'public-read-write';
  region: string;
  versioning: boolean;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, string>;
}

interface StoredObject {
  id: string;
  bucketId: string;
  bucketName: string;
  key: string;
  size: number;
  mimeType: string;
  etag: string;          // MD5 hex
  storageKey: string;    // opaque; only StorageBackend interprets this
  acl: 'private' | 'public-read';
  versionId: string;
  isLatest: boolean;
  metadata: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

interface MultipartUpload {
  uploadId: string;
  bucketId: string;
  bucketName: string;
  key: string;
  ownerId: string;
  metadata: Record<string, string>;
  parts: UploadPart[];
  createdAt: Date;
}

interface UploadPart {
  partNumber: number;   // 1–10000
  etag: string;
  size: number;
  storageKey: string;
}
```

---

## Key Design Decisions

### Why store `bucket_name` in `objects`?

Pre-signed URL validation needs to look up the bucket owner to impersonate them after signature verification. It only has the bucket name (from the URL), not the bucket ID. Denormalising `bucket_name` avoids a join on every presigned request.

### Why MD5 as ETag?

S3 uses MD5 as ETag for single-part uploads. The MD5 is computed as a streaming hash during write — it adds no extra I/O pass. For multipart uploads, the ETag is the MD5 of the assembled file (concatenated parts), not the S3 composite ETag convention (`MD5(MD5(part1) || MD5(part2) || ...)-N`).

### Why `TEXT` for JSON columns?

`node:sqlite` doesn't have native JSONB. Using `TEXT` with `JSON.stringify/parse` is idiomatic for SQLite. When migrating to PostgreSQL, replace `TEXT` with `JSONB` for better query performance on metadata filters.

### Why not use an ORM?

ORMs add abstraction and magic that obscure the actual SQL being executed — important to keep visible in a system where query performance and index usage matter. The repositories are small enough that raw SQL is clear and maintainable.
