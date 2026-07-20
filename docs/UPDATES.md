# Secure updates

Application code and user-managed harness state are separate update domains. An application update must never replace the managed overlay, Pi credentials/settings, sessions, memory, or evolution ledgers.

The current source build intentionally reports `unconfigured` from `lightningloop update check`. This is a safety state, not a missing silent updater. Installation remains disabled until all of these exist and are independently tested:

- macOS Developer ID signing and notarization;
- a Sparkle 2 HTTPS appcast with archive signatures;
- a pinned Ed25519 public key and signed bounded manifest for cross-platform artifacts;
- SHA-256 and exact byte-size verification before installation;
- platform-specific atomic install/rollback;
- pre-update managed-overlay backup, compatibility check, smoke test, and recovery proof.

`Harness/update/update-policy.ts` validates the fail-closed policy and Ed25519 manifest. Pi stays version-pinned and is updated through Pi's package mechanisms only as an explicit operation; LightningLoop never silently calls global `pi update`.

The supported pre-release update path is source-controlled and explicit: fast-forward a clean canonical checkout, rerun `script/install_from_github.sh` on macOS or `script/install_tui.ps1` on Windows, and keep the previous macOS app backup until the installed smoke test is green. Before it touches a live target, the macOS installer stages and verifies the exact packed TUI and universal GUI, then backs up the prior GUI, TUI package, and package aliases. Any commit, signature, or normal Finder-launch smoke failure restores the prior set. The Finder-launch contract is independent of the checkout because the GUI discovers the installed TUI under `~/.local` and only fixed Node locations. This does not replace the signed manifest, Developer ID, notarization, clean-machine, or rollback gates for a public release, and it never bypasses Gatekeeper.

Sparkle recommends HTTPS, code signing, archive signing, and modern Sparkle 2 security practices: <https://sparkle-project.org/documentation/security-and-reliability/>. Windows packaging will use a pinned npm/package artifact initially; a future packaged GUI can use Windows App SDK notifications and installer integration after signing is established.
