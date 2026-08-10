# Product refresh review packet — 2026-07-20

> **Superseded:** This interim packet is retained as history only. Its branch, PID, counts, screenshots, and remote-action instructions are stale. Review and delivery must use `docs/REVIEW_PACKET_2026-07-21_FINISH.md`; do not reuse the already-merged `codex/lightningloop` branch.

## Contract and owner boundary

This packet covers one integrated LightningLoop product refresh:

1. Add credential-free built-in model selection to the macOS GUI and prefer Cerebras `gemma-4-31b` (Gemma 4 31B) while failing closed if the exact installed runtime catalog no longer contains it.
2. Present LightningLoop/BarnLabs branding on product and GitHub contribution surfaces without hiding truthful dependency attribution in architecture, authentication, threat-model, NOTICE, dependency, or internal adapter material.
3. Improve the read-only update-status contract, strict signed-manifest validation, source-update guidance, and user-facing brand hierarchy.
4. Provide four copyable app/GitHub handoffs for setup, existing provider access, maintenance, and diagnosis. Existing access is connected through the official provider flow; no agent or LightningLoop path reads, imports, exports, copies, or relays another agent's credential.

Owner authorization permits a focused commit, push of the existing non-protected `codex/lightningloop` branch, and a draft pull request after the required independent reviews. It does not authorize a protected-branch push, merge, tag, release, signing, notarization, visibility/settings mutation, collaborator change, secret action, or production publication. The pre-existing untracked `AGENTS.md` belongs to the owner and is explicitly excluded from the change.

## Frozen repository identity

- Local branch: `codex/lightningloop`
- Local and remote topic-branch base before this packet: `8d208e55cd40af046ba5052c326e67a2c3f25261`
- Current canonical remote `main`: `fde002057a35b561d6e1f0816aa874d6851df2d1`
- That canonical commit is the merge of the prior topic branch: parents `5c4bb9266d1bbbcc6ad3782c6eb1ae00d04b3b9c` and `8d208e55cd40af046ba5052c326e67a2c3f25261`.
- Existing pull request for the branch: `#2`, merged. There is no open pull request for the new worktree changes.

Fresh canonical command:

```bash
gh repo view barnlabs/LightningLoop \
  --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef
```

Fresh output:

```json
{"defaultBranchRef":{"name":"main"},"isPrivate":false,"nameWithOwner":"barnlabs/LightningLoop","url":"https://github.com/barnlabs/LightningLoop","visibility":"PUBLIC"}
```

The repository remained public and no remote setting changed.

## Exact integrated diff

Reviewers must inspect the shared worktree directly. The authoritative tracked diff is:

```bash
git diff -- \
  .github/CODEOWNERS \
  .github/ISSUE_TEMPLATE/bug_report.yml \
  .github/ISSUE_TEMPLATE/feature_request.yml \
  .github/pull_request_template.md \
  CONTRIBUTING.md DESIGN.md \
  Harness/cli/index.test.ts Harness/cli/index.ts \
  Harness/core/pi-options.test.ts Harness/core/pi-options.ts \
  Harness/core/provider-profile.test.ts Harness/core/provider-profile.ts \
  Harness/pi/lightningloop-extension.test.ts Harness/pi/lightningloop-extension.ts \
  Harness/pi/model-adapter.test.ts Harness/pi/model-adapter.ts \
  Harness/rpc/server.test.ts Harness/rpc/server.ts \
  Harness/update/update-policy.test.ts Harness/update/update-policy.ts \
  LightningLoop.xcodeproj/project.pbxproj \
  LightningLoop/Models/ProviderConfiguration.swift \
  LightningLoop/Resources/Assets.xcassets/AccentColor.colorset/Contents.json \
  LightningLoop/Services/HarnessProcessClient.swift \
  LightningLoop/Services/KeychainStore.swift \
  LightningLoop/Services/LoopEngine.swift \
  LightningLoop/Services/ProviderClient.swift \
  LightningLoop/Stores/AppModel.swift \
  LightningLoop/Support/Brand.swift \
  LightningLoop/Views/SettingsView.swift \
  LightningLoop/Views/SidebarView.swift \
  LightningLoopTests/ArtifactOpenBoundaryTests.swift \
  LightningLoopTests/HarnessProcessClientTests.swift \
  LightningLoopTests/MemoryEvolutionTests.swift \
  LightningLoopTests/ProviderClientTests.swift \
  LightningLoopTests/ProviderConfigurationTests.swift \
  PRODUCTION_READINESS_CHECKLIST.md README.md RUNBOOK.md \
  docs/GITHUB_REVIEW_2026-07-20.md docs/UPDATES.md \
  docs/research/cerebras-provider-2026-07-20.md \
  script/build_and_run.sh script/install_from_github.sh \
  script/tests/install_from_github_transaction_test.sh
```

The authoritative new files are:

