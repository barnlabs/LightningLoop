#!/usr/bin/env bash
#
# Easy, secure LightningLoop install via bun.
#
# Run this from a clean checkout of the repository. It installs the locked
# dependencies with lifecycle scripts disabled, builds the shared harness, and
# links the `llp` / `lloop` / `lightningloop` commands onto your PATH so you can
# just type `llp`.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<'EOF'
bun is required but was not found on PATH.

Install it, then re-run this script:
  curl -fsSL https://bun.sh/install | bash

See https://bun.sh for details. After installing, ensure bun's bin directory is
on your PATH (for example: export PATH="$HOME/.bun/bin:$PATH").
EOF
  exit 1
fi

echo "LightningLoop · installing locked dependencies with bun (lifecycle scripts disabled)…"
# bun migrates the committed package-lock.json, so dependency versions stay
# pinned to the reviewed lockfile. --ignore-scripts matches repository policy
# (no dependency lifecycle scripts run during install).
bun install --ignore-scripts

echo "LightningLoop · building the shared harness…"
bun run build:harness

echo "LightningLoop · linking llp / lloop / lightningloop onto your PATH…"
bun link

cat <<'EOF'

Done. If bun's bin directory is on your PATH, you can now run:
  llp help
  llp free                  # just-free mode: zero-cost OpenRouter models
  llp key set openrouter    # store your API key securely (read from stdin)
  llp                       # open the interactive TUI after choosing a provider

If `llp` is not found, add bun's bin directory to your PATH:
  export PATH="$HOME/.bun/bin:$PATH"
EOF
