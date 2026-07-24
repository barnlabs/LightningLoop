# Secure updates

Application code and user-managed harness state are separate update domains. An application update must never replace the managed overlay, runtime credentials/settings, sessions, memory, evolution ledgers, or any underlying runtime state.

## Read-only update check

`lightningloop update check` is a local policy check. It does not fetch a manifest, install an update, alter the managed overlay, or update the underlying runtime. The source build intentionally reports `unconfigured`: this is a safety state, not a missing silent updater.

- `unconfigured` — no signed release channel is pinned. Automatic installation is disabled. Use the explicit source path below when an update is intended.
- `configured-unverified` — a channel and key exist, but no newer signed manifest has been verified for the active platform. Artifact bytes have not been downloaded or verified; installation remains disabled.
- `manifest-verified` — a newer manifest's Ed25519 signature, exact fields, active-platform artifact declaration, origin, declared SHA-256, and declared byte bound verified. This state verifies signed metadata only: the artifact bytes have not been downloaded or hashed, and installation remains disabled until the platform installer independently verifies them.
- `blocked` — signature verification failed or no signing key is pinned. Do not install.

The update policy rejects malformed or unbound manifest fields and manifests without exactly one declaration for the explicitly selected active platform. It applies full prerelease ordering, so `0.3.0` is eligible after `0.3.0-beta.2` while an equal or older release remains blocked.

## Explicit source-build update path

Use this path only from a clean, understood canonical checkout. It is a deliberate local rebuild, not a signed public release or an automatic update.

1. From the checkout root, require a clean `main` branch: `git status --short --branch` must have no changed/untracked paths and name `main`.
2. Bind that checkout—not an unrelated GitHub query—to BarnLabs: `git remote get-url origin` (which returns the fetch URL by default) must be exactly `https://github.com/barnlabs/LightningLoop`, the same URL with `.git`, `git@github.com:barnlabs/LightningLoop.git`, or `ssh://git@github.com/barnlabs/LightningLoop.git`. Stop on an absent, forked, redirected, or otherwise different fetch remote; do not rewrite it in place.
3. Fetch only the named canonical branch: `git fetch --no-tags origin main`, then fast-forward only to that exact fetch: `git merge --ff-only FETCH_HEAD`.
4. Recheck `git status --short --branch`, confirm `git rev-parse HEAD` equals `git rev-parse refs/remotes/origin/main`, and stop if either check fails. Do not build or install from another branch, a detached HEAD, an ahead/diverged checkout, or a dirty tree.
5. On macOS, run `./script/install_from_github.sh`. It independently enforces the checkout root, clean `main`, exact origin fetch URL, and equality with fetched `origin/main` before any package/build step. It requires Finder-launchable Node 22.19+, Xcode 16+, and XcodeGen.
6. On Windows, run `pwsh -File .\script\install_tui.ps1` only after the same Git checks. It requires Node 22.19+ and the supported runtime Bash environment.
7. Keep the reported macOS rollback snapshot until the normal Finder-launch smoke test succeeds. On either platform, stop and investigate any failed lock, provenance, signature, manifest, or smoke check; do not retry against a changed live target.

Before a source installer touches a live target, it stages and verifies the exact packed TUI and—on macOS—the universal GUI. It binds the installed runtime to the package lock and cached archive SRI, preserves the old GUI/TUI/owned aliases inside the transaction boundary, rejects links/recreated targets, and rolls the prior set back after a commit, signature, or smoke failure. The Finder-launch contract is independent of the checkout because the GUI discovers the installed TUI under `~/.local` and only fixed Node locations.

The underlying runtime stays version-pinned and is updated through its package mechanisms only as an explicit operation; LightningLoop never silently performs a global runtime update. The source path does not replace Developer ID signing, notarization, a signed appcast, an Ed25519 release channel, clean-machine evidence, or public-release rollback gates, and it never bypasses Gatekeeper.

## Public-release gates

Installation remains disabled until all of these exist and are independently tested:

- macOS Developer ID signing and notarization;
- a Sparkle 2 HTTPS appcast with archive signatures;
- a pinned Ed25519 public key and signed bounded manifest for cross-platform artifacts;
- SHA-256 and exact byte-size verification before installation;
- platform-specific atomic install/rollback;
- pre-update managed-overlay backup, compatibility check, smoke test, and recovery proof.

Sparkle recommends HTTPS, code signing, archive signing, and modern Sparkle 2 security practices: <https://sparkle-project.org/documentation/security-and-reliability/>. Windows packaging will use a pinned npm/package artifact initially; a future packaged GUI can use Windows App SDK notifications and installer integration after signing is established.
