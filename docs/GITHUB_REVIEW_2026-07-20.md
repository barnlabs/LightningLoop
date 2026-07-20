# GitHub review packet — 2026-07-20

This is a read-only inventory and proposed contribution command for the canonical BarnLabs repository. It does not authorize or perform a merge, release, visibility change, ruleset change, branch-protection change, secret-scanning change, collaborator change, Actions secret change, tag, or signing/notarization operation.

## Canonical identity

Command:

```bash
gh repo view barnlabs/LightningLoop --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef
```

Exact output recorded on 2026-07-20:

```json
{"defaultBranchRef":{"name":"main"},"isPrivate":false,"nameWithOwner":"barnlabs/LightningLoop","url":"https://github.com/barnlabs/LightningLoop","visibility":"PUBLIC"}
```

## Read-only repository inventory

- Repository: public; default branch `main`; issues enabled; discussions disabled.
- Merge settings: merge commits, rebase merges, and squash merges are enabled; automatic source-branch deletion is disabled.
- Actions default token: read-only; workflows cannot approve pull-request reviews.
- Dependabot security updates: enabled.
- Secret scanning, push protection, non-provider-pattern scanning, and validity checks: disabled.
- Repository rulesets: none.
- `main` branch protection endpoint: `404 Branch not protected`.
- Direct collaborators: `baney75` is admin; `mac756` is read-only. Both are organization members.
- This change adds pinned Actions, a deterministic package-lock integrity guard, `CODEOWNERS`, pull-request and issue templates, and Dependabot configuration in the repository. The committed Windows packed-install workflow has not yet produced hosted-run evidence. These files do not substitute for server-side rulesets, branch protection, secret scanning, environments, release policy, or owner review.

## Proposed remote contribution

After all local verification and two fresh adversarial reviews are green, the exact proposed remote command is:

```bash
git push https://github.com/barnlabs/LightningLoop.git HEAD:refs/heads/codex/lightningloop
```

The proposed follow-up is a draft pull request from `codex/lightningloop` to `main`. No protected-branch push or merge is proposed. The explicit HTTPS target avoids changing the legacy local remote configuration; correcting `.git/config` remains a separately approved owner operation.

## Required owner decisions after the draft PR

1. Decide and configure a `main` ruleset or branch protection with required CI and required independent review.
2. Review whether to enable secret scanning and push protection for this public repository.
3. Select one merge policy and decide whether merged branches should be deleted automatically.
4. Define release environments and the signed/notarized release process before publishing binaries.
5. Keep repository visibility, collaborators, releases, tags, signing, and production settings under explicit owner control.

Until those decisions and the signing/notarization gates are complete, GitHub source installation is supported but public binary release remains blocked.
