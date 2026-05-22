#!/usr/bin/env bash
# Test: bucket CRUD — create, list, get, update ACL/versioning, delete.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo -e "${BOLD}=== Bucket tests ===${RESET}"

TOKEN=$(get_token "bucket-test-user" "Bucket Tester")
AUTH="-H \"Authorization: Bearer $TOKEN\""

# Helper that injects the auth header
api() { curl -s "$@" -H "Authorization: Bearer $TOKEN"; }

BUCKET="test-bkt-$(date +%s)"

# ── Create ────────────────────────────────────────────────────────────────────
RESP=$(api -X POST "$BASE_URL/buckets" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$BUCKET\",\"acl\":\"private\"}")

assert_contains "create bucket — name in response"      "$RESP" "\"$BUCKET\""
assert_contains "create bucket — acl private"           "$RESP" '"acl":"private"'
assert_contains "create bucket — versioning false"      "$RESP" '"versioning":false'

STATUS=$(http_status -X POST "$BASE_URL/buckets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$BUCKET\"}")
assert_status "duplicate bucket name — 409" "$STATUS" "409"

# ── Name validation ───────────────────────────────────────────────────────────
STATUS=$(http_status -X POST "$BASE_URL/buckets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"AB"}')
assert_status "bucket name too short — 400" "$STATUS" "400"

STATUS=$(http_status -X POST "$BASE_URL/buckets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"-starts-with-dash"}')
assert_status "bucket name leading dash — 400" "$STATUS" "400"

STATUS=$(http_status -X POST "$BASE_URL/buckets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Has_Underscore"}')
assert_status "bucket name with underscore — 400" "$STATUS" "400"

# ── List ──────────────────────────────────────────────────────────────────────
RESP=$(api "$BASE_URL/buckets")
assert_contains "list buckets — contains created bucket" "$RESP" "\"$BUCKET\""

# ── Get ───────────────────────────────────────────────────────────────────────
RESP=$(api "$BASE_URL/buckets/$BUCKET")
assert_contains "get bucket — name matches" "$RESP" "\"$BUCKET\""

STATUS=$(http_status "$BASE_URL/buckets/nonexistent-bucket-xyz" \
  -H "Authorization: Bearer $TOKEN")
assert_status "get nonexistent bucket — 404" "$STATUS" "404"

# ── Update ACL ────────────────────────────────────────────────────────────────
RESP=$(api -X PUT "$BASE_URL/buckets/$BUCKET" \
  -H "Content-Type: application/json" \
  -d '{"acl":"public-read","versioning":true}')
assert_contains "update bucket — acl public-read"  "$RESP" '"acl":"public-read"'
assert_contains "update bucket — versioning true"  "$RESP" '"versioning":true'

# ── Public read (no auth) ─────────────────────────────────────────────────────
STATUS=$(http_status "$BASE_URL/buckets/$BUCKET")
assert_status "public-read bucket accessible without auth" "$STATUS" "200"

# ── Delete ────────────────────────────────────────────────────────────────────
STATUS=$(http_status -X DELETE "$BASE_URL/buckets/$BUCKET" \
  -H "Authorization: Bearer $TOKEN")
assert_status "delete bucket — 204" "$STATUS" "204"

STATUS=$(http_status "$BASE_URL/buckets/$BUCKET" -H "Authorization: Bearer $TOKEN")
assert_status "get deleted bucket — 404" "$STATUS" "404"

summary
