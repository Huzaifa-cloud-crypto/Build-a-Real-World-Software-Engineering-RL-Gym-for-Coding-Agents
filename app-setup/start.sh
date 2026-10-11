#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_ID="${1:-worker_default}"

echo "Starting job-queue daemon worker ($WORKER_ID)..."
exec node "$ROOT_DIR/reference/dist/cli.js" worker start --worker-id "$WORKER_ID" "$@"
