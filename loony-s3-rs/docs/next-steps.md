# What To Do Next

This document is a prioritised, concrete roadmap. Items are ordered by impact — do the top ones first.

---

## 1. Make Repositories Async (Prerequisite for Everything Else)

**Why:** The current `BucketRepository` and `ObjectRepository` use Node's built-in synchronous SQLite API. Every other database driver (PostgreSQL, MySQL, MongoDB) is async. Keeping the repositories synchronous means you can never swap the database without rewriting the service layer.

**What to do:**

Define explicit async interfaces:

```typescript
// src/repositories/interfaces.ts
export interface IBucketRepository {
  findByName(name: string): Promise<Bucket | undefined>;
  findById(id: string): Promise<Bucket | undefined>;
  listByOwner(ownerId: string): Promise<Bucket[]>;
  create(bucket: Bucket): Promise<Bucket>;
  update(id: string, updates: Partial<...>): Promise<Bucket>;
  delete(id: string): Promise<void>;
  existsByName(name: string): Promise<boolean>;
}

export interface IObjectRepository {
  findLatest(bucketId: string, key: string): Promise<StoredObject | undefined>;
  list(bucketId: string, query: ListObjectsQuery): Promise<ListObjectsResult>;
  create(obj: StoredObject): Promise<StoredObject>;
  hardDelete(bucketId: string, key: string, versionId?: string): Promise<string[]>;
  countInBucket(bucketId: string): Promise<number>;
  createMultipartUpload(upload: MultipartUpload): Promise<MultipartUpload>;
  findMultipartUpload(uploadId: string): Promise<MultipartUpload | undefined>;
  upsertPart(uploadId: string, part: UploadPart): Promise<void>;
  deleteMultipartUpload(uploadId: string): Promise<void>;
}
```

Move the existing SQLite repositories to `src/repositories/sqlite/` and make them implement these interfaces by wrapping synchronous calls in `Promise.resolve()`.

Update services to `await` every repository call — this is mechanical, mostly just adding `await` in front of calls that currently return values directly.

**Files touched:** `repositories/`, `services/BucketService.ts`, `services/ObjectService.ts`, `services/MultipartUploadService.ts`, `services/PresignedUrlService.ts`

---

## 2. Replace SQLite with PostgreSQL

**Why:** SQLite is single-writer. Under concurrent upload/download load it serialises all writes. PostgreSQL has row-level locking, true parallel writes, connection pooling, and JSONB indexing on metadata.

**What to do:**

Add `pg` (node-postgres):
```bash
npm install pg @types/pg
```

Implement `src/repositories/postgres/BucketRepository.ts` and `ObjectRepository.ts` using a `pg.Pool`. The schema is the same as SQLite with these type upgrades:

| SQLite | PostgreSQL |
|--------|-----------|
| `TEXT` (for dates) | `TIMESTAMPTZ` |
| `INTEGER` (for booleans) | `BOOLEAN` |
| `INTEGER` (for sizes) | `BIGINT` |
| `TEXT` (for JSON) | `JSONB` |

Use a `pg.Pool` (not a single `Client`) so multiple concurrent requests each get their own connection:

```typescript
// src/repositories/postgres/pool.ts
import { Pool } from 'pg';
import { config } from '../../config';

export const pool = new Pool({
  connectionString: config.postgres.connectionString,
  min: 2,
  max: 20,
  idleTimeoutMillis: 10_000,
  statement_timeout: 30_000,
});
```

Add a `DB_DRIVER=postgres` env var. In `server.ts`, switch on it:

```typescript
// server.ts — the ONLY file that changes when swapping the database
const bucketRepo =
  config.dbDriver === 'postgres'
    ? new PostgresBucketRepository(pool)
    : new SqliteBucketRepository();
```

Write a simple migration runner (or use `node-migrate` / `db-migrate`) so the schema stays in version-controlled `.sql` files rather than embedded strings.

**Immediate benefit:** True horizontal scaling — multiple API processes can now write to the same database concurrently.

---

## 3. Replace Local Filesystem with Distributed Object Storage

**Why:** The local filesystem is tied to a single machine. If you run 3 API replicas, a file uploaded to replica 1 is invisible to replicas 2 and 3. You need a shared storage layer.

**Option A — MinIO (self-hosted, S3-compatible)**

MinIO is a drop-in S3-compatible object store that runs as a Docker container. It uses HTTP, so any API node can reach it. Implement `src/storage/MinioStorageBackend.ts` using Node's built-in `http`/`https` modules (or a lightweight HTTP client like `undici`):

