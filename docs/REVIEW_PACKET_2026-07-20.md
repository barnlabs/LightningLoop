# LightningLoop substantive-change review packet — 2026-07-20

Status: **WAVE 9 REVIEW PASS — CURRENT LOCAL INSTALL/UPGRADE PASS — WAVE 10 REPLACEMENT HOSTED CI PENDING**. This packet records implementation, fresh root verification, five-lane adversarial PASS, the current vendored dependency-graph install proof, and the first hosted run's repair evidence. It does not authorize a public binary release or claim Developer ID signed/notarized production readiness; all replacement hosted jobs must pass before merge.

## Contract and scope

The product identity is LightningLoop by BarnLabs. The change removes the former product/folder/target/image identity while retaining Cerebras as one optional inference provider. It adds the shared Pi-based macOS/Windows TUI, bounded promise/duty graphs, deterministic evidence gates, Exa/Brave/Firecrawl research adapters, hash-bound picture evidence, managed skill lifecycle controls, external default-browser/default-app artifact handoff, transactional GitHub source installers, GitHub contribution files, and fail-closed update policy.

The exact review diff is the staged diff on branch `codex/lightningloop`:

```bash
git diff --cached --check
git diff --cached --stat
git diff --cached
```

Only explicitly reviewed project paths belong in that index. The tracked `.codex/environments/environment.toml` is included because its public repository name/actions are part of the requested LightningLoop rename. The local untracked `AGENTS.md` remains owner-local and excluded.

## Canonical GitHub identity

Read-only command:

```bash
gh repo view barnlabs/LightningLoop --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef
```

Recorded output:

```json
{"defaultBranchRef":{"name":"main"},"isPrivate":false,"nameWithOwner":"barnlabs/LightningLoop","url":"https://github.com/barnlabs/LightningLoop","visibility":"PUBLIC"}
```

The exact proposed push is:

```bash
git push https://github.com/barnlabs/LightningLoop.git HEAD:refs/heads/codex/lightningloop
```

See `docs/GITHUB_REVIEW_2026-07-20.md` for the live settings inventory and owner-controlled gaps. No visibility, collaborator, ruleset, branch-protection, Actions-secret, signing, notarization, tag, or release mutation is included.

## Root verification evidence

### Shared harness

```text
npm run verify:lock-integrity
Lock integrity verified for 166 package entries

npm run verify:harness
191 passed, 0 failed
```

Required focused graph proof:

```text
npm run build:harness && node --test dist/graph/promise-graph.test.js dist/core/loop-engine.test.js
43 passed, 0 failed
```

The focused trace includes bounded-cycle completion, missing/spoofed/undefined promise rejection, immutable graph definitions, reviewer-evidence binding, no pass on exhaustion, forged-marker rejection, metadata-smuggling rejection, and owner-acceptance pauses for true, false, candidate-classified, general-web, contradictory, artifact-mixed, and planner-selected factual claims. No current source classification, URL, excerpt, or matching deliverable is a truth oracle.

### Native macOS (automated test/build evidence; not live-install smoke)

```text
xcodegen generate
xcodebuild ... -scheme LightningLoop -destination platform=macOS ... test
54 passed, 0 failed
Result: /tmp/LightningLoopWave8PreReview/Logs/Test/Test-LightningLoop-2026.07.20_18-02-34--0400.xcresult

Debug build: PASS
Release build: PASS
UI build-for-testing: PASS
Release architectures: x86_64 arm64
```

The `LightningLoopUI` build-for-testing result and the historical 2/2 runner result are fixtures, not proof of the current live UI journey. The live UI/install smoke is intentionally deferred until the fresh Wave 9 packet returns PASS. The Xcode UI-test runner must never be installed as the product or exempted from Gatekeeper.

### Packaging and static gates

- `npm ci --ignore-scripts`: 138 packages installed and 139 package records audited; 0 vulnerabilities.
- `npm pack --ignore-scripts --dry-run --json`: 46-file allowlisted package contains the compiled CLI, exact reviewed Pi repack, and the `lightningloop`, `lloop`, and `llp` aliases; bounded archive parsing and the runtime manifest bind path/type/mode/size/SHA-256 for every packed root file plus 136 production dependencies.
- Bash syntax and ShellCheck: pass.
- Workflow YAML parsing: pass.
- `git diff --check`: pass.
- Legacy product-brand scan outside Git history/local build residue: no former-product match.
- Real-secret pattern scans: no committed credential match.

## Wave 2 findings and repairs

