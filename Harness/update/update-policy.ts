import { createPublicKey, verify as verifySignature } from "node:crypto";

export interface UpdatePolicy {
  schemaVersion: 1;
  currentVersion: string;
  channelManifestURL: string | null;
  ed25519PublicKeyPEM: string | null;
  piPackageVersion: string;
  macOSInstaller: "sparkle2";
  windowsInstaller: "npm-pinned";
}

export interface SignedUpdateManifest {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  artifacts: Array<{ platform: "darwin-arm64" | "darwin-x64" | "win32-x64"; url: string; sha256: string; bytes: number }>;
  signature: string;
}

export interface UpdateStatus {
  state: "unconfigured" | "configured-unverified" | "verified" | "blocked";
  message: string;
  version?: string;
}

export const DEFAULT_UPDATE_POLICY: UpdatePolicy = {
  schemaVersion: 1,
  currentVersion: "0.2.0",
  channelManifestURL: null,
  ed25519PublicKeyPEM: null,
  piPackageVersion: "0.80.10",
  macOSInstaller: "sparkle2",
  windowsInstaller: "npm-pinned",
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function validateUpdatePolicy(value: UpdatePolicy): UpdatePolicy {
  if (value.schemaVersion !== 1 || !SEMVER.test(value.currentVersion) || !SEMVER.test(value.piPackageVersion)) throw new Error("Update policy has an invalid version.");
  if ((value.channelManifestURL === null) !== (value.ed25519PublicKeyPEM === null)) throw new Error("Update URL and signing key must be configured together.");
  if (value.channelManifestURL) validateHTTPS(value.channelManifestURL, "Update channel");
  return value;
}

export function updateChannelStatus(policy: UpdatePolicy): UpdateStatus {
  validateUpdatePolicy(policy);
  if (!policy.channelManifestURL) {
    return { state: "unconfigured", message: "No signed release channel is configured; automatic installation is disabled." };
  }
  return { state: "configured-unverified", message: "A release channel and signing key are configured, but no manifest or artifact has been verified. Installation remains disabled." };
}

export function verifyUpdateManifest(value: SignedUpdateManifest, policy: UpdatePolicy): UpdateStatus {
  validateUpdatePolicy(policy);
  if (!policy.ed25519PublicKeyPEM) return { state: "blocked", message: "Update verification is blocked because no release signing key is pinned." };
  if (value.schemaVersion !== 1 || !SEMVER.test(value.version) || !Number.isFinite(Date.parse(value.publishedAt))) throw new Error("Update manifest metadata is invalid.");
  if (compareSemver(value.version, policy.currentVersion) <= 0) throw new Error("Update manifest version must be newer than the installed version.");
  if (Date.parse(value.publishedAt) > Date.now() + 24 * 60 * 60_000) throw new Error("Update manifest publication time is implausibly far in the future.");
  if (value.artifacts.length < 1 || value.artifacts.length > 6) throw new Error("Update manifest must contain 1-6 artifacts.");
  const platforms = new Set<string>();
  const channelOrigin = new URL(policy.channelManifestURL!).origin;
  for (const artifact of value.artifacts) {
    validateHTTPS(artifact.url, "Artifact");
    if (platforms.has(artifact.platform)) throw new Error(`Update manifest repeats platform ${artifact.platform}.`);
    platforms.add(artifact.platform);
    if (new URL(artifact.url).origin !== channelOrigin) throw new Error("Update artifact origin must match the pinned channel origin.");
    if (!SHA256.test(artifact.sha256) || !Number.isInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 1_073_741_824) throw new Error("Update artifact integrity metadata is invalid.");
  }
  const payload = canonicalManifestPayload(value);
  let signature: Buffer;
  try { signature = Buffer.from(value.signature, "base64"); }
  catch { throw new Error("Update signature is not valid base64."); }
  if (signature.length !== 64) throw new Error("Update signature has the wrong Ed25519 length.");
  const key = createPublicKey(policy.ed25519PublicKeyPEM);
  if (key.asymmetricKeyType !== "ed25519" || !verifySignature(null, payload, key, signature)) {
    return { state: "blocked", message: "Update manifest signature verification failed." };
  }
  return { state: "verified", version: value.version, message: "Manifest signature and bounded artifact metadata verified. Platform installation remains a separate signed step." };
}

export function canonicalManifestPayload(value: SignedUpdateManifest): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: value.schemaVersion,
    version: value.version,
    publishedAt: value.publishedAt,
    artifacts: value.artifacts.map((artifact) => ({
      platform: artifact.platform,
      url: artifact.url,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    })),
  }), "utf8");
}

function validateHTTPS(raw: string, label: string): void {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) throw new Error(`${label} URL must be credential-free HTTPS.`);
}

function compareSemver(left: string, right: string): number {
  const numeric = (value: string): number[] => value.split("-", 1)[0]!.split(".").map(Number);
  const a = numeric(left);
  const b = numeric(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}
