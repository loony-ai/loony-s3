# Architecture

## High-Level Overview

loony-s3 is a three-layer system: an HTTP API layer, a stateless service layer, and a pluggable persistence layer. The persistence layer itself splits into two independent concerns — metadata (structured, relational) and blob storage (unstructured, byte-stream).

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT / SDK                                │
│               (curl, browser, custom SDK, presigned URL)            │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP / HTTPS
┌────────────────────────────▼────────────────────────────────────────┐
│                        API LAYER (Express)                           │
│                                                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│  │   Auth MW    │   │  Validation  │   │    Request Logger      │  │
│  │  (JWT/ApiKey)│   │    (Zod)     │   │    (Winston)           │  │
│  └──────────────┘   └──────────────┘   └────────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────┐  ┌───────────────────────────────────┐│
│  │    BucketController      │  │         ObjectController          ││
│  │  list / create / delete  │  │  put / get / head / list / delete ││
│  │  update / get            │  │  multipart / presigned            ││
│  └─────────────┬────────────┘  └──────────────┬────────────────────┘│
└────────────────┼───────────────────────────────┼────────────────────┘
                 │ calls                          │ calls
┌────────────────▼───────────────────────────────▼────────────────────┐
│                       SERVICE LAYER                                  │
│                                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────┐ │
│  │  BucketService   │  │  ObjectService   │  │ PresignedUrl      │ │
│  │  ACL enforcement │  │  put/get/delete  │  │ Service           │ │
│  │  name validation │  │  versioning      │  │ HMAC sign/verify  │ │
│  └────────┬─────────┘  └────────┬─────────┘  └───────────────────┘ │
│           │                     │                                    │
│  ┌────────▼─────────────────────▼─────────────────────────────────┐ │
│  │               MultipartUploadService                            │ │
│  │   initiate → upload parts → complete → assemble → cleanup       │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────┬─────────────────────────────────┬────────────────────────┘
           │                                 │
┌──────────▼──────────────┐   ┌─────────────▼──────────────────────────┐
│     METADATA LAYER       │   │           STORAGE LAYER                │
│                          │   │                                        │
│  ┌────────────────────┐  │   │  ┌──────────────────────────────────┐ │
│  │  BucketRepository  │  │   │  │   StorageBackend (interface)     │ │
│  ├────────────────────┤  │   │  │   write / read / stat / delete   │ │
│  │  ObjectRepository  │  │   │  │   assembleMultipart / deleteParts│ │
│  └────────────────────┘  │   │  └──────────────┬───────────────────┘ │
│                          │   │                 │                      │
│  node:sqlite (WAL mode)  │   │  ┌──────────────▼───────────────────┐ │
│  (swap → PostgreSQL)     │   │  │   LocalStorageBackend            │ │
│                          │   │  │   /data/{bucket}/{shard}/{uuid}  │ │
└──────────────────────────┘   │  │   (swap → MinIO / any HTTP store)│ │
                               │  └──────────────────────────────────┘ │
                               └────────────────────────────────────────┘