| Finding | Repair | Focused proof |
|---|---|---|
| macOS/CI `npm pack` could execute `prepack` | every pack path uses `--ignore-scripts`; CI asserts both installers retain it | safe dry-run pack and full harness |
| authoritative but unrelated text could certify an Atlantis answer | source criteria require a bounded literal claim present case-sensitively in the exact opened authoritative source and final deliverable/hash-matching artifact | Atlantis negative plus Paris positive tests |
| opened research URLs permitted DNS-rebinding SSRF | resolve all answers, reject any private/special/mixed set, pin the validated address into the actual TLS socket, reject redirects and non-default ports | IPv4/IPv6 private, mapped, reserved, mixed, dual-stack-public, and non-default-port tests |
| built-in provider status and model startup read Pi auth state | removed every production `getAuth` call; Pi auth is opaque and reported `Pi-managed/unknown`; Pi surfaces its own failure | adapter/RPC/CLI regressions and source absence scan |
| inactive Cerebras/other saved keys escaped memory/evolution filtering | centralized all LightningLoop-owned credential service IDs and scan inactive plus active custom services, excluding Pi | inactive Cerebras and Fireworks regressions |
| three nested Pi lock entries lacked SRI | verified exact npm-registry integrity values and added a cross-platform lock-integrity guard | all 172 lock entries pass; clean `npm ci` |
| artifact boundary tests did not prove hostile requests or non-HTML snapshots | added Host/method/token/path/asset/TTL/close/symlink tests; native `.stl`/`.blend` handoff uses a verified separate 0400 snapshot | browser tests plus native injected-opener tests |

Root review also rejected two repair drafts before integration: a writable artifact snapshot mislabeled immutable and an IPv6 rule that overblocked ordinary public `2001:` addresses. The landed implementations use a read-only copy and exact special-use IPv6 prefixes with public dual-stack acceptance tests.

## Rollback boundary

- Before live installation, the macOS installer holds an exclusive lock, verifies both staged artifacts, replaces the global install's dependency resolution with production-only offline `npm ci` from the reviewed lock, binds every packed root path/type/mode/size/hash plus canonical package identity/dependencies/bin/engines and dependency integrity/version/package/tree hashes, creates a unique rollback snapshot, and uses same-volume `renameatx_np(RENAME_EXCL)` transitions so recreated targets cannot be nested into or overwritten.
- This is a recoverable transaction, not one filesystem-atomic set. Isolated macOS fixtures compare the complete prior GUI, TUI, `llp`/`lloop`/`lightningloop`, and unrelated-alias state after injected mid-backup, mid-commit, installed-signature, and launch-smoke failures. The lock remains held through rollback/cleanup; rollback failures return nonzero. Old exact app processes must be gone before replacement, and launch proof binds one stable new PID to the installed executable. The actual post-PASS install remains required live proof.
- Windows performs the analogous per-target locked, recreated-target-rejecting, lock-bound production install, post-commit dependency-manifest verification, package/shim backup, and byte-manifest rollback; hosted Windows proof remains pending the first pushed CI run.
- Git rollback before merge is branch deletion or PR closure. After an authorized merge, use a reviewed revert PR; do not force-push `main`.
- Application updates remain fail-closed as `unconfigured`; no signed feed, automatic binary update, or user/Pi/managed-state overwrite is enabled.

## Wave 3 findings and repairs

| Finding | Repair | Focused/root proof |
|---|---|---|
| Source claims passed when embedded in negation, quotation, conditional prose, or a contradictory artifact | Automatic source criteria require the claim and excerpt as exact standalone opened-source lines and the entire text-only deliverable to equal the ordered source claims; files or verification commands force a non-automatic/user-acceptance path | canonical positive, reordered negative, source-negation negative, deliverable negation/quotation/conditional negatives, and Paris-text-plus-Atlantis-artifact negative; full harness 158/158 |
| Search providers could reflect a credential through URL or metadata fields | All provider-controlled fields and opened bodies are credential-normalized; URLs/bodies with raw, repeatedly encoded, malformed, or over-depth reflection are dropped; accepted URLs lose query/fragment | TypeScript 16-layer plus over-depth tests and native exact-16/17-layer tests; full harness and 48/48 native suite |
| Native provider HTTP response bodies could reach UI/persistence | Native provider error bodies are withheld; all AppModel error/status/result/notification paths redact secret shapes and every LightningLoop-owned credential | reflected-response regression and persisted fake-engine-error regression |
| Historical per-host custom credentials could escape memory/evolution filtering | A bounded LightningLoop-owned service-ID registry covers former and active custom services without credential values, Pi state, or broad Keychain enumeration | custom-A to custom-B memory/evolution rejection regression |
| Built-in provider ownership differed between the shared harness and native fallback | Every named preset, including Cerebras, Groq, and Fireworks, is Pi-managed; every loop path now requires the shared harness, while native custom access is limited to explicit connection testing | all-preset auth-ownership and no-harness-no-execution regressions plus native unit suite |
| UI fixture and checklist language overclaimed live proof | The fixture is visibly labeled `UI TEST FIXTURE` / `NOT CURRENT VERIFICATION`, its proof flags are false, and `LL-009`, `LL-010`, and `LL-025` remain REWORK until post-PASS smoke | UI target build-for-testing plus documentation scan; live smoke remains deliberately deferred |
| Custom-provider and Windows wording overstated proof | Docs now state user-trusted HTTPS hostname validation without native DNS pinning and keep hosted Windows proof pending | documentation diff and workflow syntax review; hosted CI remains pending push |

