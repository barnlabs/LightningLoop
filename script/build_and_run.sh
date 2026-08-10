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
VERIFY_RECEIPT=""

cleanup() {
  if [[ -n "$VERIFY_RECEIPT" && -f "$VERIFY_RECEIPT" ]]; then
    /bin/rm -f -- "$VERIFY_RECEIPT"
  fi
}
trap cleanup EXIT

built_app_pids() {
  local app_executable pid process_command
  app_executable="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    process_command="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$process_command" in
      "$app_executable"|"$app_executable "*) printf '%s\n' "$pid" ;;
    esac
  done < <(pgrep -x "$APP_NAME" 2>/dev/null || true)
}

stop_built_app() {
  local pid attempts
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null || true
  done < <(built_app_pids)

  attempts=0
  while [[ -n "$(built_app_pids)" && "$attempts" -lt 50 ]]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if [[ -n "$(built_app_pids)" ]]; then
    echo "The existing project-built $APP_NAME process did not stop; the build was not started." >&2
    exit 1
  fi
}

if [[ -z "$NODE_EXECUTABLE" ]] || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22.19+ and npm are required to build the shared Pi harness." >&2
  exit 1
fi

# Stop only the executable produced in this DerivedData directory. An installed
# LightningLoop with the same process name remains untouched.
stop_built_app

(cd "$ROOT_DIR" && npm ci --ignore-scripts)
(cd "$ROOT_DIR" && npm run build:harness)

if [[ ! -d "$PROJECT" ]]; then
  if ! command -v xcodegen >/dev/null 2>&1; then
    echo "LightningLoop.xcodeproj is missing and xcodegen is not installed." >&2
    exit 1
  fi
  (cd "$ROOT_DIR" && xcodegen generate)
fi

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

verify_app() {
  local app_executable app_pid attempts launch_token process_command receipt_token pre_open_pids
  app_executable="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
  pre_open_pids="$(built_app_pids)"
  if [[ -n "$pre_open_pids" ]]; then
    echo "An exact-path $APP_NAME process appeared after the build and before launch; refusing ambiguous verification." >&2
    return 1
  fi
  VERIFY_RECEIPT="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/lightningloop-launch-receipt.XXXXXX")"
  launch_token="$(/usr/bin/uuidgen)"
  /usr/bin/open -n \
    --env "LIGHTNINGLOOP_NODE_PATH=$NODE_EXECUTABLE" \
    --env "LIGHTNINGLOOP_LAUNCH_VERIFY_TOKEN=$launch_token" \
    --env "LIGHTNINGLOOP_LAUNCH_VERIFY_RECEIPT=$VERIFY_RECEIPT" \
    "$APP_BUNDLE"
  attempts=0
  app_pid=""
  while [[ -z "$app_pid" && "$attempts" -lt 100 ]]; do
    app_pid="$(/usr/bin/sed -n '1p' "$VERIFY_RECEIPT" 2>/dev/null || true)"
    [[ -n "$app_pid" ]] || sleep 0.1
    attempts=$((attempts + 1))
  done
  if [[ -z "$app_pid" ]]; then
    echo "$APP_NAME did not return a launch receipt from the app bundle within 10 seconds." >&2
    return 1
  fi
  receipt_token="$(/usr/bin/sed -n '2p' "$VERIFY_RECEIPT" 2>/dev/null || true)"
  if [[ ! "$app_pid" =~ ^[0-9]+$ || "$receipt_token" != "$launch_token" ]]; then
    echo "$APP_NAME returned an invalid launch receipt." >&2
    return 1
  fi
  sleep 1
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "$APP_NAME PID $app_pid exited during launch verification." >&2
    return 1
  fi
  process_command="$(/bin/ps -p "$app_pid" -o command= 2>/dev/null || true)"
  case "$process_command" in
    "$app_executable"|"$app_executable "*) ;;
    *)
      echo "PID $app_pid does not execute the app built by this invocation." >&2
      return 1
      ;;
  esac
  if ! built_app_pids | /usr/bin/grep -Fxq "$app_pid"; then
    echo "PID $app_pid is not the stable exact-path process returned by the launch receipt." >&2
    return 1
  fi
  printf '%s launched successfully from the current app bundle as newly receipted PID %s.\n' "$APP_NAME" "$app_pid"
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
    verify_app
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
