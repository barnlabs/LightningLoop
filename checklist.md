# LightningLoop — phased agent & contributor checklist

> **Who this is for:** Mac (@mac756), AI coding agents, and open-source contributors.
> **Who this is not for:** one-shot “finish the product” runs. That path fails.
> **Clone root:** wherever you cloned **`https://github.com/barnlabs/LightningLoop`**. All paths below are **repo-relative**. Never hard-code another machine’s home directory.
> **Deep ID ledger:** [`PRODUCTION_READINESS_CHECKLIST.md`](PRODUCTION_READINESS_CHECKLIST.md) (LL-001…LL-028). This file sequences work; that file owns status IDs.
> **Human process:** [`CONTRIBUTING.md`](CONTRIBUTING.md) · maintainer agent rules: [`AGENTS.md`](AGENTS.md)

---

## Hard rules (read before any tool call)

1. **One phase at a time.** Finish the phase exit criteria. **STOP.** Open a draft PR or record proof. Only then start the next phase.
2. **One LL-ID (or smaller) per PR** for product work. Never bundle brand + a11y + signing + GitHub settings.
3. **Do not one-shot** MISSING release rows (LL-013–017, LL-021–022). Those are **release-owner only** (Donovan / BarnLabs). Contributors and Mac must not start them unless Donovan names the ID and approves credentials.
4. **Never** read/copy/mutate Pi auth, `~/.pi`, Keychain secrets, or user loop/memory/evolution ledgers into git.
5. **Never** `git add` `dist/`, `node_modules/`, `.build/`, or force-add ignored paths.
6. **Canonical remote:** `https://github.com/barnlabs/LightningLoop.git` only. If a local worktree still points at a personal fork, clone barnlabs fresh for contribution work.
7. **Default PR posture:** draft PR, focused branch `contrib/<short-description>`, no force-push, no merge, no tags, no repo settings changes without explicit owner approval.

If an AI agent is about to touch more than one phase or more than one LL-ID → **STOP and ask**.

---

## Front matter

| Field | Value |
|-------|--------|
| Product | **LightningLoop** — BarnLabs open-source macOS app + cross-platform terminal for disciplined agent work |
| Tagline (approved) | Fast models. Strict evidence. |
| Stack | SwiftUI 6 (macOS 14+) + TypeScript harness on Node ≥22.19 + pinned Pi coding-agent 0.80.10; JSONL RPC; Windows TUI |
| Bins | `lightningloop` / `lloop` / `llp` → `dist/cli/index.js` after build |
| **Not** | Next.js, Convex, Clerk, or a hosted web app |
| Honest status | **Not production-shipped.** Local gates strong; signed/notarized public binary and update feed **MISSING**. |

---

## Phase map (do in order)

| Phase | Name | Who | Exit criteria (must all pass) |
|-------|------|-----|-------------------------------|
| **0** | Orient + prove local green | Anyone | Clone barnlabs; read this file + CONTRIBUTING; harness verify green; know “where code lives” |
| **1** | Hygiene & contributor surface | Mac / docs PRs | README/CONTRIBUTING link this checklist; no secrets; ignored dirs unstaged; first-PR path clear |
| **2** | Brand & product copy (safe) | Mac / product | One brand-copy PR max (tagline consistency or GitHub *proposed* copy only if owner authorizes remote edit) |
| **3** | One product REWORK ID | Mac / contributor | Exactly one of LL-010/011/019/027/028 (or smaller slice) with tests + draft PR |
| **4** | GitHub OSS baseline | Owner + Mac (settings) | LL-024 items that need `gh`/settings — **human-owned**; agents prepare notes only |
| **5** | Release / signing | **Release owner only** | LL-013–017, LL-021–022 — **forbidden** for normal contribution |
| **∞** | Ongoing joy | Everyone | Small fixes, docs, tests; never skip Phase 0 when cold-starting |

**STOP gates:** after each phase, write 3 bullets (what changed, commands run, remaining risk) before starting the next.

---

## Phase 0 — Orient + prove local green

### 0.1 Clone and identity

```bash
git clone https://github.com/barnlabs/LightningLoop.git
cd LightningLoop
git status -sb
git remote -v   # must show barnlabs/LightningLoop
```

### 0.2 Minimum day-1 (harness — no Apple signing)

