# LightningLoop threat model

Date: 2026-07-19

Status: implemented controls and remaining security contract for privileged execution

## Scope

This model covers the native macOS client, terminal client, local harness, Pi runtime, model/search providers, local workspaces, memory/evolution stores, skills, tools, and MCP processes. It excludes provider-side infrastructure and a future signed/notarized distribution pipeline.

## Assets

- inference-provider, Exa, Brave, and Firecrawl credentials;
- private goals, prompts, images, source code, and generated artifacts;
- workspace integrity and Git history;
- durable memory and prompt/skill/tool versions;
- user approvals and audit records;
- availability, token budget, and search/API quotas;
- BarnLabs identity and third-party compatibility boundaries.

## Roles and trust boundaries

- **User:** owns goals, credentials, workspaces, activation decisions, and consequential approvals.
- **LightningLoop clients:** render state and collect explicit decisions; they do not redefine policy.
- **Harness:** trusted policy enforcement and state-machine boundary.
- **Pi runtime:** reviewed dependency with powerful extension and tool surfaces; not a security boundary by itself.
- **Model output and retrieved content:** untrusted data, even when formatted as instructions.
- **Skills, tools, Pi packages, and MCP servers:** executable or instruction-bearing supply-chain inputs; untrusted until reviewed and activated.
- **External providers:** receive only requests required for an approved capability.

## Entry points

- goal text, clarification answers, pasted names, URLs, images, files, and imported prompts;
- JSONL client protocol;
- provider responses and retrieved web content;
- skill/tool/MCP manifests and their dependencies;
- workspace files, Git metadata, and build/test output;
- Keychain credential operations;
- evolution and memory proposals;
- exported artifacts and deployment requests.

## Material threats and required controls

