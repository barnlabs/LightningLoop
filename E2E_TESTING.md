# LightningLoop — Strict End-to-End Testing Requirement (with code)

This document is a **gate**, not a suggestion. No criterion in
[COMPLETION_CRITERIA.md](COMPLETION_CRITERIA.md) may be marked `DONE` unless it is
backed by **committed automated test code** and, where the surface requires it,
**captured end-to-end evidence bound to a specific build**. A separate critic (not
the implementer) verifies these gates.

## 0. Principles

1. **Code or it didn't happen.** Every behavioral criterion must have automated
   tests committed in the repo. Manual clicks are never sufficient on their own.
2. **End-to-end means end-to-end.** Prefer tests that exercise the real path
   (CLI → engine → provider adapter, or GUI → JSONL bridge → harness), not just an
   isolated helper. Unit tests are necessary but not sufficient for a `DONE`.
3. **Deterministic first.** Logic (filters, parsers, gates, validation) must be
   covered by deterministic unit tests with no network. Network/live paths get a
   separate, clearly-labelled integration/live test.
4. **Fail-closed is tested.** For every "happy path" test, add a negative test that
   proves the boundary (missing key, non-free model under `--free`, oversized/redirect
   fetch, non-catalogued model, credential in output → rejected).
5. **No secret leakage.** A test must assert that credentials never appear in
   `provider.json`, stdout/stderr, sessions, exports, or backups.

## 1. Test layers and where they run

| Layer | Tooling | Runs on | Command |
|-------|---------|---------|---------|
| Harness unit | `node --test` on `dist/**/*.test.js` | Linux/macOS/Windows | `npm run test:portable` (cross-platform subset) / `npm run test:harness` (full; macOS for sandbox tests) |
| Harness typecheck | `tsc --noEmit` | any | `npm run check:harness` |
| Harness integration (network) | `node --test`, tagged `integration`, real HTTPS to public endpoints (e.g. OpenRouter `/models`) | any with egress | `npm run test:integration` (to be added) |
| Harness live (keys) | `node --test`, tagged `live`, gated on env keys; **skips** when key absent | env with `CEREBRAS_KEY`/`OPENROUTER_KEY` | `npm run test:live` (to be added) |
| GUI unit | XCTest (`LightningLoopTests`) | macOS + Xcode | `xcodebuild ... -scheme LightningLoop test` |
| GUI UI journey | XCUITest (`LightningLoopUITests`) | macOS + Xcode (+ Accessibility) | `xcodebuild ... -scheme LightningLoopUI ...` |
| GUI E2E evidence | captured screenshots/screen-recording bound to a Debug build | macOS | recorded, stored with build id |

New harness test files MUST be added to the appropriate `package.json` script so CI
runs them. Cross-platform-safe tests go into `test:portable`. Live/integration tests
must **skip cleanly** (not fail) when their prerequisite (egress or key) is missing.

## 2. Per-criterion requirements (minimum)

Each `CC-*` criterion requires the tests below before it can be `DONE`.

### Providers / keys / models

- **CC-A1 OpenRouter selectable** — unit: `provider list` output includes openrouter;
  `saveProviderPreset("openrouter")` writes a profile that `parseProviderProfile`
  round-trips; the persisted file contains no credential.
- **CC-A2 Key entry** — unit: credential resolver returns the key from
  `OPENROUTER_API_KEY` and `OPENROUTER_KEY`; asserts the key is **not** in the saved
  profile and **not** printed by `doctor`. live: a minimal chat completion via the
  registered provider succeeds with the key present (skips without key).
- **CC-A3 Free-only discovery** — unit: `selectFreeModels` keeps only pricing==0,
  drops paid, handles malformed pricing; bounded parse rejects oversized/HTML bodies.
  integration: real `GET /models` returns ≥1 model and every `--free` result has
  zero prompt+completion price.
- **CC-A4 Model selection** — unit: selecting a discovered free id persists it;
  a non-free id under `--free` is rejected; an unknown id is rejected. integration:
  select from the live free list and round-trip.
- **CC-A5 Cerebras manual key** — live: run authenticates via manual key when
  `CEREBRAS_KEY` is set; negative unit: no key + no Pi session → clear fail-closed.
