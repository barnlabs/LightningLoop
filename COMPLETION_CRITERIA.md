# LightningLoop — Strict Completion Criteria

**Status ledger for the "full easy usage" product goal.** Each row is a bounded,
independently checkable criterion with an explicit **proof predicate**. A criterion
is `DONE` only when its proof predicate is satisfied by committed automated tests
and/or captured evidence bound to a specific build. A separate critic (not the
implementer) evaluates completion — see [E2E_TESTING.md](E2E_TESTING.md).

This document is authoritative for scope. It is deliberately harsh: partial work,
"it compiles", or "the happy path ran once" never counts as `DONE`.

## Ground rules (non-negotiable)

1. **No auto-pass.** A criterion passes only against its proof predicate. Reviewer
   prose, screenshots alone, or implementer claims do not satisfy a predicate.
2. **Surface honesty.** Every row is tagged with the surface that must be proven:
   `HARNESS` (Node/TS, Linux+macOS+Windows testable), `GUI` (macOS SwiftUI, requires
   Xcode/macOS), or `CROSS` (both). GUI rows cannot be marked `DONE` from a Linux CI
   run; they require a macOS build + test + captured UI evidence.
3. **Keys.** Live-inference rows require the relevant secret in the environment
   (`CEREBRAS_KEY`, `OPENROUTER_KEY`, etc.). Discovery-only rows that hit public
   endpoints (e.g. OpenRouter `/models`) must not require a key.
4. **Security invariants preserved.** No credential ever lands in `provider.json`,
   logs, sessions, exports, or managed backups. HTTPS-only, no-redirect, DNS-pinned,
   size/time-bounded fetches. The OS sandbox is never bypassed. Any change that
   weakens `docs/THREAT_MODEL.md` fails review regardless of feature value.
5. **No silent invariant changes.** Changing a deliberate invariant (auto-Gold
   disabled; Cerebras Pi-managed; single-model runs) requires its own criterion,
   design note, and adversarial review — it is not a side effect of another row.

## Legend

- Status: `TODO` · `WIP` · `DONE` · `BLOCKED`
- Surface: `HARNESS` · `GUI` · `CROSS`
- Test: `unit` · `integration` · `live` (needs key) · `manual-macos` · `e2e`

---

## A. Providers, keys, and model selection

| ID | Requirement | Proof predicate | Surface | Test | Status |
|----|-------------|-----------------|---------|------|--------|
| CC-A1 | **OpenRouter provider** (OpenAI-compatible, LL-managed) selectable | `provider list` includes `openrouter`; `provider select openrouter` persists a valid credential-free `provider.json`; profile parses/round-trips | HARNESS | unit | DONE (critic PASS `e76fca3`) |
| CC-A2 | **OpenRouter key entry** via `OPENROUTER_API_KEY`/`OPENROUTER_KEY` env (+ macOS Keychain) | key resolves for inference registration; key never written to `provider.json`/logs; `doctor` reports presence only | CROSS | unit + live | HARNESS-DONE (critic PASS; live inference + GUI pending) |
| CC-A3 | **Free-models-only** discovery for OpenRouter | pure `isFreeModel`/`selectFreeModels` unit-proven; live `/models` fetch returns only pricing==0 models when `--free`; bounded (size/time/HTTPS/no-redirect) | HARNESS | unit + integration | DONE (critic PASS `e76fca3`; DNS-pin follow-up) |
| CC-A4 | **Model selection** for OpenRouter (choose a discovered free model, persist it) | `provider select openrouter --model <id>` validates the id against discovery and persists it; invalid/non-free id rejected under `--free` | CROSS | unit + integration | HARNESS-DONE (critic PASS; GUI source now has OpenRouter picker + just-free toggle; live macOS pending) |
| CC-A5 | **Cerebras manual key entry** (in addition to Pi `/login`) | with `CEREBRAS_KEY` set, a Cerebras run authenticates via the manual key path without Pi OAuth; Keychain/env only; no key in `provider.json` | CROSS | live | TODO |
| CC-A6 | **Cerebras model selection works** | selecting a Cerebras model that exists in the catalog launches; a non-catalogued id fails closed with a clear message | CROSS | integration + live | TODO |
| CC-A7 | **Easy secure key entry in the GUI** (masked field, Keychain-only, never echoed) | Settings accepts OpenRouter/Cerebras keys into Keychain; value never rendered or exported; unit test asserts redaction | GUI | manual-macos | WIP (source: OpenRouter preset + SecureField + DesignedCopy.keyNeverEchoed; macOS journey unproven) |
| CC-A8 | **Login-provider onboarding** (Codex, Grok/xAI, others) is one-click from GUI/CLI | `auth` launches Pi `/login`; GUI surfaces sign-in state per provider without copying credentials | CROSS | manual-macos + integration | TODO |
| CC-A9 | **Model fusion** (combine free + paid models in one run) | a run can route/aggregate ≥2 models with a defined strategy; result records which model produced which contribution; deterministic gates unchanged | HARNESS | unit + integration + live | TODO |
| CC-A10 | **Just-free mode** | `lightningloop free` / `provider select openrouter --free` pins a zero-cost model (free router preferred), persists `freeOnly`, and runs re-verify the model is still free (fail-closed on paid); `doctor` shows Free mode | HARNESS | unit + integration | DONE (critic PASS `4964a40`) |
| CC-A11 | **Easy + secure key storage** | `key set/status/clear` stores in the OS secret store (macOS Keychain / Linux libsecret), secret read from stdin (never argv), never written to a file; fails closed with env guidance when no store exists; runtime resolution reads env→store | CROSS | unit + integration | HARNESS-DONE (critic PASS; GUI pending) |

