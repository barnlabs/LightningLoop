# Historical shared-harness security review

Date: 2026-07-19

> Historical evidence snapshot only. The counts, probes, and findings below describe the 2026-07-19 review and are not current Wave 4 proof. See `docs/REVIEW_PACKET_2026-07-20.md` for the current `REWORK` decision, updated verification counts, subsequent findings, and deferred smoke boundary.

Scope: changes on `codex/lightningloop`, including the provider-neutral TypeScript harness, Pi integration, search adapters, image inputs, native provider/credential/memory/evolution UI, protected cross-client ledgers, local persistence, and CI. Review used source inspection, deterministic tests, dependency audit, live read-only probes, a bounded real-provider Gold loop, an 80-column TUI inspection, a compiled isolated native UI journey, and a fresh app-local Evidence Lab capture. It did not include destructive testing, provider infrastructure, notarization, or a general-purpose OS sandbox penetration test. macOS canceled the XCTest UI runner while system authentication/Accessibility approval was active, so keyboard assertions could not execute in this environment.

The instructed Codex Security plugin was not installed in this environment. This is a local threat-model/diff review, not a claim that the application is secure.

## Resolved findings

### Pi passthrough could override product policy

- **Severity / confidence:** high / high
- **Component:** terminal argument boundary
- **Preconditions:** a launch included arbitrary Pi flags after `--`.
- **Realistic impact:** tool, extension, provider, model, or session options could weaken the policy wrapper while still appearing to run as LightningLoop.
- **Evidence:** passthrough arguments were appended directly to Pi arguments after LightningLoop's flags.
- **Fix / status:** fixed. Passthrough now accepts only no-session, print prompt, and a validated thinking level.
- **Verification:** positive safe-option test, negative tool/extension/provider/model/session override tests, and live print probe.
- **Remaining risk:** a local user can run raw Pi outside LightningLoop; that process is outside this product boundary.

### Execution tools inherited ambient credentials

- **Severity / confidence:** high / high
- **Component:** Pi shell/tool process environment
- **Preconditions:** the user enabled execution and the parent process had credential-shaped environment variables.
- **Realistic impact:** a model-generated command approved for another purpose could read and exfiltrate unrelated credentials.
- **Evidence:** Pi runs with launching-process authority and no sanitized child environment had been established.
- **Fix / status:** fixed for the LightningLoop TUI process. Credential-name and credential-value shaped variables are removed before tools exist; provider auth is independently brokered from Keychain.
- **Verification:** deterministic environment test and credential-free doctor/TUI probes after scrubbing.
- **Remaining risk:** non-obvious secrets in generically named environment variables are not detectable; executable tools remain preview-only and require confirmation.

### Shell approval hid command tails

- **Severity / confidence:** high / high
- **Component:** shell approval UI
- **Preconditions:** an execution command exceeded the 500-character preview.
- **Realistic impact:** dangerous syntax could be placed beyond the visible approval text.
- **Evidence:** the confirmation preview used `slice(0, 500)` while the full command could execute.
- **Fix / status:** fixed. Commands over 2,000 characters are denied and every eligible command is shown in full.
- **Verification:** overlong-command denial test and matching direct-shell guard.
- **Remaining risk:** shell syntax is complex; a user approval is not semantic proof that a command is safe.

### Provider output could reflect a credential

- **Severity / confidence:** medium / medium
- **Component:** search and model error rendering
- **Preconditions:** a provider or intermediary reflected the submitted credential in an error body or result text.
- **Realistic impact:** a secret could appear in terminal output or logs.
- **Evidence:** provider error detail and normalized result text were previously rendered without known-secret redaction.
- **Fix / status:** fixed. Search error bodies are withheld; result text and model error messages pass through exact-secret and provider-shape redaction.
- **Verification:** synthetic credential-reflection error and result test.
- **Remaining risk:** screenshots or third-party provider telemetry are outside local output redaction coverage.

### Runtime helper was downloaded without pinned integrity

