# LightningLoop product-finish review packet — 2026-07-21 (amended 2026-07-23)

## Disposition and scope

This is the final local packet for the LightningLoop product refresh plus 2026-07-23 session-title and provider-model UX completion. Local deterministic gates are re-proven in this delivery pass. On 2026-07-23 the repository owner (Donovan) authorized finish delivery: create `contrib/lightningloop-product-finish`, stage only the safe manifest, commit, push to `barnlabs/LightningLoop`, and open a **draft** PR to `main`. Still forbidden without separate explicit approval: merge, tag, signing, notarization, release, visibility/settings mutation, or force-push.

The packet covers:

1. credential-free runtime-catalog model selection with a guarded Cerebras Gemma 4 31B preference;
2. LightningLoop-first/BarnLabs-supported product branding and contribution surfaces;
3. explicit setup, loading, paused, failed, model, and unconfigured-update states;
4. safe copyable setup/provider-access/maintenance/diagnosis handoffs;
5. strict local update policy and canonical-source transaction rollback;
6. current built-binary deterministic UI evidence with an explicit live-accessibility limitation;
7. reviewer-requested same-run reservation and query-free update-URL hardening;
8. multi-layer session auto-titles (provisional / structured / optional custom-only LLM / manual lock);
9. honest runtime-catalog vs custom `/models` discovery UX and documentation.

The owner-local untracked `AGENTS.md` is excluded. It is not part of this packet and must not be staged.

## Frozen repository identity

- Checkout: `/Users/baney/Documents/Loop`
- Pre-delivery branch: `codex/lightningloop` (do not push this branch as the delivery head)
- Base `HEAD` before delivery commit: `8d208e55cd40af046ba5052c326e67a2c3f25261`
- Canonical target: public `barnlabs/LightningLoop`, default branch `main`
- Delivery branch (authorized): `contrib/lightningloop-product-finish`
- Safe-stage path count: see exact manifest (original product-finish set plus title/model UX paths)
- `AGENTS.md` remains excluded

## Exact safe-stage manifest

The following paths are the complete proposed stage set (product-finish packet plus 2026-07-23 title/model UX). Reviewers must compare this block to fresh `git diff --name-only` plus `git ls-files --others --exclude-standard` and reject any difference other than intentional exclusion of `AGENTS.md`.

```text
.codex/environments/environment.toml
.github/CODEOWNERS
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/feature_request.yml
.github/pull_request_template.md
.grok/workflows/finish-lightningloop.rhai
CONTRIBUTING.md
DESIGN.md
Harness/cli/index.test.ts
Harness/cli/index.ts
Harness/core/pi-options.test.ts
Harness/core/pi-options.ts
Harness/core/provider-profile.test.ts
Harness/core/provider-profile.ts
Harness/pi/lightningloop-extension.test.ts
Harness/pi/lightningloop-extension.ts
Harness/pi/model-adapter.test.ts
Harness/pi/model-adapter.ts
Harness/rpc/server.test.ts
Harness/rpc/server.ts
Harness/update/update-policy.test.ts
Harness/update/update-policy.ts
LightningLoop.xcodeproj/project.pbxproj
LightningLoop/App/LightningLoopApp.swift
LightningLoop/Models/LoopModels.swift
LightningLoop/Models/ProviderConfiguration.swift
LightningLoop/Resources/Assets.xcassets/AccentColor.colorset/Contents.json
LightningLoop/Resources/Assets.xcassets/SignalGold.colorset/Contents.json
LightningLoop/Services/HarnessProcessClient.swift
LightningLoop/Services/KeychainStore.swift
LightningLoop/Services/LoopEngine.swift
LightningLoop/Services/LoopPrompts.swift
LightningLoop/Services/ProviderClient.swift
LightningLoop/Stores/AppModel.swift
LightningLoop/Support/AgentHandoffPrompts.swift
LightningLoop/Support/Brand.swift
LightningLoop/Support/SessionTitle.swift
LightningLoop/Views/GoalComposerView.swift
LightningLoop/Views/LoopWorkspaceView.swift
LightningLoop/Views/SessionDetailView.swift
LightningLoop/Views/SettingsView.swift
LightningLoop/Views/SidebarView.swift
LightningLoopTests/AgentHandoffPromptsTests.swift
LightningLoopTests/ArtifactOpenBoundaryTests.swift
LightningLoopTests/HarnessProcessClientTests.swift
LightningLoopTests/KeychainStoreTests.swift
LightningLoopTests/MemoryEvolutionTests.swift
LightningLoopTests/ProviderClientTests.swift
LightningLoopTests/ProviderConfigurationTests.swift
LightningLoopTests/SessionTitleTests.swift
LightningLoopUITests/LightningLoopUITests.swift
PRODUCTION_READINESS_CHECKLIST.md
README.md
RUNBOOK.md
docs/AGENT_SETUP_AND_MAINTENANCE.md
docs/BRAND.md
docs/GITHUB_REVIEW_2026-07-20.md
docs/MODEL_SELECTION.md
docs/PRODUCT_SURFACE_BRANDING.md
docs/REVIEW_PACKET_2026-07-20_PRODUCT_REFRESH.md
docs/REVIEW_PACKET_2026-07-21_FINISH.md
docs/SESSION_TITLES.md
docs/UI_EVIDENCE_2026-07-21.md
docs/UPDATES.md
docs/UPDATE_UX_OPTIMIZATION.md
docs/research/auto-title-and-provider-models-2026-07-23.md
docs/research/cerebras-provider-2026-07-20.md
docs/screenshots/lightningloop-current-blocked-history.png
docs/screenshots/lightningloop-current-new-loop.png
docs/screenshots/lightningloop-current-settings-model.png
docs/screenshots/lightningloop-current-settings-update.png
docs/screenshots/lightningloop-current-working.png
script/build_and_run.sh
script/install_from_github.sh
script/tests/install_from_github_transaction_test.sh
```

