#!/usr/bin/env bash
set -euo pipefail

# Resolve once, up front: re-evaluating $0 after a cd breaks relative invocation.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The model's generated solution is dropped into reference/ by the harness.
# Override with SOLUTION_DIR to build a solution living elsewhere.
SOLUTION_DIR="${SOLUTION_DIR:-$ROOT_DIR/reference}"

echo "=== Building Model Solution ==="
echo "    solution: $SOLUTION_DIR"
cd "$SOLUTION_DIR"
npm install --silent
npm run build

# The verifier is private. Inside the model sandbox it is absent by design and
# gets bind-mounted at scoring time, so only build it when it is present.
if [ -d "$ROOT_DIR/evaluation" ]; then
  echo "=== Building Evaluation Verifier ==="
  cd "$ROOT_DIR/evaluation"
  npm install --silent
  npm run build
else
  echo "=== Evaluation verifier not mounted; skipping (model sandbox mode) ==="
fi

echo "Build completed successfully."
