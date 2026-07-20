#!/usr/bin/env bash
# Source-only macOS installer. It intentionally does not download, notarize, or
# bypass Gatekeeper for an app artifact.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="LightningLoop"
PROJECT="$ROOT_DIR/LightningLoop.xcodeproj"
DERIVED_DATA="$ROOT_DIR/.build/GitHubInstall"
BUILT_APP="$DERIVED_DATA/Build/Products/Release/$APP_NAME.app"
TUI_PREFIX="$HOME/.local"
TUI_PACKAGE_ROOT="$TUI_PREFIX/lib/node_modules/@barnlabs/lightningloop-harness"
APP_PARENT="$HOME/Applications"
APP_TARGET="$APP_PARENT/$APP_NAME.app"
BACKUP_PARENT="$HOME/Library/Application Support/LightningLoop/InstallerBackups"
INSTALL_LOCK_DIR="$HOME/Library/Application Support/LightningLoop/.source-install.lock"

NODE_EXECUTABLE=""
NPM_EXECUTABLE=""
PACKAGE_FILE=""
TUI_STAGING=""
APP_STAGING=""
BACKUP_ROOT=""
STAGED_TUI_ROOT=""
RUNTIME_MANIFEST_NAME=".lightningloop-runtime-manifest.json"
STAGED_RUNTIME_MANIFEST_SHA256=""
PACKED_ARCHIVE_SHA256=""
RENAME_EXCL_HELPER=""
TEST_FAIL_AT="${LIGHTNINGLOOP_INSTALL_TEST_FAIL_AT:-}"
INSTALL_LOCK_HELD=false
APP_LAUNCHED_PID=""
COMMIT_STARTED=false
COMMIT_COMPLETE=false
OLD_APP_MOVED=false
OLD_TUI_MOVED=false
NEW_APP_INSTALLED=false
NEW_TUI_INSTALLED=false
ALIAS_NAMES=()
MOVED_ALIAS_NAMES=()
NEW_ALIAS_NAMES=()

die() {
  echo "install_from_github.sh: $*" >&2
  exit 1
}

maybe_fail() {
  local point="$1"
  if [[ "$TEST_FAIL_AT" == "$point" ]]; then
    echo "install_from_github.sh: synthetic $point failure." >&2
    return 97
  fi
}

has_path() {
  [[ -e "$1" || -L "$1" ]]
}

acquire_install_lock() {
  mkdir -p "$(dirname "$INSTALL_LOCK_DIR")"
  if ! mkdir -m 700 "$INSTALL_LOCK_DIR" 2>/dev/null; then
    echo "install_from_github.sh: another LightningLoop source install holds $INSTALL_LOCK_DIR" >&2
    return 1
  fi
  INSTALL_LOCK_HELD=true
  printf '%s\n' "$$" > "$INSTALL_LOCK_DIR/owner-pid"
}

release_install_lock() {
  local release_status=0
  [[ "$INSTALL_LOCK_HELD" == true ]] || return 0
  if ! rm -f -- "$INSTALL_LOCK_DIR/owner-pid"; then release_status=1; fi
  if ! rmdir "$INSTALL_LOCK_DIR"; then release_status=1; fi
  if [[ "$release_status" -eq 0 ]]; then INSTALL_LOCK_HELD=false; fi
  return "$release_status"
}

app_command_for_pid() { /bin/ps -p "$1" -o command= 2>/dev/null || true; }
list_app_pids() {
  local pid command expected_executable
  expected_executable="$APP_TARGET/Contents/MacOS/$APP_NAME"
  for pid in $(/usr/bin/pgrep -x "$APP_NAME" 2>/dev/null || true); do
    command="$(app_command_for_pid "$pid")"
    case "$command" in
      "$expected_executable"|"$expected_executable "*) printf '%s\n' "$pid" ;;
    esac
  done
}
stop_app_processes() {
  local pid
  for pid in $(list_app_pids); do /bin/kill -TERM "$pid" 2>/dev/null || true; done
}
open_installed_app() { /usr/bin/open -n "$APP_TARGET"; }
app_pid_alive() { /bin/kill -0 "$1" 2>/dev/null; }
installer_pause() { sleep "$1"; }

