# LightningLoop runbook

## Purpose and ownership

LightningLoop is a native macOS demonstration of fast iterative model orchestration. BarnLabs owns the repository and release decisions. This is not a production service and has no hosted backend.

## Repository and runtime

- Canonical repository: `barnlabs/LightningLoop` (verified public; default branch `main` on 2026-07-20)
- Required public release target: `barnlabs/LightningLoop`
- Runtime: native macOS 14+ SwiftUI app; macOS/Windows terminal harness on Node >=22.19 and the underlying runtime's Bash requirement
- Source install: `script/install_from_github.sh` installs the macOS GUI at `~/Applications/LightningLoop.app` and the shared TUI package under `~/.local`; `script/install_tui.ps1` verifies, packs, and installs the Windows TUI
- Execution isolation: pinned Anthropic Sandbox Runtime; workspace-only writes and network denied by default
- Model/API: runtime-managed provider/model catalog; Codex, Claude, and Grok sign-in plus API-key providers including Groq, Fireworks, and LightningLoop-managed GeneralCompute
- Credentials: the underlying runtime owns Pi-managed built-in provider authentication; GeneralCompute uses Keychain or `GENERALCOMPUTE_API_KEY`; research uses official environment variables cross-platform or isolated macOS Keychain services
- Local history: `~/Library/Application Support/LightningLoop/sessions.json`
- Local ledgers: `memory.json` and `evolutions.json` in the same directory, written with owner-only permissions

## Build and health check

```bash
./script/build_and_run.sh --verify
./script/run_tui.sh doctor
npm run verify:harness
npm audit
xcodebuild -project LightningLoop.xcodeproj -scheme LightningLoop \
  -derivedDataPath .build/DerivedData CODE_SIGNING_ALLOWED=NO test
xcodebuild -project LightningLoop.xcodeproj -scheme LightningLoopUI \
  -derivedDataPath .build/UIBuild CODE_SIGNING_ALLOWED=NO build-for-testing
```

The app command is healthy when it stops only the prior executable from this checkout's project-local DerivedData, builds, confirms no exact-path process appeared before launch, launches the freshly built `.app` bundle, and verifies the stable exact executable PID against a unique DEBUG launch receipt. It must not terminate or trust a separately installed LightningLoop process that happens to share the name. The doctor must report a compatible Node version plus the active provider/model and credential status without printing any value. Native unit and harness suites must pass, and the isolated UI journey must compile. A live UI-test run is an opt-in workstation check because macOS requires Accessibility/automation approval for Xcode's test runner; never bypass or weaken that control. Its isolated launch uses process-local stores, does not query Keychain credential state, and forces the no-network native test engine.

For a source-installed macOS build, normal Finder launch must discover `~/.local/lib/node_modules/@barnlabs/lightningloop-harness`; no checkout-relative working directory or launch-only environment variable is part of the installed contract. Finder-launchable Node is deliberately limited to `~/.local/node/bin/node`, `/opt/homebrew/bin/node`, or `/usr/local/bin/node` at Node 22.19+. The installer stages and verifies the packed TUI plus universal ad-hoc-signed GUI before moving either live target, preserves the previous app/package/all package aliases in the app-owned `InstallerBackups` directory, and restores both on commit, signature, or normal-launch smoke failure. This is source-build convenience only: it neither bypasses Gatekeeper nor substitutes for Developer ID signing and notarization. Windows CI installs the packed archive into an empty temporary prefix with lifecycle scripts disabled and offline before probing managed paths.

## Repository ownership release gate

Do not push, merge, release, rename, transfer, or change settings without explicit owner authorization for the exact action. Before any authorized publication step, re-verify `barnlabs/LightningLoop`, the current branch/worktree, organization permissions, public visibility, default branch, CI, rulesets, release permissions, and rollback. The local Git remote may still use a redirecting legacy URL; changing it is a separate Git write. If any check fails, stop without deleting or overwriting repository state.

For an end-to-end artifact probe, create a new empty directory and run `lightningloop loop` with `--workspace`, `--approve-artifact-writes`, and—only when generated code execution is intended—`--approve-verification-commands`. A healthy report includes file hashes, successful command exits when enabled, and a passing workspace audit. Never point artifact mode at an existing project or home directory.

## Common incidents

### HTTP 401 or 403

