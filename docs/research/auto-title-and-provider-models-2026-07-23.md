# Research: auto title generation + loading models from providers

**Date:** 2026-07-23
**Product:** LightningLoop (`/Users/baney/Documents/Loop`, canonical `barnlabs/LightningLoop`)
**Purpose:** Ground two product gaps before implementation — (1) smarter session titles, (2) how models should appear from providers — without breaking LightningLoop’s Pi credential / catalog boundary.

---

## 1. What LightningLoop does today

### 1.1 Session titles (auto title)

| Fact | Evidence |
|------|----------|
| Default title is `"New loop"` | `LightningLoop/Models/LoopModels.swift` |
| Title is **not** LLM-generated | `AppModel.sessionTitle(for:)` is pure string logic |
| On goal edit, title becomes the goal (single-line), truncated at **92** chars with `…` | `AppModel.swift` `updateGoal` → `sessionTitle` |
| Migration rewrites legacy titles that were exactly the truncated goal | same file |
| Notifications use the same title helper (sanitized) | `startClarification` / completion paths |
| Sidebar and workspace show `session.title` | `SidebarView`, `LoopWorkspaceView` |
| No “user renamed / lock auto-title” flag | no field on session model for title provenance |

**Confidence:** `[VERIFIED]` from source.

**Implication:** “Auto title” today is a **provisional heuristic** (first-line goal slice). That matches the *first* stage of industry patterns, but never does the *second* stage (summarize into a short name).

### 1.2 Loading models from providers

LightningLoop intentionally uses **two different paths**:

| Path | Who | Network | Credentials | UI action | Used for loop execution |
|------|-----|---------|-------------|-----------|-------------------------|
| **Built-in presets** (Cerebras, Groq, Fireworks, xAI, OpenAI Codex, Anthropic) | Shared runtime (`ModelRuntime` from Pi) | **`allowModelNetwork: false`**, `modelsPath: null` | Never read by LL; Pi owns auth | **Refresh Runtime Models** → RPC `providerModels` | **Yes** — create/continue revalidate snapshot |
| **Custom OpenAI-compatible** | Native `ProviderClient.listModels()` | `GET {baseURL}/models` with Bearer key | LL Keychain only for custom | **Discover Models & Test** | **No** — custom cannot run loops without harness; native test is connection-only |

**Runtime catalog construction** (`Harness/rpc/server.ts`):

```text
ModelRuntime.create({ credentials: inert store, modelsPath: null, allowModelNetwork: false })
  → runtime.getModels(piProviderID)
  → map id/name/image/context/maxTokens
  → selectedModelCatalogued = models.some(id === profile.modelID)
```

**Fail-closed gates** (same server + GUI):

- `model_unavailable` if selected ID not in installed catalog
- `model_catalog_drift` if image/context/output limits changed after selection
- `model_selection_mismatch` if GUI expected provider/model ≠ saved profile
- GUI rejects **stale** catalog responses when provider or model changed mid-flight
- Cerebras `gemma-4-31b` is a **public-preview preference**, not entitlement (`docs/MODEL_SELECTION.md`, Cerebras catalog)

**Confidence:** `[VERIFIED]` from source + existing product docs.

**User-facing confusion risk:** Buttons and copy say “runtime catalog,” but users often hear “models from Cerebras/Groq.” Today those lists are **pinned installed Pi definitions**, not a live provider account list.

---

## 2. External patterns — auto title generation

### 2.1 Dominant product pattern (open-source chat UIs)

Cross-checked Open WebUI discussions and Hermes WebUI issue threads:

1. **Provisional title immediately** from the first user message (trim + truncate) so the sidebar is never empty.
2. **After first full exchange** (user + assistant), a **separate small completion** rewrites a short title.
3. **Fallback** to the provisional string if the model returns junk, chain-of-thought leakage, or empty output.
4. **Optional dedicated “title model”** (cheaper/faster) separate from the main chat model.
5. **Structured output** preferred: JSON `{ "title": "..." }` so parsing is reliable.
6. **Prompt constraints:** 3–5 words (or short phrase), primary language of the chat, no quotes, optional emoji (product choice), “respond only with title.”

Sources (secondary, implementation practice):

- Open WebUI title prompt discussions (default template: 3–5 words + emoji + JSON)
- Hermes WebUI: provisional first-message title → LLM rewrite after first exchange; 64-char first-message slice is the placeholder
- OpenAI Codex issue #9849: “Default title heuristic: first meaningful user message (trim + truncate to ~40 chars)”