require_absent_live_target() {
  local path="$1" label="$2"
  if has_path "$path"; then
    echo "install_from_github.sh: live $label target was recreated during installation: $path" >&2
    return 1
  fi
}

build_rename_excl_helper() {
  local output="$1"
  xcrun --sdk macosx clang -x c -o "$output" - <<'LIGHTNINGLOOP_RENAME_EXCL_C'
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3) return 64;
    if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCL) != 0) {
        perror("renameatx_np");
        return 1;
    }
    return 0;
}
LIGHTNINGLOOP_RENAME_EXCL_C
  chmod 500 "$output"
}

install_directory_no_replace() {
  local source="$1" destination="$2" label="$3"
  [[ -d "$source" && ! -L "$source" ]] || {
    echo "install_from_github.sh: $label source must be a real directory, not a link or special path." >&2
    return 1
  }
  [[ -x "$RENAME_EXCL_HELPER" ]] || {
    echo "install_from_github.sh: the atomic no-replace helper is unavailable." >&2
    return 1
  }
  "$RENAME_EXCL_HELPER" "$source" "$destination" || {
    echo "install_from_github.sh: could not atomically install $label without replacement at $destination" >&2
    return 1
  }
  [[ ! -e "$source" && ! -L "$source" && -d "$destination" && ! -L "$destination" ]] || {
    echo "install_from_github.sh: atomic $label rename did not establish the expected postcondition." >&2
    return 1
  }
}

install_alias_no_replace() {
  local source="$1" destination="$2" target
  if [[ -L "$source" ]]; then
    target="$(readlink "$source")"
    ln -s "$target" "$destination" 2>/dev/null || return 1
    if [[ ! -L "$destination" || "$(readlink "$destination")" != "$target" ]]; then
      rm -f -- "$destination"
      return 1
    fi
  elif [[ -f "$source" ]]; then
    ln "$source" "$destination" 2>/dev/null || return 1
    if [[ ! "$source" -ef "$destination" ]]; then
      rm -f -- "$destination"
      return 1
    fi
  else
    return 1
  fi
  if ! rm -f -- "$source"; then
    rm -f -- "$destination"
    return 1
  fi
}

move_directory_no_replace() {
  local source="$1" destination="$2" label="$3"
  install_directory_no_replace "$source" "$destination" "$label" || return 1
}

stop_app_and_require_empty_baseline() {
  local _
  if [[ -n "$(list_app_pids)" ]]; then
    stop_app_processes
  fi
  for _ in 1 2 3 4 5; do
    [[ -n "$(list_app_pids)" ]] || return 0
    installer_pause 1
  done
  echo "install_from_github.sh: the previous exact $APP_NAME process did not stop; no files were replaced." >&2
  return 1
}

launch_and_verify_new_app() {
  local _ pids count command expected_executable
  expected_executable="$APP_TARGET/Contents/MacOS/$APP_NAME"
  open_installed_app
  for _ in 1 2 3 4 5; do
    pids="$(list_app_pids)"
    count="$(printf '%s\n' "$pids" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')"
    if [[ "$count" -eq 1 ]]; then
      APP_LAUNCHED_PID="$pids"
      break
    fi
    installer_pause 1
  done
  [[ "$APP_LAUNCHED_PID" =~ ^[0-9]+$ ]] || {
    echo "install_from_github.sh: installed GUI did not establish one new exact process." >&2
    return 1
  }
  command="$(app_command_for_pid "$APP_LAUNCHED_PID")"
  case "$command" in
    "$expected_executable"|"$expected_executable "*) ;;
    *)
      echo "install_from_github.sh: launched PID $APP_LAUNCHED_PID does not execute the installed GUI." >&2
      return 1
      ;;
  esac
  installer_pause 1
  app_pid_alive "$APP_LAUNCHED_PID" || return 1
  pids="$(list_app_pids)"
  [[ "$pids" == "$APP_LAUNCHED_PID" ]] || {
    echo "install_from_github.sh: installed GUI PID was not stable after launch." >&2
    return 1
  }
}

