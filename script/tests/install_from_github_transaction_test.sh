#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
# shellcheck source=../install_from_github.sh
source "$ROOT_DIR/script/install_from_github.sh"

rename_helper_root="$(mktemp -d "${TMPDIR:-/tmp}/lightningloop-rename-helper.XXXXXX")"
trap 'rm -rf -- "$rename_helper_root"' EXIT
RENAME_EXCL_HELPER="$rename_helper_root/rename-excl"
build_rename_excl_helper "$RENAME_EXCL_HELPER"

# Never signal a real LightningLoop process from this isolated filesystem test.
# shellcheck disable=SC2329
pgrep() { return 1; }
# shellcheck disable=SC2329
pkill() { return 1; }
# shellcheck disable=SC2329
list_app_pids() { return 1; }
# shellcheck disable=SC2329
stop_app_processes() { return 1; }

manifest() {
  local root="$1" path relative target
  while IFS= read -r path; do
    relative="${path#"$root"/}"
    if [[ -L "$path" ]]; then
      target="$(readlink "$path")"
      printf 'l %s %s\n' "$relative" "$target"
    elif [[ -f "$path" ]]; then
      printf 'f %s %s\n' "$relative" "$(shasum -a 256 "$path" | awk '{print $1}')"
    fi
  done < <(find "$root" \( -type f -o -type l \) -print | LC_ALL=C sort)
}

write_file() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" > "$1"
}

# Values assigned here are consumed by functions in the sourced installer.
# shellcheck disable=SC2034
prepare_case() {
  local case_root="$1" name
  TUI_PREFIX="$case_root/live"
  TUI_PACKAGE_ROOT="$TUI_PREFIX/lib/node_modules/@barnlabs/lightningloop-harness"
  APP_TARGET="$case_root/live/Applications/LightningLoop.app"
  BACKUP_ROOT="$case_root/backup"
  mkdir -p "$BACKUP_ROOT/bin" "$TUI_PREFIX/bin"
  write_file "$APP_TARGET/Contents/old-gui.txt" "old gui"
  write_file "$TUI_PACKAGE_ROOT/old-tui.txt" "old tui"
  for name in lightningloop lloop llp; do write_file "$TUI_PREFIX/bin/$name" "old $name"; done
  write_file "$TUI_PREFIX/bin/unrelated-tool" "unrelated"
  ALIAS_NAMES=(lightningloop lloop llp)
  MOVED_ALIAS_NAMES=()
  NEW_ALIAS_NAMES=()
  OLD_APP_MOVED=false
  OLD_TUI_MOVED=false
  NEW_APP_INSTALLED=false
  NEW_TUI_INSTALLED=false
}

# shellcheck disable=SC2034
move_all_old_to_backup() {
  local name
  mv "$APP_TARGET" "$BACKUP_ROOT/gui.app"
  OLD_APP_MOVED=true
  mv "$TUI_PACKAGE_ROOT" "$BACKUP_ROOT/tui-package"
  OLD_TUI_MOVED=true
  for name in "${ALIAS_NAMES[@]}"; do
    mv "$TUI_PREFIX/bin/$name" "$BACKUP_ROOT/bin/$name"
    MOVED_ALIAS_NAMES+=("$name")
  done
}

# shellcheck disable=SC2034
install_new_tui_and_aliases() {
  local name
  write_file "$TUI_PACKAGE_ROOT/new-tui.txt" "new tui"
  NEW_TUI_INSTALLED=true
  for name in "${ALIAS_NAMES[@]}"; do
    write_file "$TUI_PREFIX/bin/$name" "new $name"
    NEW_ALIAS_NAMES+=("$name")
  done
}

# shellcheck disable=SC2034
install_new_app() {
  write_file "$APP_TARGET/Contents/new-gui.txt" "new gui"
  NEW_APP_INSTALLED=true
}

