# GitHub housekeeping review — 2026-07-20

**Scope:** a read-only inventory for the canonical public repository and a proposed, human-owned hardening sequence. No GitHub setting, visibility, collaborator, release, environment, workflow, branch, or credential was changed.

**Observation time:** 2026-07-20, America/New_York. The queried GitHub API returned a 2026-07-21 UTC header for the vulnerability-alert availability request.

## Canonical identity

Fresh command:

```bash
gh repo view barnlabs/LightningLoop \
  --json nameWithOwner,visibility,isPrivate,url,defaultBranchRef
```

Fresh output:

```json
{
  "defaultBranchRef": {"name": "main"},
  "isPrivate": false,
  "nameWithOwner": "barnlabs/LightningLoop",
  "url": "https://github.com/barnlabs/LightningLoop",
  "visibility": "PUBLIC"
}
```

The canonical remote `main` was `fde002057a35b561d6e1f0816aa874d6851df2d1`. This checkout’s `HEAD` was `8d208e55cd40af046ba5052c326e67a2c3f25261`; they differ. The selected GitHub-governance files nevertheless matched remote `main` byte-for-byte before this packet’s local edits, as shown by their identical Git blob IDs below. The current working-tree changes remain local until separately reviewed and authorized for a branch/PR.

## VERIFIED

| Area | Fresh evidence | Result |
|---|---|---|
| Identity and visibility | `gh repo view` output above | `barnlabs/LightningLoop`, `PUBLIC`, `isPrivate: false`, default branch `main`. Preserve this public state. |
| Main guard | `GET /repos/barnlabs/LightningLoop/branches/main/protection` returned HTTP 404 `Branch not protected`; `GET /repos/barnlabs/LightningLoop/rulesets` returned `[]`; branch summary reported `protected: false`. | There is no repository-level branch protection or ruleset on `main`. |
| Merge and branch-deletion policy | `GET /repos/barnlabs/LightningLoop` | Squash, merge-commit, and rebase merges are all allowed; auto-merge is disabled; automatic deletion of merged branches is disabled. |
| Actions policy | `GET /repos/barnlabs/LightningLoop/actions/permissions` | Actions are enabled; `allowed_actions: all`; repository-level SHA pin enforcement is false. |
| Actions token policy | `GET /repos/barnlabs/LightningLoop/actions/permissions/workflow` | Default token permission is `read`; workflow PR-approval permission is false. |
| Workflow contents | Remote `main` `.github/workflows/ci.yml`, blob `5911bc267f1f781d1347bace71c12620b4a4dffc` | `permissions` is `contents: read`; `actions/checkout` and `actions/setup-node` use full-length commit SHAs. |
| Current check names | `GET /repos/barnlabs/LightningLoop/commits/fde002057a35b561d6e1f0816aa874d6851df2d1/check-runs` | Successful current-main checks include `harness`, `windows-tui`, and `macos-app`. |
| CODEOWNERS and templates | `GET /repos/barnlabs/LightningLoop/codeowners/errors?ref=main` returned `{"errors":[]}`; remote `.github` content listing includes CODEOWNERS, issue templates, PR template, Dependabot, and workflows. | CODEOWNERS parses without errors and the public contribution paths exist. |
| Selected governance files | Local `git hash-object` values equal remote `main` content SHA before this packet’s edits: CODEOWNERS `6dcaf9b4332dfcdc6a12b01621b5e020b1de4f95`; PR template `d89a3155bd4929087574ebb144e9fa9ba4c6362d`; Dependabot `69551b570d54149a481be09c74c88a3a2e930714`; bug template `164f67a73f0e1e3feae7d8be3696d19e21704881`; config `7cd4978fde1f74737875a13d1d431ca77b710e03`; feature template `d27b6c55cf949edb571591133e843e1065739578`; CI `5911bc267f1f781d1347bace71c12620b4a4dffc`. | This checkout began with the current remote governance-template baseline. |
| Dependency alerts and updates | `GET /repos/barnlabs/LightningLoop/vulnerability-alerts` returned HTTP 204; repository security analysis reports `dependabot_security_updates: enabled`; remote `dependabot.yml` exists. | Dependency vulnerability alerts are enabled/available and security updates are enabled. This is not evidence that alerts have been triaged. |
| Secret scanning | Repository security analysis reports secret scanning, non-provider patterns, push protection, and validity checks as `disabled`. | Secret scanning is disabled. |
| Environments and releases | `GET /repos/barnlabs/LightningLoop/environments` returned 0; `GET /repos/barnlabs/LightningLoop/releases` returned `[]`. | No repository environment or release exists. |
| Collaborators and teams | Timestamped `GET /repos/barnlabs/LightningLoop/collaborators --paginate` snapshot: `baney75` has `admin`; `mac756` has `read`/pull-only; `GET /repos/barnlabs/LightningLoop/teams --paginate` returned `[]`. | Two direct collaborators and no repository teams were observed. Re-query immediately before any authorized remote command. |
| Public presentation | Repository metadata reports description `Fast inference. Relentless refinement. A provider-neutral macOS and TUI agent loop by BarnLabs.`, null homepage, and no topics. | A concise product-first description and fact-bound topics can improve discovery without inventing a website or release. |