```

---

## Component Responsibilities

### API Layer

| Component | File | Responsibility |
|-----------|------|----------------|
| Auth middleware | `api/middleware/auth.ts` | Extract and verify JWT or API key from `Authorization` header; populate `req.user` |
| Error handler | `api/middleware/errorHandler.ts` | Catch all thrown `AppError` and `ZodError`, map to correct HTTP status |
| Request logger | `api/middleware/requestLogger.ts` | Log method, path, status, latency, user ID on every response |
| BucketController | `api/controllers/BucketController.ts` | Parse, validate, and delegate bucket CRUD requests |
| ObjectController | `api/controllers/ObjectController.ts` | Parse uploads (raw body + busboy multipart), stream downloads, route multipart/presigned sub-operations |
| Routes | `api/routes/` | Wire controllers to Express Router; declare which routes are `requireAuth` vs `optionalAuth` |

### Service Layer

| Service | File | Responsibility |
|---------|------|----------------|
| BucketService | `services/BucketService.ts` | Bucket creation with name validation, ACL enforcement (`assertReadAccess`, `assertWriteAccess`, `assertOwner`) |
| ObjectService | `services/ObjectService.ts` | Single-part put (stream to storage, write metadata), get (resolve ACL, open read stream), list with prefix/delimiter, delete |
| MultipartUploadService | `services/MultipartUploadService.ts` | Three-phase multipart (initiate → upload parts → assemble on complete); abort/cleanup |
| PresignedUrlService | `services/PresignedUrlService.ts` | HMAC-SHA256 URL generation; constant-time signature validation |

### Repository Layer

Repositories are the only code that talks to the database. Services never touch SQL.

| Repository | File | Responsibility |
|-----------|------|----------------|
| BucketRepository | `repositories/BucketRepository.ts` | CRUD on `buckets` table |
| ObjectRepository | `repositories/ObjectRepository.ts` | CRUD on `objects` and `multipart_uploads` tables; list with cursor pagination |

### Storage Backend

| Backend | File | Description |
|---------|------|-------------|
| StorageBackend | `storage/StorageBackend.ts` | Interface — 6 methods, all stream-based |
| LocalStorageBackend | `storage/LocalStorageBackend.ts` | Local filesystem; atomic writes (tmp → rename), 2-char shard directories, MD5 computed during stream |

---

## Data Model

### `buckets` table

```
id          TEXT  PK
name        TEXT  UNIQUE — DNS-compatible (3–63 chars, lowercase alnum/hyphen/dot)
owner_id    TEXT  — user who created the bucket
acl         TEXT  — 'private' | 'public-read' | 'public-read-write'
region      TEXT  — informational; 'us-east-1' default
versioning  INT   — 0 or 1
metadata    TEXT  — JSON object of user-defined key/value pairs
created_at  TEXT  — ISO 8601
updated_at  TEXT  — ISO 8601
```

### `objects` table

```
id           TEXT  PK
bucket_id    TEXT  FK → buckets.id (CASCADE DELETE)
bucket_name  TEXT  — denormalised for fast presigned URL lookups
key          TEXT  — object path within bucket (e.g. images/cat.jpg)
size         INT   — bytes
mime_type    TEXT
etag         TEXT  — MD5 hex of the object content
storage_key  TEXT  UNIQUE — opaque path within the storage backend
acl          TEXT  — 'private' | 'public-read'
version_id   TEXT  — random hex string, unique per PUT
is_latest    INT   — 1 for the current version, 0 for older ones
metadata     TEXT  — JSON object
created_at   TEXT
updated_at   TEXT
deleted_at   TEXT  — NULL until soft-deleted
```

Indexes:
- `(bucket_id, key, is_latest)` — O(log n) HEAD/GET of latest version
- `(bucket_id, key)` — range scan for list with prefix

### `multipart_uploads` table

```
upload_id   TEXT  PK — opaque hex string returned at initiate
bucket_id   TEXT  FK → buckets.id
bucket_name TEXT
key         TEXT
owner_id    TEXT
metadata    TEXT  — JSON; applied to object on complete
parts       TEXT  — JSON array of {partNumber, etag, size, storageKey}
created_at  TEXT
```

---

## Storage Layout

```
$STORAGE_ROOT/
│
├── {bucket-name}/
│   ├── {2-char-shard}/        ← prevent huge flat directories (e.g. "a3/", "f7/")
│   │   └── {uuid-hex}         ← actual object file (storageKey = bucket/shard/uuid)
│   └── ...
│
└── __tmp/
    └── {uploadId}/
        ├── 1                  ← part 1 (raw bytes)
        ├── 2                  ← part 2
        └── ...                ← assembled into bucket/shard/uuid at complete
```

**Why sharding?** Most filesystems slow down when a directory exceeds ~100K entries. Using the first 2 hex chars of the UUID (256 buckets) keeps any single directory bounded.

**Why atomic writes?** Every object is first written to `{dest}.tmp.{timestamp}`, then `rename()`d to the final path. This ensures a reader never sees a partially-written file.

---

## Request Flows

### Single-part Upload (PUT /:bucket/:key)

```
Client
  │
  ├─ PUT /:bucket/:key (raw body OR multipart/form-data)
  │
  ▼
ObjectController.putObject()
  ├─ extractCustomMetadata()           reads x-meta-* headers
  ├─ if content-type = multipart/form-data → busboy pipe (no buffering)
  │  else → req stream directly
  │
  ▼
ObjectService.putObject()
  ├─ BucketRepository.findByName()     resolve bucket
  ├─ BucketService.assertWriteAccess() check ACL
  ├─ generateStorageKey()              bucket/shard/uuid
  │
  ▼
LocalStorageBackend.write(storageKey, stream)
  ├─ open tmp file
  ├─ pipe stream → md5 hash → tmp file  (streaming, no RAM buffer)
  ├─ rename(tmp → final)               atomic commit
  └─ return { storageKey, size, etag }
  │
  ▼
ObjectRepository.create(obj)          write metadata row
  │
  ▼
Response: 200 { object: { key, size, etag, versionId, ... } }
```

### Download (GET /:bucket/:key)

```
Client
  │
  ├─ GET /:bucket/:key  [optionalAuth, Range: bytes=N-M]
  │
  ▼
ObjectController.getObject()
  ├─ parseRangeHeader()               optional
  │
  ▼
ObjectService.getObject()
  ├─ BucketRepository.findByName()
  ├─ BucketService.assertReadAccess()
  ├─ ObjectRepository.findLatest()
  │
  ▼
LocalStorageBackend.read(storageKey, range?)
  └─ fs.createReadStream(path, {start, end})
  │
  ▼
stream.pipe(res)                      streaming, no RAM buffer
  Status: 200 (full) or 206 (range)
```

### Multipart Upload

```
1. POST /:bucket/:key?uploads
   → MultipartUploadService.initiateUpload()
   → ObjectRepository.createMultipartUpload()
   ← { uploadId }