`AGENTS.md` is deliberately absent. Build logs, `.build/`, temporary homes, receipt files, and test results are also absent.

## Required behavior and failure boundaries

### Runtime model and credential ownership

- Built-in model choices come only from the installed runtime's credential-free, network-disabled catalog.
- The selected provider/model, image capability, context window, and output limit are snapshotted and revalidated before use. Missing, malformed, duplicate, stale, or drifted catalog entries fail closed.
- Gemma 4 31B remains a public-preview preference, not an entitlement, availability, or production-stability claim.
- Catalog presence does not prove provider sign-in. Built-in authentication remains owned by the official runtime/provider flow; LightningLoop does not read or copy it.
- The copyable provider handoff expressly denies reading, exporting, entering, testing, or relaying credentials and leaves passwords, passkeys, OTPs, CAPTCHAs, and account approvals to the user.

### Same-run RPC exclusivity

- Create and continue reserve a run ID synchronously, before provider-profile selection or any other awaited work. A second same-run request receives `run_conflict` without invoking the agent factory.
- The reservation is released in `finally`, and any created or recovered run state is made inactive first, so profile, validation, agent, or response failures cannot strand the ID as active.
- Concurrent `Promise.all` tests cover create and stateless continue independently; each proves exactly one factory invocation, one successful response, and one `run_conflict` error.

### Cerebras API version cutover

