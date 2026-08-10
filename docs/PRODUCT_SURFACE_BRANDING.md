# Product-surface branding boundary

LightningLoop and its `lloop` / `llp` aliases are the product names on customer-facing surfaces. Those surfaces describe the managed runtime, provider sign-in, and managed provider catalog without exposing the vendor name of the embedded coding-agent dependency.

This is a presentation boundary, not an architecture claim. LightningLoop remains an orchestration and evidence layer; it does not claim to provide an independent runtime, provider catalog, credential store, or native fallback. The technical ownership and dependency facts remain documented in `docs/FOUNDATION.md`, `docs/ARCHITECTURE.md`, `docs/AUTHENTICATION.md`, `docs/THREAT_MODEL.md`, license/NOTICE material, dependency metadata, internal identifiers, and research records.

## Product-string scan boundary

The scan intentionally covers only text that is rendered or emitted through the assigned product surfaces:

- CLI `usage()` text, `process.stdout.write` status output, and `throw new Error` user errors in `Harness/cli/index.ts`.
- Prompt text built in `Harness/core/system-prompt.ts` and `Harness/core/loop-prompts.ts`.
- SwiftUI presentation constructors in all LightningLoop views.
- Agent handoff prompts in `LightningLoop/Support/AgentHandoffPrompts.swift` and `docs/AGENT_SETUP_AND_MAINTENANCE.md`.

It intentionally excludes dependency imports, adapter/type names, runtime environment variables, implementation comments, protocol compatibility fields, tests, and the technical-truth documents named above. Those exclusions preserve auditable provenance and must not be used to reintroduce vendor branding into rendered product copy.

Run this read-only check from the repository root. Each command must produce no matches:

```bash
sed -n '/export function usage()/,/^}/p' Harness/cli/index.ts | rg -n -i '\bpi\b'
rg -n -i --pcre2 '(?:process\.stdout\.write|throw new Error)\([^\n]*(?<![A-Za-z])pi(?![A-Za-z])' Harness/cli/index.ts
rg -n -i '\bpi\b' Harness/core/system-prompt.ts Harness/core/loop-prompts.ts
rg -n -i --pcre2 '(?:Text|Label|Button|GroupBox|LabeledContent|ContentUnavailableView|Picker|Toggle|TextField|confirmationDialog)\([^\n]*(?<![A-Za-z])pi(?![A-Za-z])' LightningLoop/Views
rg -n -i '\bpi\b' LightningLoop/Support/AgentHandoffPrompts.swift docs/AGENT_SETUP_AND_MAINTENANCE.md
```

The separate test suite verifies the representative public help and doctor output. Extend this boundary whenever a new product-output path is added.