## Remaining release boundaries

GitHub source installation can be exercised after fresh Wave 9 PASS; hosted CI must then pass before merge. A public macOS binary release remains REWORK and blocked on a bundled runtime/license design, Developer ID identity, hardened-runtime entitlements, notarization/stapling, signed update feed, clean-machine install/update/rollback proof, and release operations. Windows hosted CI remains pending. No tag or GitHub Release is part of this change.

## Wave 4 findings and bounded repairs

| Finding | Repair | Focused/root proof |
|---|---|---|
| A negated source substring and planner-chosen behavior scalar could certify false Gold | source claims/excerpts must be standalone lines; planner-derived behavior results are supplementary and non-certifying pending a fixed harness-owned registry | Atlantis source-negation and planner-oracle negatives; focused graph 39/39 |
| Verification could change permissions, and omitted files survived repair rounds | fingerprints/audit bind type, POSIX mode, content and root identity; every round reconciles the exact run-owned manifest without following links or deleting preexisting content | chmod, file-to-directory and contradictory stale-file regressions; artifact focused 15/15 |
| Search credentials could follow redirects or reappear in opened bodies; provider bodies were not transport-bounded | every provider redirect is denied; provider JSON and native search responses stream under absolute deadlines/strict media types/byte caps; opened source and `llms.txt` bodies reject reflected credentials | redirect, slow-drip, oversize, MIME-bypass and body-reflection tests; harness 158/158 and native 48/48 |
| Native transport still allowed built-in direct calls and successful custom responses could persist reflected keys | ProviderClient rejects non-custom profiles before credential/network; custom success fields are redacted; AppModel deeply sanitizes every nested event/report before persistence | untouched-reader/transport built-in negatives and successful-response/session-persistence regressions |
| Historical custom-key tracking failed open on registry damage or save failure | native and TypeScript readers share a bounded service-ID-only registry; invalid states fail closed; registration precedes Keychain save with rollback; runtime search keys also enter durable-record filtering | malformed/oversize/symlink/duplicate/write-failure/custom-A-to-B and stale-cache regressions |
| Windows partial backup could delete untouched shims and upgrades retained obsolete aliases | track only moved-old/installed-new paths, discover at most 32 safe prior aliases, restore exact byte manifests after mid-backup/commit/smoke failure, remove obsolete aliases only on success | committed `windows-2025` rollback/upgrade fixture; hosted execution still pending push |
| Doctor accepted Node 22.0 despite a 22.19 label; README fixture looked like current proof; security/auth docs were stale | exact Node 22.19 gate, misleading screenshot reference removed, provider/auth language current, 2026-07-19 security review labeled historical | CLI 6/6, docs links/brand/stale scans, ShellCheck and YAML parse |
| Packed installers performed a later dependency resolution not bound to the reviewed lock, and macOS rollback could mask a failed restoration | both platforms discard that resolution, run production-only offline `npm ci` from the reviewed lock, bind dependency integrity/version/manifest/tree hashes across the recoverable move, and propagate accumulated rollback failures | 148 lock-bound production dependencies verified; poisoned-cache rejection; macOS backup/commit/signature/smoke full-state rollback fixtures; hosted Windows run pending push |

## Wave 5 findings and bounded repairs