**Confidence:** `[CORROBORATED]` across multiple independent open-source products; not a formal RFC.

### 2.2 Failure modes (documented in the wild)

| Failure | Symptom | Mitigation used by others |
|---------|---------|---------------------------|
| Model echoes the prompt | Titles start with “Alright, I need to create…” | Strict output format + strip prefixes + fallback |
| Wrong/aux model not used | Always shows first-message slice | Explicit title-generation model setting |
| Overwrites user rename | User renames, next turn rewrites | `title_locked` / “manual title” flag |
| Credential leakage in title | Goal contained API key | Sanitize before title (LL already has credential sanitizer) |
| Extra cost / latency | Every chat pays a completion | Cheap model, max_tokens small, once per session |

**Confidence:** `[CORROBORATED]`.

### 2.3 Fit for LightningLoop specifically

LightningLoop sessions are **goal-driven loops**, not freeform multi-turn chat:

| Signal available for title | When |
|----------------------------|------|
| Goal text | Immediately on edit (already used) |
| Clarifying Q&A | After clarification |
| Plan criteria titles | After plan stage |
| Gold / blocked final message | End of run |

So LL has **richer structured signals** than a chat app, and can do better than “first user message only” without always paying for a title LLM call.

---

## 3. External patterns — loading models from providers

### 3.1 Industry API shape

| Provider family | List endpoint | Auth | What list means |
|-----------------|---------------|------|-----------------|
| OpenAI | `GET /v1/models` | Bearer API key | Models available to **that account/org** (not global marketing catalog) |
| Groq (OpenAI-compatible) | `GET https://api.groq.com/openai/v1/models` | Bearer | Active models for key |
| OpenAI-compatible custom hosts | Usually `GET {base}/models` | Bearer | Host-defined |
| Cerebras public docs | Human **Model Catalog** pages (production vs preview) | N/A for docs | Marketing/docs catalog ≠ account entitlement; preview can be discontinued |

OpenAI docs: list returns `id`, `object`, `created`, `owned_by` — **not** a full capability matrix (context window, image support). Clients must merge list IDs with **known metadata tables** or separate capability docs.

Groq documents the same list endpoint pattern.

Cerebras public catalog (2026-07-23 fetch of model overview):

- Production example: `gpt-oss-120b`
- Preview examples: `gemma-4-31b`, `zai-glm-4.7` (preview / deprecation notes on some)
- Preview: evaluation only, may discontinue on short notice

**Confidence:** `[VERIFIED]` for OpenAI/Groq list APIs and Cerebras catalog page content this session.

### 3.2 Two meanings of “load models” (must not conflate)

| Meaning | Definition | Proves |
|---------|------------|--------|
| **A. Marketing / installed catalog** | IDs the client *knows how to request* (docs pin, bundled JSON, Pi package) | Product can form a valid request shape |
| **B. Account-available models** | IDs returned by authenticated `GET /models` for this key | Account may call that ID *now* (still not rate-limit or billing proof) |
| **C. Capability metadata** | context window, vision, max output | Safe UI + request bounds |

LightningLoop built-ins today implement **A + C** from Pi’s installed definitions, with explicit denial that B is not queried (`catalogScope` string on `providerModels` response). Custom path implements **B** (IDs only) and incomplete C (user-entered toggles/steppers).

That is a deliberate security design:

> Pi owns credentials and catalogs for built-ins. LightningLoop must not call built-in `/models` with keys it does not hold.

**Confidence:** `[VERIFIED]` product invariant (`AGENTS.md`, `MODEL_SELECTION.md`, RPC comments).

### 3.3 Trade-offs if LightningLoop “loaded models from providers” naively

| Approach | Breaks? | Notes |
|----------|---------|-------|
| GUI `GET /models` for Cerebras/Groq with Keychain | **Yes** for built-ins | LL deliberately does not hold those keys; would re-create credential ownership |
| Harness uses Pi credentials to network-refresh catalog | Possibly OK | Auth stays in Pi; LL still only sees metadata; needs Pi API that allows network with user auth |
| Pin only (current) | No | Stale pins if Pi package lags public preview models |
| Docs scrape / hardcode Cerebras marketing table | Fragile | Preview churn; no entitlement |
| Hybrid: pin metadata + optional Pi “refresh from provider” | Best | LL stays credential-free; freshness improves |

