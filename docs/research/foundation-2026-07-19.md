# Foundation research — 2026-07-19

Research stopped when primary sources and the installed Pi implementation converged on the ownership boundaries below.

| Decision | Evidence | Result |
|---|---|---|
| Use Pi rather than rebuild runtime/auth | Installed Pi SDK exposes `ModelRuntime`, built-in models, auth status/login/logout, TUI/RPC, skills and packages | LightningLoop uses Pi-native provider IDs and login |
| Graph, not a pair of opaque loops | AWS describes dependency-aware static/dynamic/hybrid agent graphs; Promise Theory models autonomous commitments as typed relationships | Added bounded promise/duty graph runtime and traces |
| Keep customization outside app/Pi state | Pi packages can be pinned; Pi settings and credentials are Pi-owned | Added isolated managed overlay and rotating snapshots |
| Fail-closed updater | Sparkle requires signed/notarized app artifacts and signed update archives; no release key/appcast exists yet | Verification exists; automatic install remains disabled |
| `llms.txt` is an optimization | The proposal defines a root Markdown context file for LLM consumption | Off by default; exact-host allowlist only, bounded and untrusted, never outranks official pages |
| Cross-platform notifications | macOS provides permissioned local notifications; Windows native notifications depend on app packaging | Native macOS notification plus TUI BEL and opt-in argv hook |

Primary sources:

- Pi local docs: `docs/providers.md`, `docs/windows.md`, `docs/skills.md`, `docs/security.md`, `docs/packages.md`, `docs/rpc.md` in the pinned package.
- OpenAI Codex auth: <https://developers.openai.com/codex/auth/>
- Anthropic Claude Code: <https://docs.anthropic.com/en/docs/claude-code/getting-started>
- xAI quickstart and CLI: <https://docs.x.ai/developers/quickstart>, <https://docs.x.ai/build/cli/reference>
- AWS agent workflow graph: <https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentperf05-bp01.html>
- Mark Burgess, *Thinking in Promises*: <https://markburgess.org/BookOfPromises.pdf>
- Sparkle security: <https://sparkle-project.org/documentation/security-and-reliability/>
- `llms.txt` proposal: <https://llmstxt.org/>

Unresolved release dependency: BarnLabs has not yet configured a Developer ID/notarization identity, Sparkle appcast/archive signing key, Ed25519 release key, or published Windows package. The product must continue to say “unconfigured” until those are real and tested.
