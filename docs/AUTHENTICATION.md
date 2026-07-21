# Provider authentication

LightningLoop delegates built-in provider authentication to Pi. Run:

```text
lightningloop auth
```

Then use Pi's `/login` picker for OpenAI Codex, Anthropic, or xAI, and `/logout` to revoke. Pi also resolves official provider API-key environment variables for providers such as Groq, Anthropic, OpenAI, and xAI. LightningLoop does not implement a parallel OAuth client, copy tokens, include them in prompts, or put them in its managed backups.

All named built-in presets are Pi-managed: Cerebras, Groq, Fireworks, xAI/Grok, OpenAI Codex, and Anthropic Claude. LightningLoop never probes, reads, or uses a native Keychain fallback for any of those profiles; it invokes Pi and surfaces Pi's authentication failure. Status surfaces label built-ins `Pi-managed/unknown`.

Clarification, execution, automatic research, and Gold require the shared Pi harness on every profile. When the harness is unavailable, the native loop fails closed before any model or research request. An explicitly selected custom OpenAI-compatible profile on macOS may use its Keychain credential only for the user-triggered **Discover Models & Test** operation in Settings; it is not a fallback inference or review loop. Its credential service identifier is recorded in LightningLoop's bounded local registry before the credential is saved. Cross-platform users should use a Pi-managed built-in provider. Historical LightningLoop-owned service identifiers may be consulted only to redact old locally stored material; they are never used to authenticate a named built-in profile and the registry never contains credential values.

Official references:

- OpenAI documents ChatGPT sign-in and API-key authentication for Codex: <https://developers.openai.com/codex/auth/>
- Anthropic documents Claude Code account and console authentication, including Windows setup: <https://docs.anthropic.com/en/docs/claude-code/getting-started>
- xAI documents API-key authentication and its official CLI login/device-auth flow: <https://docs.x.ai/developers/quickstart> and <https://docs.x.ai/build/cli/reference>
- Pi's installed provider contract is `node_modules/@earendil-works/pi-coding-agent/docs/providers.md`.

Provider OAuth availability is a Pi integration claim, not a claim that each provider endorses LightningLoop or Pi.
