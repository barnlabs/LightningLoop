import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_UPDATE_POLICY,
  applyVerifiedUpdate,
  canonicalManifestPayload,
  type SignedUpdateManifest,
  type UpdatePolicy,
} from "./update-policy.js";

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface Fixture {
  policy: UpdatePolicy;
  manifest: SignedUpdateManifest;
  bytes: Buffer;
}

/** Build a validly signed manifest whose single win32-x64 artifact matches `bytes`. */
function fixture(bytes: Buffer): Fixture {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const policy: UpdatePolicy = {
    schemaVersion: 1,
    currentVersion: "0.2.0",
    channelManifestURL: "https://updates.example.com/stable.json",
    ed25519PublicKeyPEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
    piPackageVersion: "0.80.10",
    macOSInstaller: "sparkle2",
    windowsInstaller: "npm-pinned",
  };
  const unsigned = {
    schemaVersion: 1 as const,
    version: "0.3.0",
    publishedAt: "2026-07-19T12:00:00.000Z",
    artifacts: [{ platform: "win32-x64" as const, url: "https://updates.example.com/lightningloop.tgz", sha256: sha256Hex(bytes), bytes: bytes.length }],
  };
  const manifest: SignedUpdateManifest = {
    ...unsigned,
    signature: sign(null, canonicalManifestPayload({ ...unsigned, signature: "" }), privateKey).toString("base64"),
  };
  return { policy, manifest, bytes };
}

async function withStaging(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lightningloop-update-apply-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function stagedFileCount(root: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true } as { withFileTypes: true; recursive: true })) {
    if (entry.isFile()) count += 1;
  }
  return count;
}

test("applyVerifiedUpdate verifies signature + bytes and stages the artifact (integration)", async () => {
  await withStaging(async (root) => {
    const { policy, manifest, bytes } = fixture(Buffer.from("lightningloop release payload v0.3.0\n", "utf8"));
    const result = await applyVerifiedUpdate(manifest, policy, "win32-x64", bytes, root);
    assert.equal(result.applied, true);
    assert.equal(result.version, "0.3.0");
    assert.equal(result.platform, "win32-x64");
    assert.equal(result.sha256, sha256Hex(bytes));
    assert.equal(result.bytes, bytes.length);
    // The staged bytes are exactly the verified artifact.
    assert.deepEqual(await readFile(result.stagedPath), bytes);
    // No real OS installer is claimed or invoked.
    assert.match(result.message, /does not launch any OS installer/u);
    if (process.platform !== "win32") {
      assert.equal((await stat(result.stagedPath)).mode & 0o777, 0o600);
    }
  });
});

test("applyVerifiedUpdate refuses tampered artifact bytes and writes nothing (fail-closed)", async () => {
  await withStaging(async (root) => {
    const { policy, manifest, bytes } = fixture(Buffer.from("authentic-artifact-body-0123456789", "utf8"));
    const tampered = Buffer.from(bytes);
    tampered[0] = tampered[0]! ^ 0xff; // same length, different content
    await assert.rejects(
      applyVerifiedUpdate(manifest, policy, "win32-x64", tampered, root),
      /failed their signed SHA-256 integrity check/u,
    );
    assert.equal(await stagedFileCount(root), 0);
  });
});

test("applyVerifiedUpdate refuses artifact bytes of the wrong length", async () => {
  await withStaging(async (root) => {
    const { policy, manifest, bytes } = fixture(Buffer.from("length-bound-artifact", "utf8"));
    await assert.rejects(
      applyVerifiedUpdate(manifest, policy, "win32-x64", Buffer.concat([bytes, Buffer.from("x")]), root),
      /does not match the signed length/u,
    );
    assert.equal(await stagedFileCount(root), 0);
  });
});

test("applyVerifiedUpdate refuses a tampered manifest (broken signature) and writes nothing", async () => {
  await withStaging(async (root) => {
    const { policy, manifest, bytes } = fixture(Buffer.from("payload-for-signature-tamper", "utf8"));
    // Re-point the signed sha256 to the honest digest of different bytes without
    // re-signing: the Ed25519 signature no longer covers this manifest.
    const evilBytes = Buffer.from("attacker-substituted-payload", "utf8");
    const forged: SignedUpdateManifest = {
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0]!, sha256: sha256Hex(evilBytes), bytes: evilBytes.length }],
    };
    await assert.rejects(
      applyVerifiedUpdate(forged, policy, "win32-x64", evilBytes, root),
      /Refusing to apply update: Update manifest signature verification failed/u,
    );
    assert.equal(await stagedFileCount(root), 0);
    void bytes;
  });
});

test("applyVerifiedUpdate stays fail-closed for an unconfigured default policy", async () => {
  await withStaging(async (root) => {
    const bytes = Buffer.from("payload-without-signing-key", "utf8");
    const { manifest } = fixture(bytes);
    await assert.rejects(
      applyVerifiedUpdate(manifest, DEFAULT_UPDATE_POLICY, "win32-x64", bytes, root),
      /Refusing to apply update: .*signing key is pinned/u,
    );
    assert.equal(await stagedFileCount(root), 0);
  });
});

test("applyVerifiedUpdate refuses a platform the manifest does not declare", async () => {
  await withStaging(async (root) => {
    const bytes = Buffer.from("win-only-artifact", "utf8");
    const { policy, manifest } = fixture(bytes);
    await assert.rejects(
      applyVerifiedUpdate(manifest, policy, "darwin-arm64", bytes, root),
      /does not contain.*darwin-arm64/iu,
    );
    assert.equal(await stagedFileCount(root), 0);
  });
});