```bash
# Node 22.19+ required for full install paths; use a current LTS Node for harness dev
npm ci --ignore-scripts
npm run verify:harness
```

Exit: `verify:harness` exits 0 (typecheck + harness tests).

### 0.3 Optional native GUI (macOS only)

- Xcode 16+, XcodeGen.
- See `RUNBOOK.md` and `script/build_and_run.sh`.
- Do **not** treat source-install (`script/install_from_github.sh`) as day-1 hello-world; it enforces clean-tree / origin rules for product install.

### 0.4 Where the code lives (map)

| Area | Paths | Role |
|------|--------|------|
| Native macOS app | `LightningLoop/` | SwiftUI product |
| App entry | `LightningLoop/App/LightningLoopApp.swift` | `@main` |
| Views | `LightningLoop/Views/*.swift` | Workspace, settings, evidence |
| Stores | `LightningLoop/Stores/AppModel.swift`, `SessionArchive.swift`, `MemoryArchive.swift`, `EvolutionArchive.swift` | Local state |
| Models | `LightningLoop/Models/*.swift` | Domain types |
| Services | `LightningLoop/Services/HarnessProcessClient.swift`, `LoopEngine.swift`, `ProviderClient.swift`, `KeychainStore.swift` | GUI↔harness, native GC/Custom Discover only |
| Provider config | `LightningLoop/Models/ProviderConfiguration.swift` · `Harness/core/provider-profile.ts` | Presets, fixed base URLs, Pi vs LL-managed auth |
| Brand / titles | `LightningLoop/Support/Brand.swift`, `SessionTitle.swift`, `AgentHandoffPrompts.swift` | |
| Icons / colors | `LightningLoop/Resources/` | AppIcon, BarnLabsSymbol, AccentColor, SignalGold |
| Harness TS | `Harness/` | Shared policy + loop + RPC |
| CLI | `Harness/cli/index.ts` | tui, loop, serve, doctor, … |
| RPC | `Harness/rpc/server.ts` | JSONL for GUI |
| Loop / Gold | `Harness/core/loop-engine.ts`, `gold.ts`, `loop-prompts.ts` | State machine |
| Graph | `Harness/graph/promise-graph.ts` | Promise/duty graphs |
| Pi wrap | `Harness/pi/model-adapter.ts`, `lightningloop-extension.ts` | Providers / TUI |
| Evidence Lab | `Harness/artifacts/*.ts` | Sandboxed artifacts |
| Governance | `Harness/governance/managed-overlay.ts` | Skills/MCP overlay |
| Search / MCP / sandbox / updates | `Harness/search/`, `mcp/`, `sandbox/`, `update/` | |
| Compiled out | `dist/` (**gitignored**) | `tsc` emit |
| Tests | `LightningLoopTests/`, `LightningLoopUITests/`, `Harness/**/*.test.ts`, `script/tests/` | |
| Install scripts | `script/install_from_github.sh`, `build_and_run.sh`, `run_tui.sh`, `install_tui.ps1` | |
| Examples / tools | `Examples/`, `Tools/photo_to_relief.mjs` | Demos |
| Vendor | `vendor/earendil-works-pi-coding-agent-0.80.10-unshrunk.tgz` | Pinned Pi |
| Docs (canonical) | See § Canonical docs | |
| Production IDs | `PRODUCTION_READINESS_CHECKLIST.md` | LL table |
| CI | `.github/workflows/ci.yml` | |

### 0.5 How the product works (system)

```
User goal (+ images)
  → clarify → optional research → criteria/plan
  → plan review (repair or pass)
  → implement → harness materializes files + sandboxed checks
  → deliverable review → Gold only if strict gates pass
  else repair or honest pause (never false-pass on exhaustion)
```

| Surface | Entry | Run |
|---------|-------|-----|
| GUI | `LightningLoop/App/LightningLoopApp.swift` | `./script/build_and_run.sh` |
| Harness CLI / TUI | `Harness/cli/index.ts` → `dist/cli/index.js` | `npm run build:harness` then `node dist/cli/index.js …` / `./script/run_tui.sh` |
| GUI↔harness | `HarnessProcessClient` spawns `node …/dist/cli/index.js serve` | JSONL `protocolVersion=1` |

