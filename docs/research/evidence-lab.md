# Evidence Lab implementation research

Date: 2026-07-19

## Product decision

LightningLoop keeps the Pi runtime behind its own capability boundary and treats preview capture as verifier work, not as a model claim. The model proposes files and structured checks. The harness writes, runs, serves, captures, hashes, and reports observable evidence. The reviewer can ask for new external research or another implementation round but cannot manufacture host-side proof.

## Sources and consequences

- [Pi SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md): Pi recommends the in-process SDK for same-language integrations and RPC for cross-language hosts. LightningLoop retains its typed in-process TypeScript adapter and owned JSONL Swift bridge rather than exposing raw Pi RPC/tool authority.
- [Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md): extensions and tools run with the launching user's permissions. LightningLoop therefore keeps third-party extensions disabled by default and routes generated-code verification through its separate OS sandbox and approval envelope.
- [Apple `NSWorkspace`](https://developer.apple.com/documentation/appkit/nsworkspace): an explicit user action can delegate a URL or reviewed file to the registered default application without embedding a browsing surface in LightningLoop.
- [Apple `NSWorkspace`](https://developer.apple.com/documentation/appkit/nsworkspace): the native app delegates explicit artifact opens to the system-registered default application. HTML uses a loopback HTTP URL so the default browser receives restrictive response headers.

## Implemented proof contract

1. Evidence Lab remains off until the user grants generated-code/preview execution for one empty workspace.
2. The harness selects bounded low-ambiguity checks for Python, JavaScript, and Rust when the implementer omitted them; other runtime checks must be declared as structured vectors.
3. HTML is copied temporarily with a restrictive Content Security Policy.
4. A one-route server binds only to `127.0.0.1` on an ephemeral port. The harness fetches the page, records HTTP status, content type, byte count, and SHA-256, then closes the server.
5. Quick Look renders a bounded PNG. The harness validates its signature, dimensions, and size, then stores it under the model-inaccessible `_lightningloop/previews/` namespace.
6. The native Evidence Lab displays only hash-verified durable image proof. HTML is never embedded; explicit inspection uses an immutable, hash-bound, size-bounded, expiring loopback handoff to the default browser.
7. Preview, command, or audit failure blocks deterministic Gold.

## Explicit exclusions

- no external preview hosting or automatic deployment;
- no package downloads during verification;
- no arbitrary existing-repository mutation;
- no claim that CSP, Quick Look, a default browser, or macOS Seatbelt is a virtual machine;
- no automatic enablement based on file type or model request.
