# Managed harness governance

LightningLoop's overlay contains installed `skills`, an `enabled-skills` staging directory, `mcps`, `tools`, `graphs`, and `system-prompts`. It is separate from the application bundle and Pi state. Pi continues to own global package search, installation, updates, provider catalogs, and authentication.

Commands:

```text
lightningloop harness status
lightningloop harness backup
lightningloop harness restore --slot 0 --approve-restore
lightningloop harness reset --approve-reset
lightningloop skills list
lightningloop skills install /absolute/local/skill --approve-skill-install
lightningloop skills enable skill-name --approve-skill-enable <sha256-from-skills-list>
lightningloop skills disable skill-name
```

The macOS Settings Harness tab exposes the same status, backup, latest-restore, and backup-then-reset operations. Three slots rotate and overwrite the oldest snapshot to bound storage. Restore and reset first preserve the pre-change state. Snapshot evidence includes relative path, byte count, and SHA-256.

The overlay rejects symlinks, special files, secret-shaped or binary content, more than 2,048 files, and more than 64 MiB. Status is read-only. Restore compares every path, byte count, and SHA-256 with the stored snapshot and rejects changed, added, or removed files. Local skill import requires an explicit approval token, creates a backup, records the installed tree hash, and leaves the skill disabled. Enabling requires the exact reviewed tree hash printed by `skills list`; any post-install byte change blocks activation. Enable copies into a unique non-active staging directory, inspects and rehashes it, then atomically replaces the live tree. It validates the activated hash and updates the snapshot/status bookkeeping before retiring the prior active tree. A failure at any point removes the candidate, restores the prior approved tree (or leaves no active tree when there was none), and removes all enable staging/retired paths. Disable is deliberately fail-safe: it atomically moves the active staging copy into a three-slot targeted quarantine and verifies that the active path disappeared without first trusting or validating the inactive installation record/tree. Secret-shaped, symlink, binary, special-file, or over-budget drift in that inactive copy therefore cannot block the kill switch. Drift still blocks every future enable. These commands never edit `~/.pi` or install network packages. The separate evolution ledger can record proposal and review history, but it is not falsely represented as an enforcement dependency of this local hash gate. Backups are recovery points, not authorization to activate content.

Notification hooks are optional `tools/notification-hook.json` files. They require an absolute executable and bounded argument vector, receive one bounded JSON event on stdin, use no shell, run with scrubbed credential variables, and time out after five seconds.
