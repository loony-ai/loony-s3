# Security

## Authentication

### JWT (Bearer)

Tokens are signed with HMAC-SHA256 using `JWT_SECRET`. The default development secret is intentionally weak — **always set a long random string in production**:

```bash
JWT_SECRET=$(openssl rand -hex 32)
```

Tokens expire after `JWT_EXPIRY` (default 24 hours). There is no token revocation in the current MVP — once issued, a token is valid until it expires. To add revocation, maintain a `revoked_tokens` table and check it in the `verifyJwt` function.

### API Keys

The current API key format is `base64(userId:email)` — this is convenience encoding, **not encryption**. Anyone who intercepts the key can decode it. API keys should only be transmitted over HTTPS.

In production, replace with:
1. A random 32-byte key generated on the server
2. Only the `SHA-256(key)` stored in the database
3. The raw key returned once to the user at creation time — never stored or logged

### Secrets in Environment Variables

| Variable | Risk if leaked | Rotation |
|----------|---------------|----------|
| `JWT_SECRET` | All issued tokens become forgeable | Rotate + redeploy; old tokens still valid until expiry |
| `PRESIGNED_SECRET` | All presigned URLs become forgeable | Same |

Never log these values. Never commit them to source control.

---

## Authorization

Authorization is enforced at the service layer, not the controller layer — this means it applies regardless of which route reaches the service.

### Bucket ACL

| ACL | List | Download | Upload | Delete |
|-----|------|----------|--------|--------|
| `private` | Owner only | Owner only | Owner only | Owner only |
| `public-read` | Anyone | Anyone | Owner only | Owner only |
| `public-read-write` | Anyone | Anyone | Anyone | Owner only |

> Delete is always owner-only. There is no `public-delete` ACL.

### Object ACL

Per-object ACL (`private` or `public-read`) can grant download access to an object in a private bucket, but only the bucket owner can upload or delete.

---

## Pre-signed URLs

### Signature Algorithm

```
message   = "{operation}\n{bucketName}\n{key}\n{expiresTimestamp}"
signature = HMAC-SHA256(PRESIGNED_SECRET, message)
```

The URL embeds `X-Expires`, `X-Operation`, and `X-Signature` as query parameters.

### Timing-Safe Comparison

Signature verification uses `crypto.timingSafeEqual()` to prevent timing attacks:

```typescript
const expectedBuf = Buffer.from(expected, 'hex');
const providedBuf = Buffer.from(signatureParam, 'hex');

if (
  expectedBuf.length !== providedBuf.length ||
  !crypto.timingSafeEqual(expectedBuf, providedBuf)
) {
  throw new AppError('PRESIGNED_URL_INVALID', 'Invalid signature');
}
```

A naive `===` comparison would leak information about how many bytes match through response time differences.

### Limitations of the Current Design

1. **No operation binding to requester** — the URL grants the operation to anyone who holds it. This is standard S3 behaviour.
2. **No IP restriction** — add `X-Allowed-IP` to the signed payload if you need to restrict usage to a known IP.
3. **No path traversal prevention on key** — keys are URL-decoded before signature verification. A key like `../../etc/passwd` would be rejected by `validateObjectKey()` (enforces no leading `/`, no `//`), but double-check this if you add new key sources.

---

## Transport Security

**Always run behind HTTPS in production.** The Express server itself speaks plain HTTP — TLS should be terminated at the load balancer (nginx with a TLS certificate, or a cloud load balancer).

```nginx
server {
  listen 443 ssl;
  ssl_certificate     /etc/ssl/certs/loony-s3.crt;
  ssl_certificate_key /etc/ssl/private/loony-s3.key;
  ssl_protocols       TLSv1.2 TLSv1.3;
  ssl_ciphers         HIGH:!aNULL:!MD5;
  ...
}
```

Without HTTPS, API keys and JWT tokens are transmitted in plaintext.

---

## Input Validation

### Bucket Names

Validated against `/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/` and checked for disallowed sequences (`..`, `.-`, `-.`). This mirrors S3's naming rules and prevents:
- Path traversal via bucket names
- DNS spoofing via unusual domain-like names

### Object Keys

Validated in `ObjectService.validateObjectKey()`:
- Non-empty
- Maximum 1024 characters (S3 limit)
- No leading `/`
- No `//` sequences

### Request Bodies

Structured request bodies (create bucket, complete multipart, generate presigned URL) are validated with Zod schemas before reaching service code.

---

## Storage Path Security

`LocalStorageBackend.resolvePath()` joins `this.root` with `storageKey` using `path.join`. The `storageKey` is always generated internally (never user-provided directly), so path traversal via storage key is not a concern in the current design.

If you expose `storageKey` to users or accept it as input in the future, add:

```typescript
const resolved = path.resolve(this.root, storageKey);
if (!resolved.startsWith(this.root)) {
  throw new Error('Path traversal detected');
}
```

---

## Known Limitations (MVP Intentional Simplifications)

| Limitation | Production mitigation |
|-----------|----------------------|
| No token revocation | Add `revoked_tokens` table; check on each request |
| Passwords not validated | Add `users` table with bcrypt hashes |
| API key stored reversibly | Store only `SHA-256(key)`; one-time display |
| No rate limiting | Add `express-rate-limit` or a Redis-backed limiter |
| No HTTPS in server | Terminate TLS at nginx / load balancer |
| Single-signer presigned URLs | Acceptable — same as S3 |
