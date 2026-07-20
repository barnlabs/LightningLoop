# LightningLoop foundation

LightningLoop is an opinionated orchestration and evidence layer on top of the Pi coding-agent harness. It is not a replacement harness.

## Ownership boundary

| Owner | Responsibilities |
|---|---|
| Pi | Model catalogs and streaming, `/login` and `/logout`, credential refresh/storage, package and skill discovery, core TUI, RPC/runtime APIs |
| LightningLoop | Clarification, promise/duty graphs, strict review gates, bounded research, sandboxed artifact evidence, managed customization overlay, notifications, release-policy verification |
| User | Provider/account choice, clarifying answers, capability approvals, managed-resource promotion, release approval |

Pi is pinned at `0.80.10`. LightningLoop must use Pi's SDK/TUI APIs before adding a substitute. LightningLoop never silently invokes a global `pi update` and never includes `~/.pi` in its backups.

## Platforms

- macOS: native SwiftUI GUI and Node/Pi TUI.
- Windows: Node/Pi TUI. Pi requires Bash; Git for Windows is the recommended base. WSL, Cygwin, and MSYS2 are supported by Pi as alternatives.
- Linux: not a primary product target, but platform paths and the Node harness use XDG conventions.

The TUI remains cross-platform, but autonomous Bash artifact verification is currently macOS-only and single-process: the composed Seatbelt profile denies `process-fork`, while platforms without an equivalent deterministic descendant boundary fail closed. Multi-process build tools cannot certify artifacts through this path.

Data roots are `~/Library/Application Support/LightningLoop`, `%APPDATA%\LightningLoop`, and `$XDG_DATA_HOME/lightningloop` respectively. `LIGHTNINGLOOP_DATA_DIR` is an explicit absolute-path override for testing/portable administration.

## Runtime flow

1. Clarify the outcome and material unknowns.
2. Build falsifiable criteria and a proof-bearing plan.
3. Traverse the planning review graph until approved or bounded exhaustion.
4. Implement, materialize only approved artifacts, and gather independent evidence.
5. Traverse the implementation review graph until an independently supported objective contract can award Gold, owner acceptance is required, or bounded exhaustion pauses the run.
6. Notify on Gold, blocker, or required user input; the current built-ins pause for owner acceptance rather than treating planner-selected evidence as a truth oracle.

Gold requires criterion-complete evidence bound to every criterion's parsed predicate, a pass verdict, an unrounded score of at least 9, no required changes, no medium/high/blocking findings, no unresolved research request, successful granted artifact checks, and an objective contract independent of planner/reviewer/model assertions. The current built-ins do not supply such an oracle. Factual/source, artifact, syntax, build, behavior, render, mixed, and general semantic work therefore pauses for owner acceptance even when every supplementary check passes. An opened hash-preserved source, including `.gov`, `.edu`, or an explicitly allowlisted hostname, proves only what bytes were retrieved from that routing candidate; the planner-selected claim and matching deliverable cannot establish truth. Deliverable prose and file hashes never prove their own correctness. Planner-authored JavaScript-export expectations remain supplementary observations only. `user_acceptance` never passes automatically. Rendered output can still be sent as hash-bound picture evidence for human review, but cannot self-certify Gold. Implementer build scripts cannot satisfy a build predicate. A model cannot promote itself around these gates.

## Shipped capability surface

The repository ships one maintenance skill: `skills/maintain-lightningloop`. User or agent-added skills/MCPs/tools remain opt-in managed resources. MCP execution additionally requires the existing versioned integrity manifest, sandbox, domain list, workspace boundary, and exact invocation approval.

Root `llms.txt` retrieval is off by default. Operators may set `LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST` to a comma-separated list of exact documentation hostnames after reviewing them. This prevents arbitrary search results from becoming ambient-network fetch targets; returned text is still bounded and untrusted.