**Trust:** Pi owns credentials/`~/.pi` for **Pi-managed** presets. LightningLoop owns graphs, Gold, capabilities, Evidence Lab, managed overlay, redaction, and **LightningLoop-managed** API-key presets (GeneralCompute + Custom). Without discoverable harness → clarify/execute/Gold **fail closed**.

**Gold:** score ≥9, no medium+/blocking, evidence predicates, no silent capability skip. Exhaustion pauses.

### 0.5a Inference providers (map)

| Kind | Presets | Auth | Model catalog | Native Discover? |
|------|---------|------|---------------|------------------|
| **Pi-managed** | cerebras, groq, fireworks, xai, openai-codex, anthropic | Runtime `/login` or official env (Pi) | Installed runtime catalog only | **No** |
| **LightningLoop-managed fixed** | **generalcompute** | Keychain service `com.barnlabs.LightningLoop.provider.generalcompute.apiKey` **or** `GENERALCOMPUTE_API_KEY` | Defaults + Discover Models & Test | **Yes** (fixed base URL) |
| **Custom** | custom | Per-host Keychain service | User + Discover | **Yes** (user HTTPS host) |
| **Onboarding** | selection-required | — | — | Loop blocked until a real preset is saved |

**GeneralCompute contract (do not invent Pi support):**

| Field | Value |
|-------|--------|
| Docs | https://docs.generalcompute.com |
| Research note | [`docs/research/generalcompute-provider-2026-07-25.md`](docs/research/generalcompute-provider-2026-07-25.md) |
| Base URL (locked) | `https://api.generalcompute.com/v1` |
| Default model | `minimax-m2.7` · MiniMax M2.7 · context 192000 · maxOut ≤131072 · text-only |
| CLI | `lightningloop provider list` · `lightningloop provider select generalcompute` |
| Settings | Preset **GeneralCompute** → save API key → **Discover Models & Test** |
| Harness code | `Harness/core/provider-profile.ts`, `Harness/pi/model-adapter.ts`, `lightningloop-extension.ts` |
| Swift | `LightningLoop/Models/ProviderConfiguration.swift`, `KeychainStore.swift` |
| Workflow (agents) | `.grok/workflows/add-generalcompute-provider.rhai` |

```bash
# After harness build
npm run build:harness
node dist/cli/index.js provider list
# Select (writes credential-free provider.json only):
node dist/cli/index.js provider select generalcompute
export GENERALCOMPUTE_API_KEY=…   # never commit; or use macOS Settings Keychain
node dist/cli/index.js doctor
```

**Discover caveat:** native client uses OpenAI-style `GET /models`. GC docs also document `POST /v1/models/list`. If GET fails, enter model IDs manually from docs/public catalog.

### 0.6 Phase 0 exit checklist

- [ ] Cloned **barnlabs/LightningLoop** (not a random fork for contribution)
- [ ] Read this file § Hard rules + Phase map
- [ ] `npm run verify:harness` green
- [ ] Can name GUI entry, harness CLI entry, and where Gold is decided
- [ ] **STOP** — do not start Phase 1–3 product edits until this is true

---

## Phase 1 — Hygiene & contributor surface

**Goal:** strangers and Mac find the right starting doc; working tree stays clean.

### Allowed work

- Keep `checklist.md` / `CONTRIBUTING.md` / README “Start here” accurate
- Docs-only clarity (no invented release claims)
- Confirm `git status` never stages `dist/`, `node_modules/`, `.build/`

### Forbidden

- Bulk “cleanup” of unrelated dirty files
- Deleting review packets without owner say-so (they are history; see Canonical docs)

### Generated / local dirs (never commit)

| Path | Why present |
|------|-------------|
| `dist/` | Compiled harness |
| `node_modules/` | npm install |
| `.build/` | Xcode build |
| DerivedData / xcuserdata | Xcode local |

### Phase 1 exit

- [ ] README Start here links **this checklist** and CONTRIBUTING
- [ ] CONTRIBUTING links this checklist + day-1 commands
- [ ] No secrets in diffs
- [ ] **STOP**

---

## Phase 2 — Brand & product copy (safe only)

Canonical: [`docs/BRAND.md`](docs/BRAND.md), [`docs/PRODUCT_SURFACE_BRANDING.md`](docs/PRODUCT_SURFACE_BRANDING.md). Theme: **LL-026 REWORK**.

