#!/usr/bin/env bash
# Test: multipart upload — initiate, upload parts, complete, abort, list parts.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo -e "${BOLD}=== Multipart upload tests ===${RESET}"

TOKEN=$(get_token "mp-user" "Multipart Tester")
BUCKET="mp-test-$(date +%s)"

api() { curl -s "$@" -H "Authorization: Bearer $TOKEN"; }

# Setup bucket
api -X POST "$BASE_URL/buckets" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$BUCKET\"}" > /dev/null

# ── Initiate ──────────────────────────────────────────────────────────────────
RESP=$(api -X POST "$BASE_URL/$BUCKET/large-file.bin?uploads")
assert_contains "initiate — uploadId"     "$RESP" '"uploadId"'
assert_contains "initiate — bucketName"   "$RESP" "\"$BUCKET\""
assert_contains "initiate — key"          "$RESP" '"large-file.bin"'

UPLOAD_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['uploadId'])")

# ── Upload parts ──────────────────────────────────────────────────────────────
PART1=$(api -X PUT \
  "$BASE_URL/$BUCKET/large-file.bin?partNumber=1&uploadId=$UPLOAD_ID" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "Part one content --- ")
assert_contains "upload part 1 — partNumber" "$PART1" '"partNumber":1'
assert_contains "upload part 1 — etag"       "$PART1" '"etag"'
ETAG1=$(echo "$PART1" | python3 -c "import sys,json; print(json.load(sys.stdin)['etag'])")

PART2=$(api -X PUT \
  "$BASE_URL/$BUCKET/large-file.bin?partNumber=2&uploadId=$UPLOAD_ID" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "Part two content --- ")
assert_contains "upload part 2 — partNumber" "$PART2" '"partNumber":2'

# ── List parts ────────────────────────────────────────────────────────────────
RESP=$(api "$BASE_URL/$BUCKET/large-file.bin?uploadId=$UPLOAD_ID")
assert_contains "list parts — uploadId"       "$RESP" "\"$UPLOAD_ID\""
assert_contains "list parts — two parts"      "$RESP" '"partNumber":1'
assert_contains "list parts — part 2 present" "$RESP" '"partNumber":2'

# ── Complete ──────────────────────────────────────────────────────────────────
RESP=$(api -X POST "$BASE_URL/$BUCKET/large-file.bin?uploadId=$UPLOAD_ID" \
  -H "Content-Type: application/json" \
  -d '{"parts":[1,2],"content_type":"application/octet-stream"}')
assert_contains "complete — key"      "$RESP" '"large-file.bin"'
assert_contains "complete — etag"     "$RESP" '"etag"'
assert_contains "complete — is_latest" "$RESP" '"is_latest":true'

# ── Read assembled object ─────────────────────────────────────────────────────
BODY=$(api "$BASE_URL/$BUCKET/large-file.bin")
assert_contains "assembled object — part 1 present" "$BODY" "Part one content"
assert_contains "assembled object — part 2 present" "$BODY" "Part two content"

# ── Upload ID gone after complete ─────────────────────────────────────────────
STATUS=$(http_status "$BASE_URL/$BUCKET/large-file.bin?uploadId=$UPLOAD_ID" \
  -H "Authorization: Bearer $TOKEN")
assert_status "upload ID removed after complete — 404" "$STATUS" "404"

# ── Abort flow ────────────────────────────────────────────────────────────────
RESP2=$(api -X POST "$BASE_URL/$BUCKET/to-abort.bin?uploads")
UPLOAD_ID2=$(echo "$RESP2" | python3 -c "import sys,json; print(json.load(sys.stdin)['uploadId'])")

api -X PUT "$BASE_URL/$BUCKET/to-abort.bin?partNumber=1&uploadId=$UPLOAD_ID2" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "will be discarded" > /dev/null

STATUS=$(http_status -X DELETE "$BASE_URL/$BUCKET/to-abort.bin?uploadId=$UPLOAD_ID2" \
  -H "Authorization: Bearer $TOKEN")
assert_status "abort upload — 204" "$STATUS" "204"

# After abort the upload_id should be gone
STATUS=$(http_status "$BASE_URL/$BUCKET/to-abort.bin?uploadId=$UPLOAD_ID2" \
  -H "Authorization: Bearer $TOKEN")
assert_status "upload ID removed after abort — 404" "$STATUS" "404"

# The key itself was never committed
STATUS=$(http_status "$BASE_URL/$BUCKET/to-abort.bin" \
  -H "Authorization: Bearer $TOKEN")
assert_status "aborted object not found — 404" "$STATUS" "404"

# Cleanup
api -X DELETE "$BASE_URL/buckets/$BUCKET" > /dev/null

summary
