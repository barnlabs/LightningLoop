# Cerebras provider compatibility research

Date: 2026-07-20

## Product boundary

LightningLoop and BarnLabs are the product and repository identities. Cerebras is an optional inference provider, alongside other replaceable providers; no legacy provider-branded product name, target, directory, screenshot, or app identifier remains.

## Verified provider contract

- OpenAI-compatible base URL: `https://api.cerebras.ai/v1`.
- Default public model preset: `gpt-oss-120b`, which the current Cerebras catalog lists as a production model.
- Model metadata: 131,072-token context; LightningLoop caps output at 32,768 tokens.
- Authentication: HTTP Bearer API key, sourced through the provider's supported environment/secret-storage path and never embedded in the repository, session, log, or managed overlay.
- Version migration: send `X-Cerebras-Version-Patch: 2` while testing before the July 21, 2026 default cutover. Version 2 adds stricter structured-output and tool-call validation.
- Capability: this preset is text-only in LightningLoop until current provider discovery positively proves image support for the selected model.

## Sources retrieved

- [OpenAI compatibility](https://inference-docs.cerebras.ai/resources/openai)
- [Authentication](https://inference-docs.cerebras.ai/api-reference/authentication)
- [Supported models](https://inference-docs.cerebras.ai/models/overview)
- [Public model metadata](https://inference-docs.cerebras.ai/api-reference/models/public-models)
- [API versions](https://inference-docs.cerebras.ai/api-reference/versions)

## Security consequence

An API key pasted into chat is considered exposed. It must not be copied into source, tests, commands, output, configuration, or Keychain by an agent. The account owner should revoke/rotate it in the Cerebras console and configure the replacement through a supported local secret path.