```
API replica 1  ─┐
API replica 2  ─┼──► MinIO (HTTP :9000)  ──► disk / distributed erasure
API replica 3  ─┘
```

The `StorageBackend` interface already gives you the right abstraction — `write()`, `read()`, `assembleMultipart()` etc. map directly to MinIO's PUT/GET/multipart APIs.

**Option B — NFS / shared volume**

The simplest path: mount a shared NFS volume at `$STORAGE_ROOT` on all API replicas. The `LocalStorageBackend` continues to work unchanged. This is simple but NFS is a latency and consistency bottleneck at scale.

**Option C — Cloudflare R2 / Backblaze B2**

Both expose an S3-compatible API. A single `S3CompatibleStorageBackend` that accepts an endpoint URL, access key, and secret key can target any of these. Only the config changes per deployment.

**Add to `server.ts`:**

```typescript
const storage =
  config.storageDriver === 'minio'
    ? new MinioStorageBackend()
    : new LocalStorageBackend();
```

---

## 4. Add a Load Balancer (nginx)

**Why:** A single API process caps out at Node's event loop throughput — typically 2–5K req/s for I/O-bound workloads. Running multiple replicas behind nginx multiplies this linearly.

**What to do:**

Add `docker-compose.yml`:

```yaml
services:
  nginx:
    image: nginx:alpine
    ports: ["80:80"]
    volumes: ["./nginx/nginx.conf:/etc/nginx/nginx.conf:ro"]
    depends_on: [api1, api2, api3]

  api1:
    build: .
    environment:
      DB_DRIVER: postgres
      PG_URL: postgresql://loony:loony@postgres:5432/loony_s3
      STORAGE_DRIVER: minio
      ...

  api2: { <<: *api-template }
  api3: { <<: *api-template }

  postgres:
    image: postgres:16
    environment: { POSTGRES_DB: loony_s3, POSTGRES_USER: loony, POSTGRES_PASSWORD: loony }
    volumes: ["pg-data:/var/lib/postgresql/data"]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    volumes: ["minio-data:/data"]
```

`nginx/nginx.conf`:

```nginx
upstream loony_s3 {
  least_conn;
  server api1:3000;
  server api2:3000;
  server api3:3000;
}

server {
  listen 80;
  client_max_body_size 5g;    # match MAX_OBJECT_SIZE_BYTES

  location / {
    proxy_pass         http://loony_s3;
    proxy_http_version 1.1;
    proxy_set_header   Connection "";            # keepalive to upstream
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;                    # large uploads
    proxy_send_timeout 600s;
  }
}
```

Scale API replicas without touching code:
```bash
docker compose up --scale api=5
```

---

## 5. Add a Real User Store

**Why:** The current auth system derives a `userId` deterministically from the email — there is no real user database. Anyone can pick any email and get "their" userId with no password validation.

**What to do:**

Add a `users` table:

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,        -- bcrypt
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL,        -- SHA-256 of the raw key
  name          TEXT,                 -- human label ("CI key", "prod key")
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

Install `bcrypt`:
```bash
npm install bcrypt @types/bcrypt
```

In `POST /auth/token`: look up the user, verify the password with `bcrypt.compare()`.

In `GET /auth/apikey`: generate a random key, store its `SHA-256` hash in `api_keys`, return the raw key once. On subsequent requests, hash the incoming key and look it up.

---

## 6. Graceful Shutdown

**Why:** When a replica is killed (deploy, crash, scale-down), in-flight requests — especially large streaming uploads — are aborted mid-way. This leaves orphaned `.tmp.*` files and incomplete multipart uploads in the database.

**What to do:**

