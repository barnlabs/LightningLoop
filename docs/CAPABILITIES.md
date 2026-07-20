# Capability catalog

Date: 2026-07-19

This catalog defines what LightningLoop is being built to do without confusing a design contract with an active permission. The app can propose any entry below through its Evolution ledger. No skill, tool, MCP server, search provider, or system-prompt change becomes active merely because a model requested it or a credential exists.

## Active and sandbox-tested foundations

| Capability | State | Permission surface | Evidence |
| --- | --- | --- | --- |
| Provider-neutral text loop | active in both clients | active inference-provider request only | Swift tests and harness tests |
| Multimodal loop input | active | up to four validated local images sent only to an image-capable active provider | Swift and harness bounds/type tests |
| Pi terminal runtime | active | read-only workspace tools by default | TUI render and provider-profile tests |
| Pi-native Codex/Claude/Grok authentication | active | Pi `/login` and `/logout`; LightningLoop never copies tokens | local catalog/runtime inspection, provider-profile tests, native build |
| Promise/duty graph orchestration | active | declared promises/routes/evidence; 32-visit and 128-step hard runtime maxima; product caps lower | cycle, spoofed-promise, missing-promise, exhaustion, Gold tests |
| Managed harness backups | active in CLI and macOS Settings | LightningLoop overlay only; three slots; 2,048 files/64 MiB; no links/special files | backup/restore/reset/symlink tests and live temporary-root probe |
| Secure update verification | verification active; installation disabled | Ed25519 signed manifest and bounded HTTPS artifact metadata; no configured release key/channel | signature/tamper tests and `update check` probe |
| GitHub source installation | implementation staged; live proof REWORK | canonical clone; lock entries must carry integrity metadata; allowlisted local pack; lifecycle scripts disabled at install; no unsigned release shortcut | macOS universal build/codesign and packed-install CI are compile/package evidence only until the post-review live install/Finder-launch smoke; the Windows packed-install workflow is committed, but its first hosted-run evidence is still pending |
| Confirmed Pi execution preview | sandbox tested | per-call workspace mutation or shell confirmation | path/policy tests; no automatic loop integration |
| OS-sandboxed execution | active in Pi execution mode | workspace writes only; network denied; no inherited credentials | real allow/deny/network tests through macOS sandbox-exec |
| MCP manifest verifier and caller | disabled, fail-closed | future design must pin every executable input and deterministically contain descendants | disabled-call regression plus manifest parser negatives |
| Iterative bounded autonomous research | active in both loop engines when enabled | orchestrator plus reviewer-directed queries; at most three per research step and eight per run; deduplicated queries/URLs; five results per query; shared harness opens at most two leading HTTPS sources with redirect/time/type/size bounds and records retrieval time/hash/class | Swift/TypeScript initial and between-round research-injection tests, source-open/hash test, and URL-boundary tests |
| Exa search adapter | implemented, live verification pending | fixed `https://api.exa.ai/search` domain | response normalization code; live key not configured in this checkout |
| Brave search adapter | sandbox tested with synthetic response | fixed Brave web-search domain | endpoint/header/URL boundary test |
| Firecrawl search adapter | implemented, live verification pending | fixed Firecrawl v2 search domain | response normalization code; live key not configured in this checkout |
| Memory ledger and retrieval | active across native/shared loops and managed in GUI/TUI | session-bound run entries; explicitly promoted project/user entries; 12-entry prompt cap; protected atomic writes | Swift/TypeScript compatibility, scoping, promotion, malformed-ledger, secret, and prompt-channel tests |
| Prompt and skill evolution | active after full GUI/TUI lifecycle review | one-state confirmed transitions; bounded system-channel addenda; advisory skills grant no tools | lifecycle, evidence, activation, rollback, cross-client decoding, and prompt-injection tests |
| Reviewed workspace artifacts | active in CLI, TUI, and shared-harness native GUI | new/empty directory; bounded declared text plus audited generated files; optional structured sandboxed checks | real hash/write/parse, collision, traversal, link, secret, grant, RPC, and Gold-loop tests |
| Evidence Lab pictures, external opening, and script runner | active after separate execution approval | proactive bounded language checks; structured generated-code execution; one-route ephemeral loopback HTML proof; Quick Look PNG; hash-checked external default-app opening; no embedded HTML; reserved harness evidence paths | real Python auto-check, loopback HTTP, PNG signature/dimensions, immutable handoff tests, native schema, build, and path/hash-containment evidence |

## Active bounded workflow: photo to validated 3D relief

**Job:** turn a user-owned/reference-authorized photograph into a reviewable 3D approximation.

**Declared inputs:** one or more local images, intended use, target format, scale requirement, topology/material expectations, and rights confirmation.