# shellcheck disable=SC2034
run_case() {
  local point="$1" case_root baseline after
  case_root="$(mktemp -d "${TMPDIR:-/tmp}/lightningloop-mac-rollback-${point}.XXXXXX")"
  prepare_case "$case_root"
  baseline="$(manifest "$case_root/live")"

  case "$point" in
    backup)
      mv "$APP_TARGET" "$BACKUP_ROOT/gui.app"
      OLD_APP_MOVED=true
      ;;
    commit)
      move_all_old_to_backup
      write_file "$TUI_PACKAGE_ROOT/new-tui.txt" "new tui"
      NEW_TUI_INSTALLED=true
      write_file "$TUI_PREFIX/bin/lightningloop" "new lightningloop"
      NEW_ALIAS_NAMES=(lightningloop)
      ;;
    signature|smoke)
      move_all_old_to_backup
      install_new_tui_and_aliases
      install_new_app
      ;;
    *) return 2 ;;
  esac

  TEST_FAIL_AT="$point"
  if maybe_fail "$point"; then
    echo "Expected synthetic $point failure." >&2
    return 1
  fi
  rollback
  after="$(manifest "$case_root/live")"
  [[ "$after" == "$baseline" ]] || {
    diff -u <(printf '%s\n' "$baseline") <(printf '%s\n' "$after") >&2 || true
    echo "$point rollback did not restore the complete GUI/TUI/alias state." >&2
    return 1
  }
  rm -rf -- "$case_root"
  echo "PASS: $point failure restored the complete prior GUI/TUI/llp/lloop state."
}

for point in backup commit signature smoke; do run_case "$point"; done

# A missing backup is an unrecoverable mixed-state condition. rollback must
# report nonzero instead of letting a later successful operation mask it.
failure_root="$(mktemp -d "${TMPDIR:-/tmp}/lightningloop-mac-rollback-error.XXXXXX")"
prepare_case "$failure_root"
mv "$APP_TARGET" "$BACKUP_ROOT/gui.app"
# shellcheck disable=SC2034
OLD_APP_MOVED=true
mv "$BACKUP_ROOT/gui.app" "$BACKUP_ROOT/gui.app.unavailable"
if rollback 2>/dev/null; then
  echo "rollback unexpectedly reported success with a missing GUI backup." >&2
  exit 1
fi
rm -rf -- "$failure_root"
echo "PASS: rollback propagates restoration failure as nonzero."

stop_failure_root="$(mktemp -d "${TMPDIR:-/tmp}/lightningloop-mac-stop-error.XXXXXX")"
prepare_case "$stop_failure_root"
# shellcheck disable=SC2329
pgrep() { return 0; }
# shellcheck disable=SC2329
pkill() { return 1; }
# shellcheck disable=SC2329
list_app_pids() { printf '999\n'; }
# shellcheck disable=SC2329
stop_app_processes() { return 1; }
if rollback 2>/dev/null; then
  echo "rollback unexpectedly reported success when the installed app could not be stopped." >&2
  exit 1
fi
rm -rf -- "$stop_failure_root"
echo "PASS: rollback propagates app-stop failure as nonzero."

lock_root="$(mktemp -d "${TMPDIR:-/tmp}/lightningloop-mac-install-lock.XXXXXX")"
INSTALL_LOCK_DIR="$lock_root/install.lock"
INSTALL_LOCK_HELD=false
acquire_install_lock
[[ -f "$INSTALL_LOCK_DIR/owner-pid" ]] || { echo "install lock owner record missing" >&2; exit 1; }
# shellcheck disable=SC2034
if (INSTALL_LOCK_HELD=false; acquire_install_lock) 2>/dev/null; then
  echo "concurrent install unexpectedly acquired the existing lock." >&2
  exit 1
fi
[[ -d "$INSTALL_LOCK_DIR" ]] || { echo "failed contender removed the active install lock" >&2; exit 1; }
# shellcheck disable=SC2329
list_app_pids() { return 1; }
rollback
[[ -d "$INSTALL_LOCK_DIR" ]] || { echo "rollback released the install lock before cleanup" >&2; exit 1; }
release_install_lock
[[ ! -e "$INSTALL_LOCK_DIR" ]] || { echo "install lock was not released" >&2; exit 1; }
rm -rf -- "$lock_root"
echo "PASS: exclusive install lock rejects a contender and remains held through rollback."

