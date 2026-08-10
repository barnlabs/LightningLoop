# Cerebras provider compatibility research

- Initial research: 2026-07-20
- Version-contract refresh: 2026-07-21

## Product boundary

LightningLoop and BarnLabs are the product and repository identities. Cerebras is an optional inference provider, alongside other replaceable providers; no legacy provider-branded product name, target, directory, screenshot, or app identifier remains.

## Verified provider contract

- OpenAI-compatible base URL: `https://api.cerebras.ai/v1`.
- LightningLoop preferred model: `gemma-4-31b` (`Gemma 4 31B`). Cerebras currently lists it as a public preview model, not a production-stability promise; preview models may be discontinued on short notice.
- Current production-catalog alternative: `gpt-oss-120b`, which the current Cerebras catalog lists as a production model.
- Gemma capability: image input is enabled. Cerebras currently documents image inputs as a public-preview feature available only with `gemma-4-31b`; its limitations and input bounds still apply.
- Authentication: HTTP Bearer API key, sourced through the provider's supported environment/secret-storage path and never embedded in the repository, session, log, or managed overlay.
- API version: Cerebras' official version page says version 2 becomes the default on July 21, 2026, older versions reach end of life, and the transition header is no longer needed when version 2 takes effect. LightningLoop therefore no longer sends `X-Cerebras-Version-Patch`; it relies on the provider's default version 2 behavior. The same page also says all requests use version 2 *after* July 21. Because those statements straddle the cutover date, this repository does not claim independent evidence about provider-side propagation during July 21; no credentialed live request was made for this review.
- Version 2 compatibility: version 2 adds stricter structured-output and tool-call validation. LightningLoop's local harness and request-contract tests exercise its current request shape, but do not prove Cerebras account access or live provider behavior.
- Catalog boundary: LightningLoop accepts a built-in model only when the exact ID is present in its pinned, credential-free runtime catalog. Catalog presence does not prove provider sign-in, endpoint access, or account entitlement.

## Sources retrieved

- [OpenAI compatibility](https://inference-docs.cerebras.ai/resources/openai)
- [Authentication](https://inference-docs.cerebras.ai/api-reference/authentication)
- [Supported models](https://inference-docs.cerebras.ai/models/overview)
- [Choosing a model](https://inference-docs.cerebras.ai/models/choose-a-model)
- [Public model metadata](https://inference-docs.cerebras.ai/api-reference/models/public-models)
- [Image inputs](https://inference-docs.cerebras.ai/capabilities/image-inputs)
- [Dedicated endpoints](https://inference-docs.cerebras.ai/dedicated/overview)
- [API versions](https://inference-docs.cerebras.ai/api-reference/versions)

## Security consequence

An API key pasted into chat is considered exposed. It must not be copied into source, tests, commands, output, configuration, or Keychain by an agent. The account owner should revoke/rotate it in the Cerebras console and configure the replacement through a supported local secret path.
