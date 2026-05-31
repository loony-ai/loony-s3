#!/usr/bin/env bash
# Check whether the loony-s3 server is healthy.
# Usage:
#   ./scripts/healthcheck.sh                        # default: http://localhost:3000
#   ./scripts/healthcheck.sh http://localhost:8006
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"

echo "Checking $BASE_URL/health ..."

RESPONSE=$(curl -sf --max-time 5 "$BASE_URL/health") || {
  echo "FAIL: server did not respond at $BASE_URL"
  exit 1
}

STATUS=$(echo "$RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")

echo "Response: $RESPONSE"
echo ""

if [ "$STATUS" = "ok" ]; then
  echo "OK: server is healthy"
else
  echo "WARN: server responded but status=$STATUS"
  exit 1
fi