- **Severity / confidence:** high / high
- **Component:** Pi startup helper acquisition
- **Preconditions:** Pi started without a local `fd` helper and network access was available.
- **Realistic impact:** an unreviewed latest-release executable entered the user environment outside the repository lockfile.
- **Evidence:** source inspection and an observed first-run download showed release retrieval without a repository-pinned checksum.
- **Fix / status:** fixed for LightningLoop startup. `PI_OFFLINE=1` is set before Pi runs. The test-created helper was moved to Trash.
- **Verification:** clean startup reported that offline mode skipped the download; TUI and model probe still worked.
- **Remaining risk:** raw Pi launches outside LightningLoop retain upstream behavior.

### Native reviewer could award Gold without criterion evidence

- **Severity / confidence:** high / high
- **Component:** Swift loop state machine
- **Preconditions:** the reviewer returned pass, score at least 9, no required changes, and no material finding, but omitted criterion evidence.
- **Realistic impact:** polished but unverified output could be labeled Gold.
- **Evidence:** the Swift parser had no criterion-assessment gate while the shared TypeScript predicate did.
- **Fix / status:** fixed. Final implementation review must include exactly one satisfied, nonempty evidence assessment for every known criterion and no unknown criterion.
- **Verification:** native false-pass regression test plus the existing repair/exhaustion suite.
- **Remaining risk:** model-authored inspection evidence can still be wrong; executable/artifact workflows require independent host-side verifiers before activation.

### Protected-ledger writes could fail without rollback

- **Severity / confidence:** low / high
- **Component:** native memory/evolution persistence
- **Preconditions:** Application Support encoding, atomic write, protection, or permission update failed.
- **Realistic impact:** the UI could imply a promotion, deletion, or proposal persisted when relaunch would disagree.
- **Evidence:** archive saves ignored errors.
- **Fix / status:** fixed. Ledger mutations roll back in-memory state and surface failure text when a protected write fails.
- **Verification:** compile/test gate and direct diff review.
- **Remaining risk:** the older session archive remains best-effort; a future shared repository should make persistence failure explicit in the main workspace.

### Run memory could be mislabeled as eligible outside its session

- **Severity / confidence:** medium / high
- **Component:** native/shared managed-memory retrieval
- **Preconditions:** a run-scoped record existed without a retrieval path bound to the originating session ID.
- **Realistic impact:** private or task-specific context could influence an unrelated run, or the UI could imply that memory affected agents when it did not.
- **Evidence:** the initial ledger stored run entries without `sourceRunID` and no loop engine loaded eligible records.
- **Fix / status:** fixed. New run memory records bind to the selected native session. Native and RPC retrieval require the same run ID; CLI/TUI generic sessions load only promoted project/user entries. Retrieval excludes contradicted, expired, superseded, unapproved, or secret-shaped records and caps prompt context at 12 entries.
- **Verification:** Swift session-isolation and system-channel tests plus TypeScript store, promotion, malformed-ledger, and secret-shape tests.
- **Remaining risk:** promoted memory can still be factually wrong or malicious; it is labeled untrusted and must not override current policy. Semantic relevance ranking is not implemented.

### Evolution records did not have a safe runtime effect

- **Severity / confidence:** medium / high
- **Component:** native evolution ledger and both agent runtimes
- **Preconditions:** a user completed the documented lifecycle expecting a reviewed prompt or skill change to apply.
- **Realistic impact:** the UI could overstate activation, while an unsafe direct implementation could instead have granted permissions implicitly.
- **Evidence:** proposals were persisted and lifecycle-tested but no active record entered agent prompts.
- **Fix / status:** fixed for system prompts and advisory skills. Activation requires ordered source review, named evaluation evidence, adversarial review with no material finding, explicit user approval, and a rollback target. Active content is count/size bounded, secret-shaped content is excluded, and rollback removes it from future prompts. Tool/MCP permissions remain separate.
- **Verification:** Swift prompt/skill-channel and activation-gate tests; TypeScript active-guidance, malformed-ledger, secret-shape, and lifecycle tests.
- **Remaining risk:** evaluation suites are recorded rather than automatically executed by the ledger UI, and instruction-bearing guidance can still be wrong. The system labels skills advisory and grants no capability through them.

### Text-only implementation could not substantiate real artifact claims