required_node_version() {
  local version major minor
  version="$("$1" --version 2>/dev/null || true)"
  if [[ "$version" =~ ^v?([0-9]+)\.([0-9]+)\. ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    [[ "$major" -gt 22 || ( "$major" -eq 22 && "$minor" -ge 19 ) ]]
  else
    return 1
  fi
}

select_supported_node() {
  # Finder does not inherit a shell-managed PATH. Keep the source installer
  # aligned with HarnessProcessClient's fixed, app-launchable candidates.
  local candidate npm_candidate
  for candidate in "$HOME/.local/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] || continue
    required_node_version "$candidate" || continue
    npm_candidate="$(dirname "$candidate")/npm"
    [[ -x "$npm_candidate" ]] || continue
    NODE_EXECUTABLE="$candidate"
    NPM_EXECUTABLE="$npm_candidate"
    return 0
  done
  die "A Finder-launchable Node.js 22.19+ installation is required at ~/.local/node/bin/node, /opt/homebrew/bin/node, or /usr/local/bin/node. Shell-only Node installations are not supported for the GUI source install."
}

require_xcode_16() {
  local version major
  version="$(xcodebuild -version 2>/dev/null | /usr/bin/head -n 1 || true)"
  if [[ "$version" =~ ^Xcode[[:space:]]+([0-9]+)(\.[0-9]+)*$ ]]; then
    major="${BASH_REMATCH[1]}"
    [[ "$major" -ge 16 ]] && return 0
  fi
  die "Xcode 16+ is required (found: ${version:-unavailable})."
}

record_staged_aliases() {
  local alias
  while IFS= read -r alias; do
    [[ "$alias" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "Packed package declared an unsafe executable name."
    ALIAS_NAMES+=("$alias")
  done < <("$NODE_EXECUTABLE" -e '
    const bin = require(process.argv[1]).bin;
    for (const name of Object.keys(bin || {}).sort()) console.log(name);
  ' "$STAGED_TUI_ROOT/package.json")
  [[ "${#ALIAS_NAMES[@]}" -gt 0 ]] || die "Packed package declared no TUI executables."
}

move_existing_aliases_to_backup() {
  local name path target
  for name in "${ALIAS_NAMES[@]}"; do
    path="$TUI_PREFIX/bin/$name"
    if has_path "$path"; then
      install_alias_no_replace "$path" "$BACKUP_ROOT/bin/$name" || return 1
      MOVED_ALIAS_NAMES+=("$name")
    fi
  done

  # Keep a previous package's additional bin aliases too. Only aliases which
  # resolve inside its package root are touched; unrelated user commands stay.
  for path in "$TUI_PREFIX/bin"/*; do
    [[ -L "$path" ]] || continue
    name="$(basename "$path")"
    case " ${MOVED_ALIAS_NAMES[*]} " in *" $name "*) continue ;; esac
    target="$(cd "$(dirname "$path")" && cd "$(dirname "$(readlink "$path")")" 2>/dev/null && pwd -P || true)"
    case "$target" in
      "$TUI_PACKAGE_ROOT"/*)
        install_alias_no_replace "$path" "$BACKUP_ROOT/bin/$name" || return 1
        MOVED_ALIAS_NAMES+=("$name")
        ;;
    esac
  done
}

rollback() {
  local name rollback_status=0
  if [[ -n "$(list_app_pids)" ]]; then
    stop_app_processes
    if [[ -n "$(list_app_pids)" ]]; then rollback_status=1; fi
  fi
  if [[ "$NEW_APP_INSTALLED" == true ]] && ! rm -rf -- "$APP_TARGET"; then rollback_status=1; fi
  if [[ "$NEW_TUI_INSTALLED" == true ]] && ! rm -rf -- "$TUI_PACKAGE_ROOT"; then rollback_status=1; fi
  for name in ${NEW_ALIAS_NAMES[@]+"${NEW_ALIAS_NAMES[@]}"}; do
    if ! rm -f -- "$TUI_PREFIX/bin/$name"; then rollback_status=1; fi
  done
  if [[ "$OLD_APP_MOVED" == true ]]; then
    if has_path "$APP_TARGET" || ! move_directory_no_replace "$BACKUP_ROOT/gui.app" "$APP_TARGET" "saved GUI"; then rollback_status=1; fi
  fi
  if [[ "$OLD_TUI_MOVED" == true ]]; then
    if has_path "$TUI_PACKAGE_ROOT" || ! move_directory_no_replace "$BACKUP_ROOT/tui-package" "$TUI_PACKAGE_ROOT" "saved TUI"; then rollback_status=1; fi
  fi
  for name in ${MOVED_ALIAS_NAMES[@]+"${MOVED_ALIAS_NAMES[@]}"}; do
    if has_path "$TUI_PREFIX/bin/$name" || ! install_alias_no_replace "$BACKUP_ROOT/bin/$name" "$TUI_PREFIX/bin/$name"; then rollback_status=1; fi
  done
  return "$rollback_status"
}

cleanup() {
  local status=$? rollback_status=0
  trap - EXIT
  if [[ "$status" -ne 0 && "$COMMIT_STARTED" == true && "$COMMIT_COMPLETE" == false ]]; then
    rollback || rollback_status=$?
    if [[ "$rollback_status" -ne 0 ]]; then
      echo "install_from_github.sh: rollback failed with status $rollback_status; inspect $BACKUP_ROOT immediately." >&2
      status="$rollback_status"
    fi
  fi
  if [[ -n "$PACKAGE_FILE" && -f "$PACKAGE_FILE" ]] && ! rm -f -- "$PACKAGE_FILE"; then status=1; fi
  if [[ -n "$TUI_STAGING" && -d "$TUI_STAGING" ]] && ! rm -rf -- "$TUI_STAGING"; then status=1; fi
  if [[ -n "$APP_STAGING" && -d "$APP_STAGING" ]] && ! rm -rf -- "$APP_STAGING"; then status=1; fi
  if ! release_install_lock; then
    echo "install_from_github.sh: failed to release install lock $INSTALL_LOCK_DIR" >&2
    status=1
  fi
  exit "$status"
}

main() {
trap cleanup EXIT
[[ "$(uname -s)" == "Darwin" ]] || die "This installer is for macOS. On Windows, run script/install_tui.ps1."
select_supported_node
command -v xcodebuild >/dev/null 2>&1 || die "Xcode 16+ is required."
require_xcode_16
command -v xcodegen >/dev/null 2>&1 || die "XcodeGen is required."
acquire_install_lock || die "Concurrent source installation is not allowed."

cd "$ROOT_DIR"
"$NPM_EXECUTABLE" ci --ignore-scripts
"$NPM_EXECUTABLE" run verify:harness
xcodegen generate
PACKAGE_BASENAME="$("$NPM_EXECUTABLE" pack --ignore-scripts --silent | tail -n 1)"
PACKAGE_FILE="$ROOT_DIR/$PACKAGE_BASENAME"
[[ -f "$PACKAGE_FILE" ]] || die "npm pack did not create a package archive."
"$NODE_EXECUTABLE" "$ROOT_DIR/script/tests/locked_runtime_manifest.mjs" archive "$ROOT_DIR/package-lock.json" "$PACKAGE_FILE"
PACKED_ARCHIVE_SHA256="$(/usr/bin/shasum -a 256 "$PACKAGE_FILE" | /usr/bin/awk '{print $1}')"
[[ "$PACKED_ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "Could not hash the reviewed package archive."

# Nothing under a live install path is touched until both independently staged
# artifacts have passed their bounded checks.
mkdir -p "$TUI_PREFIX" "$APP_PARENT" "$BACKUP_PARENT"
TUI_STAGING="$(mktemp -d "$TUI_PREFIX/.lightningloop-tui-stage.XXXXXX")"
RENAME_EXCL_HELPER="$TUI_STAGING/.lightningloop-rename-excl"
build_rename_excl_helper "$RENAME_EXCL_HELPER"
STAGED_TUI_ROOT="$TUI_STAGING/lib/node_modules/@barnlabs/lightningloop-harness"
mkdir -p "$(dirname "$STAGED_TUI_ROOT")" "$TUI_STAGING/bin"
"$NODE_EXECUTABLE" "$ROOT_DIR/script/tests/locked_runtime_manifest.mjs" extract \
  "$ROOT_DIR/package-lock.json" "$STAGED_TUI_ROOT" "$PACKAGE_FILE"
record_staged_aliases
for alias in "${ALIAS_NAMES[@]}"; do
  ln -s "../lib/node_modules/@barnlabs/lightningloop-harness/dist/cli/index.js" "$TUI_STAGING/bin/$alias"
done
[[ "$(/usr/bin/shasum -a 256 "$PACKAGE_FILE" | /usr/bin/awk '{print $1}')" == "$PACKED_ARCHIVE_SHA256" ]] || die "Package archive changed during extraction."
[[ -f "$STAGED_TUI_ROOT/dist/cli/index.js" ]] || die "Staged TUI package was incomplete."

# The reviewed archive is extracted directly and only deterministic aliases are
# created. Build its production dependency tree with the reviewed repository
# lock, then bind every installed package version and byte tree into a manifest
# that is checked again after the recoverable move.
/bin/cp "$ROOT_DIR/package-lock.json" "$STAGED_TUI_ROOT/package-lock.json"
"$NPM_EXECUTABLE" ci --omit=dev --ignore-scripts --offline --prefix "$STAGED_TUI_ROOT"
"$NODE_EXECUTABLE" "$ROOT_DIR/script/tests/locked_runtime_manifest.mjs" write \
  "$ROOT_DIR/package-lock.json" "$STAGED_TUI_ROOT" "$STAGED_TUI_ROOT/$RUNTIME_MANIFEST_NAME" "$PACKAGE_FILE"
STAGED_RUNTIME_MANIFEST_SHA256="$(/usr/bin/shasum -a 256 "$STAGED_TUI_ROOT/$RUNTIME_MANIFEST_NAME" | /usr/bin/awk '{print $1}')"
[[ "$STAGED_RUNTIME_MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "Could not hash the staged runtime manifest."
"$NODE_EXECUTABLE" "$STAGED_TUI_ROOT/dist/cli/index.js" help >/dev/null
for alias in "${ALIAS_NAMES[@]}"; do
  [[ -x "$TUI_STAGING/bin/$alias" ]] || die "Staged TUI executable $alias was absent."
  "$TUI_STAGING/bin/$alias" help >/dev/null
done

xcodebuild -project "$PROJECT" -scheme "$APP_NAME" -configuration Release -derivedDataPath "$DERIVED_DATA" \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO build
[[ -d "$BUILT_APP" ]] || die "Release build did not produce $BUILT_APP."
APP_STAGING="$(mktemp -d "$APP_PARENT/.lightningloop-app-stage.XXXXXX")"
/usr/bin/ditto "$BUILT_APP" "$APP_STAGING/$APP_NAME.app"
/usr/bin/codesign --force --deep --sign - "$APP_STAGING/$APP_NAME.app"
/usr/bin/codesign --verify --deep --strict "$APP_STAGING/$APP_NAME.app"
ARCHITECTURES="$(/usr/bin/lipo -archs "$APP_STAGING/$APP_NAME.app/Contents/MacOS/$APP_NAME")"
case " $ARCHITECTURES " in *" arm64 "*) ;; *) die "Staged GUI lacks arm64." ;; esac
case " $ARCHITECTURES " in *" x86_64 "*) ;; *) die "Staged GUI lacks x86_64." ;; esac

BACKUP_ROOT="$(mktemp -d "$BACKUP_PARENT/LightningLoop-backup.XXXXXX")"
mkdir -p "$BACKUP_ROOT/bin" "$TUI_PREFIX/bin" "$(dirname "$TUI_PACKAGE_ROOT")"
COMMIT_STARTED=true
stop_app_and_require_empty_baseline
if has_path "$APP_TARGET"; then
  move_directory_no_replace "$APP_TARGET" "$BACKUP_ROOT/gui.app" "existing GUI backup" || die "Could not preserve the existing GUI without replacement."
  OLD_APP_MOVED=true
fi
maybe_fail backup
move_existing_aliases_to_backup || die "Could not preserve the existing TUI aliases without replacement."
if [[ -d "$TUI_PACKAGE_ROOT" ]]; then
  move_directory_no_replace "$TUI_PACKAGE_ROOT" "$BACKUP_ROOT/tui-package" "existing TUI backup" || die "Could not preserve the existing TUI without replacement."
  OLD_TUI_MOVED=true
fi

install_directory_no_replace "$STAGED_TUI_ROOT" "$TUI_PACKAGE_ROOT" "TUI" || die "Recoverable installation stopped before replacing the raced TUI target."
NEW_TUI_INSTALLED=true
for alias in "${ALIAS_NAMES[@]}"; do
  install_alias_no_replace "$TUI_STAGING/bin/$alias" "$TUI_PREFIX/bin/$alias" || die "Recoverable installation stopped before replacing raced alias $alias."
  NEW_ALIAS_NAMES+=("$alias")
  if [[ "${#NEW_ALIAS_NAMES[@]}" -eq 1 ]]; then maybe_fail commit; fi
done
install_directory_no_replace "$APP_STAGING/$APP_NAME.app" "$APP_TARGET" "GUI" || die "Recoverable installation stopped before replacing the raced GUI target."
NEW_APP_INSTALLED=true

INSTALLED_RUNTIME_MANIFEST_SHA256="$(/usr/bin/shasum -a 256 "$TUI_PACKAGE_ROOT/$RUNTIME_MANIFEST_NAME" | /usr/bin/awk '{print $1}')"
[[ "$INSTALLED_RUNTIME_MANIFEST_SHA256" == "$STAGED_RUNTIME_MANIFEST_SHA256" ]] || die "Installed packed-root and dependency manifest changed during commit."
"$NODE_EXECUTABLE" "$ROOT_DIR/script/tests/locked_runtime_manifest.mjs" verify \
  "$ROOT_DIR/package-lock.json" "$TUI_PACKAGE_ROOT" "$TUI_PACKAGE_ROOT/$RUNTIME_MANIFEST_NAME" "$PACKAGE_FILE"
maybe_fail signature
/usr/bin/codesign --verify --deep --strict "$APP_TARGET"
for alias in "${ALIAS_NAMES[@]}"; do "$TUI_PREFIX/bin/$alias" help >/dev/null; done
"$TUI_PREFIX/bin/lightningloop" doctor --runtime-only
# Deliberately no LIGHTNINGLOOP_* environment override: this is the Finder
# launch contract against the installed package and fixed Node locations.
maybe_fail smoke
launch_and_verify_new_app
COMMIT_COMPLETE=true

echo "Installed GUI: $APP_TARGET"
echo "Installed TUI: $TUI_PREFIX/bin/llp (aliases: lloop, lightningloop)"
[[ ":$PATH:" == *":$TUI_PREFIX/bin:"* ]] || echo "Add $TUI_PREFIX/bin to PATH to invoke llp directly."
echo "Rollback snapshot: $BACKUP_ROOT"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
