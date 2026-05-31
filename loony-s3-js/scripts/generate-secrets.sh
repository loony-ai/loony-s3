#!/usr/bin/env bash
# Generate strong random secrets for production deployment.
# Usage:
#   ./scripts/generate-secrets.sh              # print to stdout
#   ./scripts/generate-secrets.sh >> .env      # append to env file
set -euo pipefail

JWT_SECRET=$(openssl rand -hex 32)
PRESIGNED_SECRET=$(openssl rand -hex 32)

echo "JWT_SECRET=$JWT_SECRET"
echo "PRESIGNED_SECRET=$PRESIGNED_SECRET"
