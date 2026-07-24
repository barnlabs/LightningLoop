import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalManifestPayload, updateChannelStatus, validateUpdatePolicy, verifyUpdateManifest, type SignedUpdateManifest, type UpdatePolicy } from "./update-policy.js";

test("release channel fails closed until a signing identity is configured", () => {
  const policy: UpdatePolicy = { schemaVersion: 1, currentVersion: "0.2.0", channelManifestURL: null, ed25519PublicKeyPEM: null, piPackageVersion: "0.80.10", macOSInstaller: "sparkle2", windowsInstaller: "npm-pinned" };
  const status = updateChannelStatus(policy);
  assert.equal(status.state, "unconfigured");
  assert.match(status.message, /clean canonical checkout/i);
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
  assert.equal(verifyUpdateManifest(manifest, policy, "win32-x64").state, "manifest-verified");
  assert.equal(verifyUpdateManifest({ ...manifest, version: "0.3.1" }, policy, "win32-x64").state, "blocked");
  const signed = (candidate: Omit<SignedUpdateManifest, "signature">): SignedUpdateManifest => ({
    ...candidate,
    signature: sign(null, canonicalManifestPayload({ ...candidate, signature: "" }), privateKey).toString("base64"),
  });
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, version: "0.1.0" }), policy, "win32-x64"), /newer/);
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, artifacts: [...unsigned.artifacts, { ...unsigned.artifacts[0]! }] }), policy, "win32-x64"), /repeats platform/);
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, artifacts: [{ ...unsigned.artifacts[0]!, url: "https://other.example.com/lightningloop.tgz" }] }), policy, "win32-x64"), /origin/);
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, artifacts: [{ ...unsigned.artifacts[0]!, url: "https://updates.example.com/lightningloop.tgz?download=1" }] }), policy, "win32-x64"), /credential-free HTTPS/);
  assert.throws(() => verifyUpdateManifest(signed({ ...unsigned, publishedAt: "2999-01-01T00:00:00.000Z" }), policy, "win32-x64"), /future/);
  assert.throws(() => verifyUpdateManifest(manifest, policy, "darwin-arm64"), /does not contain.*darwin-arm64/i);
});

test("rejects noncanonical Ed25519 base64 with altered unused padding bits", () => {
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
  const canonicalSignature = sign(null, canonicalManifestPayload({ ...unsigned, signature: "" }), privateKey).toString("base64");
  const canonicalManifest: SignedUpdateManifest = { ...unsigned, signature: canonicalSignature };
  assert.equal(verifyUpdateManifest(canonicalManifest, policy, "win32-x64").state, "manifest-verified");

  assert.equal(canonicalSignature.endsWith("=="), true);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const finalSymbolIndex = alphabet.indexOf(canonicalSignature.at(-3)!);
  assert.equal(finalSymbolIndex & 0x0f, 0, "Canonical one-byte Base64 tails have four zero padding bits.");
  const alteredSignature = `${canonicalSignature.slice(0, -3)}${alphabet[finalSymbolIndex | 0x01]}==`;
  assert.deepEqual(Buffer.from(alteredSignature, "base64"), Buffer.from(canonicalSignature, "base64"));
  assert.throws(
    () => verifyUpdateManifest({ ...canonicalManifest, signature: alteredSignature }, policy, "win32-x64"),
    /canonical base64/i,
  );
});

test("a configured channel is not mislabeled as verified", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const policy: UpdatePolicy = {
    schemaVersion: 1, currentVersion: "0.2.0", channelManifestURL: "https://updates.example.com/stable.json",
    ed25519PublicKeyPEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
    piPackageVersion: "0.80.10", macOSInstaller: "sparkle2", windowsInstaller: "npm-pinned",
  };
  assert.equal(updateChannelStatus(policy).state, "configured-unverified");
  assert.throws(() => validateUpdatePolicy({ ...policy, channelManifestURL: "https://updates.example.com/stable.json?channel=stable" }), /credential-free HTTPS/);
});

test("signed manifests reject unbound fields and unsupported runtime platforms", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const policy: UpdatePolicy = {
    schemaVersion: 1, currentVersion: "0.2.0", channelManifestURL: "https://updates.example.com/stable.json",
    ed25519PublicKeyPEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
    piPackageVersion: "0.80.10", macOSInstaller: "sparkle2", windowsInstaller: "npm-pinned",
  };
  const unsigned = {
    schemaVersion: 1 as const, version: "0.3.0", publishedAt: "2026-07-19T12:00:00.000Z",
    artifacts: [{ platform: "linux-x64", url: "https://updates.example.com/lightningloop.tgz", sha256: "a".repeat(64), bytes: 42 }],
  };
  const unsupportedPlatform: SignedUpdateManifest = {
    ...unsigned,
    signature: sign(null, canonicalManifestPayload({ ...unsigned, signature: "" } as SignedUpdateManifest), privateKey).toString("base64"),
  } as SignedUpdateManifest;
  assert.throws(() => verifyUpdateManifest(unsupportedPlatform, policy, "win32-x64"), /unsupported platform/i);

  const validUnsigned = {
    ...unsigned,
    artifacts: [{ ...unsigned.artifacts[0]!, platform: "win32-x64" as const }],
  };
  const unboundField = {
    ...validUnsigned,
    signature: sign(null, canonicalManifestPayload({ ...validUnsigned, signature: "" }), privateKey).toString("base64"),
    installerHint: "ignore-me",
  } as SignedUpdateManifest;
  assert.throws(() => verifyUpdateManifest(unboundField, policy, "win32-x64"), /unexpected field/i);
});

test("release ordering accepts a stable successor to an installed prerelease", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const policy: UpdatePolicy = {
    schemaVersion: 1, currentVersion: "0.3.0-beta.2", channelManifestURL: "https://updates.example.com/stable.json",
    ed25519PublicKeyPEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
    piPackageVersion: "0.80.10", macOSInstaller: "sparkle2", windowsInstaller: "npm-pinned",
  };
  const unsigned = {
    schemaVersion: 1 as const, version: "0.3.0", publishedAt: "2026-07-19T12:00:00.000Z",
    artifacts: [{ platform: "win32-x64" as const, url: "https://updates.example.com/lightningloop.tgz", sha256: "a".repeat(64), bytes: 42 }],
  };
  const manifest: SignedUpdateManifest = { ...unsigned, signature: sign(null, canonicalManifestPayload({ ...unsigned, signature: "" }), privateKey).toString("base64") };
  assert.equal(verifyUpdateManifest(manifest, policy, "win32-x64").state, "manifest-verified");
});
