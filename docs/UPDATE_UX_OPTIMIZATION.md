# Update UX and policy optimization

## Contract

`lightningloop update check` must explain whether installation is eligible without performing a network request or modifying local state. A source build must direct an operator to the one explicit source-update path, while any incomplete, malformed, ambiguous, unsigned, equal-version, or older manifest remains ineligible for installation.

## Before and after

Before this change, an `unconfigured` source build said only that automatic installation was disabled. Operators had to find the separate update documentation to learn the supported manual path. The manifest verifier also relied on TypeScript declarations for target-platform shape and compared only numeric release components, which incorrectly treated a stable release as equal to its prerelease.

After this change:

- `unconfigured` directs the operator to fast-forward a clean canonical checkout and use the documented platform source installer; it never performs that action itself.
- Manifest JSON must contain exactly the signed protocol fields. Every artifact must declare a supported macOS or Windows platform, and the caller must name an active target that has exactly one declaration. The `manifest-verified` state covers signed metadata only; artifact bytes remain unverified until the platform installer downloads, sizes, and hashes them.
- Semver comparison includes prerelease identifiers. For example, `0.3.0` is newer than `0.3.0-beta.2`; equal and older versions still fail closed.
- Malformed manifests are rejected before Ed25519 verification, avoiding avoidable public-key work and giving a deterministic reason rather than a type-dependent failure.

## Observable proof

The focused update-policy suite covers the source-build message, missing signing configuration, tampering, unsupported and missing active platforms, unbound fields, future publication dates, duplicate active-platform declarations, origin mismatch, and stable-after-prerelease eligibility.

```bash
npm run build:harness
node --test dist/update/update-policy.test.js
node dist/cli/index.js update check
```

The first two commands are local build/test operations. `update check` is local and read-only; it does not fetch, install, or update the underlying runtime.

## Boundaries and rollback

This is policy and documentation only. It does not alter macOS or Windows installer transactions, package locks, runtime-manifest/SRI binding, managed-overlay backups, user-managed resources, runtime credentials, or release channels. Reverting this bounded change returns the prior status copy and parser behavior; it does not require an installer rollback or touch a user installation. The separate source-installer rollback boundary remains the backup set created before its live commit.
