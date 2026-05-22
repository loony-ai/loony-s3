#!/usr/bin/env bash
# Run all test groups in sequence. Fails fast if the server is not reachable.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASE_URL="${BASE_URL:-http://localhost:8006}"
export BASE_URL

echo "Target: $BASE_URL"
echo ""

# Verify the server is up
if ! curl -sf "$BASE_URL/health" > /dev/null; then
  echo "ERROR: server not reachable at $BASE_URL"
  echo "Start it with:  ./scripts/start-dev.sh"
  exit 1
fi

TOTAL_PASS=0
TOTAL_FAIL=0
ALL_PASS=true

run_suite() {
  local script="$1"
  echo ""
  if bash "$SCRIPT_DIR/$script"; then
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    ALL_PASS=false
  fi
}

run_suite test-auth.sh
run_suite test-buckets.sh
run_suite test-objects.sh
run_suite test-presigned.sh
run_suite test-multipart.sh

echo ""
echo "════════════════════════════════════"
if $ALL_PASS; then
  echo "  ALL SUITES PASSED"
else
  echo "  $TOTAL_FAIL SUITE(S) FAILED"
  exit 1
fi
echo "════════════════════════════════════"