---

## 4. Gaps vs “finished product” feel

### Auto title

| Gap | Severity | User impact |
|-----|----------|-------------|
| Long goals make sidebar unreadable (92-char dump) | Medium | Hard to scan history |
| No short semantic name after plan/clarify | Medium | Loops look like truncated prose |
| Goal edit always rewrites title | Medium | Cannot keep a short name if refining the goal |
| No manual rename UI | Medium | Power users stuck |
| LLM title would spend provider tokens | Low if optional | Must be explicit / fail soft |

### Model loading

| Gap | Severity | User impact |
|-----|----------|-------------|
| “Refresh Runtime Models” ≠ live provider list | High (expectation) | “Where is Gemma?” when pin lacks it |
| Custom discover: IDs only, no names/capabilities | Medium | User must hand-edit context/vision |
| No automatic refresh on Settings open for all paths | Low | Extra click |
| Catalog presence ≠ signed-in / entitled | Doc/UX | Already warned; must keep |
| Built-in presets hardcode preferred IDs that can age | Medium | Checklist already notes aging presets |

---

## 5. Recommended product design (research → implement later)

### 5.1 Auto title — three layers (recommended)

**Layer 0 — Provisional (ship-compatible, already mostly there)**
- Keep `sessionTitle(for:)` but improve heuristics:
  - collapse whitespace
  - strip common prefixes (“please ”, “i want to ”, “help me ”)
  - take first sentence or first ~8 words
  - hard cap **48–60** visible chars (sidebar), not 92
- Still offline, free, deterministic, testable.

**Layer 1 — Structured local upgrade (no extra LLM)**
After clarification or plan exists:

```text
prefer: first plan step title OR first criterion title
else: improved goal heuristic
```

Still deterministic; fits evidence-first product.

**Layer 2 — Optional LLM title (opt-in or post-first-successful-provider-turn)**
- One harness `complete` with **tiny** max tokens, JSON `{title}` only
- Input: redacted goal + optional plan titles (never credentials)
- Only if session `titleSource != .manual`
- Fail soft → Layer 1
- Do **not** block Gold/pause on title failure
- Record metrics separately if cost envelope (LL-019) cares

**Session model fields to add:**

```text
title: String
titleSource: provisional | structured | llm | manual
titleLocked: Bool  // true after user rename
```

**Tests:** pure functions for heuristic; no network in unit tests; LLM path mocked.

**Confidence:** `[RECOMMENDED]` design synthesis.

### 5.2 Loading models — keep boundary, improve freshness UX

**Do not:** make the macOS GUI call built-in provider `/models` with secrets.

**Do:**

1. **Clarify copy** in Settings:
   “Installed runtime catalog (not live account inventory). Catalogued ≠ signed-in.”
   Current `catalogScope` string is correct; surface it more prominently.

2. **Refresh ergonomics**
   - On opening Settings Provider tab for a built-in: auto `refreshRuntimeModelCatalog()` once per selection (already partly on save).
   - Show empty/error/offline states distinctly (feeds LL-011 long-state QA).

3. **Custom path upgrade**
   - Map OpenAI list → picker with `id` as modelID and display name = id until richer metadata exists.
   - Optional: after select, leave context/vision user-editable (already).
   - Never auto-run Discover on every keystroke.

4. **Optional future: Pi-mediated network catalog**
   - New harness flag only if Pi supports refreshing installed models **with Pi-held credentials** and still returns credential-free metadata to LL.
   - Same validation: max 500 models, no dups, bounds, drift checks.
   - Keep `allowModelNetwork: false` as default fail-closed.

5. **Cerebras Gemma**
   - Keep preference + catalog guard (matches Cerebras preview policy).
   - When not catalogued, UI already explains; ensure picker lists only real catalog entries so users can switch to `gpt-oss-120b` etc. without fighting the preference.

**Confidence:** `[RECOMMENDED]` aligned with existing LL-027 / security model.

---

## 6. Cross-ref matrix

