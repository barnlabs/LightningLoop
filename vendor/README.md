# Vendored Pi package

`earendil-works-pi-coding-agent-0.80.10-unshrunk.tgz` is a deterministic repack of the official npm artifact `@earendil-works/pi-coding-agent@0.80.10`.

- Official artifact SHA-256: `9f2771711b8d4ebb8d59e3177026ab417bfc6caf0d4296a58de741b41e4d9c1c`
- Reviewed repack SHA-256: `cdccf8772e5852906e105ff8de6af7883264006ddffa665097e816e3a58ec513`
- Only removed file: `package/npm-shrinkwrap.json`
- Package name, version, executable code, assets, and declared dependencies are unchanged.

The upstream shrinkwrap pinned `brace-expansion@5.0.6` and `protobufjs@7.6.4` after fixes were published. Removing only that nested lock lets LightningLoop's root `package-lock.json` and explicit overrides bind `brace-expansion@5.0.7` and `protobufjs@7.6.5`. The vendored tarball is itself included in the outer packed-root provenance contract.

Recreate from a clean temporary directory with npm lifecycle scripts disabled, verify the official archive hash above, extract it, remove only `package/npm-shrinkwrap.json`, and run `npm pack <extracted-package> --ignore-scripts`. Any upstream Pi upgrade must replace this artifact, update both hashes, rerun the complete harness/install proofs, and receive supply-chain review.
