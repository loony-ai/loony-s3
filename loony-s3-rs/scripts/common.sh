#!/usr/bin/env bash
# Shared helpers for test scripts.

BASE_URL="${BASE_URL:-http://localhost:8006}"
PASS=0
FAIL=0

# colours (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN="\033[0;32m"; RED="\033[0;31m"; RESET="\033[0m"; BOLD="\033[1m"
else
  GREEN=""; RED=""; RESET=""; BOLD=""
fi

pass() { echo -e "${GREEN}✓ PASS${RESET}  $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}✗ FAIL${RESET}  $1"; FAIL=$((FAIL + 1)); }

# assert_eq <label> <actual> <expected_substring>
assert_contains() {
  local label="$1" actual="$2" expected="$3"
  if echo "$actual" | grep -q "$expected"; then
    pass "$label"
  else
    fail "$label — expected '$expected' in: $actual"
  fi
}

# assert_http <label> <actual_status> <expected_status>
assert_status() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label — expected HTTP $expected, got $actual"
  fi
}

# curl wrapper that returns status code only
http_status() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

# curl wrapper that returns body only
http_body() { curl -s "$@"; }

# curl wrapper that returns both "STATUS BODY"
http() {
  local status body
  body=$(curl -s -w "\n%{http_code}" "$@")
  status=$(echo "$body" | tail -1)
  body=$(echo "$body" | head -n -1)
  echo "$status $body"
}

# Get a token for user_id and name; prints the token
get_token() {
  local user_id="${1:-test-user}" name="${2:-Test User}"
  http_body -X POST "$BASE_URL/auth/token" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"$user_id\",\"name\":\"$name\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])"
}

# Print summary and exit with error if any test failed
summary() {
  echo ""
  echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}  ${RED}$FAIL failed${RESET}"
  [ "$FAIL" -eq 0 ] || exit 1
}