| Threat | Impact | Required controls | Verification |
| --- | --- | --- | --- |
| Secret committed or logged | Provider/account compromise | Keychain references only, deny secret fields in schemas, redacting logger, staged secret scan | synthetic canary tests and pre-push scan |
| Provider key inherited by tools | Malicious script exfiltrates every configured key | credential broker injects only into provider transport, sanitized tool environment | child-process environment test |
| Custom-provider SSRF or credential forwarding | A user-configured custom key reaches an unintended service | custom endpoints are explicit user-trusted public HTTPS hostnames only: no literal IP, local name, or URL credential; named presets are not custom endpoints; native custom access is connection-test-only and cannot execute a loop | Swift and TypeScript URL validation tests. The native connection-test path does not DNS-pin its connection, so this is hostname validation rather than a complete DNS-rebinding defense |
| Research-source DNS rebinding / SSRF | Opened evidence reaches loopback, private, link-local, or special-use infrastructure | source opens resolve all DNS records before socket creation; any non-global answer fails closed; HTTPS uses a custom lookup pinned to the validated address, with no redirects, strict TLS, exact media types, bounded bytes, and an absolute deadline | injected resolver/transport tests for loopback, RFC1918, link-local, IPv4-mapped IPv6, mixed records, a public pinned path, slow transport, and media-type confusion |
| Prompt or retrieval injection | Model bypasses criteria or requests dangerous tools | mark content untrusted, capability checks outside prompts, independent evidence review | adversarial fixtures |
| Path traversal or symlink escape | Writes outside approved workspace | canonical path resolution, workspace root checks, symlink-aware policy | filesystem boundary tests |
| Model overwrites existing work or invents artifact evidence | Data loss or false Gold | dedicated empty directory, run-owned path set, atomic bounded UTF-8 writes, SHA-256 evidence, post-command workspace audit, harness report supplied to reviewer | collision/traversal/link/secret tests plus real file/RPC/Gold integration |
| Generated HTML abuses rendering or exfiltrates data | Local data disclosure, unwanted navigation, renderer attack surface | picture capture requires explicit execution grant; user-triggered external opening rechecks the source hash and serves immutable bounded bytes on a tokenized, expiring `127.0.0.1` route; HTTP CSP denies connections/forms/frames/objects; no embedded browser; reserved evidence namespace | loopback token/Host/method/path/CSP tests, post-start mutation test, path/hash containment, signature/size gates, native build review |
| Arbitrary command execution | Data loss, persistence, credential theft | default-deny tools, scoped approval, sandbox option, command preview, timeout/output limits | policy tests and destructive-command fixtures |
| Malicious skill/Pi package/MCP | Host compromise or covert network access | skills stay advisory; MCP execution is disabled until every executable input is pinned and descendant containment is deterministic; ledger activation grants no runtime authority | disabled-call, registry, and activation tests |
| Unpinned runtime tool download | Supply-chain replacement or unreviewed executable | force Pi startup offline; require separately reviewed system tools | clean-home TUI startup test |
| Self-approved evolution | Persistent policy weakening | separate proposal/review/activation roles; user activation for permission changes | state-machine tests |
| Poisoned or cross-run memory | Repeated false/malicious context, credential persistence, or session-data leakage | provenance, session-ID binding, scope, expiry, promotion approval, supersession, prompt caps, untrusted labels; exact filtering covers Keychain, process-captured research credentials, and bounded historical custom-service IDs, with unsafe registries failing closed | native/shared retrieval, promotion, session-isolation, runtime credential, provider-switch, unsafe-registry, and secret-shape tests |
| False Gold | User trusts defective artifact | parsed proof kind/exact target per criterion; unverified deliverable/snippet/reference inputs; assertion-bound runtime output; hash-bound source/file/render evidence; deterministic Gold predicate; verifier status; harsh review; explicit exclusions | paraphrased-fact, syntax-vs-behavior, source-open, image-mutation, Gold invariant tests |
| Infinite loop or cost amplification | Quota/cost exhaustion | per-stage round cap, token/time/cost budgets, cancellation, retry caps | exhaustion tests |
| Graph node spoofs a capability or bypasses review | Unauthorized action or false Gold | named required/provided promises, declared routes only, visit/step caps, deterministic Gold gate independent of model route | missing/spoofed promise and Gold tests |
| Update overwrites user or Pi harness state | Customization loss, credential disruption, supply-chain execution | separate managed overlay/Pi state; rotating backup; Ed25519 manifest; unsigned channel disabled | overlay and update-policy tests |
| Search result steers `llms.txt` to unintended host | Internal-network probe, credential reflection, or prompt injection | retrieval off by default; exact-host allowlist; HTTPS/no redirect/byte/exact-type/absolute-deadline bounds; reject the complete body on active-credential or malformed/over-depth encoding detection; untrusted label | allowlist, slow transport, media confusion, and credential-body regressions |
| Search provider reflects its active credential into result metadata, a URL, or response body | Credential reaches model context or an automatic evidence open | provider calls reject same/cross-origin redirects and consume only strictly typed, byte-bounded streamed JSON under one absolute deadline; centrally normalize every provider-controlled field; reject raw or repeatedly percent-decoded credential forms; return public HTTP(S) URLs only after query/fragment removal; retain active credentials to block later source and `llms.txt` bodies | Exa, Brave, and Firecrawl same/cross-origin redirect tests; partitioned strict-type, oversize, and slow-drip tests; raw/deep-encoded result and evidence-body regressions |
| Custom inference provider reflects its credential in successful content | Credential reaches model discovery, connection-test status, history, or UI | native custom provider credentials remain LightningLoop-owned; all bounded current and historical values are rejected or redacted before observable assignment, and native custom access cannot execute a loop; Pi-managed built-in credentials remain opaque | synthetic cross-provider, historical, successful-response, suspension-window, and loaded-history regressions |
| JSONL confusion/injection | Client/harness state desync | strict LF framing, bounded message size, schema validation, request correlation | protocol fuzz/contract tests |
| Unsafe export or deploy | Overwrite or unintended publication | explicit target, diff/preview, last-responsible approval, rollback and smoke checks | integration tests and manual gate |
| Sensitive local history | Private data exposure on disk | data minimization, sensitivity labels, documented plaintext boundary, deletion controls | storage inspection |
| Affiliation confusion | Trademark/reputation harm | independent BarnLabs identity, general third-party notice, provider logos absent from the product brand | UI/docs review |

## Security invariants

1. A configured credential is never model-visible merely because it exists.
2. A capability is denied unless a current grant matches its exact provider, tool, workspace, target, and risk.
3. Model text cannot grant a capability, activate an evolution, promote memory, or declare Gold.
4. Review exhaustion pauses; it never passes.
5. High-risk operations fail closed on stale state, missing evidence, ambiguous targets, or interrupted verification.
6. An active prompt or skill always has a version, evaluation evidence, explicit approval, and rollback target; active skill guidance never grants a capability.
7. The TUI and GUI use the same policy decisions and Gold predicate.
8. Artifact mode cannot become Gold unless the harness-generated file/command report and workspace audit pass; model-authored claims are not host evidence.

## Remaining risk

Even with these controls, model outputs can be wrong, reviewers can miss defects, local malware can access user-authorized data, provider services can retain requests under their policies, and generated code can be malicious. The declarative writer performs canonical and symlink checks but is not a defense against a hostile same-user process racing filesystem operations. Sandboxing reduces but does not eliminate host, resource-exhaustion, side-channel, and supply-chain risk. Security claims must name the tested coverage and exclusions.
