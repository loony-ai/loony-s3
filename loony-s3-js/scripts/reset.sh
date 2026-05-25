#!/usr/bin/env bash
# Wipe all data: database (SQLite or PostgreSQL) and all stored objects.
# Safe to run while the server is stopped; warns if it appears to be running.
set -euo pipefail

STORAGE_ROOT="${STORAGE_ROOT:-/home/sankar/loonystorage/s3/data}"
DB_BACKEND="${DB_BACKEND:-sqlite}"
DB_PATH="${DB_PATH:-/home/sankar/loonystorage/s3/db/metadata.db}"
POSTGRES_URL="${POSTGRES_URL:-}"
PORT="${PORT:-8006}"

echo "=== loony-s3-js reset ==="
echo "  Backend : $DB_BACKEND"
echo "  Storage : $STORAGE_ROOT"
echo ""

# ── Guard: warn if server is running ─────────────────────────────────────────

if lsof -ti tcp:"$PORT" &>/dev/null; then
  echo "WARNING: a process is listening on port $PORT."
  echo "Stop the server before resetting to avoid locked files."
  echo ""
  read -r -p "Continue anyway? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# ── Database ──────────────────────────────────────────────────────────────────

if [ "$DB_BACKEND" = "sqlite" ]; then
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
  mkdir -p "$(dirname "$DB_PATH")"
  echo "Deleted SQLite database: $DB_PATH"

elif [ "$DB_BACKEND" = "postgres" ]; then
  if [ -z "$POSTGRES_URL" ]; then
    echo "ERROR: DB_BACKEND=postgres but POSTGRES_URL is not set"
    exit 1
  fi
  psql "$POSTGRES_URL" <<'SQL'
TRUNCATE TABLE multipart_uploads CASCADE;
TRUNCATE TABLE objects CASCADE;
TRUNCATE TABLE buckets CASCADE;
SQL
  echo "Truncated PostgreSQL tables"

else
  echo "ERROR: Unknown DB_BACKEND=$DB_BACKEND (expected sqlite or postgres)"
  exit 1
fi

# ── Object storage ────────────────────────────────────────────────────────────

rm -rf "$STORAGE_ROOT"
mkdir -p "$STORAGE_ROOT/__tmp"
echo "Deleted object storage: $STORAGE_ROOT"

echo ""
echo "Done. Run start-dev.sh to reinitialise."