| Item | Status | Action for Mac |
|------|--------|----------------|
| Product / steward names | LOCAL assets | Keep LightningLoop first, BarnLabs second |
| Icons / colors | Present under `LightningLoop/Resources/` | **Do not** regenerate/raster-edit without art approval |
| Tagline inconsistency | **Resolved** | Canonical “Fast models. Strict evidence.” now used on all product surfaces (CLI `usage()` + loop banner, `Harness/cli/index.ts`) and the GoldLanding example; verified by `rg "Ruthless review" Harness/` returning nothing |
| Goal composer secondary copy | **GAP** | Align with brand or document exception in PR |
| GitHub description/topics | Proposed only | Needs **owner** `gh` authorization — not a drive-by agent edit |
| Signed-release claims | Must stay fail-closed | Never claim public binary is ready |

### Phase 2 exit

- [ ] At most **one** focused brand/copy PR
- [ ] Product-surface Pi-name scan still clean (see `docs/PRODUCT_SURFACE_BRANDING.md`)
- [ ] **STOP** — do not chain into UI a11y or release

---

## Phase 3 — One product REWORK ID (contributor-safe)

Pick **exactly one** from the **safe** list. Read the LL row in `PRODUCTION_READINESS_CHECKLIST.md` first.

### Safe for Mac / public PRs (with tests)

| ID | Theme | Notes |
|----|--------|------|
| LL-010 | Live UI journey | Needs host Accessibility permission; do not weaken macOS controls |
| LL-011 | Responsive / a11y QA | VoiceOver, contrast, reduced motion, empty/error states |
| LL-019 | Perf/cost envelope | No invented provider pricing |
| LL-027 | Model selection honesty | Independent review still pending; keep credential-free |
| LL-028 | Agent handoff prompts | String tests; never scrape other agents’ credentials |
| **Provider slice** | New **LightningLoop-managed** or Pi-aligned preset | Only when docs prove contract; never invent Pi `knownProvider` support. Mirror GeneralCompute pattern: fixed base URL, tests, AUTHENTICATION/MODEL_SELECTION/research note, Keychain catalog entry |

### Provider change checklist (any new preset)

- [ ] Primary docs URL + research note under `docs/research/`
- [ ] Swift `ProviderPreset` + harness `ProviderPreset` / `selectableProviderPresets` stay in lockstep
- [ ] `piProviderID` **only** if Pi ships the provider; else LightningLoop-managed (no Pi `/login` claim)
- [ ] Fixed base URL enforced in TS `validatedBaseURL` and Swift `validated`
- [ ] Credential service in `fixedLightningLoopCredentialServices` (redaction) when LightningLoop-owned
- [ ] CLI help `provider select` list + doctor/status copy
- [ ] Tests: profile defaults, no silent host rewrite, Pi vs native auth branching, ProviderClient allow/deny
- [ ] Docs: AUTHENTICATION, MODEL_SELECTION, RUNBOOK, SECURITY, README Providers
- [ ] **No** secrets in tree; keys `gc_live_*` shape mentioned only as docs text

### Not safe without owner (treat as Phase 5)

LL-013 runtime bundle · LL-014 Developer ID · LL-015 notarization · LL-016 update feed · LL-017 signed lifecycle · LL-021 release ops · LL-022 publish.

### Phase 3 exit

- [ ] Single LL-ID **or** named provider slice in PR title/body
- [ ] Deterministic tests or recorded proof per the LL row
- [ ] Draft PR; two reviewers when required by AGENTS/production table
- [ ] **STOP**

---

## Phase 4 — GitHub OSS baseline (human + notes)

**LL-024 REWORK.** Agents may draft an inventory PR of *proposed* settings. **Do not** change visibility, rulesets, Actions secrets, collaborators, or branch protection without Donovan’s exact authorization.

Known gaps (from `docs/GITHUB_REVIEW_2026-07-20.md`): no branch protection on `main`, secret scanning off, Actions not limited to SHA-pinned-only at repo policy level, etc.

**Mac ownership note:** CODEOWNERS lists `@mac756` as lead. GitHub **write** (or triage) must match that claim; pull-only cannot approve as CODEOWNER in practice. Donovan must align permissions before Mac is blocked on reviews.

### Phase 4 exit

- [ ] Written inventory + proposed commands reviewed by owner
- [ ] Or authorized settings applied with rollback notes
- [ ] **STOP**

