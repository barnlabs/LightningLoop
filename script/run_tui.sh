#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

if [[ ! -d node_modules ]]; then
  npm ci --ignore-scripts
fi

npm run build:harness
exec node dist/cli/index.js "$@"