| Finding | Repair | Focused/root proof |
|---|---|---|
| Stored green evidence labels survived deleted, changed, or undecodable picture/source bytes | the native Evidence view reopens bounded bytes, verifies the recorded SHA-256 and image decode, with explicit changed/unavailable/unreadable/stale states; source text is withheld unless its current hash matches | ArtifactEvidenceReader 3/3 and external-open boundary 6/6; full native 58/58 |
| A selected provider filtered only its own credential, allowing another current/runtime/historical key into research context | TypeScript and native research recompute the complete bounded LightningLoop-owned service/value set on every operation, cover every provider field/opened body/`llms.txt`, and fail closed on invalid registry state | TypeScript research 18/18, native research 12/12, full harness/native suites |
| Verifier descendants could mutate artifacts after the transient audit | each command runs in a dedicated process group with bounded numeric ancestry tracking and exact macOS dedicated-workspace cwd attribution; residual descendants are terminated and reject proof; exact root/path/type/mode/bytes/hash manifest is reopened after reviewer latency immediately before a terminal decision | delayed rewrite/chmod/type/grandchild and unrelated-process regressions; sandbox/artifact 24/24; engine integration mutation test |
| Planner-selected narrow predicates and contradictory source prose could falsely satisfy an unrelated objective | planner/reviewer prose no longer supplies objective sufficiency; artifact and general semantic work pauses for owner acceptance; automatic source Gold is limited to one fixed harness-parsed factual grammar whose entire opened body must match the ordered contract, so extra negation/Atlantis/unrelated content fails | syntax-downgrade, owner-impersonation, contradiction, and exact-grammar regressions; graph/engine 41/41 |
| Native readers cached credential catalogs and observable state could expose raw engine/history text across async notification boundaries | catalogs recompute on every read; new keys require 8–4096 characters while legacy short values remain protected; loaded/history/inbound/notification fields sanitize before observable assignment or await; invalid registry hides content without rewriting history; native no-harness execution pauses before the engine | lifecycle/security 21/21 plus full native 58/58 |
| The documented mac installer was not executable; installed dependencies could be re-resolved outside the lock; partial rollback could be masked | executable installer; both platforms replace npm's staging resolution with offline production `npm ci` from the reviewed lock and verify an out-of-tree dependency manifest after commit; rollback accumulates failures and compares full prior GUI/TUI/alias state | 148 production dependencies, poisoned-cache rejection, mac backup/commit/signature/smoke rollback fixtures, ShellCheck/YAML/package gates; hosted Windows execution pending |

Smoke remains deliberately deferred. Fresh reviewers must verify the exact repaired diff and this fresh root proof before any PASS decision.

## Wave 6 findings and bounded repairs

| Finding | Repair | Focused/root proof |
|---|---|---|
| The fixed capital oracle accepted one-line proposition splicing such as Paris followed by Atlantis inside its city slot | country/city slots now use one punctuation-free title-cased proper-name grammar; the exact splice plus semicolon/colon/period-abbreviation variants pause | graph/engine 42/42; full harness 184/184 |
| App-level execution paused without the harness, but native clarification and the underlying native reviewer engine could still make calls or return completion | production injects a blocked service for every no-harness profile; both clarification and execution independently stop; native `LoopEngine` itself always returns paused/non-complete; custom direct access remains only explicit Settings connection testing | native fallback/input focused 18/18; full native 62/62 |
| Current report status revalidated previews and source, but omitted STL/BLEND/other file bytes | every manifest entry now requires bounded regular non-link bytes, exact size and SHA-256 under per-file/count/aggregate caps; picture/source add decode/UTF-8 checks | `.stl` mutation and `.blend` deletion regressions; ArtifactEvidenceReader 4/4; native 62/62 |
| Goals, answers, model prompts, Pi session entries, and research queries could carry a configured or secret-shaped value across a trust boundary | fresh selected/unselected/runtime/historical LightningLoop-owned catalogs plus secret-shape checks reject semantic input before UI/model/provider/session persistence; research rejects rather than rewrites and makes zero network calls | TS trust-boundary 22/22, TS research 19/19, native fallback/input 18/18, native research 13/13 |
| Verifier containment depended on catching a fast detached process through polling/ancestry/cwd | the pinned macOS Seatbelt profile is composed to replace `allow process-fork` with `deny process-fork`; mismatch/non-mac fails closed; polling is cleanup defense only; multi-process Cargo proof is now honestly unsupported | immediate `setsid`/new-PGID/chdir spawn receives EPERM; sandbox/artifact 24/24; harness 184/184 |
| Install health treated clean first-run provider selection as failure; no cross-platform provider selector existed; concurrent/recreated targets and stale app processes could invalidate transaction proof; root lock bin metadata drifted | installer uses explicit runtime-only doctor while normal doctor reports onboarding; clean `llp` stops before Pi with provider list/select commands and credential-free bounded metadata; both platforms hold exclusive locks and reject recreated targets; macOS requires an empty old-process baseline and stable new installed PID; packed runtime contract exactly matches reviewed package/lock name, version, dependencies, three aliases, and engine | harness 184/184; CLI/provider 19/19; mac lock/recreated-target/process fixtures; 148 dependency manifest; tampered-bin rejection; hosted Windows lock/onboarding execution pending |
| The staged public `.codex` environment still retained the former product name | the tracked environment now names LightningLoop and exposes separate macOS-app and TUI actions | index-only legacy-brand scan; environment diff review |