## UNAVAILABLE / UNRESOLVED

| Item | Why it remains unresolved | Required next evidence |
|---|---|---|
| Organization-wide policy/rulesets | The repository endpoints prove no repository-level guard and an unprotected `main`; they do not establish every possible organization-wide policy. | A BarnLabs owner must inspect any organization ruleset/policy that applies to this repository before relying on a new guard. |
| Dependabot and secret-scanning alert disposition | Availability/status was verified only. Individual alert counts and remediation status were not inspected in this packet. | A separately authorized security review with scoped alert evidence. |
| Least-privilege adequacy | The timestamped direct-collaborator and team inventory is factual, but whether the current admin/read access and recovery model is intended remains a human governance choice. | BarnLabs owner decision recorded with recovery and review responsibility; live re-query before mutation. |
| Brand homepage | The remote homepage is null and no official product URL was supplied or independently verified. | An explicitly approved official URL; otherwise leave it unset. |
| Local-to-remote delivery | The checkout head differs from remote `main`, and this packet’s changes are local. | Independent diff review, an authorized branch/PR decision, and post-merge re-query. |

## PROPOSED — DO NOT RUN WITHOUT EXPLICIT AUTHORIZATION

Each command below is exact proposed remote work, not a command executed for this review. Review the policy choice, run it from a clean authorized branch/session, then re-run the inventory above. Do not change visibility, collaborators, teams, releases, environments, secrets, or repository ownership as part of this sequence.

### 1. Product-first repository metadata

```bash
gh repo edit barnlabs/LightningLoop \
  --description 'LightningLoop is a BarnLabs app for disciplined, evidence-led agent work on macOS and the terminal.' \
  --add-topic macos \
  --add-topic swiftui \
  --add-topic cli \
  --add-topic developer-tools \
  --add-topic agent-orchestration
```

Leave the homepage unset. This command intentionally preserves `PUBLIC` visibility and makes no release claim.

### 2. Constrain Actions to the already-pinned GitHub-owned actions

```bash
gh api --method PUT repos/barnlabs/LightningLoop/actions/permissions --input - <<'JSON'
{"enabled":true,"allowed_actions":"selected","sha_pinning_required":true}
JSON

gh api --method PUT repos/barnlabs/LightningLoop/actions/permissions/selected-actions --input - <<'JSON'
{"github_owned_allowed":true,"verified_allowed":false,"patterns_allowed":[]}
JSON
```

Precondition: an independent reviewer confirms that every current and planned workflow uses only GitHub-owned, full-SHA-pinned actions, including any new automation. Rollback is the current observed policy: `allowed_actions: all`, `sha_pinning_required: false`.

### 3. Add a repository ruleset for `main`

```bash
gh api --method POST repos/barnlabs/LightningLoop/rulesets --input - <<'JSON'
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {
      "type": "pull_request",
      "parameters": {
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_approving_review_count": 1,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {"context": "harness"},
          {"context": "windows-tui"},
          {"context": "macos-app"}
        ],
        "strict_required_status_checks_policy": true
      }
    }
  ]
}
JSON
```

This is a proposed minimum technical guard, not a substitute for LightningLoop’s two context-isolated review packet. The current direct-access and recovery model, bypass permission, and organization-wide policy must be explicitly decided before activation. Rollback requires the ruleset ID returned by this command and an explicitly authorized `gh api --method DELETE repos/barnlabs/LightningLoop/rulesets/ID`.

### 4. Delete merged topic branches after the ruleset is proven

```bash
gh api --method PATCH repos/barnlabs/LightningLoop --input - <<'JSON'
{"delete_branch_on_merge":true}
JSON
```

Precondition: the branch/ruleset workflow works on one disposable PR and the owner accepts automatic cleanup. Rollback is the current observed `delete_branch_on_merge: false`.

### 5. Enable secret-scanning controls if the owner accepts the alert-handling duty

```bash
gh api --method PATCH repos/barnlabs/LightningLoop --input - <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": {"status": "enabled"},
    "secret_scanning_push_protection": {"status": "enabled"},
    "secret_scanning_validity_checks": {"status": "enabled"}
  }
}
JSON
```

Precondition: a named BarnLabs security owner, private-alert response path, and false-positive/revocation procedure. This turns on a repository security feature; it is not an autonomous cleanup or a license to inspect private data. Rollback is the observed disabled state, but should occur only under explicit authorization.

## Review and rollback boundary

This packet does not approve its own changes. Two fresh context-isolated reviewers must inspect the exact local diff, this evidence, and distinct failure questions before the repository owner decides whether any proposed command is appropriate. The implementer must not execute the commands, self-approve, merge, or alter public visibility.

Local rollback is a targeted reversal of the files in this packet. Remote rollback is limited to the named setting or ruleset that an authorized owner actually changed; no remote rollback applies because this review was read-only.