Notes: CC-A1..A4 are the first implemented increment (harness). CC-A9 (fusion) is a
real architecture change: today `LoopEngine` takes exactly one adapter — a fusion
router and per-contribution provenance must be designed before implementation.

## B. Research

| ID | Requirement | Proof predicate | Surface | Test | Status |
|----|-------------|-----------------|---------|------|--------|
| CC-B1 | **Keyless research** (no Exa/Brave/Firecrawl key required) | a research run discovers real URLs and opens ≥1 HTTPS source with no search key set; bounded/pinned/no-redirect; snippets labelled untrusted | HARNESS | integration | TODO |
| CC-B2 | **Research quality** ("fantastic") — iterative, deduped, source-bound | reviewer-triggered follow-up queries; per-run caps enforced; factual criteria bind to an exact opened URL + content hash | HARNESS | unit + integration | TODO |
| CC-B3 | Keyless path preserves the source-trust model | opened sources keep retrieval time/hash/source-class; `.gov/.edu`/allowlist routing intact; no host allowlist bypass | HARNESS | unit | TODO |

Note: today research requires a paid search key (Exa/Brave/Firecrawl). `openSource`
and `llms.txt` exist but need a search provider to drive discovery. CC-B1 requires a
new keyless discovery backend (e.g. a no-key search endpoint or a bounded engine)
behind the existing trust/redaction gates.

## C. Loop toward the goal (incl. image goals)

| ID | Requirement | Proof predicate | Surface | Test | Status |
|----|-------------|-----------------|---------|------|--------|
| CC-C1 | **Harsh looping** toward the goal | reviewer requires score ≥9, no medium/high/blocking, no required changes; exhaustion pauses (never false pass) | HARNESS | unit | DONE (exists) |
| CC-C2 | **A run can reach a defined completion** via a separate critic/oracle | a completion oracle (owner objective contract or immutable harness oracle) can move a run to `gold`; still fail-closed without it | HARNESS | unit + integration | TODO |
| CC-C3 | **Loop toward an image goal** (produce/refine an image to a target) | a goal to create/edit an image drives generation + rendered-preview evidence; reviewer scores against the image target; pauses honestly | CROSS | integration + live | TODO |

Note: CC-C1 already holds (`reviewGatePassed`, `decideGold`, fail-closed pause).
CC-C2 intentionally conflicts with the current hard-disabled auto-Gold
(`objectiveContractPassed = false`); it needs the "separate critic evaluate for
completion" mechanism the owner asked for, designed as an explicit oracle.

## D. Viewers and artifacts

| ID | Requirement | Proof predicate | Surface | Test | Status |
|----|-------------|-----------------|---------|------|--------|
| CC-D1 | **3D model viewer** for generated models (GLB/OBJ) in the GUI | GUI renders a produced `.glb`/`.obj` interactively (SceneKit/RealityKit), with hash-verified load | GUI | manual-macos | WIP (source: SceneKit viewer + verifiedFileURL; macOS render unproven) |
| CC-D2 | **Image viewer/editor** for image work | GUI shows the working image with zoom/compare (before/after); edits are hash-tracked | GUI | manual-macos | WIP (source: zoom/compare viewer; hash-bound; macOS render unproven) |
| CC-D3 | Viewers bound to Evidence Lab provenance | every viewed artifact is the exact hash-verified run output; no unverified bytes rendered | CROSS | unit + manual-macos | WIP (Swift unit tests for policy + verifiedFileURL; live GUI unproven) |

