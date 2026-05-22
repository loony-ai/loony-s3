#!/usr/bin/env bash
# Test: object lifecycle — upload, download, range requests, metadata,
#       TTL, versioning, listing, and deletion.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo -e "${BOLD}=== Object tests ===${RESET}"

TOKEN=$(get_token "obj-test-user" "Object Tester")
BUCKET="obj-test-$(date +%s)"

api() { curl -s "$@" -H "Authorization: Bearer $TOKEN"; }

# ── Setup bucket ──────────────────────────────────────────────────────────────
api -X POST "$BASE_URL/buckets" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$BUCKET\"}" > /dev/null

# ── PUT object ────────────────────────────────────────────────────────────────
RESP=$(api -X PUT "$BASE_URL/$BUCKET/hello.txt" \
  -H "Content-Type: text/plain" \
  --data-binary "Hello loony-s3-rs!")

assert_contains "put object — key"       "$RESP" '"key":"hello.txt"'
assert_contains "put object — size 18"   "$RESP" '"size":18'
assert_contains "put object — etag"      "$RESP" '"etag":'
assert_contains "put object — is_latest" "$RESP" '"is_latest":true'

VERSION_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['version_id'])")

# ── GET object body ───────────────────────────────────────────────────────────
BODY=$(api "$BASE_URL/$BUCKET/hello.txt")
assert_contains "get object — body" "$BODY" "Hello loony-s3-rs!"

# ── HEAD ─────────────────────────────────────────────────────────────────────
STATUS=$(http_status "$BASE_URL/$BUCKET/hello.txt" \
  -X HEAD -H "Authorization: Bearer $TOKEN")
assert_status "head object — 200" "$STATUS" "200"

# ── Content-Type passthrough ──────────────────────────────────────────────────
CT=$(curl -s -I "$BASE_URL/$BUCKET/hello.txt" \
  -H "Authorization: Bearer $TOKEN" | grep -i "content-type" | tr -d '\r')
assert_contains "content-type header" "$CT" "text/plain"

# ── Range request ─────────────────────────────────────────────────────────────
RANGED=$(api -r 0-4 "$BASE_URL/$BUCKET/hello.txt")
assert_contains "range request bytes 0-4" "$RANGED" "Hello"

STATUS=$(http_status -H "Range: bytes=0-4" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/$BUCKET/hello.txt")
assert_status "range request — 206" "$STATUS" "206"

# ── x-amz-meta-* headers ─────────────────────────────────────────────────────
RESP=$(api -X PUT "$BASE_URL/$BUCKET/with-meta.txt" \
  -H "Content-Type: text/plain" \
  -H "x-amz-meta-author: alice" \
  -H "x-amz-meta-project: demo" \
  --data-binary "metadata test")

assert_contains "put with metadata — author" "$RESP" '"author":"alice"'
assert_contains "put with metadata — project" "$RESP" '"project":"demo"'

# ── TTL ───────────────────────────────────────────────────────────────────────
RESP=$(api -X PUT "$BASE_URL/$BUCKET/expiring.txt" \
  -H "Content-Type: text/plain" \
  -H "x-ttl-seconds: 60" \
  --data-binary "expires soon")
assert_contains "put with TTL — expires_at not null" "$RESP" '"expires_at":"'

# ── Nested keys (slash in key) ────────────────────────────────────────────────
api -X PUT "$BASE_URL/$BUCKET/folder/sub/file.bin" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "nested" > /dev/null
BODY=$(api "$BASE_URL/$BUCKET/folder/sub/file.bin")
assert_contains "nested key — body" "$BODY" "nested"

# ── List objects ──────────────────────────────────────────────────────────────
RESP=$(api "$BASE_URL/$BUCKET/list?list=true")
assert_contains "list objects — hello.txt present"       "$RESP" '"hello.txt"'
assert_contains "list objects — with-meta.txt present"   "$RESP" '"with-meta.txt"'

# prefix filter
RESP=$(api "$BASE_URL/$BUCKET/list?list=true&prefix=folder/")
assert_contains "list with prefix — nested key present" "$RESP" '"folder/sub/file.bin"'

# delimiter (virtual folders)
RESP=$(api "$BASE_URL/$BUCKET/list?list=true&delimiter=/")
assert_contains "list with delimiter — commonPrefixes has folder/" "$RESP" '"folder/"'

# ── Versioning ────────────────────────────────────────────────────────────────
RESP2=$(api -X PUT "$BASE_URL/$BUCKET/hello.txt" \
  -H "Content-Type: text/plain" \
  --data-binary "Updated content")
VERSION_ID2=$(echo "$RESP2" | python3 -c "import sys,json; print(json.load(sys.stdin)['version_id'])")
assert_contains "second version — is_latest true" "$RESP2" '"is_latest":true'

BODY=$(api "$BASE_URL/$BUCKET/hello.txt")
assert_contains "get latest — returns updated content" "$BODY" "Updated content"

BODY=$(api "$BASE_URL/$BUCKET/hello.txt?version_id=$VERSION_ID")
assert_contains "get specific version — returns v1" "$BODY" "Hello loony-s3-rs!"

RESP=$(api "$BASE_URL/$BUCKET/hello.txt?list_versions=true")
assert_contains "list versions — has two entries" "$RESP" '"versions"'
COUNT=$(echo "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['versions']))")
if [ "$COUNT" -ge 2 ]; then pass "list versions — count >= 2"; else fail "list versions — expected >= 2, got $COUNT"; fi

# ── 404 for nonexistent object ────────────────────────────────────────────────
STATUS=$(http_status "$BASE_URL/$BUCKET/doesnotexist.bin" \
  -H "Authorization: Bearer $TOKEN")
assert_status "get nonexistent — 404" "$STATUS" "404"

# ── Delete object ─────────────────────────────────────────────────────────────
STATUS=$(http_status -X DELETE "$BASE_URL/$BUCKET/hello.txt" \
  -H "Authorization: Bearer $TOKEN")
assert_status "delete object — 204" "$STATUS" "204"

STATUS=$(http_status "$BASE_URL/$BUCKET/hello.txt" \
  -H "Authorization: Bearer $TOKEN")
assert_status "get after delete — 404" "$STATUS" "404"

# ── Access control ────────────────────────────────────────────────────────────
# Private bucket — no auth → 403
STATUS=$(http_status "$BASE_URL/$BUCKET/with-meta.txt")
assert_status "private bucket — unauthenticated access 403" "$STATUS" "403"

# Cleanup
api -X DELETE "$BASE_URL/buckets/$BUCKET" > /dev/null

summary
