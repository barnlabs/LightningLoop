# Agent setup and maintenance prompts

Use one prompt below when handing LightningLoop work to an agent. These are instruction templates, not permission to mutate GitHub, credentials, application settings, releases, or persistent automation. The app keeps the same four templates in `LightningLoop/Support/AgentHandoffPrompts.swift`; the Swift tests make their critical safety contracts deterministic.

## Set up or install LightningLoop

```text
Help me set up or install LightningLoop safely. Start by confirming that the target is the canonical `barnlabs/LightningLoop` repository with read-only `gh repo view barnlabs/LightningLoop --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef` evidence and inspect `git status --short --branch` before doing anything else. Preserve every dirty-worktree change: never reset, checkout, clean, stash, overwrite, or change a remote to make the tree convenient.

Follow the current source-install and update guidance in `docs/UPDATES.md` and the first-run guidance in `README.md`; do not substitute an unsigned release asset, registry shortcut, or global runtime update. Before reporting success, run `lightningloop doctor`, `lightningloop update check`, and `lightningloop harness status`, plus the applicable local build or test commands. Treat `unconfigured`, `configured-unverified`, `manifest-verified`, and `blocked` update states as stop conditions for automatic installation; signed manifest metadata alone never verifies downloaded artifact bytes.

Do not create persistent automation or commit, push, merge, tag, release, publish, transfer, or change GitHub settings, application settings, secrets, credentials, credential stores, underlying runtime state, hooks, plugins, or configuration. Report the exact commands and sanitized outputs, the canonical-repository evidence, the current update state, the tests run, any blocker, and the available rollback boundary. Ask the user before an action outside those limits.
```

## Connect existing provider access

```text
Help me connect existing provider access to LightningLoop without handling any secret. Do not read, copy, export, or inspect credentials. Do not inspect another agent or runtime credential store or data directory. Use `lightningloop auth` and the provider's official sign-in flow for built-in providers.

If the flow requires a password, passkey, OTP, CAPTCHA, account approval, or other user-only authentication, leave that step to me in the official provider page or application. Do not operate a password manager, reveal a credential value, or ask me to paste a secret into chat, a terminal command, a file, or a log. For a custom provider, direct the secret to the user-only GUI entry in LightningLoop Settings; do not enter, save, test, or export it yourself.

You may report only sanitized provider/model availability and the next user action. Do not create persistent automation or commit, push, merge, tag, release, publish, transfer, or change GitHub settings, application settings, secrets, credentials, credential stores, underlying runtime state, hooks, plugins, or configuration.
```

## Maintain or update LightningLoop

```text
Help me maintain or deliberately update LightningLoop. First confirm the canonical `barnlabs/LightningLoop` repository with read-only `gh repo view barnlabs/LightningLoop --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef` evidence and inspect `git status --short --branch`. Preserve a dirty worktree exactly: never reset, checkout, clean, stash, overwrite, or alter a remote. If the checkout is not clean or canonical, stop and report the condition instead of attempting an update.

Follow the current source-install and update guidance in `docs/UPDATES.md`. Run `lightningloop doctor`, `lightningloop update check`, and `lightningloop harness status`, then run the applicable local tests before recommending or performing a source-install step. An `unconfigured`, `configured-unverified`, `manifest-verified`, or `blocked` update result never authorizes automatic installation; signed manifest metadata alone never verifies downloaded artifact bytes. Use only the documented clean fast-forward and source-installer path when I explicitly authorize that local operation.

Do not create persistent automation or commit, push, merge, tag, release, publish, transfer, or change GitHub settings, application settings, secrets, credentials, credential stores, underlying runtime state, hooks, plugins, or configuration. Report exact sanitized command evidence, the version/update eligibility, test results, any installer rollback snapshot or recovery boundary, and unresolved risk. Ask before any action outside this scope.
```

## Diagnose or repair LightningLoop

```text
Help me diagnose or repair LightningLoop with the smallest reversible step. Start from the exact symptom and current local state. Preserve a dirty worktree; never reset, checkout, clean, stash, overwrite, or change remotes. Gather read-only evidence with `lightningloop doctor`, `lightningloop update check`, and `lightningloop harness status`, then run only the targeted applicable tests.

Do not inspect, read, copy, export, or modify credentials, another agent or runtime credential store or data directory, underlying runtime state, or user-managed resources. If authentication is relevant, direct me to `lightningloop auth` and the official provider flow; password, passkey, OTP, CAPTCHA, and account approval steps remain mine. A custom-provider secret belongs in the user-only GUI entry in LightningLoop Settings.

Do not create persistent automation or commit, push, merge, tag, release, publish, transfer, or change GitHub settings, application settings, secrets, credentials, credential stores, hooks, plugins, or configuration. Explain the smallest proposed repair before changing anything, report exact sanitized evidence and test output, and name the rollback or recovery boundary plus every remaining risk.
```

## Evidence and recovery expectations

For setup and maintenance, the minimum evidence is the canonical-repository check, clean/dirty worktree state, `doctor`, `update check`, `harness status`, relevant test result, and the exact source-install rollback snapshot when an installer was explicitly authorized. `docs/UPDATES.md` remains the source of truth for the clean fast-forward and source-install path. No prompt authorizes an automatic release, GitHub setting change, secret/credential action, persistent automation, or overwrite of user-managed state.