---

## Phase 5 — Release / signing (**FORBIDDEN** for normal work)

| ID | Task |
|----|------|
| LL-013 | Bundle Node/Pi for clean-machine |
| LL-014 | Developer ID + entitlements + hardened runtime |
| LL-015 | Notarize / staple / Gatekeeper |
| LL-016 | Signed update feed |
| LL-017 | Install/upgrade/rollback on signed artifacts |
| LL-021 | Release operations |
| LL-022 | Authorized public release |

If an agent is asked to “just ship the app” without these green → **refuse and point here**.

---

## Canonical docs (active vs archive)

| Use for | Path |
|---------|------|
| Product install & story | `README.md` |
| Day-1 contribute | `CONTRIBUTING.md` + **this file** |
| Commands / ops | `RUNBOOK.md` |
| Architecture | `docs/ARCHITECTURE.md` |
| Pi / foundation boundary | `docs/FOUNDATION.md` |
| Auth | `docs/AUTHENTICATION.md` |
| Model selection honesty | `docs/MODEL_SELECTION.md` |
| Threat model | `docs/THREAT_MODEL.md` |
| Brand | `docs/BRAND.md`, `docs/PRODUCT_SURFACE_BRANDING.md` |
| Updates | `docs/UPDATES.md` |
| Agent setup prompts | `docs/AGENT_SETUP_AND_MAINTENANCE.md` |
| Production ID table | `PRODUCTION_READINESS_CHECKLIST.md` |
| Security policy | `SECURITY.md` |
| GeneralCompute research | `docs/research/generalcompute-provider-2026-07-25.md` |
| Cerebras research (pattern) | `docs/research/cerebras-provider-2026-07-20.md` |
| Dated finish packets | `docs/REVIEW_PACKET_*`, `docs/ADVERSARIAL_REVIEW_*`, `docs/UI_EVIDENCE_*`, `docs/research/*` — **historical evidence**, not day-1; do not treat as superseding ARCHITECTURE/BRAND |

---

## Local deploy vs public release (honest)

There is **no hosted web deploy**. “Ship locally” means:

| Path | Command | When | Not a claim of |
|------|---------|------|----------------|
| Harness only | `npm run verify:harness` then `npm run build:harness` | Always first | App store / notarization |
| GUI Debug | `./script/build_and_run.sh` | Dirty feature branch OK | Finder-install product |
| Source install GUI+TUI | `./script/install_from_github.sh` | **Clean** checkout of canonical **barnlabs** `main` (or authorized FF); Node 22.19+ at approved paths | Signed/notarized release |
| Windows TUI | `script/install_tui.ps1` | Windows | Signed release |

**Forbidden to call “deployed”:** unsigned local Debug binary, draft PR merge, or `update check` reporting `unconfigured`. Release rows LL-013–022 stay MISSING until release owner green-lights.

---

## Active delivery log (agents append, do not invent status)

### 2026-07-25 — GeneralCompute provider

| Item | Detail |
|------|--------|
| Intent | Add https://docs.generalcompute.com as first-class LightningLoop provider |
| Branch | `contrib/lightningloop-product-finish` (product-finish PR surface; GC is an additive preset) |
| Workflow | `.grok/workflows/add-generalcompute-provider.rhai` → Research / Implement / Verify / Review |
| Architecture | LightningLoop-managed fixed OpenAI preset; **no** `piProviderID`; Discover + Keychain/`GENERALCOMPUTE_API_KEY` |
| Proof (harness) | `npm run check:harness`; `node --test dist/core/provider-profile.test.js dist/pi/model-adapter.test.js` (20/20 at land) |
| CLI proof | `provider list` shows `generalcompute`; `provider select generalcompute` writes fixed profile without secrets |
| Review follow-ups closed | ProviderClientTests no longer misclassifies GC as Pi-managed; SECURITY/ARCHITECTURE/Settings copy aligned |
| Remaining risk | Swift XCTest not always run on agent hosts; GET `/models` vs GC `POST /v1/models/list`; live account entitlement unproven |
| Public release | **Not** claimed — local/source install only |

**Phase exit bullets (for next human/agent):**

