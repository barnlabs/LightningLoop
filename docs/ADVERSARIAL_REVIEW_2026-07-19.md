# Foundation adversarial review — 2026-07-19

Scope: Pi authentication boundary, cross-platform paths, graph runtime, research, artifact linting, managed overlay/backups, notifications, update verification, native GUI integration, docs, and shipped skill. The Codex Security plugin was required by the project-wide adapter but unavailable in this task, so this is a manual code/test review and must not be described as a full independent security assessment.

## Resolved findings

### Arbitrary `llms.txt` host could become a network fetch primitive

- Severity: high
- Confidence: high
- Component: `SearchClient.documentationContext`
- Preconditions: an enabled research provider returns an attacker-controlled public hostname and the reviewer produces a documentation-shaped query.
- Impact: a DNS-rebinding or malicious result could steer an autonomous fetch toward an unintended target.
- Evidence: initial implementation validated URL syntax/public hostname but did not pin resolution.
- Fix: retrieval is now off by default and requires an exact hostname in `LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST`; HTTPS, no credentials, no redirects, bounded type/size/time, and untrusted labeling remain enforced.
- Verification: harness typecheck/test suite plus direct diff review.
- Remaining risk: allowlisted domains can serve malicious context; the content remains untrusted and cannot grant capabilities.

### Provider authentication was duplicated through macOS Keychain

- Severity: medium
- Confidence: high
- Component: Pi adapter and TUI provider registration.
- Impact: Windows incompatibility and drift from official refresh/login behavior.
- Fix: built-in providers now use Pi provider IDs and Pi `/login`; macOS Keychain remains only a compatibility fallback and custom-provider path.
- Verification: catalog inspection, typecheck, tests, CLI help, and native build.
- Remaining risk: the compatibility bridge should be removed only after a documented migration release.

### User-managed resources could be overwritten by a future app updater

- Severity: high
- Confidence: high
- Component: update/governance design.
- Fix: platform data overlay is separate from application and Pi state; three rotating snapshots, hashes, symlink/special-file/size bounds, backup-before-restore/reset, and fail-closed unsigned channel.
- Verification: backup/restore/symlink/reset tests and live temporary-root CLI probes.
- Remaining risk: no real release installer, key, appcast, or rollback has been exercised; automatic installation therefore remains disabled.

### Agent-selected lint could mutate artifacts

- Severity: medium
- Confidence: high
- Component: Evidence Lab command validation.
- Fix: `--fix`, `--write`, `--write-mode`, `--in-place`, and `-w` are rejected in autonomous verification.
- Verification: dedicated regression test.
- Remaining risk: a nominally read-only executable could have surprising behavior; the executable allowlist, empty run-owned workspace, sandbox, network denial, and post-run audit remain required.

## Open limitations

1. Windows TUI code paths are implemented and a committed `windows-2025` CI job is designed to cover lock-integrity verification, portable contracts, packed installation, and CLI/path/backup/update probes, but it has not yet run on a hosted runner because this work was not pushed. Git for Windows/Bash setup, interactive terminal rendering, notification BEL/hook, and the packed package path still need hosted-run proof before release.
2. Signed auto-install is intentionally not implemented. Developer ID/notarization, Sparkle feed/archive signing, Ed25519 release identity, Windows package publication, atomic installer, rollback, and external smoke tests remain release gates.
3. Native macOS OAuth-provider readiness is checked by Pi when a run begins; the GUI does not inspect or display token values. A missing login produces a bounded actionable error.
4. Notification hooks are user-configured executables and therefore code execution by user choice. They use no shell, scrub common credential environment variables, have bounded input/argv/output/time, and never alter loop approval state.
5. This historical review predated verification of the canonical `barnlabs/LightningLoop` repository. No remote was changed. Current organization permissions, visibility, CI, links, rulesets, release permissions, and rollback must still be verified before publication.

## Fresh proof

- `npm run test:harness`: 77/77 passed.
- `npm run test:portable`: 16/16 passed locally; the committed Windows packed-install and rollback workflow remains pending its first hosted CI run.
- `xcodebuild test ...`: 23/23 passed.
- Universal Release build: succeeded; binary contains `arm64` and `x86_64`.
- `npm audit --omit=dev`: zero vulnerabilities.
- Skill validator: `maintain-lightningloop` valid.
- Temporary-root `harness status`, `harness backup`, and `update check`: passed; update state `unconfigured`; Pi state unchanged.
