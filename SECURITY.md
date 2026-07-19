# Security policy

## Supported version

Security fixes are currently applied to the latest commit on the default branch.

## Reporting

Please open a private security advisory in this repository rather than a public issue for credential exposure, request forgery, unsafe local-file behavior, or another exploitable defect.

## Security model

- API keys are stored as a generic password in macOS Keychain using `AfterFirstUnlockThisDeviceOnly` accessibility.
- The app never writes the key to loop history, UserDefaults, logs, exports, or repository files.
- Goal content, clarification answers, plans, reviews, and implementations are sent to the configured Cerebras API when a loop runs.
- Loop history is stored locally under the user’s Application Support directory.
- The implementer produces text/Markdown. CerebrasLoop does not execute model-generated commands or silently edit local files.
- Prompt text is untrusted input. Agent prompts isolate it as data and the reviewer independently enforces the explicit rubric, but prompt injection remains a model-level residual risk.

If an API key is accidentally committed or published, revoke it immediately in the Cerebras console and replace the Keychain entry.
