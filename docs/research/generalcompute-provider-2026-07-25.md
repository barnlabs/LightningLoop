# GeneralCompute provider compatibility research

- Initial research: 2026-07-25

## Product boundary

LightningLoop and BarnLabs are the product and repository identities. GeneralCompute is an optional inference provider, alongside other replaceable providers. It is **not** a Pi built-in `knownProvider` and is **not** authenticated via runtime `/login`. LightningLoop owns the fixed preset, credential storage, and Discover Models & Test path.

## Verified provider contract

- OpenAI-compatible base URL: `https://api.generalcompute.com/v1` (chat completions under this prefix).
- LightningLoop preferred model: `minimax-m2.7` (`MiniMax M2.7`). Official Models & Pricing documents a 192k context window for this model.
- Output bound: LightningLoop profile schema caps `maxOutputTokens` at `131072`. Public catalog may advertise a higher `max_completion_tokens` (e.g. 192000); the app pins `131072` to stay inside the shared schema.
- Image input: no documented vision/image capability for the default model; LightningLoop sets `supportsImages` to `false`.
- Authentication: HTTP Bearer API key. Keys are often shaped like `gc_live_*`. LightningLoop stores the key in macOS Keychain service `com.barnlabs.LightningLoop.provider.generalcompute.apiKey` and accepts environment variable `GENERALCOMPUTE_API_KEY` in the harness (including non-macOS).
- Model inventory: docs prefer org inventory via `POST /v1/models/list` over OpenAI-style `GET /v1/models`. LightningLoop native Discover currently uses OpenAI-compatible `GET /models`; if that path is unsupported on an account, users can enter model IDs manually. Live public catalog has also listed IDs such as `gpt-oss-120b`, `deepseek-v3.1` / `deepseek-v3.2`, and `gemma-4-31B-it` (availability and pricing can change).
- Pi ownership: GeneralCompute does **not** appear in Pi’s `providers.md` as a `knownProvider` with `GENERALCOMPUTE_API_KEY`. Do not invent Pi support or claim `/login` manages this provider.
- Context-window note: third-party guides may list 160k for MiniMax; prefer official Models & Pricing at 192k when setting LightningLoop defaults.

## Sources retrieved

- [GeneralCompute documentation](https://docs.generalcompute.com)
- Models & Pricing and API reference pages under that site (base URL, auth Bearer, model IDs, context windows)

## Security consequence

An API key pasted into chat is considered exposed. It must not be copied into source, tests, commands, output, configuration, or Keychain by an agent. The account owner should revoke/rotate it in the GeneralCompute console and configure the replacement through Settings or `GENERALCOMPUTE_API_KEY`.
