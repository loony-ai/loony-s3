# loony-s3-rs

A self-hosted S3-compatible object storage server written in Rust.  
Mirrors the TypeScript [loony-s3](../loony-s3) project with the same feature set but as a single static binary.

## Features

| Feature            | Details                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| Object storage     | PUT / GET / HEAD / DELETE with streaming I/O                            |
| Bucket management  | Create, read, update (ACL/versioning), delete                           |
| Object versioning  | Every PUT creates a new version; latest is returned by default          |
| Object TTL         | Set `x-ttl-seconds` on upload; expired objects cleaned automatically    |
| Multipart upload   | Initiate → upload parts → complete / abort (S3-compatible query params) |
| Presigned URLs     | HMAC-SHA256 signed GET/PUT/DELETE URLs with configurable expiry         |
| Auth               | JWT Bearer tokens + base64-encoded API keys                             |
| ACL                | `private` / `public-read` / `public-read-write` per bucket and object   |
| Metadata backends  | SQLite (default) or PostgreSQL                                          |
| Storage backends   | Local filesystem or NFS (with `fsync` before rename)                    |
| Rate limiting      | Per-window limits for auth, upload, download, and general traffic       |
| Background cleanup | Removes expired objects and abandoned multipart uploads                 |
| Observability      | Structured `tracing` logs + `/metrics` JSON endpoint                    |
| Graceful shutdown  | SIGTERM/Ctrl-C → drain → force exit                                     |

---

## Quick start

```bash
# Build
cargo build --release

# Run with SQLite + local storage (all defaults)
./target/release/loony-s3

# Or with env overrides
PORT=8080 \
STORAGE_ROOT=/data/objects \
DB_PATH=/data/metadata.db \
JWT_SECRET=my-secret \
./target/release/loony-s3
```

See [docs/configuration.md](docs/configuration.md) for all environment variables.

---

## API overview

### Auth

```
POST /auth/token          Issue JWT + API key
```

### Buckets

```
GET    /buckets           List your buckets
POST   /buckets           Create bucket
GET    /buckets/:name     Get bucket metadata
PUT    /buckets/:name     Update ACL / versioning / metadata
DELETE /buckets/:name     Delete bucket
```

### Objects

All object operations share the route `/:bucket/*key`.  
Behaviour is selected by **HTTP method** and **query parameters**:

| Method   | Query params                                  | Action                                             |
| -------- | --------------------------------------------- | -------------------------------------------------- |
| `GET`    | _(none)_                                      | Download object body                               |
| `GET`    | `?list=true`                                  | List objects in bucket                             |
| `GET`    | `?list_versions=true`                         | List all versions of a key                         |
| `GET`    | `?presign=true&operation=GET&expires_in=3600` | Generate presigned URL                             |
| `GET`    | `?signature=…&expires=…&operation=…`          | Download via presigned URL (no auth header needed) |
| `GET`    | `?uploadId=X`                                 | List multipart parts                               |
| `HEAD`   | _(none)_                                      | Object metadata (no body)                          |
| `PUT`    | _(none)_                                      | Upload object                                      |
| `PUT`    | `?partNumber=N&uploadId=X`                    | Upload a multipart part                            |
| `POST`   | `?uploads`                                    | Initiate multipart upload                          |
| `POST`   | `?uploadId=X`                                 | Complete multipart upload                          |
| `DELETE` | _(none)_                                      | Delete object (all versions)                       |
| `DELETE` | `?version_id=X`                               | Delete a specific version                          |
| `DELETE` | `?uploadId=X`                                 | Abort multipart upload                             |

### System

```
GET /health               Liveness probe
GET /metrics              Operational counters (JSON)
```

Full request/response examples: [docs/api.md](docs/api.md)

---

## Running the test suite

```bash
# Start the server (SQLite, port 8006)
./scripts/start-dev.sh

# In another terminal — run all smoke tests
./scripts/test-all.sh

# Individual test groups
./scripts/test-auth.sh
./scripts/test-buckets.sh
./scripts/test-objects.sh
./scripts/test-multipart.sh
./scripts/test-presigned.sh
```

See [docs/testing.md](docs/testing.md) for what each script covers.

---

## Architecture

```
src/
├── main.rs              Bootstrap: storage, DB, services, router, graceful shutdown
├── config.rs            All config read from env vars via dotenvy
├── error.rs             AppError enum → axum IntoResponse (JSON)
├── types.rs             Domain types (Bucket, StoredObject, UploadPart, …)
├── metrics.rs           Static atomic counters + snapshot()
├── storage/
│   ├── mod.rs           ByteStream type + StorageBackend trait
│   └── local.rs         FsStorageBackend (local + NFS via use_fsync flag)
├── repositories/
│   ├── mod.rs           BucketRepository + ObjectRepository traits
│   ├── sqlite.rs        SQLite implementations (sqlx, non-macro queries)
│   └── postgres.rs      PostgreSQL implementations
├── services/
│   ├── bucket.rs        Bucket CRUD + name validation + ACL checks
│   ├── object.rs        Object put/get/stream/list/delete + TTL
│   ├── multipart.rs     Initiate/upload/complete/abort/list-parts
│   ├── presigned.rs     HMAC-SHA256 sign/validate
│   └── cleanup.rs       Expired objects + stale upload sweeper
└── api/
    ├── mod.rs           Router construction + rate limiting layers
    ├── auth.rs          AuthUser / OptionalAuth axum extractors
    ├── state.rs         AppState (shared services + config)
    ├── middleware/
    │   ├── request_id.rs  X-Request-ID propagation
    │   └── rate_limit.rs  governor-based per-window limiter
    └── handlers/
        ├── auth.rs      POST /auth/token
        ├── bucket.rs    Bucket CRUD handlers
        └── object.rs    Object + multipart + presigned handlers
```

---

## Configuration reference

See [docs/configuration.md](docs/configuration.md).

## Deployment

See [docs/deployment.md](docs/deployment.md).
