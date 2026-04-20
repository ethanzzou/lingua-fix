#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed or not on PATH."
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust cargo is not installed or not on PATH."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing root dependencies..."
  npm install
fi

if [ ! -d frontend/node_modules ]; then
  echo "Installing frontend dependencies..."
  npm --prefix frontend install
fi

if [ ! -f frontend/dist/index.html ] || [ ! -f target/release/linguafix ]; then
  echo "Building LinguaFix..."
  npm run build
fi

echo "Starting LinguaFix..."
npm start
