#!/usr/bin/env bash
# Start loony-s3-js in development mode (SQLite, port 8006).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DATA_DIR="/tmp/loony-s3-js-dev"

mkdir -p "$DATA_DIR/objects"

# Build if dist is missing
if [ ! -f "$ROOT/dist/server.js" ]; then
  echo "Building…"
  npm --prefix "$ROOT" run build
fi

echo "Starting loony-s3-js on port 8006 (SQLite, data dir: $DATA_DIR)"
exec env \
  PORT=8006 \
  BASE_URL=http://localhost:8006 \
  STORAGE_BACKEND=local \
  STORAGE_ROOT="$DATA_DIR/objects" \
  DB_BACKEND=sqlite \
  DB_PATH="$DATA_DIR/metadata.db" \
  JWT_SECRET=dev-secret \
  PRESIGNED_SECRET=dev-presigned \
  MIN_PART_SIZE_BYTES=0 \
  NODE_OPTIONS='--experimental-sqlite' \
  node "$ROOT/dist/server.js"
