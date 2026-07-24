# Contributing

LightningLoop is a BarnLabs open-source project. Contributions are welcome; keep them native, small, testable, and safe for a public demo.

1. Create a focused branch.
2. Install the locked terminal dependencies with `npm ci --ignore-scripts`; dependency lifecycle scripts are disabled by repository policy.
3. Add or update deterministic tests for orchestration, policy, memory, evolution, protocol, or search behavior.
4. Run both the Swift and TypeScript verification commands in `RUNBOOK.md`.
5. Verify no API keys, Keychain values, user loop history, memory ledger, or evolution ledger appear in the diff.
6. Explain behavior, validation, and remaining risk in the pull request.

Do not add automatic shell approval, host-authority execution, unrestricted local-file mutation, floating runtime packages, unpinned MCP processes, telemetry, or a hosted backend without an explicit design and security review. New system prompts, skills, tools, MCPs, and memory-policy changes must preserve the evolution lifecycle in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