For a Pi-managed named built-in provider, use `lightningloop auth` and the runtime's `/login` flow (or repair that provider's official environment-variable configuration), then retry through the LightningLoop runtime. LightningLoop never reads or replaces runtime credentials. For GeneralCompute, set `GENERALCOMPUTE_API_KEY` or save the key in Settings and use **Discover Models & Test** (not `/login`). For an explicitly selected custom macOS profile, update its LightningLoop-owned credential in Settings and use **Discover Models & Test**; this test does not authorize native loop execution without the shared harness. For Exa, Brave, or Firecrawl, repair only the matching research credential. Never paste any key into source, logs, an issue, or a loop prompt.

### Model output is malformed

The run fails closed and preserves prior history. Retry once. If reproducible, capture the phase and sanitized response shape—not credential-bearing request headers—and add a decoder regression test.

### Reviewer never passes

This is expected fail-closed behavior. The configured per-stage review cap pauses the run and preserves findings. Improve the goal/answers or raise the cap deliberately; do not bypass the reviewer.

### Provider or model behavior changes

Review the provider’s current primary documentation, run credential-free runtime model discovery, and test the affected local request contract. Update presets, provider-specific headers, and parsers together; do not silently redirect a preset endpoint. Cerebras API v2 became the default on 2026-07-21, so LightningLoop no longer sends the transition-only `X-Cerebras-Version-Patch` header; reintroduce a version override only for a future documented migration.

### Managed harness recovery

Run `lightningloop harness status`, then `backup` before a managed change. `restore --slot 0` restores the latest snapshot while preserving a new pre-restore backup. `reset --approve-reset` affects only LightningLoop's skills/MCP manifests/tools/graphs/prompt overlay and never underlying runtime state. Stop on a symlink, special file, size bound, or malformed snapshot.

### Update channel

`lightningloop update check` is local and read-only: it does not fetch, install, alter the managed overlay, or update the underlying runtime. A source build must report `unconfigured` until a real signed release channel exists; do not bypass that state. Its message now points to the only supported source-build path: verify a clean canonical checkout, fast-forward it, then run the platform installer in `docs/UPDATES.md`. Keep the macOS rollback snapshot until its normal Finder-launch smoke test passes. A `configured-unverified`, `manifest-verified`, or `blocked` result is not install permission; signed manifest metadata does not prove downloaded bytes. Stop and preserve the current installation.

### Custom provider is rejected

Custom endpoints must use a credential-free public HTTPS DNS hostname. Literal IPs, localhost, `.local` names, URL credentials, query strings, and fragments are rejected. This is intentional; do not weaken it to accommodate a private endpoint without a new threat model and explicit product decision.

### Sandbox initialization fails

Execution fails closed and the TUI reports that the OS sandbox is unavailable. Keep the session read-only. Re-run the harness tests and verify `/usr/bin/sandbox-exec` exists; do not bypass the sandbox or substitute host-authority shell execution.

### Artifact workspace is rejected

Use a real, dedicated, empty directory. Root, home, links, existing content, traversal, secret-like paths/content, and files not owned by the current run are intentionally rejected. Move wanted existing work elsewhere or start a new directory; do not weaken the collision gate. If verification fails, inspect the bounded report and revise the generated files or command vector rather than claiming Gold.

### MCP integrity mismatch

Do not update the stored hash reflexively. Reopen the named source, review the exact executable and artifact changes, rerun the synthetic sandbox suite, and create a new reviewed manifest version. Floating launchers remain prohibited.

### Memory or evolution ledger is malformed

The shared harness fails closed instead of inserting ambiguous context. Back up the affected owner-only JSON file, inspect it without copying secrets into an issue, and repair it through the native UI/TUI or restore a known-good local copy. Do not disable parsing or activation gates. Rolling an active evolution back in Settings or with `/evolution-rollback UUID` removes it from future prompts.

## Rollback and recovery

There is no server deployment. Roll back code by checking out a known-good tagged release or commit. Managed harness resources have three local rotating snapshots; sessions and other app history do not yet have cloud recovery. Deleting the app does not necessarily delete runtime credentials, Keychain data, or Application Support history.

## Cost and limits

Every review and repair is a separate API call. The cap of 1–8 rounds per plan and implementation stage prevents unbounded retries. The UI reports token count and model time. It does not invent cost when a provider does not return a trustworthy price signal; provider pricing and limits can change.
