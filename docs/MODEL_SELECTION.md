# Model selection

LightningLoop keeps provider authentication, credentials, and model catalogs inside the shared LightningLoop runtime. The macOS GUI stores only a bounded, credential-free provider profile containing the selected model metadata. It never calls a built-in provider's `/models` endpoint, reads a provider credential for that path, or falls back to native inference.

A new user picks a real catalogued model on the installed app (macOS Settings, TUI `/models`, or `llp` / `lloop` CLI) in one minute: choose a preset, load the catalog, pick a listed ID, persist it. Unknown IDs and missing host keys fail closed with a clear `model_unavailable` or `key set NAME` message. LightningLoop never invents a model and never silently substitutes another ID.

## Surfaces

| Surface | List / pull | Add / pick | Persist |
|---------|-------------|------------|---------|
| CLI (`llp`, `lloop`, `lightningloop`) | `provider models` | `provider pick N\|ID` or `provider add ID` | writes `provider.json` (no secrets) |
| TUI | `/models` | `/models N` or `/models add ID` | same file; `/loop` uses the new ID |
| macOS GUI | **Load catalog** (Pi runtime) or **Load models** (OpenRouter / host) | catalogued picker | picker save is immediate |

`provider select PRESET --model ID` still persists only a catalogued ID. A bare `provider select PRESET` writes that preset's guarded default so first-run can continue; the next `models` / `pick` step is how you replace it with a listed ID. Execution still fail-closes if the saved ID is not in the current catalog.

## Built-in providers (Pi-managed)

1. Selecting a built-in provider resets its profile to that provider's guarded preferred model.
2. **Load catalog** / `provider models` / `/models` asks the shared runtime for its installed model catalog. The response contains only validated model metadata—never credential values, account identifiers, or authentication status.
3. The picker permits only models catalogued by that installed runtime. Saving copies the chosen model ID, display name, image capability, context window, and output bound into the local profile.
4. Before creating or continuing a run, the harness checks that the selected built-in model is still catalogued. Otherwise it returns `model_unavailable` before constructing an agent or sending a provider request.

The GUI binds each asynchronous catalog response to both the provider ID and model ID that requested it. A same-provider selection change invalidates the in-flight response, clears its catalog state, and asks the user to refresh again; stale metadata can never announce the new selection as catalogued.

The catalog process uses an inert in-memory credential store with model-network refresh disabled. It does not read the runtime authentication store, query a provider, or infer account eligibility. Catalogued is exact installed-catalog presence, not a claim about account entitlements.

OpenRouter's public catalog and Pi runtime catalogs auto-load when Settings appears. GeneralCompute and Custom wait for **Load models** because those hosts require a key. UI tests set `LIGHTNINGLOOP_UI_TESTING=1` so fixtures are not overwritten.

## Cerebras: Gemma 4 31B

The Cerebras preference is `Gemma 4 31B` with model ID `gemma-4-31b`. Cerebras lists it as a **public preview** model, with preview image inputs. On selecting Cerebras, the GUI displays that preference and immediately refreshes the installed runtime catalog.

If the installed runtime does not catalogue that exact model ID, the GUI explains the preview/catalog guard, prevents saving it after a catalog refresh, and the harness blocks execution with a clear `model_unavailable` error. The user can instead select another catalogued runtime model. This guard does not inspect sign-in state or provider entitlement.

This reflects Cerebras' [model catalog](https://inference-docs.cerebras.ai/models/overview), which lists `gemma-4-31b` as Gemma 4 31B Preview, and its [image-input documentation](https://inference-docs.cerebras.ai/capabilities/image-inputs), which identifies that model as the current image-input preview. Preview availability may change; the pinned runtime catalog remains the local execution guard.

## GeneralCompute

GeneralCompute is a LightningLoop-managed fixed preset (not Pi-managed). Selecting it resets to preferred model `minimax-m2.7` (`MiniMax M2.7`) at base URL `https://api.generalcompute.com/v1` with 192k context and a schema-capped 131072 max output tokens, text-only. Store the API key in Settings (Keychain) or set `GENERALCOMPUTE_API_KEY`. Use **Load models** for account-visible model IDs; the harness registers the profile via `registerProvider` and never claims Pi `/login` ownership. A missing key fails closed (`lightningloop key set generalcompute`). See [generalcompute-provider-2026-07-25.md](research/generalcompute-provider-2026-07-25.md).

## LightningLoop-managed catalogs

LightningLoop-managed presets (OpenRouter, GeneralCompute, Custom) expose **Load models** in Settings, `lightningloop provider models` on the CLI, and `/models` in the TUI.

- **OpenRouter:** public `GET /models`. No key is read. The GUI and harness never send `Authorization` for this catalog. Install, doctor, and tests stay Keychain-silent (PR 17).
- **GeneralCompute / Custom:** host `GET /models` with the stored key. No key → clear next-action, empty catalog, no invented IDs.

`provider pick` / `/models N` / the GUI picker persist only a listed ID. An unknown ID fails closed as `model_unavailable`.

Custom OpenAI-compatible profiles and GeneralCompute retain the user-triggered load action. That is the only direct native provider operation: it is not a fallback path for Pi-managed built-in providers. Pi-managed presets list the installed runtime catalog only; LightningLoop does not invent a native `/models` client for those.

Host discovery surfaces **account-visible model IDs**. The list is not a marketing catalog and usually does not include display names or capability metadata; context window and image support remain user-set until the host exposes richer fields. Selecting a discovered ID copies it into the draft profile and sets the display name to that ID by default. GeneralCompute’s org inventory may prefer `POST /v1/models/list`; if `GET /models` is unsupported, the load fails closed — do not invent an ID.

## UX copy

Settings Setup is one **Provider and model** section: preset, load catalog/models, catalogued picker. The built-in picker is the **installed LightningLoop runtime catalog**, not a live provider account inventory. Opening Setup auto-loads only credential-free catalogs (Pi runtime and OpenRouter public).
