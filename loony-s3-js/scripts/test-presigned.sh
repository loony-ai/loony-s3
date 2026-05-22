#!/usr/bin/env bash
# Test: presigned URL generation and consumption.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo -e "${BOLD}=== Presigned URL tests ===${RESET}"

TOKEN=$(get_token "presign-user" "Presign Tester")
BUCKET="presign-test-$(date +%s)"

api() { curl -s "$@" -H "Authorization: Bearer $TOKEN"; }

# Setup
api -X POST "$BASE_URL/buckets" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$BUCKET\"}" > /dev/null

api -X PUT "$BASE_URL/$BUCKET/secret.txt" \
  -H "Content-Type: text/plain" \
  --data-binary "Top secret content" > /dev/null

# ── Generate presigned GET URL ─────────────────────────────────────────────────
RESP=$(api "$BASE_URL/$BUCKET/secret.txt?presign=true&operation=GET&expires_in=300")
assert_contains "generate presigned URL — url field"      "$RESP" '"url"'
assert_contains "generate presigned URL — expiresAt"      "$RESP" '"expiresAt"'
assert_contains "generate presigned URL — contains sig"   "$RESP" 'signature='
assert_contains "generate presigned URL — operation=GET"  "$RESP" 'operation=GET'

PRESIGNED_URL=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")

# ── Use presigned URL (no auth header) ────────────────────────────────────────
BODY=$(curl -s "$PRESIGNED_URL")
assert_contains "consume presigned URL — body" "$BODY" "Top secret content"

STATUS=$(http_status "$PRESIGNED_URL")
assert_status "consume presigned URL — 200" "$STATUS" "200"

# ── Tampered signature → 401 ──────────────────────────────────────────────────
TAMPERED="${PRESIGNED_URL%signature=*}signature=deadbeef"
STATUS=$(http_status "$TAMPERED")
assert_status "tampered signature — 401" "$STATUS" "401"

# ── Wrong operation ───────────────────────────────────────────────────────────
RESP_PUT=$(api "$BASE_URL/$BUCKET/secret.txt?presign=true&operation=PUT&expires_in=60")
PUT_URL=$(echo "$RESP_PUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
# Using GET presigned URL for GET but with PUT operation=PUT in the URL
# should succeed because it's a different signed URL
assert_contains "presigned PUT URL — url present" "$RESP_PUT" '"url"'

# ── Default expires_in (3600) ─────────────────────────────────────────────────
RESP2=$(api "$BASE_URL/$BUCKET/secret.txt?presign=true&operation=GET")
EXPIRES=$(echo "$RESP2" | python3 -c "import sys,json; print(json.load(sys.stdin)['expiresAt'])")
NOW=$(date +%s)
DIFF=$((EXPIRES - NOW))
if [ "$DIFF" -gt 3500 ] && [ "$DIFF" -le 3700 ]; then
  pass "default expires_in ~3600 seconds ($DIFF s remaining)"
else
  fail "default expires_in unexpected: $DIFF s remaining"
fi

# Cleanup
api -X DELETE "$BASE_URL/buckets/$BUCKET" > /dev/null

summary