- **CC-A9 Fusion** — unit: router selects/aggregates ≥2 models per a strategy with
  per-contribution provenance; negative: provenance missing → rejected. live: a real
  2-model fusion run records both contributions.

### Three-agent roster / sources / browser / skills

- **CC-H1 Agents** — unit: roster parse/save/route; integration: `llp agents select` writes credential-free `agents.json`.
- **CC-H2 Source policy** — unit: TLD + host allowlist; negative: blog/local/credentialed URL rejected; loop research drops non-reputable hits.
- **CC-H3 Terminal browser** — unit: injected fetch (no-redirect, type/size); integration: `llp browse https://example.com/` fails closed.
- **CC-H4 GUI browser** — XCTest for `SourceTrust`; XCUITest/manual-macos for the Browser pane.
- **CC-H5 Skills** — unit: progressive disclosure loads only the current role's full skill bodies.

### Research

- **CC-B1 Keyless research** — integration: with no search key set, a research turn
  discovers ≥1 URL and opens ≥1 HTTPS source; asserts bounded/pinned/no-redirect.
  negative unit: redirect/oversized/non-HTTPS/credential-body → rejected.
- **CC-B2/B3** — unit: per-run caps (≤8 queries, ≤3/batch, ≤5 results, ≤2 opens);
  source class + hash preserved; allowlist not bypassable.

### Loop / image goal / completion

- **CC-C1** — already covered by `loop-engine.test.ts` (harsh gate, fail-closed pause).
  Keep green.
- **CC-C2 Completion oracle** — unit: with a valid owner/immutable objective oracle,
  a run reaches `gold`; without it, stays paused. integration: a scripted oracle run
  end-to-end. The critic role is exercised by a distinct evaluator, not the implementer.
- **CC-C3 Image goal** — integration: an image-goal run produces an image artifact +
  rendered-preview evidence and is scored against the target; live for real generation.

### Viewers / design / updates / docs (GUI-heavy)

- **CC-D1/D2/D3** — XCTest for load/hash-verification logic + XCUITest journey that
  opens the 3D viewer and image viewer; captured screen-recording of an interactive
  rotate/zoom bound to a Debug build.
- **CC-E1/E2** — brand/design audit checklist + captured UI evidence per primary flow.
- **CC-E3 Updates** — integration test against a **test signing channel**: manifest
  fetch → Ed25519 verify → byte-hash verify → apply on a throwaway install; negative:
  tampered manifest/bytes → refused. macOS installer smoke recorded.
- **CC-E4 Docs humanized** — automated link/format check (no broken links, headings
  valid); human/critic review of clarity against the humanizer skill.

## 3. The "loop toward completion" protocol (this request)

The owner asked to **loop and work toward completing this, requiring a separate
critic to evaluate for completion.** The mechanized protocol is:

1. **Pick the next `TODO`/`WIP` criterion(s)** from `COMPLETION_CRITERIA.md`.
2. **Implement** with tests per §2. Keep `check:harness` clean and `test:portable`
   green at all times.
3. **Self-verify**: run the required test layers; capture evidence for GUI/live rows.
4. **Critic evaluation (separate agent/human):** the critic re-runs the tests /
   reviews the evidence and records, per touched `CC-*` ID, a `PASS` (with cited
   evidence) or `FAIL` (with the exact missing predicate). The implementer may not
   self-certify a criterion.
5. **Only a critic `PASS` flips a row to `DONE`.** A `FAIL` returns to step 2.
6. Repeat until the "full easy usage" definition in `COMPLETION_CRITERIA.md` holds.

## 4. CI expectations

- `check:harness`, `test:portable`, `verify:lock-integrity`, and `npm audit` must be
  green on every PR (Linux-runnable).
- `test:integration` runs where egress is available; `test:live` runs only where keys
  are configured and otherwise **skips** (never a hard failure for missing secrets).
- Full `test:harness` and the Swift/Xcode suites run on macOS CI (`.github/workflows/ci.yml`).
- A criterion's PR description must list the `CC-*` IDs it advances and paste the
  test output / link the captured evidence for each.