- **Severity / confidence:** high / high
- **Component:** shared implementer, CLI/TUI, native shared-harness UI, and Gold evidence path
- **Preconditions:** a goal required files, a build, or executable verification rather than a text response.
- **Realistic impact:** the app could present a polished description as the implementation even though no file existed and no check ran, contradicting the product's autonomous-delivery claim.
- **Evidence:** the implementer prompt explicitly limited output to text/Markdown, while the sandboxed execution and MCP paths were separate from `/loop`.
- **Fix / status:** fixed for new-project artifact mode. The user selects a dedicated empty directory and separately approves writes and optional verification. The model returns bounded UTF-8 files and structured command vectors; the harness validates paths/content, atomically writes only run-owned files, records SHA-256 evidence, runs only allowlisted executables in the network-denied sandbox, audits the workspace, and supplies the authoritative report to the reviewer. Text-only remains the default.
- **Verification:** real write/hash/revision and `node --check` tests; existing-content, traversal, link, secret-shape, missing-grant, RPC, and false-evidence gates; photo/tool seed integrity and mutation detection; real GLB/OBJ/preview generation and GLB reopen validation; CLI rejection probe; native direct-fallback denial; UI target compilation.
- **Remaining risk:** medium. Generated code execution is not a VM, resource limits do not include a hard memory quota, a hostile same-user process could attempt a filesystem race, and existing-project edits remain intentionally outside this grant.

### Generated HTML previewing expanded the renderer attack surface

- **Severity / confidence:** medium / high
- **Component:** shared Evidence Lab picture capture and external default-browser handoff
- **Preconditions:** the user explicitly enables Evidence Lab execution and a run materializes an HTML entry point.
- **Realistic impact:** malicious generated HTML could attempt external requests, navigation, persistence, excessive resource use, or exploitation of a system renderer vulnerability.
- **Evidence:** picture proof requires macOS Quick Look, while an explicit external open processes model-authored HTML and JavaScript in the user's default browser.
- **Fix / status:** mitigated and explicitly gated. Picture capture is off by default and shares the generated-code execution approval. The proof path uses an ephemeral `127.0.0.1` response and bounded Quick Look output. The native app revalidates hashes and never embeds HTML. On explicit open, a separate helper snapshots the reviewed HTML and allowlisted assets into bounded memory, serves them at an unguessable expiring URL with restrictive HTTP headers, and launches the default browser. Other formats open only after containment, type, size, and hash validation.
- **Verification:** real HTML integration tests prove loopback HTTP 200, token and Host binding, restrictive headers, stale-hash rejection, immutable post-start bytes, PNG signature/dimensions, reserved-path output, and post-render workspace audit; native builds cover the client boundary.
- **Remaining risk:** medium. CSP is defense in depth, not a browser VM. Quick Look, the default browser, extensions, and media decoders retain platform attack surface; browser history may retain the short-lived URL; and a hostile same-user process remains outside the stated boundary. Do not enable Evidence Lab for untrusted multi-tenant content.

## Open risks and hard stops

### Powerful implementer execution lacked an OS sandbox

- **Severity / confidence:** high / high
- **Affected component:** planned tool/MCP implementer
- **Preconditions:** execution preview is enabled and a user approves a command.
- **Impact:** approved code runs with the launching user's remaining process permissions.
- **Evidence:** Pi explicitly has no built-in permission system; current controls are policy interception and environment/path reduction.
- **Required fix:** demonstrably constrained execution, artifact import/export, resource limits, and adversarial bypass tests.
- **Implementation status:** fixed for the terminal execution surface and opt-in complete-loop artifact verification. LightningLoop pins Anthropic Sandbox Runtime, replaces the host shell, excludes in-process write/edit tools, limits writes to the approved workspace, denies network by default, scrubs credential-shaped environment variables, and kills the process group on timeout/cancel. MCP verify/call uses the same boundary plus integrity manifests. The GUI exposes a separate command confirmation and refuses artifact authority in the native fallback.
- **Verification:** real sandbox tests write inside a temporary workspace, fail to read a synthetic sibling-home secret, fail to reach `example.com`, and fail closed before initialization. The MCP test completes initialize, tools/list, and tools/call through the sandbox. Artifact integration executes a structured parse check and binds its report to Gold.
- **Remaining risk:** medium. Sandbox Runtime is a beta research preview and macOS Seatbelt is not a VM. Existing-project mutation, arbitrary binaries, networked installs, and automatic MCP activation remain excluded.

### Native and terminal persistence are only partially bridged

