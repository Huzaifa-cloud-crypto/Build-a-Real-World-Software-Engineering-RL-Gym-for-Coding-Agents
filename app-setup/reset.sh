#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Cleaning State and Build Artifacts ==="
rm -rf "$ROOT_DIR/.queue_data"
rm -rf "$ROOT_DIR/reference/dist"
rm -rf "$ROOT_DIR/evaluation/dist"
rm -rf "$ROOT_DIR"/evaluation/.test_scratch_*
rm -rf "$ROOT_DIR/evaluation/.mutant_test_dir"
rm -rf "$ROOT_DIR/temp_model_run"

echo "=== Rebuilding System ==="
"$ROOT_DIR/app-setup/build.sh"

echo "Reset completed."
