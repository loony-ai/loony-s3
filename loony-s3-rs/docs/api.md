# API Reference

All requests that modify state require an `Authorization` header.  
Unauthenticated reads are allowed on buckets/objects with `public-read` or `public-read-write` ACL.

## Authentication

### Issue token

```
POST /auth/token
Content-Type: application/json

{ "user_id": "alice", "name": "Alice" }
```

Response `201`:
```json
{
  "token": "eyJ0eXAiOiJKV1Qi...",
  "api_key": "YWxpY2U6QWxpY2U="
}
```

Use either scheme in subsequent requests:
```
Authorization: Bearer <token>
Authorization: ApiKey <api_key>
```

---

## Buckets

### Create bucket

```
POST /buckets
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "my-bucket",
  "acl":  "private",       // optional: private | public-read | public-read-write
  "region": "us-east-1"   // optional
}
```

Response `201`:
```json
{
  "id": "b4f2...",
  "name": "my-bucket",
  "acl": "private",
  "region": "us-east-1",
  "versioning": false,
  "owner_id": "alice",
  "created_at": "2026-05-22T10:00:00Z",
  "updated_at": "2026-05-22T10:00:00Z"
}
```

### List buckets

```
GET /buckets
Authorization: Bearer <token>
```

Response `200`: array of bucket objects.

### Get bucket

```
GET /buckets/:name
Authorization: Bearer <token>
```

### Update bucket

```
PUT /buckets/:name
Authorization: Bearer <token>
Content-Type: application/json

{
  "acl": "public-read",
  "versioning": true,
  "metadata": { "project": "demo" }
}
```

All fields are optional; only provided fields are updated.

### Delete bucket

```
DELETE /buckets/:name
Authorization: Bearer <token>
```

Response `204`.

---

## Objects

All object operations use the route `/:bucket/*key`.

### Upload object

```
PUT /:bucket/:key
Authorization: Bearer <token>
Content-Type: text/plain
Content-Length: <bytes>
x-ttl-seconds: 3600          (optional — object expires after N seconds)
x-amz-acl: public-read       (optional — object ACL)
x-amz-meta-author: alice     (optional — stored as metadata)

<body>
```

Response `201`:
```json
{
  "id": "...",
  "bucket_name": "my-bucket",
  "key": "hello.txt",
  "size": 18,
  "mime_type": "text/plain",
  "etag": "43181f1a...",
  "acl": "private",
  "version_id": "ccb99ac4...",
  "is_latest": true,
  "metadata": {},
  "created_at": "...",
  "updated_at": "...",
  "expires_at": null
}
```

### Download object

```
GET /:bucket/:key
Authorization: Bearer <token>

# With Range (partial content):
GET /:bucket/:key
Range: bytes=0-1023
```

Response `200` (or `206` for range requests) with raw body.  
Headers include `Content-Type`, `ETag`, `x-version-id`.

### Download specific version

```
GET /:bucket/:key?version_id=<version_id>
```

### Head object

```
HEAD /:bucket/:key
```

Returns headers only — no body.

### List objects in bucket

```
GET /:bucket/list?list=true
GET /:bucket/list?list=true&prefix=folder/&delimiter=/&max_keys=100
```

Query params:

| Param | Description |
|---|---|
| `prefix` | Key prefix filter |
| `delimiter` | Hierarchy delimiter (e.g. `/` to simulate folders) |
| `max_keys` | Max results (default 1000, max 1000) |
| `continuation_token` | Resume from previous page |

Response `200`:
```json
{
  "objects": [ ... ],
  "commonPrefixes": ["folder/"],
  "isTruncated": false,
  "nextContinuationToken": null,
  "keyCount": 5
}
```

> **Note:** The key in the URL before `?list=true` is ignored. Use any placeholder (e.g. `list`).

### List object versions

```
GET /:bucket/:key?list_versions=true
Authorization: Bearer <token>
```

Response:
```json
{ "versions": [ ... ] }
```

### Delete object

```
DELETE /:bucket/:key
Authorization: Bearer <token>

# Delete specific version:
DELETE /:bucket/:key?version_id=<version_id>
```

Response `204`.

---

## Presigned URLs

Generate a time-limited URL that can be used without an auth header.

### Generate presigned URL

```
GET /:bucket/:key?presign=true&operation=GET&expires_in=3600
Authorization: Bearer <token>
```

| Param | Values | Description |
|---|---|---|
| `operation` | `GET`, `PUT`, `DELETE` | The allowed HTTP method |
| `expires_in` | seconds | URL lifetime (max `PRESIGNED_MAX_EXPIRY_SECONDS`) |

Response:
```json
{
  "url": "http://localhost:3000/my-bucket/hello.txt?operation=GET&expires=1779457610&signature=946f...",
  "expiresAt": 1779457610
}
```

### Use presigned URL

```
GET <url>
```

No `Authorization` header required. Returns the object body.

---

## Multipart Upload

For large objects — upload in parts (minimum 1 part).

### 1. Initiate

```
POST /:bucket/:key?uploads
Authorization: Bearer <token>
```

Response `201`:
```json
{
  "uploadId": "f47ac10b-...",
  "bucketName": "my-bucket",
  "key": "large-file.bin"
}
```

### 2. Upload parts

```
PUT /:bucket/:key?partNumber=1&uploadId=<uploadId>
Authorization: Bearer <token>
Content-Length: <part size>

<part body>
```

Repeat for each part (parts can be uploaded concurrently).

Response:
```json
{ "partNumber": 1, "etag": "abc123...", "size": 5242880 }
```

### 3. Complete

```
POST /:bucket/:key?uploadId=<uploadId>
Authorization: Bearer <token>
Content-Type: application/json

{
  "parts": [1, 2, 3],
  "content_type": "application/octet-stream",
  "acl": "private",
  "ttl_seconds": null
}
```

Response: the assembled `StoredObject`.

### Abort

```
DELETE /:bucket/:key?uploadId=<uploadId>
Authorization: Bearer <token>
```

Response `204`. All uploaded parts are deleted.

### List parts

```
GET /:bucket/:key?uploadId=<uploadId>
Authorization: Bearer <token>
```

Response:
```json
{
  "uploadId": "...",
  "key": "large-file.bin",
  "parts": [ { "partNumber": 1, "etag": "...", "size": 5242880, "storage_key": "..." } ]
}
```

---

## System

### Health check

```
GET /health
```

Response `200`:
```json
{ "status": "ok" }
```

### Metrics

```
GET /metrics
```

Response `200`:
```json
{
  "uptimeSeconds": 3600,
  "requests": { "total": 1234, "active": 2, "errors4xx": 10, "errors5xx": 0 },
  "storage": { "bytesUploaded": 104857600, "bytesDownloaded": 524288000 },
  "objects": { "created": 500, "deleted": 30, "expired": 5 },
  "cleanup": { "staleUploadsRemoved": 2, "expiredObjectsRemoved": 5 }
}
```

---

## Error responses

All errors return JSON with HTTP status codes:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Bucket 'foo' not found",
    "statusCode": 404
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Malformed input |
| `UNAUTHORIZED` | 401 | Missing or invalid credentials |
| `FORBIDDEN` | 403 | Authenticated but not allowed |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Resource already exists |
| `GONE` | 410 | Object has expired |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