- **Severity / confidence:** medium / high
- **Affected component:** client consistency
- **Preconditions:** the same conceptual run is used across clients or a rule changes on only one side.
- **Impact:** state, review rendering, or policy could drift despite matching current gates.
- **Evidence:** native inference now uses the shared TypeScript/Pi state machine through one-line JSONL requests when the locked harness is discoverable. Swift session history remains a separate archive and the app retains a labeled direct fallback.
- **Required fix:** move durable run snapshots and resume semantics behind the protocol, then migrate the native archive.
- **Implementation status:** protocol and inference bridge fixed; cross-client resume remains a labeled `ponytail:`.
- **Verification:** 27+ protocol/core tests cover malformed frames, versions, duplicate requests, bounds, cancellation, restart recovery, and deterministic Gold; native XCTest launches the compiled service and validates a correlated handshake.
- **Remaining risk:** medium for resume/state drift, low for the active shared inference path.

### Custom provider could target local services

- **Severity / confidence:** high / high
- **Component:** Swift and TypeScript provider-profile validation
- **Preconditions:** a user selected Custom and entered an HTTPS localhost, local DNS, or IP-literal endpoint.
- **Realistic impact:** a provider credential could be sent to an unintended local service, or the client could be used for SSRF-like access.
- **Evidence:** the initial custom validation required HTTPS but accepted local names and IP literals.
- **Fix / status:** fixed. Custom endpoints require a public DNS hostname; localhost, `.localhost`, `.local`, literal IPv4/IPv6, URL credentials, queries, and fragments are rejected. Known presets remain endpoint-pinned, and native authentication redirects remain same-origin.
- **Verification:** Swift and TypeScript regression tests for localhost, local names, IP literals, credential-bearing URLs, HTTP, and preset redirection.
- **Remaining risk:** DNS rebinding and a malicious public custom-provider host remain possible. A custom provider is an explicit user trust choice; no arbitrary-header support is exposed.

### macOS persistence silently failed with file-protection options

- **Severity / confidence:** medium / high
- **Component:** native profile, session, memory, and evolution archives
- **Preconditions:** atomic writes used the iOS-style complete-file-protection option in the macOS app/test host.
- **Realistic impact:** Settings or local loop state appeared changed in memory but was not durable across launch.
- **Evidence:** the provider-profile regression test returned `persistenceFailed`; the same option existed in all four archives.
- **Fix / status:** fixed. Stores now use atomic writes and explicit owner-only directory/file permissions (`0700`/`0600`). Secrets remain in Keychain rather than these files.
- **Verification:** provider save/load test plus the 23-test native suite.
- **Remaining risk:** the session archive is still best-effort and has no backup/cloud recovery.

## Validation summary

- Native macOS tests: 23 passed, 0 failed.
- Harness tests: 65 passed, 0 failed.
- Isolated native UI journey: compiled successfully with a temporary-home/no-Keychain/no-network launch contract; live execution is pending macOS Accessibility/automation approval.
- npm dependency audit: 0 known vulnerabilities at review time.
- Live probes: provider-neutral doctor, policy-wrapped TUI at 80 columns, `/loop-help`, `/research brave`, `/research off`, `/loop-cancel`, image attach/clear, and a bounded real-provider strict loop. The real loop completed clarification, planning, plan review, implementation, implementation review, and deterministic Gold in 2.7 seconds with the exact requested output and no credential disclosure.
- UI inspection: SwiftUI source and stable accessibility identifiers were reviewed; the compiled native app launched with an isolated temporary home and a real checked-in artifact report. A debug-only app-local capture verified the Evidence Lab hierarchy, contrast, rendered-work viewport, proof labels, and opaque detail surface. The XCTest journey still could not initialize because macOS reported active system authentication, so executed keyboard/focus assertions remain an external audit item.
- Artifact proof: deterministic tests compiled Python, executed TypeScript, and built/tested Rust offline in the network-denied sandbox; HTML proof returned loopback HTTP 200 and produced a signature-checked PNG. The integrity-pinned dependency-free Node workflow also generated `.glb`/`.obj`/PNG/JSON, then reopened the GLB and verified 4,096 vertices, an embedded texture, and a material slot.
- Repository secret-shape scan: 0 matching files. Synthetic credential markers remain confined to in-memory test values and are verified by the redaction tests.
