# CerebrasLoop runbook

## Purpose and ownership

CerebrasLoop is a native macOS demonstration of fast iterative model orchestration. BarnLabs owns the repository and release decisions. This is not a production service and has no hosted backend.

## Repository and runtime

- Repository: `baney75/CerebrasLoop`
- Runtime: native macOS 14+ SwiftUI app
- Model/API: Cerebras Inference, `gemma-4-31b`, API version patch 2
- Local credential: macOS Keychain service `com.barnlabs.CerebrasLoop.apiKey`
- Local history: `~/Library/Application Support/CerebrasLoop/sessions.json`

## Build and health check

```bash
./script/build_and_run.sh --verify
xcodebuild -project CerebrasLoop.xcodeproj -scheme CerebrasLoop \
  -derivedDataPath .build/DerivedData CODE_SIGNING_ALLOWED=NO test
```

The first command is healthy when the app builds, opens, and `pgrep` finds the process. The second is healthy when all tests pass.

## Common incidents

### HTTP 401 or 403

Replace the API key in Settings, then use **Test Connection**. Never paste the key into source or an issue.

### Model output is malformed

The run fails closed and preserves prior history. Retry once. If reproducible, capture the phase and sanitized response shape—not credential-bearing request headers—and add a decoder regression test.

### Reviewer never passes

This is expected fail-closed behavior. The configured per-stage review cap pauses the run and preserves findings. Improve the goal/answers or raise the cap deliberately; do not bypass the reviewer.

### API version behavior changes

Review Cerebras’s version documentation, test the probe and a full loop locally, then update the pinned header and parsers together.

## Rollback and recovery

There is no server deployment. Roll back code by checking out a known-good tagged release or commit. Loop history is a local JSON file; there is no automatic backup or cloud recovery. Deleting the app does not necessarily delete Keychain data or Application Support history.

## Cost and limits

Every review and repair is a separate API call. The cap of 1–8 rounds per plan and implementation stage prevents unbounded retries. The UI reports token count, model time, and an estimate based on the documented Gemma 4 31B token prices present when this version was built; provider pricing can change.
