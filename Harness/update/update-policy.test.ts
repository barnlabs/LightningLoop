import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalManifestPayload, updateChannelStatus, validateUpdatePolicy, verifyUpdateManifest, type SignedUpdateManifest, type UpdatePolicy } from "./update-policy.js";

test("release channel fails closed until a signing identity is configured", () => {
  const policy: UpdatePolicy = { schemaVersion: 1, currentVersion: "0.2.0", channelManifestURL: null, ed25519PublicKeyPEM: null, piPackageVersion: "0.80.10", macOSInstaller: "sparkle2", windowsInstaller: "npm-pinned" };
  assert.equal(updateChannelStatus(policy).state, "unconfigured");
  assert.throws(() => validateUpdatePolicy({ ...policy, channelManifestURL: "https://example.com/update.json" }), /configured together/);
});

test("verifies an Ed25519 manifest and blocks tampering", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const policy: UpdatePolicy = {
    schemaVersion: 1, currentVersion: "0.2.0", channelManifestURL: "https://updates.example.com/stable.json",
    ed25519PublicKeyPEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
    piPackageVersion: "0.80.10", macOSInstaller: "sparkle2", windowsInstaller: "npm-pinned",
  };
  const unsigned = {
    schemaVersion: 1 as const, version: "0.3.0", publishedAt: "2026-07-19T12:00:00.000Z",
    artifacts: [{ platform: "win32-x64" as const, url: "https://updates.example.com/lightningloop.tgz", sha256: "a".repeat(64), bytes: 42 }],
  };
  const manifest: SignedUpdateManifest = { ...unsigned, signature: sign(null, canonicalManifestPayload({ ...unsigned, signature: "" }), privateKey).toString("base64") };
  assert.equal(verifyUpdateManifest(manifest, policy).state, "verified");
  assert.equal(verifyUpdateManifest({ ...manifest, version: "0.3.1" }, policy).state, "blocked");
  const signed = (candidate: Omit<SignedUpdateManifest, "signature">): SignedUpdateManifest => ({
    ...candidate,
    signature: sign(null, canonicalManifestPayload({ ...candidate, signature: "" }), privateKey).toString("base64"),
  });
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, version: "0.1.0" }), policy), /newer/);
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, artifacts: [...unsigned.artifacts, { ...unsigned.artifacts[0]! }] }), policy), /repeats platform/);
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, artifacts: [{ ...unsigned.artifacts[0]!, url: "https://other.example.com/lightningloop.tgz" }] }), policy), /origin/);
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, publishedAt: "2999-01-01T00:00:00.000Z" }), policy), /future/);
});

test("a configured channel is not mislabeled as verified", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const policy: UpdatePolicy = {
    schemaVersion: 1, currentVersion: "0.2.0", channelManifestURL: "https://updates.example.com/stable.json",
    ed25519PublicKeyPEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
    piPackageVersion: "0.80.10", macOSInstaller: "sparkle2", windowsInstaller: "npm-pinned",
  };
  assert.equal(updateChannelStatus(policy).state, "configured-unverified");
});