```typescript
// server.ts
const server = app.listen(config.port, () => { ... });

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`${signal} received — shutting down gracefully`);

  server.close(() => {
    // All keep-alive connections drained; exit.
    pool.end().then(() => process.exit(0));
  });

  // Force-exit after 30s if connections don't drain.
  setTimeout(() => process.exit(1), 30_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

Add a middleware that returns `503` to new requests once `isShuttingDown = true` so nginx routes new requests to healthy replicas immediately.

---

## 7. Background Cleanup Worker

**Why:** Storage deletion is currently fire-and-forget — the metadata row is removed immediately but the file deletion on disk may fail silently, leaving orphaned files.

**What to do:**

Add a `storage_cleanup_queue` table:

```sql
CREATE TABLE storage_cleanup_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key  TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  attempted_at TIMESTAMPTZ,
  attempts     INTEGER DEFAULT 0
);
```

When `ObjectRepository.hardDelete()` removes a row, it inserts into `storage_cleanup_queue` instead of calling the storage backend directly.

Run a background worker (can be a separate process or a `setInterval` in the same process):

```typescript
async function runCleanup() {
  const rows = await pool.query(
    `UPDATE storage_cleanup_queue
     SET attempted_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM storage_cleanup_queue
       WHERE attempted_at IS NULL OR attempted_at < now() - interval '5 minutes'
       LIMIT 100 FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );

  for (const row of rows.rows) {
    try {
      await storage.delete(row.storage_key);
      await pool.query('DELETE FROM storage_cleanup_queue WHERE id = $1', [row.id]);
    } catch (err) {
      logger.warn('Cleanup failed', { storageKey: row.storage_key, attempts: row.attempts });
      if (row.attempts >= 5) {
        logger.error('Giving up on cleanup', { storageKey: row.storage_key });
        await pool.query('DELETE FROM storage_cleanup_queue WHERE id = $1', [row.id]);
      }
    }
  }
}

setInterval(runCleanup, 60_000);
```

`FOR UPDATE SKIP LOCKED` ensures multiple replicas don't process the same row simultaneously.

---

## 8. Observability

**Why:** You can't debug what you can't see. In a distributed system with multiple replicas, correlating a slow request to a specific replica/query/storage call requires structured telemetry.

**What to add:**

**Structured request IDs** — generate a `requestId` (UUID) at the middleware boundary and attach it to every log line in that request's scope. Return it as `X-Request-ID` in the response header.

**Per-operation timing** — log the time spent in storage vs. metadata vs. total for every PUT and GET. This immediately surfaces whether slowness is database or disk I/O.

**Health endpoint metrics** — extend `/health` to return:
```json
{
  "status": "ok",
  "db": { "pool_total": 20, "pool_idle": 18, "pool_waiting": 0 },
  "uptime_seconds": 3600
}
```

**Prometheus metrics** (optional) — expose `/metrics` with:
- `http_requests_total` (by method, path, status)
- `http_request_duration_seconds` histogram
- `object_uploads_total`, `object_bytes_uploaded_total`
- `db_pool_connections` gauge

Use `prom-client` (zero dependencies, widely used with Node.js).

---

## 9. Object Expiry (TTL)

**Why:** Many use cases need temporary storage — pre-generated reports, session uploads, user-uploaded files that are processed and then discarded.

**What to do:**

Add `expires_at TIMESTAMPTZ` to the `objects` table.

Accept `x-expires-at` or `x-ttl-seconds` on PUT:

```typescript
const expiresAt = req.headers['x-ttl-seconds']
  ? new Date(Date.now() + parseInt(req.headers['x-ttl-seconds']) * 1000)
  : null;
```

In the cleanup worker, add a second pass:

```sql
SELECT storage_key FROM objects
WHERE expires_at IS NOT NULL AND expires_at < now()
LIMIT 500;
```

Delete from storage, then `DELETE FROM objects WHERE id = $1`.

---

## 10. Rate Limiting and Quotas

**Why:** Without limits, a single user can saturate the server with large uploads or list-object scans.

**What to do:**

**Per-IP rate limiting** — use `express-rate-limit` (in-memory) or `redis` (distributed, survives replica restarts):

```typescript
import rateLimit from 'express-rate-limit';
app.use('/auth/token', rateLimit({ windowMs: 60_000, max: 20 }));
app.use(rateLimit({ windowMs: 1000, max: 200 }));  // global: 200 req/s per IP
```

**Per-user storage quota** — add a `storage_bytes_used` column to `users`. Increment on PUT, decrement on DELETE (use a background reconciliation job to handle crashes). Reject uploads that would exceed the quota with HTTP 402 (Payment Required) or 403.

---

## Priority Order

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 1 | Make repos async | 1 day | Unlocks everything below |
| 2 | PostgreSQL repos | 2 days | True horizontal scaling |
| 3 | MinIO storage backend | 2 days | Shared storage across replicas |
| 4 | Docker Compose + nginx | 1 day | Run it all together |
| 5 | Real user store | 1 day | Production-safe auth |
| 6 | Graceful shutdown | 0.5 day | Clean deploys |
| 7 | Background cleanup | 1 day | No orphaned files |
| 8 | Observability | 2 days | Debuggability |
| 9 | Object TTL | 0.5 day | Common use case |
| 10 | Rate limiting | 0.5 day | Safety |

Items 1–4 together are "production-ready horizontal scaling." Items 5–10 are "production-ready service."
