# API Reference

All requests except `/health` and pre-signed URL endpoints require an `Authorization` header.

```
Authorization: Bearer <jwt>
Authorization: ApiKey <base64(userId:email)>
```

Base URL: `http://localhost:3000` (configurable via `BASE_URL`)

---

## Auth

### POST /auth/token

Issue a JWT for an email/password pair.

**Request**
```json
{ "email": "user@example.com", "password": "any-string" }
```

**Response 200**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "24h",
  "userId": "74657374-4065-4861-ad70-6c652e636f6d"
}
```

> **Note:** The MVP derives a stable `userId` from the email. In production, validate against a real user store.

---

### GET /auth/apikey

Exchange a Bearer JWT for a base64-encoded API key.

**Headers:** `Authorization: Bearer <jwt>`

**Response 200**
```json
{ "apiKey": "NzQ2NTczNzQ..." }
```

Use it with: `Authorization: ApiKey NzQ2NTczNzQ...`

---

## Health

### GET /health

No auth required. Returns 200 if the server is alive.

**Response 200**
```json
{ "status": "ok", "timestamp": "2026-04-18T18:00:00.000Z" }
```

---

## Buckets

### GET /buckets

List all buckets owned by the authenticated user.

**Response 200**
```json
{
  "buckets": [
    {
      "id": "8759e2f3-8bae-46fe-806c-59650d533efd",
      "name": "my-bucket",
      "ownerId": "74657374-4065-4861-ad70-6c652e636f6d",
      "acl": "private",
      "region": "us-east-1",
      "versioning": true,
      "metadata": {},
      "createdAt": "2026-04-18T10:00:00.000Z",
      "updatedAt": "2026-04-18T10:00:00.000Z"
    }
  ],
  "count": 1
}
```

---

### POST /buckets

Create a new bucket.

**Request**
```json
{
  "name": "my-bucket",
  "acl": "private",
  "region": "us-east-1",
  "versioning": false,
  "metadata": { "env": "production" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | 3–63 chars, lowercase alphanumeric, hyphens, and dots. Must start and end with alphanumeric. No `..`, `.-`, or `-.` sequences. |
| `acl` | enum | no | `private` (default), `public-read`, `public-read-write` |
| `region` | string | no | Informational; defaults to `us-east-1` |
| `versioning` | boolean | no | Enable object versioning (default `false`) |
| `metadata` | object | no | Arbitrary string key/value pairs |

**Response 201**
```json
{ "bucket": { ...bucketObject } }
```

**Errors**
| Code | HTTP | Condition |
|------|------|-----------|
| `BUCKET_ALREADY_EXISTS` | 409 | Name already taken |
| `INVALID_BUCKET_NAME` | 400 | Name fails validation |

---

### GET /buckets/:name

Get details for a specific bucket.

**Response 200**
```json
{ "bucket": { ...bucketObject } }
```

**Errors:** `BUCKET_NOT_FOUND` (404), `ACCESS_DENIED` (403)

---

### PATCH /buckets/:name

Update bucket settings. Only the owner can patch.

**Request** (all fields optional)
```json
{
  "acl": "public-read",
  "versioning": true,
  "metadata": { "env": "staging" }
}
```

**Response 200**
```json
{ "bucket": { ...updatedBucketObject } }
```

---

### DELETE /buckets/:name

Delete a bucket. Only the owner can delete.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `force` | boolean | Set to `true` to delete a non-empty bucket (also deletes all objects and their storage) |

**Response 204** (no body)

**Errors:** `BUCKET_NOT_EMPTY` (409) — omit `?force=true` to see this

---

## Objects

### PUT /:bucket/:key

Upload a single object. The body is streamed — no size limit from buffering.

**Headers**

| Header | Description |
|--------|-------------|
| `Content-Type` | MIME type of the object (auto-detected from key extension if omitted) |
| `Content-Length` | Byte size; validated if provided |
| `x-acl` | `private` (default) or `public-read` |
| `x-meta-{name}` | Custom metadata; stored as `{ name: value }` |

Two body formats are accepted:
- **Raw binary** — set `Content-Type` to the file's MIME type and send bytes directly
- **multipart/form-data** — include the file in a field named `file` (browser-style upload)

**Response 200**
```json
{
  "object": {
    "key": "images/photo.jpg",
    "size": 204800,
    "mimeType": "image/jpeg",
    "etag": "d41d8cd98f00b204e9800998ecf8427e",
    "versionId": "001eba80336647038424f3d8e2498682",
    "isLatest": true,
    "acl": "private",
    "metadata": { "author": "sankar" },
    "createdAt": "2026-04-18T10:00:00.000Z",
    "updatedAt": "2026-04-18T10:00:00.000Z"
  }
}
```

**Response headers**
```
ETag: "d41d8cd98f00b204e9800998ecf8427e"
x-version-id: 001eba80336647038424f3d8e2498682
```

---

### GET /:bucket/:key

Download an object. Response body is the raw object bytes.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `versionId` | string | Download a specific version instead of the latest |

**Headers (request)**

| Header | Description |
|--------|-------------|
| `Range` | Byte range: `bytes=0-1023` (returns 206 Partial Content) |

**Response headers**
```
Content-Type: image/jpeg
Content-Length: 204800
ETag: "d41d8cd98..."
Last-Modified: Sat, 18 Apr 2026 10:00:00 GMT
x-version-id: 001eba80...
x-meta-author: sankar       ← custom metadata echoed back
```

**Response 200** (full) or **206** (range)

> Public objects (`acl: public-read`) are accessible without an `Authorization` header.

---

### HEAD /:bucket/:key

Retrieve metadata without downloading the body.

Response headers are identical to `GET` but with no body.

**Response 200** (no body)

---

### GET /:bucket

List objects in a bucket.

**Query params**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `prefix` | string | `""` | Only return keys starting with this prefix |
| `delimiter` | string | `""` | Group keys that contain this character after the prefix into `commonPrefixes` (virtual directory listing) |
| `maxKeys` | number | `1000` | Maximum objects per page (max 1000) |
| `continuationToken` | string | — | Resume a truncated listing (use `nextContinuationToken` from the previous response) |

**Response 200**
```json
{
  "objects": [
    {
      "key": "images/cat.jpg",
      "size": 48320,
      "mimeType": "image/jpeg",
      "etag": "abc123...",
      "versionId": "...",
      "isLatest": true,
      "acl": "private",
      "metadata": {},
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "commonPrefixes": ["images/", "docs/"],
  "isTruncated": false,
  "nextContinuationToken": null,
  "keyCount": 3
}
```

**Virtual directory listing example** — with `delimiter=/`:
- Keys `images/cat.jpg`, `images/dog.jpg`, `docs/readme.md`, `root.txt`
- Returns: `objects: [{ key: "root.txt" }]`, `commonPrefixes: ["docs/", "images/"]`

---

### DELETE /:bucket/:key

Delete an object (hard delete — removes metadata row and schedules storage cleanup).

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `versionId` | string | Delete a specific version; omit to delete all versions of the key |

**Response 204** (no body)

**Errors:** `OBJECT_NOT_FOUND` (404), `ACCESS_DENIED` (403)

---

## Multipart Upload

Use multipart for objects that are too large to upload in a single request (typically > 100 MB).

### Phase 1 — Initiate

**POST /:bucket/:key?uploads**

No body required. Custom metadata headers (`x-meta-*`) are captured here and applied to the final object.

**Response 200**
```json
{
  "uploadId": "df5e5f0acd5e4e50ad1a285a42e23886",
  "key": "big/archive.tar.gz",
  "bucket": "my-bucket"
}
```

---

### Phase 2 — Upload Parts

**PUT /:bucket/:key?partNumber=N&uploadId=X**

Upload a single part. Parts are numbered from 1 to 10000.

**Headers**
```
Content-Type: application/octet-stream
Content-Length: 104857600
```

**Response 200**
```json
{
  "partNumber": 1,
  "etag": "b3b0cbd1348891a520c69e7d6199fbd8",
  "size": 104857600
}
```

Save each `etag` — they are required to complete the upload.

> Parts can be uploaded concurrently from different clients. Order does not matter at upload time; it is enforced at complete time.

---

### Phase 3 — Complete

**POST /:bucket/:key?uploadId=X**

Assemble parts in the specified order and create the final object.

**Request**
```json
{
  "parts": [
    { "partNumber": 1, "etag": "b3b0cbd1..." },
    { "partNumber": 2, "etag": "19278e6b..." }
  ]
}
```

Parts must be listed in ascending `partNumber` order. Each `etag` must match exactly what was returned during upload.

**Response 200**
```json
{
  "object": {
    "key": "big/archive.tar.gz",
    "size": 358400,
    "mimeType": "application/gzip",
    "etag": "4e2e04d5620468c505b06c6d13956f3e",
    "versionId": "ae446481...",
    ...
  }
}
```

---

### Abort

**DELETE /:bucket/:key?uploadId=X**

Cancel an in-progress upload and delete all uploaded parts.

**Response 204** (no body)

---

### List Parts

**GET /:bucket/:key?uploadId=X&parts=true**

**Response 200**
```json
{
  "parts": [
    { "partNumber": 1, "etag": "b3b0cbd1...", "size": 204800, "storageKey": "__tmp/..." },
    { "partNumber": 2, "etag": "83ff27d6...", "size": 153600, "storageKey": "__tmp/..." }
  ]
}
```

---

## Pre-signed URLs

Pre-signed URLs delegate time-limited access to a single object operation without exposing credentials.

### Generate

**POST /:bucket/presign**

Only bucket owners can generate pre-signed URLs.

**Request**
```json
{
  "key": "reports/q1-2026.pdf",
  "operation": "GET",
  "expiresInSeconds": 3600,
  "metadata": {}
}
```

| Field | Values | Description |
|-------|--------|-------------|
| `operation` | `GET`, `PUT`, `DELETE` | What the holder of the URL can do |
| `expiresInSeconds` | 1 – 604800 | URL lifetime in seconds (max 7 days) |

**Response 200**
```json
{
  "url": "http://localhost:3000/presigned/my-bucket/reports%2Fq1-2026.pdf?X-Expires=1776535662&X-Operation=GET&X-Signature=0661aa...",
  "expiresAt": "2026-04-18T19:00:00.000Z",
  "operation": "GET"
}
```

---

### Use a Pre-signed URL

**GET|PUT|DELETE /presigned/:bucket/:key?X-Expires=...&X-Operation=...&X-Signature=...**

No `Authorization` header required — the signature is the credential.

The server:
1. Checks `X-Expires` against the current time
2. Recomputes the HMAC-SHA256 signature and compares with `X-Signature` using a constant-time comparison (preventing timing attacks)
3. Delegates to the same handler as the authenticated endpoint

**Errors**
| Code | HTTP | Condition |
|------|------|-----------|
| `PRESIGNED_URL_EXPIRED` | 403 | `X-Expires` is in the past |
| `PRESIGNED_URL_INVALID` | 403 | Signature mismatch or malformed params |

---

## Common Error Responses

```json
{
  "error": {
    "code": "OBJECT_NOT_FOUND",
    "message": "Object 'images/missing.jpg' not found",
    "statusCode": 404
  }
}
```

| Code | HTTP | When |
|------|------|------|
| `UNAUTHORIZED` | 401 | Missing or expired token |
| `ACCESS_DENIED` | 403 | Token valid but insufficient permissions |
| `BUCKET_NOT_FOUND` | 404 | Bucket name does not exist |
| `OBJECT_NOT_FOUND` | 404 | Key does not exist (or version not found) |
| `BUCKET_ALREADY_EXISTS` | 409 | Bucket name is already taken |
| `BUCKET_NOT_EMPTY` | 409 | Delete without `?force=true` on non-empty bucket |
| `INVALID_BUCKET_NAME` | 400 | Name fails DNS-compatible validation |
| `INVALID_PART_NUMBER` | 400 | Part number out of range or ETag mismatch |
| `PAYLOAD_TOO_LARGE` | 413 | Exceeds `MAX_OBJECT_SIZE_BYTES` |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Full Example: Upload → Generate Presigned URL → Download

```bash
BASE="http://localhost:3000"

# 1. Get a JWT
TOKEN=$(curl -s -X POST $BASE/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"any"}' | jq -r .token)

# 2. Create a bucket
curl -s -X POST $BASE/buckets \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo-bucket","acl":"private","versioning":true}'

# 3. Upload a file (raw binary)
curl -s -X PUT "$BASE/demo-bucket/hello.txt" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -H "x-meta-author: demo" \
  --data-binary "Hello, loony-s3!"

# 4. Generate a 1-hour presigned GET URL
URL=$(curl -s -X POST "$BASE/demo-bucket/presign" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"hello.txt","operation":"GET","expiresInSeconds":3600}' | jq -r .url)

# 5. Download using the presigned URL — no auth header needed
curl -s "$URL"
# Output: Hello, loony-s3!

# 6. List with delimiter (virtual directories)
curl -s "$BASE/demo-bucket?delimiter=/" \
  -H "Authorization: Bearer $TOKEN" | jq '{objects: [.objects[].key], commonPrefixes}'

# 7. Delete the object
curl -s -X DELETE "$BASE/demo-bucket/hello.txt" \
  -H "Authorization: Bearer $TOKEN"
```