- `LightningLoop/Resources/Assets.xcassets/SignalGold.colorset/Contents.json`
- `LightningLoop/Support/AgentHandoffPrompts.swift`
- `LightningLoopTests/AgentHandoffPromptsTests.swift`
- `LightningLoopTests/KeychainStoreTests.swift`
- `docs/AGENT_SETUP_AND_MAINTENANCE.md`
- `docs/BRAND.md`
- `docs/MODEL_SELECTION.md`
- `docs/PRODUCT_SURFACE_BRANDING.md`
- `docs/UPDATE_UX_OPTIMIZATION.md`
- `docs/REVIEW_PACKET_2026-07-20_PRODUCT_REFRESH.md`

Inspect each new file directly. `AGENTS.md` is not in this list and must not be staged.

## Behavior and failure-path evidence

### Model selection and credentials

- The pinned installed runtime's credential-free, network-disabled catalog currently returns Cerebras `gemma-4-31b`, name `Gemma 4 31B IT`, `text` plus `image` input, context window `131072`, and maximum output `40960`.
- Both TypeScript and Swift defaults use exact ID `gemma-4-31b`, product display name `Gemma 4 31B`, image support, context `131072`, and maximum output `40960`.
- `providerModels` constructs a runtime with an inert credential store, `modelsPath: null`, and model networking disabled. The response contains bounded metadata only and never returns sign-in/account state.
- Catalog validation rejects provider mismatches, more than 500 entries, empty or overlong IDs/names, duplicate IDs, invalid limits, and non-boolean capabilities.
- `createRun` and `continueRun` load one immutable provider snapshot, revalidate its exact catalog membership, and pass that same snapshot into agent construction. The negative test receives `model_unavailable` with zero agent calls; the positive test constructs exactly one agent only when `gemma-4-31b` is present; a race regression changes the on-disk profile inside catalog resolution and proves the factory still receives the validated Cerebras/Gemma snapshot.
- Every native clarify/execute request carries the catalogued provider ID, model ID, image capability, context window, and maximum output-token limit. The RPC server refreshes the installed runtime catalog, compares every field, returns `model_catalog_drift` on any difference, and builds the runtime profile from the refreshed catalog entry rather than stale defaults. The Pi adapter independently compares the resolved model's capabilities and limits before use.
- The native model pauses before its engine call when the guarded default has not been confirmed by the installed catalog. Built-in model values are picker-owned; explicitly selected Custom profiles retain the user-triggered direct connection test.
- Runtime authentication remains opaque as `runtime-managed/unknown`. No built-in catalog request reads a credential, inspects another application's data directory, calls a provider `/models` endpoint, or makes a provider-network request.
- The JSONL boundary now rejects malformed UTF-8, non-newline-terminated output, extra envelope/request fields, wrong request correlation, invalid timestamps, multiple/missing terminal results, and invalid stage ordering. The native subprocess runner concurrently drains stdout/stderr with one aggregate cap, enforces deadlines and cancellation, escalates from termination to `SIGKILL`, and reaps only its exact child. Fixtures include finite 9 MiB output, endless output, dual-pipe output, deadline, cancellation, and prompt exit.
- Historical credential-service names are read/filter-only and cannot be selected by writable authentication APIs. Credential-registry or protected-ledger read failures abort memory/evolution mutation before in-memory or on-disk changes; byte-preservation fixtures cover those failures.

### Agent handoffs

- The app and GitHub documentation expose the same four copy targets: setup/install, connect existing provider access, maintain/update, and diagnose/repair.
- The provider-access prompt explicitly prohibits reading, copying, exporting, inspecting, entering, testing, or relaying a credential. It routes built-ins to `lightningloop auth` plus the official provider flow and leaves password, passkey, OTP, CAPTCHA, and account approval to the user.
- A custom-provider secret is directed to the user-only LightningLoop Settings entry. Copy prompts grant no commit, push, merge, release, settings, persistent-automation, or credential authority.
- Deterministic Swift string tests preserve those boundaries and reject dependency branding in every copyable prompt.

### Update and GitHub boundaries

- The canonical-source installer is bound to the actual clean checkout root, local branch `main`, exact BarnLabs origin forms, fetched `refs/remotes/origin/main`, and `HEAD == origin/main`. Transaction fixtures reject fork origins, missing origins, topic branches, dirty checkouts, missing fetched refs, and a local `main` ahead of the canonical ref while preserving complete rollback.
- `update check` is local/read-only and remains `unconfigured`; it performs no fetch or installation and points to the documented clean-checkout source path.
- Signed manifest validation now accepts only exact manifest/artifact fields, strict base64, supported macOS/Windows platforms, same-origin HTTPS artifacts, SHA-256 and byte bounds, and full prerelease ordering. Unknown fields and unsupported targets fail before cryptographic acceptance.
- The GitHub audit is read-only. It records the current public/default-main identity, current settings, and exact proposed hardening commands. None of those setting commands was run.

## Verification record

### Passed