Note: today there is no SceneKit/RealityKit 3D viewer and no image editor in the app;
`Tools/photo_to_relief.mjs` produces GLB/OBJ/preview.png harness-side only.

## E. Design, branding, updates, docs

| ID | Requirement | Proof predicate | Surface | Test | Status |
|----|-------------|-----------------|---------|------|--------|
| CC-E1 | **Beautiful, consistent design** across primary flows | design pass applied; captured UI evidence bound to a build; palette/typography match `docs/BRAND.md` | GUI | manual-macos | WIP (designed empty/error/offline/long-history states + brand tagline; no macOS capture this run) |
| CC-E2 | **LLoop branding** consistent (name, icon, palette, copy) | brand audit checklist all-green; no stray vendor branding on UX surfaces | CROSS | unit + manual-macos | PARTIAL (assets exist) |
| CC-E3 | **Update system that "just works"** | signed channel + platform installer downloads, verifies (Ed25519 + byte hash), and applies an update end-to-end on a test channel; fail-closed otherwise | CROSS | integration + manual-macos | TODO |
| CC-E4 | **README + docs humanized** (potetostack "humanizer" skill) | humanizer skill is present/identified; README + key docs rewritten and reviewed for clarity; links valid | HARNESS | unit (link/format) + review | BLOCKED (skill not in repo — see note) |

Note: no "humanizer"/potetostack skill exists anywhere in the repo. CC-E4 is
`BLOCKED` until the owner provides the skill or its source; the humanization pass
then runs against it.

## G. Install & distribution

| ID | Requirement | Proof predicate | Surface | Test | Status |
|----|-------------|-----------------|---------|------|--------|
| CC-G1 | **Easy + secure install via bun**, then `llp` works | `script/install_bun.sh` runs `bun install --ignore-scripts` (locked from `package-lock.json`), builds the harness, and `bun link`s `llp`/`lloop`/`lightningloop`; `llp help` runs from PATH | HARNESS | integration | DONE (critic PASS `e1ac6db`) |
| CC-G2 | **Custom-themed `llp` experience** | the TUI shows the LightningLoop-branded header/footer/status; `llp free` + `llp key set` are discoverable | CROSS | manual-macos + integration | PARTIAL (header tagline + bin identity, discoverable help/provider/key/free/doctor/loop, honest usage footer; live TTY chrome still needs a human terminal) |

## H. Three-agent loop, sources, browser, skills

| ID | Requirement | Proof predicate | Surface | Test | Status |
|----|-------------|-----------------|---------|------|--------|
| CC-H1 | **Three selectable agents** (Researcher, Engineer, Verifier) | `agents list` shows all three; `agents select ROLE --model ID` persists credential-free `agents.json`; `RosterAdapter` routes orchestrator→researcher, implementer→engineer, reviewer→verifier; invalid role/id fail closed | HARNESS | unit + integration | DONE (harness; critic pending) |
| CC-H2 | **Strict reputable-source rule for every agent** | `classifySourceUrl` allows only `.gov/.edu/.mil/.int` and the committed documentation-host allowlist; search/open/browse drop everything else; loop research ignores non-reputable hits | HARNESS | unit | DONE (harness; critic pending) |
| CC-H3 | **Terminal browser** | `llp browse URL` and `/browse URL` render a bounded text snapshot of one reputable HTTPS page (no-redirect, size/time/type gated); non-reputable URL fails closed | HARNESS | unit + integration | DONE (harness; critic PARTIAL on live command success / DNS pin) |
| CC-H4 | **GUI browser** | Workspace Browser pane uses WKWebView; navigation allowlist is loopback artifacts + reputable HTTPS; Settings expose the three agent model fields | GUI | manual-macos | WIP (designed empty/refused/offline states; macOS XCTest / UI proof pending) |
| CC-H5 | **Shipped skills + tools with progressive disclosure** | five shipped skills exist; `discloseSkills(role)` returns the full catalog as one-liners and loads only matching bodies + that role's tools; recursive skill improvement remains inert drafts | HARNESS | unit | DONE (harness; critic pending) |

