# Configuration Reference

All configuration is read from environment variables at startup. Copy `.env.example` to `.env` and fill in the values.

---

## Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | TCP port the HTTP server listens on |
| `NODE_ENV` | `development` | `development` enables coloured logs and verbose output. Set to `production` for JSON logs. |
| `BASE_URL` | `http://localhost:3000` | Used when constructing pre-signed URL strings returned to clients. Set to your public domain in production. |

---

## Storage (Local Filesystem)

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_ROOT` | `/tmp/loony-s3/data` | Root directory for all object data. Must be on a filesystem with sufficient space. |
| `DB_PATH` | `/tmp/loony-s3/metadata.db` | Path to the SQLite database file. |

Both directories are created automatically on startup if they do not exist.

**Production recommendation:** Use a dedicated mounted volume for `STORAGE_ROOT` and `DB_PATH`. Do not use `/tmp` — it is ephemeral and may be cleared on restart.

---

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | `dev-secret-change-in-production` | HMAC-SHA256 key used to sign and verify JWTs. **Must be changed in production.** Generate with `openssl rand -hex 32`. |
| `JWT_EXPIRY` | `24h` | Token lifetime. Accepts any value accepted by the `jsonwebtoken` library (e.g. `1h`, `7d`, `3600`). |

---

## Pre-signed URLs

| Variable | Default | Description |
|----------|---------|-------------|
| `PRESIGNED_SECRET` | `dev-presigned-secret` | HMAC-SHA256 key used to sign pre-signed URL payloads. Separate from `JWT_SECRET` so rotating one doesn't invalidate the other. **Must be changed in production.** |
| `PRESIGNED_MAX_EXPIRY_SECONDS` | `604800` | Maximum lifetime a caller may request for a pre-signed URL (default 7 days). Requests for longer expiry are rejected with 400. |

---

## Upload Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_OBJECT_SIZE_BYTES` | `5368709120` | Maximum size of any single object (5 GB). Enforced on single-part PUT via `Content-Length`. |
| `MAX_PART_SIZE_BYTES` | `104857600` | Maximum size of a single multipart part (100 MB). |
| `MIN_PART_SIZE_BYTES` | `0` | Minimum size of a multipart part. `0` disables the check. Set to `5242880` (5 MB) for strict S3 compatibility — enforced on all parts except the last. |
| `MAX_PARTS` | `10000` | Maximum number of parts in a multipart upload (matches S3). |

---

## Example `.env` Files

### Local Development (defaults, no changes needed)

```env
PORT=3000
NODE_ENV=development
STORAGE_ROOT=/tmp/loony-s3/data
DB_PATH=/tmp/loony-s3/metadata.db
JWT_SECRET=dev-secret-change-in-production
PRESIGNED_SECRET=dev-presigned-secret
BASE_URL=http://localhost:3000
```

### Production (single server)

```env
PORT=3000
NODE_ENV=production
STORAGE_ROOT=/var/data/loony-s3/objects
DB_PATH=/var/data/loony-s3/metadata.db

JWT_SECRET=<output of: openssl rand -hex 32>
JWT_EXPIRY=12h
PRESIGNED_SECRET=<output of: openssl rand -hex 32>
PRESIGNED_MAX_EXPIRY_SECONDS=86400

BASE_URL=https://storage.yourdomain.com
MAX_OBJECT_SIZE_BYTES=5368709120
MIN_PART_SIZE_BYTES=5242880
```

### Future — PostgreSQL + Distributed Storage

When the PostgreSQL and distributed storage backends are implemented (see [next-steps.md](next-steps.md)), add:

```env
DB_DRIVER=postgres
PG_URL=postgresql://loony:secret@postgres:5432/loony_s3
PG_POOL_MIN=2
PG_POOL_MAX=20

STORAGE_DRIVER=minio
MINIO_ENDPOINT=http://minio:9000
MINIO_BUCKET=loony-s3-objects
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
```

`server.ts` reads `DB_DRIVER` and `STORAGE_DRIVER` and instantiates the appropriate implementation. No service code changes.
