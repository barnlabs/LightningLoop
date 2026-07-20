#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="LightningLoop"
BUNDLE_ID="com.barnlabs.LightningLoop"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/LightningLoop.xcodeproj"
DERIVED_DATA="$ROOT_DIR/.build/DerivedData"
APP_BUNDLE="$DERIVED_DATA/Build/Products/Debug/$APP_NAME.app"
NODE_EXECUTABLE="$(command -v node || true)"

if [[ -z "$NODE_EXECUTABLE" ]] || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22.19+ and npm are required to build the shared Pi harness." >&2
  exit 1
fi

(cd "$ROOT_DIR" && npm ci --ignore-scripts)
(cd "$ROOT_DIR" && npm run build:harness)

if [[ ! -d "$PROJECT" ]]; then
  if ! command -v xcodegen >/dev/null 2>&1; then
    echo "LightningLoop.xcodeproj is missing and xcodegen is not installed." >&2
    exit 1
  fi
  (cd "$ROOT_DIR" && xcodegen generate)
fi

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

xcodebuild \
  -project "$PROJECT" \
  -scheme "$APP_NAME" \
  -configuration Debug \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  build

open_app() {
  /usr/bin/open -n --env "LIGHTNINGLOOP_NODE_PATH=$NODE_EXECUTABLE" "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 1
    pgrep -x "$APP_NAME" >/dev/null
    printf '%s launched successfully.\n' "$APP_NAME"
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
