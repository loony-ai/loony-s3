#!/usr/bin/env bash
# Start loony-s3-rs in development mode (SQLite, port 8006).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DATA_DIR="/tmp/loony-s3-rs-dev"

mkdir -p "$DATA_DIR"

# Build if no binary
if [ ! -f "$ROOT/target/debug/loony-s3" ]; then
  echo "Building…"
  cargo build --manifest-path "$ROOT/Cargo.toml"
fi

echo "Starting loony-s3-rs on port 8006 (SQLite, data dir: $DATA_DIR)"
exec env \
  PORT=8006 \
  BASE_URL=http://localhost:8006 \
  STORAGE_BACKEND=local \
  STORAGE_ROOT="$DATA_DIR/objects" \
  DB_BACKEND=sqlite \
  DB_PATH="$DATA_DIR/metadata.db" \
  JWT_SECRET=dev-secret \
  PRESIGNED_SECRET=dev-presigned \
  RUST_LOG=info \
  "$ROOT/target/debug/loony-s3"
