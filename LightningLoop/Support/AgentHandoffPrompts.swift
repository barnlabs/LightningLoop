import Foundation

struct AgentHandoffPrompt: Equatable, Sendable, Identifiable {
    let id: String
    let title: String
    let text: String
}

enum AgentHandoffPrompts {
    static let setupInstall = AgentHandoffPrompt(
        id: "setup-install",
        title: "Set up or install LightningLoop",
        text: """
        Help me set up or install LightningLoop safely. Start with read-only `gh repo view barnlabs/LightningLoop --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef` evidence, then bind the actual checkout to it: verify the checkout root, require a clean `main` branch, and compare `git remote get-url origin` with the exact canonical BarnLabs HTTPS/SSH forms documented in `docs/UPDATES.md`. The GitHub query alone does not authenticate an unrelated checkout; stop before fetch, build, or installation if origin is absent, forked, redirected, or different. Preserve every dirty-worktree change: never reset, checkout, clean, stash, overwrite, or change a remote to make the tree convenient.

        Follow the current source-install and update guidance in `docs/UPDATES.md` and the first-run guidance in `README.md`; fetch only explicit canonical `origin main`, fast-forward only to `FETCH_HEAD`, and prove `HEAD` equals fetched `refs/remotes/origin/main` before the source installer. Do not substitute `git pull`, an unsigned release asset, a registry shortcut, or a global runtime update. Before reporting success, run `lightningloop doctor`, `lightningloop update check`, and `lightningloop harness status`, plus the applicable local build or test commands. Treat `unconfigured`, `configured-unverified`, `manifest-verified`, and `blocked` update states as stop conditions for automatic installation; signed manifest metadata alone never verifies downloaded artifact bytes.

        Do not create persistent automation or commit, push, merge, tag, release, publish, transfer, or change GitHub settings, application settings, secrets, credentials, credential stores, underlying runtime state, hooks, plugins, or configuration. Report the exact commands and sanitized outputs, the canonical-repository evidence, the current update state, the tests run, any blocker, and the available rollback boundary. Ask the user before an action outside those limits.
        """
    )

    static let connectExistingProviderAccess = AgentHandoffPrompt(
        id: "connect-existing-provider-access",
        title: "Connect existing provider access",
        text: """
        Help me connect existing provider access to LightningLoop without handling any secret. Do not read, copy, export, or inspect credentials. Do not inspect another agent or runtime credential store or data directory. Use `lightningloop auth` and the provider's official sign-in flow for built-in providers.

        If the flow requires a password, passkey, OTP, CAPTCHA, account approval, or other user-only authentication, leave that step to me in the official provider page or application. Do not operate a password manager, reveal a credential value, or ask me to paste a secret into chat, a terminal command, a file, or a log. For a custom provider, direct the secret to the user-only GUI entry in LightningLoop Settings; do not enter, save, test, or export it yourself.

        You may report only sanitized provider/model availability and the next user action. Do not create persistent automation or commit, push, merge, tag, release, publish, transfer, or change GitHub settings, application settings, secrets, credentials, credential stores, underlying runtime state, hooks, plugins, or configuration.
        """
    )

    static let maintainUpdate = AgentHandoffPrompt(
        id: "maintain-update",
        title: "Maintain or update LightningLoop",
        text: """
        Help me maintain or deliberately update LightningLoop. First gather read-only `gh repo view barnlabs/LightningLoop --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef` evidence, then independently bind the actual checkout root, clean `main` branch, and `git remote get-url origin` to the exact canonical BarnLabs HTTPS/SSH forms in `docs/UPDATES.md`. The GitHub query alone does not authenticate an unrelated checkout. Preserve a dirty worktree exactly: never reset, checkout, clean, stash, overwrite, or alter a remote. If the checkout is dirty, not on `main`, lacks origin, or points to a fork/other URL, stop before fetch and report the condition.

        Follow the current source-install and update guidance in `docs/UPDATES.md`. Run `lightningloop doctor`, `lightningloop update check`, and `lightningloop harness status`, then run the applicable local tests before recommending or performing a source-install step. An `unconfigured`, `configured-unverified`, `manifest-verified`, or `blocked` update result never authorizes automatic installation; signed manifest metadata alone never verifies downloaded artifact bytes. When I explicitly authorize the local source update, fetch only explicit canonical `origin main`, fast-forward only to `FETCH_HEAD`, prove `HEAD` equals fetched `refs/remotes/origin/main`, and rerun the clean-checkout checks before installation. Do not use `git pull` or another configured ref.

        Do not create persistent automation or commit, push, merge, tag, release, publish, transfer, or change GitHub settings, application settings, secrets, credentials, credential stores, underlying runtime state, hooks, plugins, or configuration. Report exact sanitized command evidence, the version/update eligibility, test results, any installer rollback snapshot or recovery boundary, and unresolved risk. Ask before any action outside this scope.
        """
    )

    static let diagnoseRepair = AgentHandoffPrompt(
        id: "diagnose-repair",
        title: "Diagnose or repair LightningLoop",
        text: """
        Help me diagnose or repair LightningLoop with the smallest reversible step. Start from the exact symptom and current local state. Preserve a dirty worktree; never reset, checkout, clean, stash, overwrite, or change remotes. Gather read-only evidence with `lightningloop doctor`, `lightningloop update check`, and `lightningloop harness status`, then run only the targeted applicable tests.

        Do not inspect, read, copy, export, or modify credentials, another agent or runtime credential store or data directory, underlying runtime state, or user-managed resources. If authentication is relevant, direct me to `lightningloop auth` and the official provider flow; password, passkey, OTP, CAPTCHA, and account approval steps remain mine. A custom-provider secret belongs in the user-only GUI entry in LightningLoop Settings.

        Do not create persistent automation or commit, push, merge, tag, release, publish, transfer, or change GitHub settings, application settings, secrets, credentials, credential stores, hooks, plugins, or configuration. Explain the smallest proposed repair before changing anything, report exact sanitized evidence and test output, and name the rollback or recovery boundary plus every remaining risk.
        """
    )

    static let all = [setupInstall, connectExistingProviderAccess, maintainUpdate, diagnoseRepair]
}