1. **Changed:** GeneralCompute preset end-to-end (Swift + harness + docs + checklist provider map).
2. **Commands:** harness typecheck + provider-profile/model-adapter tests; CLI select; optional `./script/build_and_run.sh`.
3. **Risk:** model inventory API shape; no notarized binary; do not merge without owner review of PR #6.

---

## Ownership (RACI sketch)

| Area | Mac (@mac756) | Donovan / BarnLabs release |
|------|----------------|----------------------------|
| Docs, brand copy (safe), tests, single REWORK IDs | Lead | Review |
| CODEOWNERS reviews (needs write access) | Lead | Ensure GitHub role matches |
| Signing, notarization, update keys, publish, repo visibility/rulesets | — | **Owner only** |
| Pi credential boundary / security exceptions | Consult | Owner |

---

## What NOT to touch (matrix)

| Surface | Rule |
|---------|------|
| `~/.pi`, Pi auth files | Never inspect or commit |
| Keychain / live API keys | Never |
| Signing identities / notarization credentials | Owner only |
| Update channel private keys | Owner only |
| `git add dist node_modules .build` | Never |
| Force-push / merge to main / tags | Never as contributor |
| GitHub settings / secrets / collaborators | Owner-authorized only |
| Regenerating app icons without art approval | Never |

---

## Agent operating rules (short)

1. Phase 0 green before product code.
2. One phase · one LL-ID · one draft PR.
3. Prefer harness + unit tests over “looks good.”
4. Fail closed on release claims.
5. When stuck twice on the same gate → stop and ask a human.

### Commands

```bash
# From clone root
npm ci --ignore-scripts
npm run verify:harness
npm run build:harness
./script/run_tui.sh          # after harness build
./script/build_and_run.sh    # macOS GUI
```

---

## Pointers

| Need | Go to |
|------|--------|
| Production IDs | `PRODUCTION_READINESS_CHECKLIST.md` |
| Architecture | `docs/ARCHITECTURE.md` |
| Providers / auth | `docs/AUTHENTICATION.md`, `docs/MODEL_SELECTION.md`, §0.5a above |
| Brand | `docs/BRAND.md` |
| GitHub gaps | `docs/GITHUB_REVIEW_2026-07-20.md` |
| Contribute | `CONTRIBUTING.md` |
| Local deploy honesty | § Local deploy vs public release |

**Last checklist structure update:** 2026-08-28 (one-minute setup / skills pack / no-bloat delivery log). Re-verify LL statuses against `PRODUCTION_READINESS_CHECKLIST.md` before claiming a row green.

### 2026-08-28 — One-minute setup, obvious skills, no extra panels

| Item | Detail |
|------|--------|
| Intent | Same PR 16. First-run is four steps: provider → key or /login → one model → loop. doctor/help name the next action. Settings is Setup / Skills / Harness. Default skill pack list/enable/disable in CLI, TUI, and Settings. No marketplace. No leaks. |
| Branch | `cursor/e2e-models-keys-oauth-pi-1b7b` |
| First-run | `llp` with no provider prints Next/Then only. Cut help/free/doctor/agents/browse from the required path. Windows still matches `provider select PRESET`. |
| Skills | Shipped pack: lloop-research, lloop-engineer, lloop-verify, lloop-sources, lloop-browse, maintain-lightningloop. `llp skills list\|enable\|disable`. TUI `/skills`. Settings Skills tab. `skill-pack.json` is IDs only. Drafts never auto-enable. |
| No bloat | Removed Settings General/Memory/Evolution tabs and agent-handoff cards. Removed goal-composer pipeline cards. Footer is help · provider · key · skills · /loop. |
| Proof (this Linux VM) | Recorded after gates. **Not run:** xcodebuild, XCTest, XCUITest, live TTY, live inference. |
| Production rows | **Unchanged.** LL-013–017, LL-021, LL-022 remain MISSING. LL-010 and LL-011 remain REWORK. No production row faked. |

**Phase exit bullets:**

1. **Changed:** Four-step first-run, next-action doctor/help, default skill pack enable/disable, slimmer Settings and goal composer.
2. **Commands:** `check:harness`, `test:portable`, `build:harness`, isolated CLI first-run/skills probes.
3. **Risk:** Live macOS Settings/Keychain journey still unproven. LL-010/011 stay REWORK.

### 2026-08-28 — Model selection, keys, tool auth, shared engine state