**Active capabilities:** narrow request routing, trusted macOS image normalization, and the repository-owned dependency-free `Tools/photo_to_relief.mjs`, seeded with SHA-256 integrity enforcement and run through the approved sandboxed verifier with scoped workspace writes and no network. No arbitrary home-directory access or publication.

**Gold evidence:** normalized source image preserved; textured `.glb` plus `.obj`; shaded preview; dimensions/counts report; file hashes; missing-view uncertainty disclosed; GLB header, chunks, mesh, embedded texture, and material reopen successfully. The checked-in example has 4,096 vertices, 7,938 triangles, one reopened mesh, and one material slot.

**Failure states:** missing image, insufficient views, uncertain rights, unsupported normalization, malformed mesh, or export/reopen failure pauses the run.

## Active routed workflow: advanced application or script

**Job:** create or change a repository-local program with real build and test proof.

**Declared inputs:** workspace, runtime/platform, behavior, constraints, security/data classification, done condition, and deployment boundary.

**Active capabilities:** a new empty output directory can receive bounded run-owned UTF-8 files through reviewed artifact mode. The separate Evidence Lab grant enables structured single-process Python and JavaScript checks, timing and redacted output, generated images, and native source inspection. Commands run in the macOS sandbox with process forking and external network denied; multi-process build/test tools fail closed. Existing-repository mutation, package-registry access, and preview deployment remain separate.

**Gold evidence:** acceptance tests; lint/type/build/test output; diff review; security findings and fixes; actual run proof; rollback notes; explicit exclusions.

**Failure states:** dirty-file collision, ambiguous target, missing toolchain, unreviewed dependency, failing verification, secret detection, or unsafe deploy condition pauses the run.

## Active routed workflow: beautiful responsive website

**Job:** create an intentional, accessible website rather than a generic generated template.

**Declared inputs:** audience/job, content, art direction, brand assets, target routes, device matrix, accessibility requirements, and hosting boundary.

**Active capabilities:** new-project frontend files and structured checks through reviewed artifact mode. With Evidence Lab approval, the harness proves an ephemeral loopback HTTP response and renders bounded PNG evidence on macOS. The native UI shows only hash-verified static pictures, hashes, localhost records, and source. Explicit links open HTML in the default browser through an immutable short-lived server and open other reviewed formats in their default apps. Production deploy is separate. `Examples/GoldLanding` is the checked-in proof artifact.

**Gold evidence:** screenshots at 375 and 1280 CSS pixels; keyboard/focus proof; accessible names and contrast review; zero console errors; network failures reviewed; loading/empty/error states; responsive long-content and reduced-motion checks.

**Failure states:** missing rights/provenance, inaccessible interaction, hotlinked private assets, console/network defects, layout failure, or absent rollback stops Gold.

## MCP and tool contract

A user-supplied or researched MCP/tool definition begins as an inert evolution draft containing:

- exact command/package/version or source commit;
- purpose and negative trigger;
- requested filesystem, process, network, and private-data permissions;
- dependency integrity and update policy;
- input/output schemas and size limits;
- timeout, concurrency, retry, and kill behavior;
- synthetic sandbox evaluation and adversarial fixtures;
- material reviewer findings;
- user approval and a tested rollback target.

Pi does not provide a built-in permission sandbox, and Pi packages can have host authority. LightningLoop therefore keeps MCP execution disabled. The current manifest parser rejects arbitrary or floating launchers, but an interpreter plus mutable script arguments and a server that forks descendants are not yet a sufficient execution boundary. `lightningloop mcp verify` and tool calls fail closed until every executable input is pinned and deterministic descendant containment is integrated. Ledger activation never grants model-use authority.

## System-prompt evolution

User-provided and researched prompts/skills are treated as versioned artifacts. The native UI and Pi TUI record the exact change, named evaluation and result, requested permissions, material reviewer findings, and rollback target through the ordered lifecycle. Terminal mutations use the same owner-only JSON schema, atomic replacement, bounded input, secret rejection, and fail-closed parsing as native persistence. Only active system-prompt and skill records enter future prompts; they are count/size bounded and secret-shaped content is excluded. Skills are advisory. The active prompt cannot approve its own replacement, and tool/MCP permissions are never implied by benchmark improvement.

`ponytail:` LightningLoop records evaluation evidence but does not yet run arbitrary proposal-specific evaluation suites automatically. The user/reviewer owns the recorded evidence, and activation remains explicit.

## Search implementation sources

- [Exa Search API](https://exa.ai/docs/reference/search)
- [Brave Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get)
- [Firecrawl v2 Search API](https://docs.firecrawl.dev/api-reference/endpoint/search)