2. PUT /:bucket/:key?partNumber=N&uploadId=X  (repeat per part)
   → MultipartUploadService.uploadPart()
   → LocalStorageBackend.write(__tmp/{uploadId}/N, stream)
   → ObjectRepository.upsertPart(uploadId, part)
   ← { partNumber, etag, size }

3. POST /:bucket/:key?uploadId=X
   Body: { parts: [{partNumber, etag}, ...] }
   → MultipartUploadService.completeUpload()
   → validate part ETags against stored parts
   → LocalStorageBackend.assembleMultipart([partKeys], destinationKey)
      ├─ open destination write stream
      ├─ for each part: pipe partStream → destination (sequential)
      └─ delete part files
   → ObjectRepository.create(final object)
   → ObjectRepository.deleteMultipartUpload(uploadId)
   ← { object: { key, size, etag, ... } }

   Abort: DELETE /:bucket/:key?uploadId=X
   → MultipartUploadService.abortUpload()
   → LocalStorageBackend.deleteParts([partKeys])
   → ObjectRepository.deleteMultipartUpload(uploadId)
```

### Pre-signed URL

```
GENERATE:
  POST /:bucket/presign
  Body: { key, operation, expiresInSeconds }
  → PresignedUrlService.generate()
  → compute: expiresTs = now + expiresInSeconds
  → signature = HMAC-SHA256(secret, "{op}\n{bucket}\n{key}\n{expiresTs}")
  ← { url: "/presigned/{bucket}/{key}?X-Expires=...&X-Operation=...&X-Signature=...", expiresAt }

USE:
  GET /presigned/{bucket}/{key}?X-Expires=...&X-Operation=GET&X-Signature=...
  → PresignedUrlService.validate()
  → check expiresTs > now
  → recompute signature; crypto.timingSafeEqual()
  → impersonate bucket owner in req.user
  → delegate to ObjectController.getObject()
```

---

## Authentication

### JWT (Bearer)

```
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...

Payload: { sub: userId, email: string, iat: number, exp: number }
```

Issued by `POST /auth/token`. The `userId` is derived deterministically from the email in the MVP (no user database). Replace with a real user store in production.

### API Key

```
Authorization: ApiKey <base64(userId:email)>
```

Convenience format. Obtain from `GET /auth/apikey` (requires a valid Bearer token). Replace with a DB-backed API key table in production.

---

## ACL Model

```
Bucket ACL          Object ACL      Effective access
──────────────────  ──────────────  ────────────────────────────────────
private             private         Owner only
private             public-read     Any authenticated user can download
public-read         private         Any user can list; owner downloads
public-read         public-read     Anyone can list and download (no auth)
public-read-write   *               Anyone can upload and download
```

ACL checks are enforced in `BucketService.assertReadAccess()` and `assertWriteAccess()`. The controller never touches ACL logic.

---

## Error Model

All errors are instances of `AppError(code, message)` and are handled centrally in `errorHandler` middleware.

```typescript
const HTTP_STATUS: Record<ErrorCode, number> = {
  BUCKET_NOT_FOUND:       404,
  BUCKET_ALREADY_EXISTS:  409,
  BUCKET_NOT_EMPTY:       409,
  OBJECT_NOT_FOUND:       404,
  UPLOAD_NOT_FOUND:       404,
  INVALID_BUCKET_NAME:    400,
  INVALID_OBJECT_KEY:     400,
  INVALID_PART_NUMBER:    400,
  INVALID_PART_SIZE:      400,
  INVALID_CONTENT_LENGTH: 400,
  ACCESS_DENIED:          403,
  UNAUTHORIZED:           401,
  PRESIGNED_URL_EXPIRED:  403,
  PRESIGNED_URL_INVALID:  403,
  PAYLOAD_TOO_LARGE:      413,
  INTERNAL_ERROR:         500,
  NOT_IMPLEMENTED:        501,
}
```

Response body:
```json
{
  "error": {
    "code": "BUCKET_NOT_FOUND",
    "message": "Bucket 'my-bucket' not found",
    "statusCode": 404
  }
}
```

---

## Dependency Injection

`server.ts` is the only composition root. It instantiates every dependency and wires them together:

```typescript
// Infrastructure
const storage = new LocalStorageBackend();

// Repositories
const bucketRepo = new BucketRepository();
const objectRepo = new ObjectRepository();

// Services
const bucketService = new BucketService(bucketRepo, objectRepo);
const objectService = new ObjectService(bucketRepo, objectRepo, storage, bucketService);
const multipartService = new MultipartUploadService(bucketRepo, objectRepo, storage, bucketService);
const presignedService = new PresignedUrlService(bucketRepo);

// Controllers
const bucketController = new BucketController(bucketService);
const objectController = new ObjectController(objectService, multipartService, presignedService, bucketRepo);
```

Swapping any backend means replacing exactly one `new` call. The service layer never knows what's behind a repository.