The official [Cerebras API versions page](https://inference-docs.cerebras.ai/api-reference/versions), retrieved 2026-07-21, says API version 2 becomes the default on July 21, older versions reach end of life, and the transition header is no longer needed when v2 takes effect. It also says all requests use v2 *after* July 21. The runtime and native dead path therefore no longer send `X-Cerebras-Version-Patch: 2`, and the focused TypeScript test expects an empty provider-header map.

No credentialed provider request was made. The repository does not claim independent evidence about provider-side rollout propagation during the July 21 boundary. Local tests prove LightningLoop's request and fail-closed contracts, not Cerebras account access or live behavior.

### Launch identity

`script/build_and_run.sh --verify` stops only an existing process whose command matches this checkout's project-local built executable. After building it rejects any exact-path process that appeared before launch. The DEBUG app receives a unique UUID plus a temporary receipt path through `open`; verification accepts only the stable exact executable PID that writes the matching token and PID. The final run accepted newly receipted PID `30506`. The receipt route is compiled out of Release.

### Session titles (2026-07-23)

- Provisional titles use offline heuristics (noise strip, word/length caps). Structured titles prefer plan/criterion titles when present.
- Optional LLM titles run only for custom OpenAI-compatible profiles with a Keychain credential and an explicit Settings toggle; failures never block Gold or pause.
- Manual rename sets `titleLocked`; auto-title updates stop until unlock.
- Titles are cosmetic; they are not Gold evidence.

### Provider model loading honesty (2026-07-23)

- Built-in pickers still use the credential-free installed runtime catalog (`allowModelNetwork: false`); Settings copy states catalogued ≠ entitlement / live account inventory.
- Custom discovery remains user-triggered `GET /models` with account-visible IDs only; context/vision stay user-set.
- Stale catalog response rejection and create/continue revalidation remain fail-closed.

### Update and delivery

- `lightningloop update check` is local and read-only. The final status is `unconfigured`; automatic installation is off and no signed feed/key exists.
- Configured channel URLs and signed artifact URLs must be credential-free HTTPS URLs without fragments or query strings. Focused tests reject query-bearing examples for both URL classes.
- Signed-manifest validation is not install authority and does not prove downloaded bytes, platform signing, rollback, or a public release.
- Canonical-source install fixtures bind a clean `main` checkout to fetched `barnlabs/LightningLoop` origin/main and preserve complete prior GUI/TUI/alias byte state on injected failures.
- Delivery authorized 2026-07-23 for draft PR only; signing/notarize/public release rows remain MISSING.

## Final verification record

| Gate | Final result |
|---|---|
| `xcodegen generate` | PASS; project regenerated |
| `xcodebuild -project LightningLoop.xcodeproj -scheme LightningLoop -derivedDataPath .build/NativeTests CODE_SIGNING_ALLOWED=NO test` | PASS; **80** tests, 0 failures, `TEST SUCCEEDED` (includes 7 `SessionTitleTests`; re-run 2026-07-23 delivery) |
| `xcodebuild -project LightningLoop.xcodeproj -scheme LightningLoopUI -derivedDataPath .build/UIBuild CODE_SIGNING_ALLOWED=NO build-for-testing` | PASS; `TEST BUILD SUCCEEDED` (prior packet; UI journey compile not re-claimed as live a11y) |
| `npm run build:harness && node --test dist/rpc/server.test.js dist/update/update-policy.test.js` | PASS; 24 tests, 24 pass, 0 fail, including both same-run concurrency probes and both query-bearing URL rejections |
| `npm run verify:harness` | PASS; **207** tests, 207 pass, 0 fail (re-run 2026-07-23 delivery) |
| `npm run verify:lock-integrity` | PASS; 166 package entries verified |
| `npm audit --audit-level=low` and the `npm ci` inside build/run | PASS; 0 vulnerabilities |
| `bash script/tests/install_from_github_transaction_test.sh` | PASS; canonical source, backup/commit/signature/smoke rollback, lock, race/link, process-baseline, and new-PID launch fixtures |
| `node script/tests/locked_runtime_dirty_cache_test.mjs` | PASS; poisoned cache rejected through lockfile integrity |
| universal Release `xcodebuild` with `ARCHS='arm64 x86_64'` | PASS; Mach-O `x86_64 arm64` |
| Release `strings` scan | PASS; DEBUG fixture/capture/receipt identifiers absent |
| `./script/build_and_run.sh --verify` | PASS; newly receipted stable exact-path PID `30506` |
| `node dist/cli/index.js harness status` | PASS; `0 files / 0 bytes`, three empty backup slots, provider runtime auth/settings changed `NO` |
| `node dist/cli/index.js update check` | PASS; `unconfigured`, automatic installation disabled, runtime pin `0.80.10`, overlay changed `NO` |
| `shellcheck` on the changed build/install/transaction scripts | PASS; no findings |
| `git diff --check` | PASS |
| Exact safe-stage path count | **75** paths in the amended manifest (not the pre-title 68) |
| Gitleaks over exact 75 safe-stage paths | PASS; 75 files / ~888 KB scanned; **0 findings** (2026-07-23 delivery; prior 68-file result superseded) |

The full command logs are local under `.build/final-*.log` and are intentionally excluded from staging.

Reviewer-repair source binding (SHA-256):

- `Harness/rpc/server.ts`: `408c1e031ba064d1860fadc91ecdc3db34894aabc42cd27ed621f2e37224d1f2`
- `Harness/rpc/server.test.ts`: `176f8dee1378f65b80b76e135f3e1c86e9f0f62b8e2f6090493b03d6589b5876`
- `Harness/update/update-policy.ts`: `6fad2acc76aa03f90a1c20704515aba747f675ba3c86493df18e172d9aab1d3d`
- `Harness/update/update-policy.test.ts`: `a2329f0f64903fce71593fd82816ff87ee8e5fc5bae5c7977b4f37b5a5b43b24`

## Current UI evidence and limitation

All five files are deterministic fixtures rendered by the real production views from the final Debug app. They are not live runtime, provider, entitlement, interaction, keyboard, focus, or accessibility captures. Fixture state uses process-local archives/provider/ledger/attachments and a credential reader that always returns `nil`; it cannot inherit user sessions or read Keychain.

Binary binding:

- Debug executable stub SHA-256: `93a28b4b1d5f1f4dae59b26985eafdc9b3a10f38824c549c6f5c7b5bcd729353`
- Debug implementation dylib SHA-256: `8c4836eb16cb31045b3d3332b247b5f71cb4dbc94bb95c21ef05af62f20607e6`

| Screenshot | Pixels | Captured (America/New_York) | SHA-256 |
|---|---:|---:|---|
| `lightningloop-current-new-loop.png` | 2440 × 1640 | 2026-07-21 16:55:29 | `577e46c12f1d0c0f63618a4c745dcc178471d3708fdc4980da08f9b450703232` |
| `lightningloop-current-working.png` | 2440 × 1640 | 2026-07-21 16:55:31 | `729ec19890b320aedb6514d65fbd598add60c824e3bdae46e43685cf7d31573d` |
| `lightningloop-current-blocked-history.png` | 2440 × 1640 | 2026-07-21 16:55:32 | `14dde4b1fb581b75576876e724cc09803ef0f9c43cc3a4edceb23224a2b2b359` |
| `lightningloop-current-settings-model.png` | 1400 × 1380 | 2026-07-21 16:55:34 | `4efc70fa06f1ed8e4c96570057f6f300af0072e00b251fd190fcd055bb402f8a` |
| `lightningloop-current-settings-update.png` | 1400 × 1380 | 2026-07-21 16:55:35 | `199559a9332939c9621a7067d437d18ec59a509d695964fd496373724e2d17e8` |

Live XCUITest remains `REWORK` on this host. Xcode reported `The test runner failed to initialize for UI testing` with underlying error `Authentication canceled. System authentication is running.` The Computer Use bridge also failed to start its native pipe. No authentication or accessibility control was weakened. Keyboard, focus, VoiceOver, reduced-motion, and full live interaction proof remain excluded.

## Process cleanup proof

- The final normal Debug PID and all five capture PIDs were stopped after proof collection; no exact project-built LightningLoop process remains.
- All support-process clusters spawned by the failed 16:20–16:25 UI attempts were stopped; a final start-time audit returned none.
- Pre-existing 06:25 services were preserved: SkyComputerUseService PID `8362`, xcodebuildmcp parent PID `11130`, and xcodebuildmcp child PID `11481` remained. They were not launched or owned by this finish task.

## Reviewer questions

Return exactly `PASS`, `REWORK`, or `BLOCKED`, then list only material findings with file/line evidence.

1. Can runtime catalog drift, stale persisted state, opaque authentication, or the Cerebras v2 cutover cause silent fallback, the wrong model, an obsolete version header, credential access, or an unsupported readiness claim?
2. Can DEBUG fixture/receipt paths leak into Release, load user data, read credentials, contact a provider, or be mistaken for live accessibility/runtime proof?
3. Can an old or independently launched same-path process satisfy `build_and_run.sh --verify`?
4. Can paused/failed/loading/setup/update UI strand the user, spin indefinitely, hide cancellation/recovery, or imply signed automatic updates?
5. Can concurrent create or continue requests with the same run ID cross an await before exclusivity is established, invoke the factory twice, or leave a failed reservation stranded?
6. Can either an update channel URL or signed artifact URL carry a query string, fragment, credentials, or a non-HTTPS scheme through validation?
7. Does the exact **75-path** amended manifest exclude `AGENTS.md` and contain every product, test, documentation, and screenshot change needed for this packet (including session titles and model UX)?
8. Does the proposed post-review handoff use only fresh branch `contrib/lightningloop-product-finish` against canonical `barnlabs/LightningLoop`, with draft-PR/hosted-CI gates and no merge/release authority?

## Rollback and root-owned delivery proposal

No production state exists to roll back. No install, runtime, managed overlay, provider account, Keychain value, release channel, or GitHub setting changed. Build products and logs are local ignored evidence. Before delivery, the current recoverable boundary is the dirty worktree itself; do not discard it or use destructive reset/checkout.

After independent review passes, root may preserve the exact worktree by creating fresh branch `contrib/lightningloop-product-finish`, staging only the **75-path** amended safe-stage manifest, reviewing `git diff --cached --check` and the cached name list, committing once, and pushing exactly `HEAD:refs/heads/contrib/lightningloop-product-finish` to `https://github.com/barnlabs/LightningLoop.git` (do not use a legacy `baney75` remote label if it diverges). The follow-up may be a **draft** PR from that branch to `main`, followed by hosted checks. A failed post-commit review is recoverable with a normal revert commit on the fresh branch.

No reuse of `codex/lightningloop`; no protected-branch push; no force-push, merge, tag, release, signing, notarization, settings/visibility/collaborator mutation, secret action, or production publication.
