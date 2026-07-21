# LightningLoop design

LightningLoop is a BarnLabs orchestration and evidence layer for Pi. It is a product identity, not a provider-specific client and not a replacement for Pi. Pi remains responsible for its provider catalog, official interactive login/logout, credential refresh/storage, package discovery, and TUI/runtime APIs. LightningLoop owns bounded duty graphs, independent review policy, artifact evidence, managed customization boundaries, and release verification.

## Identity and compatibility

The supported product name, bundle identity, data root, and canonical GitHub repository are `LightningLoop`, `com.barnlabs.LightningLoop`, the platform LightningLoop data directory, and `barnlabs/LightningLoop`. BarnLabs owns the product identity; provider names are capabilities only and never branding, trust authorities, or sources of embedded credentials.

## Current provider policy

`Harness/core/provider-profile.ts` and `LightningLoop/Models/ProviderConfiguration.swift` require explicit first-run provider selection. OpenAI Codex is the convenience default only when code explicitly asks for a default profile. Pi owns provider catalogs and official login flows; a provider change must update both implementations, tests, this design, and release/checklist evidence together.

## Review graph contract

A graph node declares a bounded duty, required promises, the promises it provides, named transitions, and a visit cap. The graph has a total-step cap. Missing inputs, undeclared outputs/routes, absent handlers/targets, visit exhaustion, and step exhaustion fail closed. Terminal nodes must publish every promise they declare; an approval route therefore cannot bypass the review/evidence contract it advertises. Exhaustion pauses and never becomes approval.

The production plan and implementation graphs are deliberately hybrid: their edges, limits, promise names, and terminal states are deterministic, while the underlying model work remains dynamic. A node/agent does not approve its own work.

## Change and review protocol

A substantive change is any graph, security, provider, managed-overlay, release, or identity modification. Before review, the author MUST provide the exact diff, focused command/output, relevant failure-path or trace evidence, documentation changes, checklist status, and rollback boundary. Two fresh context-isolated adversarial reviewers MUST independently receive that packet and distinct failure questions. Neither reviewer may approve its own implementation.

For graph-runtime changes run:

```bash
npm run build:harness && node --test dist/graph/promise-graph.test.js
```

For Swift/project/package changes, also follow the native proof sequence in `AGENTS.md`; do not claim native verification from a TypeScript-only check.

GitHub housekeeping is a separate controlled outcome. Verify the canonical target before any repository operation:

```bash
gh repo view barnlabs/LightningLoop --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef
```

The canonical repository is already public. Preserve and record the returned `PUBLIC`/`isPrivate: false` state; no visibility mutation belongs to this change. Never infer the target from a redirecting remote URL, and do not change visibility, branch protection, releases, secrets, or other repository settings without separate explicit authorization for that exact mutation.