Smoke remains deliberately deferred. Fresh reviewers must verify the exact repaired diff and this fresh root proof before any PASS decision.

## Wave 7 findings and bounded repairs

| Finding | Repair | Focused/root proof |
|---|---|---|
| A planner-selected `.gov`/`.edu`/allowlisted routing candidate could still certify `The capital of France is Atlantis.` | all source URL/classification/hash/excerpt/claim/deliverable evidence is supplementary; factual and general semantic work pauses for owner acceptance until a harness-owned immutable oracle exists; prompts and docs use the same boundary | exact candidate/general-web Atlantis and true-Paris pauses; full harness 190/190 |
| Percent-encoded configured credentials crossed semantic goal/answer/prompt/session boundaries | every semantic string and object key is inspected raw and through 16 bounded percent-decode rounds; malformed or over-depth encoding fails closed; selected/unselected/runtime/historical values and secret shapes are rejected before observation/model/network/persistence | central, extension, adapter, provider-reflection, RPC goal/answer/restoration regressions; harness 190/190 |
| The underlying native engine still made provider/research calls even though AppModel hid it | native `LoopEngine` is a zero-call compatibility boundary; clarification fails before dependencies and execution returns paused/non-complete without agent, research, event, memory, or evolution calls; custom native access is named and limited to Settings connection testing | zero-call focused suite; full native 54/54 |
| Terminal artifact revalidation could allocate unbounded grown or added files after reviewer latency | terminal reopen streams directory entries and 64 KiB file chunks under 4,096-entry/2,048-file/10 MiB per-file/128 MiB aggregate caps; it binds type/mode/device/inode/size/time/hash before and after reading and rejects growth/replacement/additions | sparse expected growth, sparse unexpected addition, 2,049-file flood, concurrent-growth regressions; artifact 24/24; harness 190/190 |
| Packed root CLI/skills were not integrity-bound | a bounded tar parser validates the exact 44-file archive; runtime manifest schema 2 binds every packed root path/type/mode/size/hash and the archive hash, then reopens the installed tree plus 148 lock-bound dependencies before any CLI execution | mutated `dist/cli/index.js` rejection, archive proof, dependency reverify, poisoned-cache rejection |
| Windows arbitrary prefixes could cross volumes or alias one target through reparse paths; both installers had check/use target races | Windows resolves identity, rejects reparse/junction paths, stages/backups on the live volume, and uses same-volume .NET no-replace renames; macOS uses compiled `renameatx_np(RENAME_EXCL)` atomic directory transitions; both verify postconditions and retain exact rollback state | macOS race/rollback/lock/process fixtures and ShellCheck pass; expanded Windows cross-volume/reparse/race fixtures are committed but hosted execution remains pending |
| Live docs/UI advertised native inference, generic Settings-key remediation, and an unnecessary public-visibility conversion | capability names/copy now say connection testing only; runbook separates Pi/custom/research auth recovery; existing public visibility is preserved without a settings mutation | native capability regression, index/docs/link/brand scans, canonical `gh repo view` evidence |

Smoke remains deliberately deferred. Fresh reviewers must verify the exact repaired diff and this fresh root proof before any PASS decision.

## Wave 8 findings and bounded repairs

