# Security policy

## Supported version

Security fixes are currently applied to the latest commit on the default branch.

## Reporting

Please open a private security advisory in this repository rather than a public issue for credential exposure, request forgery, unsafe local-file behavior, or another exploitable defect.

## Security model

- Pi owns credentials for Pi-managed named built-in inference providers (Cerebras, Groq, Fireworks, xAI, OpenAI Codex, Anthropic). GeneralCompute is LightningLoop-managed: its API key uses a fixed Keychain service or `GENERALCOMPUTE_API_KEY`. Research keys and an explicit native custom-provider credential are stored as separate generic passwords in macOS Keychain using `AfterFirstUnlockThisDeviceOnly` accessibility; LightningLoop does not read Pi credentials.
- The app never writes credential values to loop history, UserDefaults, logs, exports, prompts, memory, evolution proposals, or repository files.
- Goal content, attached images, clarification answers, plans, reviews, and implementations are sent to the active inference provider when a loop runs. When research is enabled, bounded queries are also sent to the selected search provider.
- Loop history is stored locally under the user’s Application Support directory.
- The complete-loop implementer is text-only by default. Reviewed artifact mode requires a user-selected empty output directory and explicit write grant. It atomically creates bounded UTF-8 files, permits revisions only to run-owned paths, and records hashes. A separate Evidence Lab grant permits structured, single-process Python and JavaScript verification, ephemeral loopback HTML proof, and CSP-confined local preview rendering. Raw shell syntax is not the command protocol; process forking, external network, ambient credentials, general home reads, and outside writes remain denied. Multi-process compilers and test runners, including Cargo, fail closed in autonomous verification.
- The Pi TUI starts offline and read-only, hides ambient packages/context, and allowlists tools. In `--allow-execution` mode, every shell call still requires a separate confirmation and runs through the pinned Anthropic Sandbox Runtime with workspace-only writes, no network by default, a scrubbed environment, and a two-minute hard cap. Pi's in-process write/edit tools remain disabled.
- MCP execution is disabled and fails closed. The version-1 manifest parser still rejects floating package/download launchers, but execution remains unavailable until every interpreter/script/dependency input is integrity-bound and descendants are deterministically contained.
- Search clients contact only their fixed provider endpoint, reject redirects, require strictly typed and byte-bounded streamed JSON, and enforce one absolute request deadline. Returned `http(s)` result links are normalized. Opened evidence and allowlisted `llms.txt` use exact text media types, absolute time/byte bounds, and reject the entire body if it contains an active research credential in raw, repeatedly encoded, malformed, or over-depth form. Retrieved content remains untrusted.
- Pi-managed named built-in presets use the runtime catalog and auth. GeneralCompute is a LightningLoop-managed fixed OpenAI-compatible preset (`https://api.generalcompute.com/v1`) with Discover Models & Test; it is not Pi `/login`. A custom inference profile requires an explicit user-trusted, credential-free public HTTPS DNS hostname; literal IPs, localhost/local names, query strings, fragments, and cross-origin authentication redirects are rejected. Native connection testing for Custom/GeneralCompute does not DNS-pin its connection, so hostname validation is not a complete DNS-rebinding/SSRF defense; loop execution and Gold remain blocked unless the shared harness is available.
- Durable memory rejects common credential shapes, process-captured research credentials, exact configured Keychain values, and credentials belonging to bounded historical custom-provider service IDs. The historical service-ID registry contains no credential values; a malformed, oversized, linked, or unreadable existing registry fails closed. Successful custom-provider model text is exact-credential redacted before it reaches the loop. Memory binds run entries to one session, caps retrieval, and requires explicit user promotion beyond run scope. Protected mutations reject links, malformed or oversized ledgers, and intervening terminal-client edits instead of overwriting them. Retrieved memory is labeled untrusted.
- Evolution proposals reject common credential shapes and exact configured Keychain values and remain inert until source review, evaluation evidence, adversarial review, explicit user approval, and a rollback target pass. Active system prompts and advisory skills are bounded; skills cannot grant tools or permissions, and active tool/MCP ledger state grants no execution authority.
- Prompt text is untrusted input. Agent prompts isolate it as data and the reviewer independently enforces the explicit rubric, but prompt injection remains a model-level residual risk.

The historical 2026-07-19 scoped review is preserved in [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md). Current findings, proof counts, exclusions, and decision status are recorded in [the active review packet](docs/REVIEW_PACKET_2026-07-20.md); Wave 7 repairs are complete and fresh Wave 8 review remains pending.

If an API key is accidentally committed or published, revoke it immediately in the affected provider console and replace its Keychain entry.