- `npm run verify:harness` in a clean temporary home seeded only with a synthetic credential-free Cerebras profile — **205 tests, 205 pass, 0 fail**, including exact-catalog positive/negative/race and capability/limit-drift paths, strict JSONL failures, malformed catalog rejection, product-language output, prompt safety, and strict updater paths.
- `npm run build:harness && node --test dist/graph/promise-graph.test.js` — **9 tests, 9 pass, 0 fail**.
- `node dist/cli/index.js harness status` — current overlay `0 files / 0 bytes`; all three backup slots empty; `Provider runtime auth/settings changed: NO`.
- `node dist/cli/index.js update check` — `unconfigured`; automatic installation disabled; runtime pin `0.80.10`; managed overlay unchanged.
- `script/build_and_run.sh --verify` — Xcode Debug build **succeeded** and the script launched only its exact built executable as current-job PID `14495`; the prior name-only `pkill`/`pgrep` behavior is gone, no pre-existing process was stopped, and the launched app had no TCP connection.
- `xcodebuild ... test` — **72 tests, 72 pass, 0 failures; TEST SUCCEEDED**, including exact model-snapshot propagation, malformed JSONL rejection, finite 9 MiB/endless aggregate-output caps, concurrent dual-pipe draining, exact-child deadline/cancellation/reaping, historical credential filtering, and nondestructive protected-ledger failure paths.
- Native app builds — arm64 Debug executable identified as Mach-O arm64; independent `ARCHS=x86_64 ONLY_ACTIVE_ARCH=NO` Debug build succeeded and identified as Mach-O x86_64.
- `npm run verify:lock-integrity` — **166 package entries** had valid lockfile integrity; the process-safe build's fresh install audited **139 packages with 0 vulnerabilities**.
- `node --test dist/graph/promise-graph.test.js` — **9 tests, 9 pass, 0 fail**.
- `xcrun actool ...` — asset catalog compiled successfully; both semantic color JSON files also passed `jq empty`.
- `git diff --check` — pass.
- All GitHub YAML files parse — pass.
- Local Markdown targets across the root and `docs/*.md` — pass.
- Product-string boundary scans — zero dependency-name matches in CLI usage/errors, prompt builders, SwiftUI presentation constructors, copyable agent prompts, and the GitHub agent guide. Technical attribution and internal adapter/type/path names remain deliberately truthful.
- Secret scanning of the exact packet-only changed-file set (55 files; owner-local `AGENTS.md` excluded) — **0 findings**. Synthetic security fixtures remain deliberate test inputs, not credential material.
- The required Codex Security plugin was not callable in this environment; the manager performed the scanner run, focused manual security diff, and exact trust-boundary review. The two fresh context-isolated reviews required below are **BLOCKED by Donovan's current instruction not to spawn any more workers**. This packet must not be described as a full plugin or independent security assessment, and no commit, push, draft pull request, or hosted CI action may proceed.

### UI and release limitation — not a failure

The fresh native build, exact-process launch verifier, XCTest suite, and both architecture-specific app builds are green. This packet still does not claim a live accessibility/UI journey, VoiceOver validation, signed/notarized distribution, or clean-machine release proof. The draft PR's hosted `macos-app` job remains a required independent delivery gate; merge and release remain outside authorization.

## Reviewer questions

Reviewer A — runtime/model/credential/UX:

> Can a missing, stale, mismatched, duplicate, or malformed catalog; an old saved model; catalog refresh race; or opaque authentication state cause LightningLoop to launch the wrong model, silently fall back, leak account/credential state, or claim Gemma readiness without exact installed-catalog presence? Can any agent handoff read, copy, transmit, or gain authority over a secret?

Reviewer B — updater/brand/GitHub/release:

> Can public branding conceal dependency or credential ownership; can an unsupported, unbound, malformed, incorrectly ordered, unsigned, or wrong-origin update become eligible; can the copy prompts expand authority; or can the GitHub proposal mutate or overclaim current repository/release state?

Each reviewer must independently return `PASS`, `REWORK`, or `BLOCKED`, list every material finding with file/line evidence, and distinguish the disclosed live-accessibility, signing/notarization, and hosted-CI limitations from a code pass.

## Rollback and proposed remote action

Local rollback is a targeted reversal of only the files listed above plus removal of the listed new files. It does not require a credential, catalog, overlay, user-data, installer, or remote-settings rollback. No managed overlay, runtime state, provider account, Keychain value, installation, release channel, or GitHub setting changed.

After both independent reviews pass and the exact staged diff is rechecked, the exact proposed non-protected branch push is:

```bash
git push -u https://github.com/barnlabs/LightningLoop.git \
  HEAD:codex/lightningloop
```

The proposed follow-up is a **draft** pull request from `codex/lightningloop` to `main`, followed by hosted checks. No merge, tag, release, visibility/settings mutation, or protected-branch push is proposed.

## Reviewer results

**BLOCKED.** Manager-owned deterministic gates and focused manual trust-boundary review pass, but the two required fresh context-isolated reviewers were not run because Donovan explicitly directed the manager to spawn no more workers and not wait on agents. This is a terminal delivery-gate disposition, not a waiver. Consequently the local changes remain uncommitted, no branch was pushed, no draft pull request was opened, and hosted CI was not started. A later delivery attempt must freeze a new exact manifest and obtain both reviews before any remote action.
