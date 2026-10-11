#!/usr/bin/env bash
set -e

echo "=== Building Reference Solution ==="
cd "$(dirname "$0")/../reference"
npm install --silent
npm run build

echo "=== Building Evaluation Verifier ==="
cd "$(dirname "$0")/../evaluation"
npm install --silent
npm run build

echo "Build completed successfully."
