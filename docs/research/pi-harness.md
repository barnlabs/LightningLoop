# Should LightningLoop use the Pi agent harness?

Date: 2026-07-19
Data cutoff: 2026-07-19 02:00 America/New_York
Audience: LightningLoop maintainers and security reviewers
Objective: choose the shared agent runtime for a native macOS client and a terminal UI
Scope: Pi's current provider, SDK/RPC, TUI, session, skills/extensions, package, and security capabilities. This does not endorse any third-party Pi package.

## Conclusion

Adopt Pi as a pinned runtime dependency behind a LightningLoop-owned policy and protocol boundary. Use Pi's TUI/SDK for the terminal client and a versioned JSONL bridge for the native GUI. Do not expose raw Pi with unrestricted built-in tools or install third-party packages automatically.

## Evidence that changes the decision

| Claim | Evidence | Type | Date | CRAAP | Confidence |
| --- | --- | --- | --- | ---: | --- |
| Pi is an active modular harness with TUI, agent core, unified models, and an SDK | Pi repository README and release v0.80.10 | first-party repository/release | 2026-07-16 | 15/15 | high |
| Native/non-Node clients can embed Pi through strict JSONL RPC | RPC documentation specifies stdin/stdout framing, correlation, state, events, and extension UI requests | first-party documentation | retrieved 2026-07-19 | 15/15 | high |
| Skills and packages cover the requested extensibility, but are executable supply-chain inputs | skill/package docs define project discovery and warn that skills/packages can execute arbitrary actions | first-party documentation | retrieved 2026-07-19 | 15/15 | high |
| Pi cannot be the security boundary | repository and containerization docs state that Pi runs with launching-user permissions and has no built-in permission system | first-party documentation | retrieved 2026-07-19 | 15/15 | high |
| The local Mac satisfies the current runtime floor | Node v24.15.0 is installed; package metadata requires Node >=22.19.0 | direct local evidence and npm registry metadata | 2026-07-19 | 14/15 | high |

## Material disagreement

Pi's extension system can implement permission gates, and its CLI can allowlist or disable tools. That is useful policy plumbing, but it does not contradict the maintainers' explicit statement that Pi itself is not a filesystem/process/network/credential isolation boundary. LightningLoop must enforce its own default-deny capability model and offer a sandboxed execution path for powerful work.

Pi also intentionally omits built-in MCP support in favor of extensions. This matches LightningLoop's need for reviewed, explicitly activated MCP definitions, but means MCP management is product work rather than a free inherited feature.

## Assumptions and limitations

- The pinned Pi APIs may evolve; the integration requires contract tests and reviewed upgrades.
- Pi's TUI is suitable for the first terminal client; LightningLoop now wraps it with the same role, model, credential, search, and sandbox policy used by the JSONL service.
- The JSONL bridge is now integrated into the Swift GUI and covered by a native test that launches the compiled service. Durable cross-client resume remains separate follow-up work.
- Provider support does not guarantee every model has equally reliable tool calling.

## Risks and disconfirming evidence

- If Gemma 4 31B cannot reliably use the required tool schemas, the implementer may need a constrained tool protocol or a different implementation model while retaining Gemma for orchestration/review demos.
- If Pi's SDK/RPC compatibility becomes unstable, LightningLoop should preserve the protocol boundary and replace the adapter rather than couple both clients directly to Pi internals.
- If a macOS-native sandbox cannot support required creative/build tools, execution may need a disposable VM or container with explicit artifact import/export.

## Reevaluation triggers

- a Pi major version or security advisory;
- a breaking change to SDK, RPC, provider, session, or extension APIs;
- a provider model/tool-calling change;
- evidence that policy interception can be bypassed;
- a second maintained harness with equivalent TUI/SDK/session support and a materially stronger native permission model.

## Sources

- https://github.com/earendil-works/pi — retrieved 2026-07-19
- https://github.com/earendil-works/pi/releases/tag/v0.80.10 — retrieved 2026-07-19
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md — retrieved 2026-07-19
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md — retrieved 2026-07-19
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md — retrieved 2026-07-19
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md — retrieved 2026-07-19
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session.md — retrieved 2026-07-19
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md — retrieved 2026-07-19