| Finding | Repair | Focused/root proof |
|---|---|---|
| RPC correlation IDs and outbound provider metadata bypassed exact/repeated-decoded credential inspection | the complete structurally parsed inbound envelope is checked before retention and every complete outbound envelope before emission; unsafe IDs fall back to non-secret protocol correlation; raw, encoded, malformed, and over-depth metadata never reaches agent/state/output | RPC/MCP focused 13/13 |
| No-harness UI actions could appear enabled from a stored custom connection-test credential; Evidence copy still advertised Cargo/project checks; README overstated built-in `/models` discovery | loop readiness now requires the exact shared-harness runtime; Settings separately reports custom connection credentials; Evidence copy says bounded single-process Python/JavaScript and multi-process fail-closed; Pi owns built-in catalogs and only Custom has native discovery/test | native capability regression and UI build-for-testing |
| A linked existing macOS GUI/TUI source could be atomically moved and then rejected before rollback flags were recorded | directory commit rejects linked/special sources before `renameatx_np`; the exact symlink remains untouched and no backup destination appears | mac transaction fixture including linked-source negative |
| MCP pinned only the interpreter and spawned outside deterministic descendant containment | MCP verification and calls are fully disabled/fail-closed until every executable input is pinned and descendant containment is deterministic; ledger activation grants no execution authority | disabled cooperative-fixture call plus floating-launcher negative |
| README claimed every provider used native `/models` discovery | documentation now delegates built-in catalogs/models to Pi and limits native discovery to explicit Custom connection testing | code/docs comparison |

Smoke remains deliberately deferred. Fresh reviewers must verify the exact repaired diff and this fresh root proof before any PASS decision.

## Wave 9 decision

**PASS.** Five context-isolated adversarial reviewers independently reopened the staged contract, exact diff, focused proof, and distinct graph/RPC, installer, native/artifact, brand/docs, and security failure questions after the Wave 8 repairs. All five reported `PASS` with no material finding. The focused post-review regression set passed 41/41 after widening only the fail-closed macOS process-inspection deadline from one to five seconds; no containment rule was removed. This unanimous decision permits the deferred local source install and smoke phase. Hosted macOS/Windows CI must still pass before merge, and this decision does not authorize or represent a signed/notarized binary release.

Post-review reliability and install proof: the process-inspection deadline was bounded at 30 seconds and Node test-file concurrency at two after unrestricted parallelism saturated macOS `lsof`; an independent security re-review returned PASS because error rejection, descendant detection, termination, and containment remain unchanged. The full harness passed 191/191. The transactional source installer then passed 191/191 again, verified 46 packed root entries and 136 lock-bound production dependencies, reported zero full-tree and production vulnerabilities, built `x86_64 arm64`, verified the ad-hoc app signature, passed `llp`/`lloop`/`lightningloop` and runtime doctor checks, and launched one exact process from `~/Applications/LightningLoop.app`. The exact official Pi npm tarball and reviewed repack differ only by removal of the upstream nested shrinkwrap; the root lock and overrides bind the patched `brace-expansion@5.0.7` and `protobufjs@7.6.5`, and the outer package provenance binds the repack itself. Hosted macOS/Windows CI remains required before merge.

## Wave 10 hosted-CI repairs

The first hosted run passed the macOS native app job and exposed two supply-chain portability defects before merge. The harness audit rejected vulnerable versions pinned by Pi's nested npm shrinkwrap even though patched compatible releases existed. LightningLoop now vendors an exact official `@earendil-works/pi-coding-agent@0.80.10` repack with only `npm-shrinkwrap.json` removed; `vendor/README.md` records both hashes and the rebuild rule, a byte-for-byte extracted-tree comparison confirms no other change, root overrides select the patched releases, and both full and production audits report zero. The Windows poisoned-cache fixture now invokes npm's JavaScript CLI with the pinned Node executable instead of trying to spawn `npm.cmd` directly. The local poisoned-cache fixture, 191/191 harness, 46-entry archive parser, offline packed install, transactional upgrade, and independent supply-chain review are PASS. A replacement hosted run must pass all three jobs before merge.

Later replacement runs exposed two further clean-run assumptions without reaching merge. The Rust fail-closed test now accepts only the exact missing-Cargo failure when the executor intentionally rejects a non-home toolchain, or Seatbelt `EPERM` when a supported Cargo is available; runtime containment is unchanged. Packed staging no longer asks npm to resolve an ephemeral global dependency tree merely to generate aliases. The bounded reviewed-archive parser writes the 46 exact root payload files with create-new semantics, both installers generate only the three reviewed aliases, and the existing offline lock install plus 136-dependency byte-tree manifest remains the authority. The Windows data-root helper now selects `win32` or POSIX path semantics explicitly instead of inheriting the test host's separator. Fresh local parser/extraction/offline-install/manifest/shim proof, the macOS rollback fixture, a current transactional upgrade, platform tests, and security/supply-chain rereviews are PASS; the next hosted run remains the merge gate.