| Item | Detail |
|------|--------|
| Intent | One product path for model pick, Discover/pull, OS-store keys (including search), runtime `/login` for built-ins, and GUI/TUI/`loop` sharing the same provider.json + secret store. Not a signed release. |
| Branch | `cursor/e2e-models-keys-oauth-pi-1b7b` |
| Model selection | `provider select PRESET --model ID` validates OpenRouter against the public catalog, GeneralCompute against the live host catalog, and Pi-managed presets against the installed runtime catalog. Unknown IDs fail closed. |
| Discover | `provider models` uses the active profile: public OpenRouter, host `/models` for GeneralCompute/Custom, installed runtime catalog for built-ins. Settings Providers tab leads with Discover. OpenRouter Discover works without a key. |
| Keys | `llp key set\|status\|clear` accepts `openrouter`, `generalcompute`, `custom`, `cerebras`, `firecrawl`, `exa`, `brave`. stdin only. Status is stored/missing. TUI/`loop`/serve resolve env then the OS store on every platform. |
| Tool auth | Firecrawl/Exa/Brave stay API-key (no invented OAuth). Missing research keys fail closed with `llp key set NAME`. Runtime sign-in remains `lightningloop auth` + `/login`. |
| Proof (this Linux VM) | Node v22.22.2. `npm run check:harness` exit 0. `npm run test:portable` **193 tests, 192 pass, 1 skipped, 0 fail**. `npm run build:harness` exit 0. Isolated `LIGHTNINGLOOP_DATA_DIR`: no-arg first-run exit 2; `provider models` without a profile fails closed; `provider select cerebras` then `provider models` lists the installed runtime catalog (gemma-4-31b, gpt-oss-120b, zai-glm-4.7); unknown `--model totally-made-up-model-xyz` fails closed for Cerebras and OpenRouter; `provider select openrouter --model google/gemma-4-31b-it:free --free` persists that ID and doctor shows it on all three agents; `provider models --free` lists the public OpenRouter catalog with no key; `key status openrouter|firecrawl|exa|brave` reports stored/missing and never a value; `key status anthropic` rejected; `search firecrawl` / `search exa` fail closed with `llp key set NAME`; `doctor --runtime-only` PASS; `provider.json` has no secrets. GitHub Actions run 33190079302 on `01e6b33`: harness, windows-tui, and macos-app all green (`xcodebuild test` + LightningLoopUI `build-for-testing`). **Not run here:** live TTY, live inference, XCUITest journey. |
| Production rows | **Unchanged.** LL-013–017, LL-021, LL-022 remain MISSING. LL-010 and LL-011 remain REWORK. No production row faked. |

**Phase exit bullets:**

1. **Changed:** Shared catalog + key resolution so GUI, TUI, and `loop` read one provider/key/model/research state.
2. **Commands:** `check:harness`, `test:portable`, `build:harness`, isolated CLI provider/key/doctor probes.
3. **Risk:** Native GUI Discover and Keychain journey compiled and unit-tested in macos-app CI; they are not a live Settings/Keychain proof. LL-010/011 stay REWORK.

### 2026-08-28 — GUI + TUI product feel (owner-assigned one PR)

| Item | Detail |
|------|--------|
| Intent | Finish native GUI source and TUI feel so both surfaces read as one LightningLoop product. Not a signed release. |
| Branch | `cursor/gui-tui-product-feel-b678` |
| GUI | OpenRouter preset + Keychain key entry (lockstep with harness); designed empty/error/offline/long-history states; evidence-bound image zoom/compare and SceneKit mesh viewers (hash-verified only); Browser pane empty/refused/offline; Settings just-free toggle; brand tagline on the goal hero |
| TUI | Header tagline + invoked bin; footer lists `help · provider · key · free · doctor · /loop`; `/help` and TUI aliases; honest usage line only when the provider reported tokens/cost |
| Proof (this Linux VM) | Node v22.22.2. `npm run check:harness` exit 0. `npm run test:portable` **188 tests, 187 pass, 1 skipped, 0 fail**. `npm run build:harness` exit 0. `node dist/cli/index.js help` shows first commands. Isolated `LIGHTNINGLOOP_DATA_DIR`: no-arg first-run exit 2 lists help/provider/key/free/doctor; `provider list` includes openrouter; `doctor --runtime-only` PASS; `key status openrouter` reports store none and never a value. **Not run:** xcodebuild, XCTest, XCUITest, live TTY chrome, any live inference |
| Production rows | **Unchanged.** LL-013–017, LL-021, LL-022 remain MISSING. LL-010 and LL-011 remain REWORK. No cost figures invented. No screenshots taken. |
| Remaining risk | Swift compiles only on macOS 14+ / Xcode 16. SceneKit GLB load may fall back to a verified placeholder. Live key-entry journey and VoiceOver remain unproven. |

