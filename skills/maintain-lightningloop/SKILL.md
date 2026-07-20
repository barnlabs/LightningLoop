---
name: maintain-lightningloop
description: Safely inspect or change LightningLoop task graphs, managed skills, MCP manifests, tools, system-prompt addenda, notification hooks, or update policy. Use for harness evolution, graph routing changes, backup/restore/reset work, or adding a project-local capability without mutating Pi authentication or global Pi settings.
disable-model-invocation: true
---

# Maintain LightningLoop

Treat Pi as the model, authentication, package, and resource-discovery owner. Never copy Pi credentials or edit `~/.pi` as part of a LightningLoop change.

Before mutation:

1. Read the nearest `AGENTS.md` and the relevant file under `docs/`.
2. Run `lightningloop harness status` and `lightningloop harness backup`.
3. Define the duty, required promises, provided promises, evidence, failure route, visit bound, and total-step bound for graph changes.
4. Put user-managed resources only under LightningLoop's managed overlay. Reject symlinks, special files, secrets, unbounded hooks, and shell-string execution.

For a change:

- Prefer one focused resource over another broad skill.
- Keep authentication in Pi's built-in `/login` or official API-key environment flow.
- Keep MCP activation manifest-pinned, integrity-checked, least-privilege, and user-approved.
- Keep lint and tests non-mutating by default; prohibit `--fix`, `--write`, and format-in-place commands in autonomous verification.
- Preserve current and three rotating snapshots. Never bundle the managed overlay into an application update.
- Stop on missing promises, unresolved high/blocking review findings, exhausted graph bounds, failed evidence, or an unverified update signature.

Verify with `npm run verify:harness`, the macOS test/build commands in `AGENTS.md`, and a diff review. Record the exact evidence and rollback slot in project docs. Do not claim an update path is enabled until its signing key, signed feed/manifest, installer, rollback, and external smoke test are verified.
