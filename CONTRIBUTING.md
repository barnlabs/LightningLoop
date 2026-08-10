# Contributing

LightningLoop is a BarnLabs open-source project. Contributions are welcome; keep them native, small, testable, and safe for a public demo.

## Start here (Mac, humans, and AI agents)

1. Clone **`https://github.com/barnlabs/LightningLoop`** (canonical remote only).
2. Read the phased handoff map: **[checklist.md](checklist.md)** — **Phase 0 first**. Do not one-shot the whole production table.
3. Day-1 prove the harness (no Apple signing required):

   ```bash
   npm ci --ignore-scripts
   npm run verify:harness
   ```

4. Pick **one** allowed task from checklist Phase **1–3** (docs/hygiene, brand copy, or one LL-ID). Release/signing rows are owner-only (Phase 5).
5. Branch `contrib/<short-description>`, implement, test, open a **draft** pull request.

Deep production IDs live in [PRODUCTION_READINESS_CHECKLIST.md](PRODUCTION_READINESS_CHECKLIST.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Commands: [RUNBOOK.md](RUNBOOK.md).

## Checklist for every PR

1. Create a focused branch.
2. Install the locked terminal dependencies with `npm ci --ignore-scripts`; dependency lifecycle scripts are disabled by repository policy.
3. Add or update deterministic tests for orchestration, policy, memory, evolution, protocol, or search behavior.
4. Run both the Swift and TypeScript verification commands in `RUNBOOK.md` when those surfaces change (harness-only PRs: `npm run verify:harness` is enough).
5. Verify no API keys, Keychain values, user loop history, memory ledger, or evolution ledger appear in the diff.
6. Explain behavior, validation, and remaining risk in the pull request.
7. Do not stage `dist/`, `node_modules/`, or `.build/`. Do not force-push, merge, tag, or change repository settings as part of a contribution.

Do not add automatic shell approval, host-authority execution, unrestricted local-file mutation, floating runtime packages, unpinned MCP processes, telemetry, or a hosted backend without an explicit design and security review. New system prompts, skills, tools, MCPs, and memory-policy changes must preserve the evolution lifecycle in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
