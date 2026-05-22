#!/usr/bin/env bash
# Test: authentication — token issuance, JWT validation, API key auth.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo -e "${BOLD}=== Auth tests ===${RESET}"

# ── Issue token ───────────────────────────────────────────────────────────────
RESP=$(http_body -X POST "$BASE_URL/auth/token" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"auth-test","name":"Auth Tester"}')

assert_contains "issue token — returns token"   "$RESP" '"token"'
assert_contains "issue token — returns api_key" "$RESP" '"api_key"'

TOKEN=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
API_KEY=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")

# ── Use JWT to access a protected resource ────────────────────────────────────
STATUS=$(http_status -X GET "$BASE_URL/buckets" -H "Authorization: Bearer $TOKEN")
assert_status "JWT auth — GET /buckets returns 200" "$STATUS" "200"

# ── Use API key ───────────────────────────────────────────────────────────────
STATUS=$(http_status -X GET "$BASE_URL/buckets" -H "Authorization: ApiKey $API_KEY")
assert_status "API key auth — GET /buckets returns 200" "$STATUS" "200"

# ── Missing auth ──────────────────────────────────────────────────────────────
STATUS=$(http_status -X POST "$BASE_URL/buckets" \
  -H "Content-Type: application/json" \
  -d '{"name":"no-auth-bucket"}')
assert_status "no auth header — 401" "$STATUS" "401"

# ── Bad token ─────────────────────────────────────────────────────────────────
STATUS=$(http_status -X GET "$BASE_URL/buckets" -H "Authorization: Bearer not.a.token")
assert_status "bad token — 401" "$STATUS" "401"

summary
