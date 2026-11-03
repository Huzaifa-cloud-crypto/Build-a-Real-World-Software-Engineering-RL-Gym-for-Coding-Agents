#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLUTION_DIR="${SOLUTION_DIR:-$ROOT_DIR/reference}"
CLI_ENTRY="${SOLUTION_DIR}/dist/cli.js"

WORKER_ID="${1:-worker_default}"
[ "$#" -gt 0 ] && shift

if [ ! -f "$CLI_ENTRY" ]; then
  echo "ERROR: no compiled CLI at $CLI_ENTRY" >&2
  echo "       run app-setup/build.sh first." >&2
  exit 1
fi

echo "Starting job-queue worker daemon ($WORKER_ID)..."
exec node "$CLI_ENTRY" worker start --worker-id "$WORKER_ID" "$@"
