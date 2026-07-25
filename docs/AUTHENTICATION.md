# Provider authentication

LightningLoop delegates built-in provider authentication to Pi. Run:

```text
lightningloop auth
```

Then use Pi's `/login` picker for OpenAI Codex, Anthropic, or xAI, and `/logout` to revoke. Pi also resolves official provider API-key environment variables for providers such as Groq, Anthropic, OpenAI, and xAI. LightningLoop does not implement a parallel OAuth client, copy tokens, include them in prompts, or put them in its managed backups.

Pi-managed built-in presets are: Cerebras, Groq, Fireworks, xAI/Grok, OpenAI Codex, and Anthropic Claude. LightningLoop never probes, reads, or uses a native Keychain fallback for any of those profiles; it invokes Pi and surfaces Pi's authentication failure. Status surfaces label those built-ins `Pi-managed/unknown`.

**GeneralCompute** is a LightningLoop-owned fixed OpenAI-compatible preset (not a Pi `knownProvider`). It uses a fixed base URL `https://api.generalcompute.com/v1`, an API key in macOS Keychain (`com.barnlabs.LightningLoop.provider.generalcompute.apiKey`) or environment variable `GENERALCOMPUTE_API_KEY`, and Settings **Discover Models & Test**. It is never authenticated via runtime `/login`.

Clarification, execution, automatic research, and Gold require the shared Pi harness on every profile. When the harness is unavailable, the native loop fails closed before any model or research request. An explicitly selected custom OpenAI-compatible profile or GeneralCompute on macOS may use its LightningLoop-owned Keychain credential for the user-triggered **Discover Models & Test** operation in Settings; that path is not a native fallback inference or review loop. Custom host-suffixed service identifiers are recorded in LightningLoop's bounded local registry before the credential is saved; GeneralCompute uses a fixed service already in the credential catalog. Cross-platform users can use a Pi-managed built-in provider or GeneralCompute with `GENERALCOMPUTE_API_KEY`. Historical LightningLoop-owned service identifiers may be consulted only to redact old locally stored material; they are never used to authenticate a Pi-managed named built-in profile and the registry never contains credential values.

Official references:

- OpenAI documents ChatGPT sign-in and API-key authentication for Codex: <https://developers.openai.com/codex/auth/>
- Anthropic documents Claude Code account and console authentication, including Windows setup: <https://docs.anthropic.com/en/docs/claude-code/getting-started>
- xAI documents API-key authentication and its official CLI login/device-auth flow: <https://docs.x.ai/developers/quickstart> and <https://docs.x.ai/build/cli/reference>
- Pi's installed provider contract is `node_modules/@earendil-works/pi-coding-agent/docs/providers.md`.

Provider OAuth availability is a Pi integration claim, not a claim that each provider endorses LightningLoop or Pi.
