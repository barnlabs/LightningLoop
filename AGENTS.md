# AGENTS.md

LightningLoop is a native macOS SwiftUI app **and** a cross-platform Node/TypeScript
terminal harness (`@barnlabs/lightningloop-harness`, the `lightningloop`/`lloop`/`llp`
CLI + TUI). See [README.md](README.md), [RUNBOOK.md](RUNBOOK.md), and
[CONTRIBUTING.md](CONTRIBUTING.md) for the authoritative developer commands.

## Cursor Cloud specific instructions

This VM is Linux. Only the **Node harness (CLI/TUI)** builds and runs here. The
SwiftUI GUI and every `xcodebuild` step in `RUNBOOK.md`/`README.md` require macOS
Xcode and cannot run on this VM — skip them.

### Node version (important gotcha)

- The repo requires Node `>=22.19.0` (`package.json` `engines`; `doctor` enforces it).
- The default `node` on `PATH` is `/exec-daemon/node` (**v22.14.0**), which is too
  old. `npm` does not block it (no `engine-strict`), but the harness expects a
  satisfying Node.
- Use nvm's **v22.22.2** instead. Interactive shells are already wired to pick it up
  (a one-time block was appended to `~/.bashrc`), so `node --version` should report
  `v22.22.2`. If you land in a shell that still shows 22.14.0, run
  `nvm use 22.22.2` or prepend `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- `nvm use` alone does **not** reliably beat `/exec-daemon` in `PATH` here; prefer the
  explicit prepend above when in doubt. The startup update script already installs
  deps with the correct Node.

### Dependencies

- Install/refresh with `npm ci --ignore-scripts` (repository policy; `.npmrc` sets
  `ignore-scripts=true`, `save-exact=true`, `audit=true`). Lifecycle scripts are
  intentionally disabled. The startup update script runs this for you.

### Tests / lint / build (what actually works on Linux)

- Typecheck: `npm run check:harness`
- **Tests: `npm run test:portable`** — the cross-platform subset (55 tests, fully
  green on Linux). Use this as the Linux automated gate.
- Full `npm run test:harness` / `npm run verify:harness` are **macOS-oriented**: on
  Linux ~16 tests fail *by design*. The autonomous artifact-verification path
  fail-closes off macOS (`Harness/sandbox/sandboxed-bash.ts` requires
  `/usr/bin/sandbox-exec` / Seatbelt for "deterministic descendant containment").
  This is a security boundary — do **not** edit code to make them pass. CI runs the
  full suite on `macos-15` (`.github/workflows/ci.yml`).
- Optional: `sudo apt-get install -y bubblewrap socat` lets the Anthropic
  sandbox-runtime initialize on Linux, which fixes ~5 basic sandbox tests; the
  remaining Seatbelt fork-denial tests still need macOS.
- Build: `npm run build:harness` (emits `dist/`). Audit: `npm audit`.

### Running the app (CLI)

- Build then run: `node dist/cli/index.js <command>` (or `./script/run_tui.sh <args>`).
- First run is credential-free: `provider list`, then `provider select <preset>`,
  then `doctor`. Provider selection persists `provider.json` under the data dir; set
  `LIGHTNINGLOOP_DATA_DIR` to isolate state.
- Launching the interactive TUI or running a full `loop` requires a real provider
  **inference API key** (managed via the runtime `/login` or `GENERALCOMPUTE_API_KEY`).
  Not needed for environment validation.