| Claim | Source A | Source B | Status |
|-------|----------|----------|--------|
| LL titles are goal truncation only | `AppModel.sessionTitle` | Sidebar uses `session.title` | Agree |
| Built-in catalog is network-disabled pin | `server.ts` ModelRuntime.create | `MODEL_SELECTION.md` | Agree |
| Custom uses `/models` + key | `ProviderClient.listModels` | Settings Discover button | Agree |
| Chat apps use provisional + LLM rewrite | Hermes WebUI issues | Open WebUI title prompts | Agree |
| OpenAI/Groq expose list-models | OpenAI API ref | Groq docs | Agree |
| Cerebras Gemma is preview | Cerebras model catalog page | LL docs + preference notice | Agree |
| List models = entitlement | OpenAI list is account-scoped | LL docs deny entitlement claim | Agree (with nuance: list ≠ unlimited use) |

---

## 7. Contradictions / open questions

1. **Should LLM titles use the active loop model or a fixed cheap model?**
   - Cheap/fixed: stable cost; may not exist on every provider.
   - Active model: works everywhere catalogued; may be expensive (Gemma 31B for 5 words).
   - Recommendation: active model with hard max_tokens (~32) and once-only.

2. **When does title lock after structured upgrade?**
   - If user edits goal heavily, refresh provisional only when `titleSource == provisional`.

3. **Can Pi refresh models over the network without LL holding keys?**
   - Needs Pi API confirmation; not verified this session beyond current `allowModelNetwork: false` usage.

4. **TUI parity**
   - Any title/model UX must exist in TUI or be documented GUI-only.

---

## 8. Suggested implementation order (for finish work)

1. **Heuristic title v2** + `titleSource` / manual lock + rename in sidebar (no network).
2. **Settings copy + auto-refresh catalog** on provider select (built-in).
3. **Custom discovered-model picker polish** (still IDs).
4. **Optional LLM title** after plan or after first harness turn (feature flag / settings toggle).
5. **Explore Pi-mediated live catalog** only if product still feels “stale” after (2).

Do **not** fold signing/notarize MISSING rows into this; these are product UX completion items under the existing REWORK cluster (LL-027 adjacent for models; new checklist row for titles if shipping).

---

## 9. Source inventory (this session)

| # | Source | Type | Use |
|---|--------|------|-----|
| 1 | Local LightningLoop Swift/TS (AppModel, ProviderClient, SettingsView, rpc/server.ts, provider-profile.ts) | Primary | Current behavior |
| 2 | `docs/MODEL_SELECTION.md`, `PRODUCTION_READINESS_CHECKLIST.md` LL-027 | Primary | Product policy |
| 3 | OpenAI List models API reference | Primary | Industry list shape |
| 4 | Groq Supported Models / list endpoint docs | Primary | Compatible list shape |
| 5 | Cerebras Inference Model Catalog page | Primary | Preview vs production IDs |
| 6 | Open WebUI title generation discussions | Secondary | Prompt/UX patterns |
| 7 | Hermes WebUI auto chat names issues | Secondary | Provisional → LLM rewrite |
| 8 | openai/codex issue #9849 (tab titles) | Secondary | Heuristic defaults |

CRAAP: primary product + official API docs ≥10/15 for core claims; open-source UX threads used only for pattern, not as authority on LL security.

---

## 10. Bottom line

- **Auto title:** LL already has stage-0 (goal truncate). Finishing “auto title generation” means (a) better offline heuristic + rename lock, then (b) optional one-shot LLM or structured plan-based titles — without treating title quality as Gold evidence.
- **Loading models from providers:** LL **must not** impersonate provider auth for built-ins. “Load models” correctly means **refresh the Pi/runtime installed catalog** (and custom `/models` only for Custom). UX should stop implying live account inventory unless a **Pi-mediated** network refresh is designed and proven. Catalogued ≠ entitled remains non-negotiable.

---

## 11. Implementation status (2026-07-23)

Shipped in-tree:

- `LightningLoop/Support/SessionTitle.swift` — provisional / structured / LLM parse helpers
- `LoopSession.titleSource` + `titleLocked` with legacy decode defaults
- Sidebar rename + unlock auto-title
- Clarification / planning events apply structured titles; optional custom-only LLM (`autoTitleLLMEnabled`)
- Settings: runtime catalog honesty copy, auto-refresh on Providers appear, custom discovered-model picker polish
- Docs: `docs/SESSION_TITLES.md`, `docs/MODEL_SELECTION.md`
- Tests: `LightningLoopTests/SessionTitleTests.swift` (native suite 80/80)
- Finish workflow: ProductUX phase in `.grok/workflows/finish-lightningloop.rhai`