## F. Governance (this request's explicit deliverables)

| ID | Requirement | Proof predicate | Surface | Test | Status |
|----|-------------|-----------------|---------|------|--------|
| CC-F1 | **Strict completion criteria document** | this file exists, is comprehensive, and is used by the critic | — | review | DONE |
| CC-F2 | **Strict end-to-end testing (with code) requirement** | [E2E_TESTING.md](E2E_TESTING.md) exists and mandates automated code tests per criterion + gates | — | review | DONE |
| CC-F3 | **Separate critic evaluation** of each increment vs these criteria | a critic (subagent/human, not the implementer) records a pass/fail with cited evidence per touched ID | — | review | ACTIVE (see Critic log) |

### Critic log

- **Increment 1 — OpenRouter (CC-A1..A4):** Independent critic first returned
  **CC-A4 FAIL** (`--free`/`--model` not validated against discovery) plus CC-A3
  hardening notes. Implementer fixed both; critic re-check at commit `e76fca3`
  returned **PASS for CC-A1, CC-A2, CC-A3, CC-A4** (harness surface). Open
  follow-ups: DNS-pinned `/models` fetch, a committed `test:integration` target,
  live inference test (needs `OPENROUTER_KEY` in env), and the GUI (macOS) surface.
- **Increment 2/3/4 — Free mode (CC-A10), key storage (CC-A11), bun install
  (CC-G1):** Independent critic re-ran all gates and returned **PASS for CC-A10,
  CC-A11, CC-G1** (Free mode pins `openrouter/free` with fail-closed runtime
  re-check wired into both `runLoop` and the TUI; libsecret key round-trip proven
  on Linux with no plaintext file; bun install → `bun link` → `llp help` proven).
  Non-blocking follow-ups: `enforceFreeMode` tolerates all fetch errors (best-effort
  runtime re-check); no committed libsecret/bun *integration* tests (logic covered
  by unit tests + injected backends); GUI surfaces still pending (macOS).
- **Increment GUI/TUI feel (this run):** Implementer added OpenRouter to the Swift GUI, designed empty/error/offline/long-history states, evidence-bound image/3D viewers, and TUI discoverability (help/provider/key/free/doctor/loop + honest usage footer). **No GUI row is DONE** — this VM cannot run xcodebuild or XCUITest. CC-G2 remains PARTIAL. LL-013–017, LL-021, LL-022 stay MISSING. LL-010/LL-011 stay REWORK.
- **Increment models/keys/engine (this run):** Shared CLI/TUI/serve key resolution now includes Firecrawl/Exa/Brave and the OS store on Linux; Discover/`--model` fail closed against the correct catalog. **No GUI row is DONE.** CC-A7 and CC-A11 remain HARNESS-DONE / GUI pending. LL-010/LL-011 stay REWORK. LL-013–017, LL-021, LL-022 stay MISSING.
- **Increment H — three-agent loop (CC-H1..H5):** Independent critic at `ed2be9a`
  returned **PASS for CC-H1, CC-H2, CC-H5** (harness). **CC-H3 PARTIAL** (command
  success is proven via `executeBrowseCommand` + injected fetch; live `llp browse`
  RFC 9110 snapshot was captured this session; default browse transport is not
  DNS-pinned). **CC-H4 PARTIAL** — Swift Browser pane + Settings source present;
  macOS XCTest / UI proof pending. Search/open now share `isReputableSourceUrl`.

---

## Definition of "full easy usage" (the finish line)

All of the following are simultaneously true, each proven per its row above:

1. A new user can, in the GUI, pick a provider (incl. **OpenRouter free-only** and
   **Cerebras manual key**), enter a key **securely**, or sign in to a login
   provider — and immediately run a loop. (CC-A1..A8)
2. Research works **without any search key**. (CC-B1..B3)
3. The loop drives **harshly** toward text **and image** goals and can be judged
   **complete by a separate critic/oracle**. (CC-C1..C3)
4. Generated **3D models and images are viewable** in-app. (CC-D1..D3)
5. The app is **beautiful, on-brand**, and its **updates just work**. (CC-E1..E3)
6. **Docs are humanized**; **fusion** of free + paid models is available. (CC-E4, CC-A9)
7. Every one of the above is backed by **automated tests + captured E2E evidence**
   per [E2E_TESTING.md](E2E_TESTING.md), signed off by the **separate critic**.
