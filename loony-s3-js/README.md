# loony-s3

A simplified but production-quality object storage service modelled after Amazon S3, built with Node.js and TypeScript.

## Features

- **Buckets** — create, configure, and delete storage buckets with ACL control
- **Objects** — upload, download, delete, and list objects with full metadata
- **Streaming I/O** — no file is ever fully buffered; uploads and downloads are streamed end-to-end
- **Multipart uploads** — large files split into parts, assembled on completion
- **Object versioning** — every PUT creates a new version; old versions are retained and queryable
- **Pre-signed URLs** — HMAC-SHA256 signed time-limited URLs for authenticated temporary access
- **Range requests** — HTTP `Range` header support for partial downloads
- **Custom metadata** — arbitrary key/value pairs on both buckets and objects via `x-meta-*` headers
- **JWT + API Key auth** — two interchangeable credential schemes

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ (requires `--experimental-sqlite`) |
| Language | TypeScript 5 (strict) |
| HTTP | Express 4 |
| Metadata DB | Node built-in `node:sqlite` (WAL mode) |
| File storage | Local filesystem (pluggable via `StorageBackend` interface) |
| Auth | JWT (jsonwebtoken) |
| Validation | Zod |
| Logging | Winston |

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env

# Run in development mode (with file watching)
npm run dev
```

The server starts on `http://localhost:3000`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | `development` or `production` |
| `STORAGE_ROOT` | `/tmp/loony-s3/data` | Root directory for stored objects |
| `DB_PATH` | `/tmp/loony-s3/metadata.db` | SQLite database file path |
| `JWT_SECRET` | *(dev default)* | HMAC secret for JWT signing — **change in production** |
| `JWT_EXPIRY` | `24h` | JWT lifetime |
| `PRESIGNED_SECRET` | *(dev default)* | HMAC secret for pre-signed URL signing — **change in production** |
| `PRESIGNED_MAX_EXPIRY_SECONDS` | `604800` | Maximum allowed pre-signed URL lifetime (7 days) |
| `BASE_URL` | `http://localhost:3000` | Base URL included in generated pre-signed URLs |
| `MAX_OBJECT_SIZE_BYTES` | `5368709120` | Maximum single object size (5 GB) |
| `MIN_PART_SIZE_BYTES` | `0` | Minimum multipart part size (0 = disabled; set to 5242880 for S3 compatibility) |
| `MAX_PARTS` | `10000` | Maximum parts per multipart upload |

## API Overview

See [docs/api-reference.md](docs/api-reference.md) for full request/response details.

```
POST   /auth/token                    Issue JWT
GET    /auth/apikey                   Get API key

GET    /buckets                       List your buckets
POST   /buckets                       Create bucket
GET    /buckets/:name                 Get bucket
PATCH  /buckets/:name                 Update bucket
DELETE /buckets/:name                 Delete bucket

GET    /:bucket                       List objects
PUT    /:bucket/:key                  Upload object (single-part)
GET    /:bucket/:key                  Download object
HEAD   /:bucket/:key                  Object metadata
DELETE /:bucket/:key                  Delete object

POST   /:bucket/:key?uploads          Initiate multipart upload
PUT    /:bucket/:key?partNumber=N&uploadId=X   Upload part
POST   /:bucket/:key?uploadId=X       Complete multipart upload
DELETE /:bucket/:key?uploadId=X       Abort multipart upload

POST   /:bucket/presign               Generate pre-signed URL
GET|PUT|DELETE /presigned/:bucket/:key  Execute pre-signed operation
```

## Project Structure

```
src/
├── types/index.ts                  Domain types and Express augmentation
├── config/index.ts                 Typed env-var config
├── db/database.ts                  SQLite init, WAL pragma, migrations
├── storage/
│   ├── StorageBackend.ts           Pluggable storage interface
│   └── LocalStorageBackend.ts      Filesystem implementation
├── repositories/
│   ├── BucketRepository.ts         Bucket CRUD (SQLite)
│   └── ObjectRepository.ts         Object/multipart CRUD (SQLite)
├── services/
│   ├── BucketService.ts            Bucket business logic + ACL enforcement
│   ├── ObjectService.ts            Object put/get/list/delete
│   ├── MultipartUploadService.ts   3-phase multipart (initiate/part/complete)
│   └── PresignedUrlService.ts      HMAC URL generation and validation
├── api/
│   ├── middleware/
│   │   ├── auth.ts                 JWT + API key extraction
│   │   ├── errorHandler.ts         Centralised error → HTTP response
│   │   └── requestLogger.ts        Per-request structured logging
│   ├── controllers/
│   │   ├── BucketController.ts     Bucket HTTP handlers
│   │   └── ObjectController.ts     Object HTTP handlers + presigned proxy
│   └── routes/
│       ├── auth.ts                 /auth routes
│       ├── buckets.ts              /buckets routes
│       └── objects.ts              /:bucket routes
└── server.ts                       DI composition root + Express bootstrap
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for diagrams and deep-dive explanations.

## Scaling

See [docs/next-steps.md](docs/next-steps.md) for a concrete roadmap to production-grade horizontal scaling.

## License

MIT