**Phase exit bullets:**

1. **Changed:** GUI product source (OpenRouter, designed states, bound viewers) and TUI discoverability/branding. Honest checklist/criteria only.
2. **Commands:** see proof row. Seatbelt/sandbox tests were not edited to pass on Linux.
3. **Risk:** native GUI is source-complete, not live-proven. Do not merge as a production ship.

### 2026-08-28 — macos-app target membership (PR 15 follow-up)

| Item | Detail |
|------|--------|
| Trigger | GitHub Actions run 33137383836, job 98740296269, step "Build and test", exit 65. Isolated UI journey skipped. |
| Cause (verified) | CI runs `xcodebuild -project LightningLoop.xcodeproj` and does **not** run `xcodegen generate`. New Swift files were on disk and listed by `project.yml`, but absent from the committed `project.pbxproj`, so `DesignedEmptyState`, `DesignedCopy`, `ProviderIdentityChip`, `ArtifactViewerPolicy`, `ArtifactImageViewer`, and `ArtifactModelViewer` were never compiled. The generic `R` error was a cascade from those missing types. |
| Fix | Added `DesignedCopy.swift`, `DesignedStateViews.swift`, `ArtifactViewerPolicy.swift`, `ArtifactImageViewer.swift`, `ArtifactModelViewer.swift`, `LoopHistoryFilter.swift` to the app target, and `ArtifactViewerPolicyTests.swift` to the unit-test target. Tightened `ArtifactEvidenceView` viewer types. Gold / sandbox / credential boundaries unchanged. |
| Proof (this Linux VM) | Membership verified by reading `LightningLoop.xcodeproj/project.pbxproj` (file refs + Sources phases). **Not run:** xcodebuild, XCTest, XCUITest. Do not treat this follow-up as a green macos-app row. |
| Production rows | **Unchanged.** LL-010 and LL-011 remain REWORK. No production row faked. |

### 2026-08-28 — ArtifactImageViewer FormatStyle disambiguation (PR 15 follow-up)

| Item | Detail |
|------|--------|
| Trigger | GitHub Actions run 33137697643, job 98741320318, step "Build and test", exit 65. Isolated UI journey skipped. Target membership worked; new files compiled. |
| Cause | `ArtifactImageViewer.swift:67` `scale.formatted(.number.precision(.fractionLength(1)))` — ambiguous use of `number` on `CGFloat` under Swift 6 / Xcode 16.4. |
| Fix | Zoom label is `String(format: "%.1f", Double(scale))`. Viewer policy, hash gate, and credential boundaries unchanged. |
| Proof (this Linux VM) | Source edit only. **Not run:** xcodebuild. GUI remains unproven until macos-app is green. |
| Production rows | **Unchanged.** LL-010 and LL-011 remain REWORK. |

### 2026-08-28 — OpenRouter XCTest contract (PR 15 follow-up)

| Item | Detail |
|------|--------|
| Trigger | GitHub Actions run 33137802334 compiled. Isolated UI journey skipped. Native unit tests: 95 tests, 2 failures (`testEveryBuiltInPresetIsPiManagedAndOnlyCustomAllowsNativeConnectionTesting`). harness job passed. |
| Cause | The test still required every non-exempt built-in preset to be Pi-managed. This PR already treats `openrouter` like `generalcompute`: LightningLoop-managed key, `usesPiAuthentication == false`, native connection testing allowed. |
| Fix | Named Pi-managed loop is only cerebras/groq/fireworks/xai/openaiCodex/anthropic. OpenRouter now has the same LightningLoop-managed asserts as GeneralCompute. Gold / sandbox / credential boundaries unchanged. |
| Proof (this Linux VM) | Source edit only. **Not run:** xcodebuild / XCTest. GUI remains unproven until macos-app is green. |
| Production rows | **Unchanged.** LL-010 and LL-011 remain REWORK. |
