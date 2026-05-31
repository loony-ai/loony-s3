#!/usr/bin/env bash
# Stop the loony-s3-rs dev server gracefully.
set -euo pipefail

PORT="${PORT:-8006}"

PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)

if [ -z "$PIDS" ]; then
  echo "No process found on port $PORT"
  exit 0
fi

echo "Stopping loony-s3-rs (port $PORT, PID(s): $PIDS)"
echo "$PIDS" | xargs kill -SIGTERM 2>/dev/null || true

# Wait up to 10s for graceful shutdown
for i in $(seq 1 10); do
  sleep 1
  REMAINING=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  if [ -z "$REMAINING" ]; then
    echo "Server stopped."
    exit 0
  fi
done

# Force kill if still running
echo "Server did not stop in time — sending SIGKILL"
lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill -SIGKILL 2>/dev/null || true
echo "Done."