target_root="$(mktemp -d "${TMPDIR:-/tmp}/lightningloop-recreated-target.XXXXXX")"
write_file "$target_root/recreated" "attacker bytes"
if require_absent_live_target "$target_root/recreated" "fixture" 2>/dev/null; then
  echo "recreated live target was not rejected." >&2
  exit 1
fi
rm -rf -- "$target_root"
echo "PASS: recreated live targets fail closed before replacement."

race_root="$(mktemp -d "${TMPDIR:-/tmp}/lightningloop-no-replace-race.XXXXXX")"
write_file "$race_root/staged-directory/payload" "reviewed payload"
require_absent_live_target "$race_root/live-directory" "race fixture"
write_file "$race_root/live-directory/attacker" "raced destination"
if install_directory_no_replace "$race_root/staged-directory" "$race_root/live-directory" "race fixture" 2>/dev/null; then
  echo "atomic directory rename accepted a destination recreated after the absence check." >&2
  exit 1
fi
[[ "$(cat "$race_root/live-directory/attacker")" == "raced destination" && ! -e "$race_root/live-directory/staged-directory" ]] || exit 1

write_file "$race_root/staged-alias" "reviewed shim"
require_absent_live_target "$race_root/live-alias" "alias race fixture"
write_file "$race_root/live-alias" "raced shim"
if install_alias_no_replace "$race_root/staged-alias" "$race_root/live-alias" 2>/dev/null; then
  echo "alias claim replaced a destination recreated after the absence check." >&2
  exit 1
fi
[[ "$(cat "$race_root/live-alias")" == "raced shim" ]] || exit 1
rm -rf -- "$race_root"
echo "PASS: atomic directory and exclusive alias commits reject after-check recreation without nesting."

symlink_root="$(mktemp -d "${TMPDIR:-/tmp}/lightningloop-symlink-source.XXXXXX")"
mkdir -p "$symlink_root/real" "$symlink_root/backup"
ln -s real "$symlink_root/live"
if move_directory_no_replace "$symlink_root/live" "$symlink_root/backup/saved" "symlink fixture" 2>/dev/null; then
  echo "directory commit accepted a linked live source." >&2
  exit 1
fi
[[ -L "$symlink_root/live" && ! -e "$symlink_root/backup/saved" ]] || exit 1
rm -rf -- "$symlink_root"
echo "PASS: linked live directory is rejected before atomic rename and remains untouched."

# Process-boundary fixtures exercise the same wrapper-driven baseline and
# launch checks without opening or signaling a real application.
# shellcheck disable=SC2329
list_app_pids() { printf '111\n'; }
# shellcheck disable=SC2329
stop_app_processes() { return 0; }
# shellcheck disable=SC2329
installer_pause() { return 0; }
if stop_app_and_require_empty_baseline 2>/dev/null; then
  echo "persistent old process incorrectly satisfied the no-process baseline." >&2
  exit 1
fi
echo "PASS: a persistent old exact app process blocks the replacement baseline."

APP_TARGET="/tmp/lightningloop-process-fixture/LightningLoop.app"
APP_LAUNCHED_PID=""
# shellcheck disable=SC2329
open_installed_app() { return 0; }
# shellcheck disable=SC2329
list_app_pids() { printf '456\n'; }
# shellcheck disable=SC2329
app_command_for_pid() { printf '%s\n' "$APP_TARGET/Contents/MacOS/$APP_NAME"; }
# shellcheck disable=SC2329
app_pid_alive() { [[ "$1" == "456" ]]; }
launch_and_verify_new_app
[[ "$APP_LAUNCHED_PID" == "456" ]] || { echo "new app PID was not recorded" >&2; exit 1; }
echo "PASS: launch proof binds one stable new PID to the installed executable."
