# Model selection

LightningLoop keeps provider authentication, credentials, and model catalogs inside the shared LightningLoop runtime. The macOS GUI stores only a bounded, credential-free provider profile containing the selected model metadata. It never calls a built-in provider's `/models` endpoint, reads a provider credential, or falls back to native inference.

## Built-in providers

1. Selecting a built-in provider resets its profile to that provider's guarded preferred model.
2. The GUI asks the shared runtime for its installed model catalog. The response contains only validated model metadata—never credential values, account identifiers, or authentication status.
3. The picker permits only models catalogued by that installed runtime. Saving copies the chosen model ID, display name, image capability, context window, and output bound into the local profile.
4. Before creating or continuing a run, the harness checks that the selected built-in model is still catalogued. Otherwise it returns `model_unavailable` before constructing an agent or sending a provider request.

The GUI binds each asynchronous catalog response to both the provider ID and model ID that requested it. A same-provider selection change invalidates the in-flight response, clears its catalog state, and asks the user to refresh again; stale metadata can never announce the new selection as catalogued.

The catalog process uses an inert in-memory credential store with model-network refresh disabled. It does not read the runtime authentication store, query a provider, or infer account eligibility. Catalogued is exact installed-catalog presence, not a claim about account entitlements.

## Cerebras: Gemma 4 31B

The Cerebras preference is `Gemma 4 31B` with model ID `gemma-4-31b`. Cerebras lists it as a **public preview** model, with preview image inputs. On selecting Cerebras, the GUI displays that preference and immediately refreshes the installed runtime catalog.

If the installed runtime does not catalogue that exact model ID, the GUI explains the preview/catalog guard, prevents saving it after a catalog refresh, and the harness blocks execution with a clear `model_unavailable` error. The user can instead select another catalogued runtime model. This guard does not inspect sign-in state or provider entitlement.

This reflects Cerebras' [model catalog](https://inference-docs.cerebras.ai/models/overview), which lists `gemma-4-31b` as Gemma 4 31B Preview, and its [image-input documentation](https://inference-docs.cerebras.ai/capabilities/image-inputs), which identifies that model as the current image-input preview. Preview availability may change; the pinned runtime catalog remains the local execution guard.

## GeneralCompute

GeneralCompute is a LightningLoop-managed fixed preset (not Pi-managed). Selecting it resets to preferred model `minimax-m2.7` (`MiniMax M2.7`) at base URL `https://api.generalcompute.com/v1` with 192k context and a schema-capped 131072 max output tokens, text-only. Store the API key in Settings (Keychain) or set `GENERALCOMPUTE_API_KEY`. Use **Discover Models & Test** for account-visible model IDs; the harness registers the profile via `registerProvider` and never claims Pi `/login` ownership. See [generalcompute-provider-2026-07-25.md](research/generalcompute-provider-2026-07-25.md).

## Custom providers

LightningLoop-managed presets (OpenRouter, GeneralCompute, Custom) expose **Discover Models** in Settings and `lightningloop provider models` on the CLI. OpenRouter's public catalog needs no key. GeneralCompute and Custom call the host `/models` endpoint with the stored key. `provider select PRESET --model ID` persists only a catalogued ID; an unknown ID fails closed.

Custom OpenAI-compatible profiles and GeneralCompute retain the user-triggered Discover action. That is the only direct native provider operation: it is not run automatically, and it does not provide a fallback path for Pi-managed built-in providers. Pi-managed presets list the installed runtime catalog only; LightningLoop does not invent a native `/models` client for those.

Discovery calls the host’s OpenAI-compatible `GET /models` endpoint and surfaces **account-visible model IDs**. The list is not a marketing catalog and usually does not include display names or capability metadata; context window and image support remain user-set until the host exposes richer fields. Selecting a discovered ID copies it into the draft profile and sets the display name to that ID by default. GeneralCompute’s org inventory may prefer `POST /v1/models/list`; if `GET /models` is unsupported, enter model IDs manually.

## UX copy

Settings states explicitly that the built-in picker is the **installed LightningLoop runtime catalog**, not a live provider account inventory. Opening the Providers settings tab refreshes the runtime catalog for the active built-in profile when the shared runtime is available.
