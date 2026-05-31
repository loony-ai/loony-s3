#!/usr/bin/env bash
# Start loony-s3-js using environment variables from .env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
ENV_FILE="$ROOT/.env"

# Load .env — skip blank lines, comments, and variables with empty values
# so the app's built-in defaults are used for anything left unset.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | grep -v '=$')
  set +a
  echo "Loaded env from $ENV_FILE"
else
  echo "Warning: $ENV_FILE not found — using defaults"
fi

# Build if dist is missing
if [ ! -f "$ROOT/dist/server.js" ]; then
  echo "Building…"
  npm --prefix "$ROOT" run build
fi

# Required for the built-in node:sqlite module (harmless when using postgres)
export NODE_OPTIONS='--experimental-sqlite'

echo "Starting loony-s3-js on port ${PORT:-3000} (db=${DB_BACKEND:-sqlite}, storage=${STORAGE_BACKEND:-local})"
exec node "$ROOT/dist/server.js"
