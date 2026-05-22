# Configuration

All configuration is read from environment variables at startup.  
A `.env` file in the working directory is loaded automatically via `dotenvy`.

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port to listen on |
| `BASE_URL` | `http://localhost:3000` | Public base URL (used in presigned URL generation) |
| `NODE_ENV` | `development` | Runtime environment label |

## Storage backend

| Variable | Default | Description |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` or `nfs` |
| `STORAGE_ROOT` | `/tmp/loony-s3-rs/data` | Root directory for local storage |
| `NFS_MOUNT_PATH` | `/mnt/nfs/loony-s3` | Root directory when `STORAGE_BACKEND=nfs` |

**NFS mode** uses the same `FsStorageBackend` but calls `fsync` before the atomic rename, preventing partial-file visibility across NFS nodes.

## Database backend

| Variable | Default | Description |
|---|---|---|
| `DB_BACKEND` | `sqlite` | `sqlite` or `postgres` |
| `DB_PATH` | `/tmp/loony-s3-rs/metadata.db` | SQLite file path (created if missing) |
| `DATABASE_URL` | `postgresql://localhost:5432/loony_s3` | PostgreSQL connection URL |

Schema migrations run automatically on startup for both backends.

## Authentication

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | `dev-secret-change-in-production` | HMAC secret for JWT signing |
| `JWT_EXPIRY` | `86400` | Token lifetime in seconds (default 24 h) |

## Presigned URLs

| Variable | Default | Description |
|---|---|---|
| `PRESIGNED_SECRET` | `dev-presigned-secret` | HMAC-SHA256 key for presigned URL signing |
| `PRESIGNED_MAX_EXPIRY_SECONDS` | `604800` | Maximum allowed expiry (7 days) |

## Upload limits

| Variable | Default | Description |
|---|---|---|
| `MAX_OBJECT_SIZE_BYTES` | `5368709120` | 5 GiB single-object limit |
| `MIN_PART_SIZE_BYTES` | `0` | Minimum multipart part size |
| `MAX_PARTS` | `10000` | Maximum number of multipart parts |

## Background cleanup

| Variable | Default | Description |
|---|---|---|
| `CLEANUP_EXPIRED_INTERVAL_SECS` | `300` | How often to sweep expired objects (5 min) |
| `CLEANUP_STALE_UPLOADS_INTERVAL_SECS` | `3600` | How often to sweep stale multipart uploads (1 h) |
| `CLEANUP_STALE_UPLOAD_MAX_AGE_SECS` | `86400` | Age threshold for stale uploads (24 h) |
| `CLEANUP_BATCH_SIZE` | `100` | Max objects removed per cleanup pass |

## Rate limiting

Limits are per-server (not distributed). They use a fixed-window governor.

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_WINDOW_SECS` | `900` | Window duration (15 min) |
| `RATE_LIMIT_AUTH_MAX` | `20` | Token requests per window |
| `RATE_LIMIT_UPLOAD_MAX` | `200` | PUT requests per window |
| `RATE_LIMIT_DOWNLOAD_MAX` | `600` | GET object requests per window |
| `RATE_LIMIT_GENERAL_MAX` | `500` | All other requests per window |

## Graceful shutdown

| Variable | Default | Description |
|---|---|---|
| `SHUTDOWN_DRAIN_TIMEOUT_SECS` | `10` | Seconds to wait for in-flight requests |
| `SHUTDOWN_FORCE_EXIT_TIMEOUT_SECS` | `30` | Seconds before `process::exit(1)` |

## Example `.env`

```env
PORT=8080
BASE_URL=https://storage.example.com

STORAGE_BACKEND=local
STORAGE_ROOT=/var/data/loony-s3/objects

DB_BACKEND=postgres
DATABASE_URL=postgresql://loony:secret@db:5432/loony_s3

JWT_SECRET=change-me-in-production-64-chars-min
PRESIGNED_SECRET=another-strong-secret

CLEANUP_EXPIRED_INTERVAL_SECS=60
RATE_LIMIT_GENERAL_MAX=1000
```
