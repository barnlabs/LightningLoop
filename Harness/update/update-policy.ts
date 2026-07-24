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

export type UpdatePlatform = SignedUpdateManifest["artifacts"][number]["platform"];

export interface UpdateStatus {
  state: "unconfigured" | "configured-unverified" | "manifest-verified" | "blocked";
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

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MANIFEST_FIELDS = ["artifacts", "publishedAt", "schemaVersion", "signature", "version"];
const ARTIFACT_FIELDS = ["bytes", "platform", "sha256", "url"];
const SUPPORTED_PLATFORMS = new Set<UpdatePlatform>(["darwin-arm64", "darwin-x64", "win32-x64"]);

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function validateUpdatePolicy(value: UpdatePolicy): UpdatePolicy {
  if (value.schemaVersion !== 1 || !parseSemver(value.currentVersion) || !parseSemver(value.piPackageVersion)) throw new Error("Update policy has an invalid version.");
  if ((value.channelManifestURL === null) !== (value.ed25519PublicKeyPEM === null)) throw new Error("Update URL and signing key must be configured together.");
  if (value.channelManifestURL) validateHTTPS(value.channelManifestURL, "Update channel");
  return value;
}

export function updateChannelStatus(policy: UpdatePolicy): UpdateStatus {
  validateUpdatePolicy(policy);
  if (!policy.channelManifestURL) {
    return { state: "unconfigured", message: "Automatic installation is disabled because this source build has no signed release channel. To update deliberately, fast-forward a clean canonical checkout and use the platform source-installer path in docs/UPDATES.md." };
  }
  return { state: "configured-unverified", message: "A release channel and signing key are configured, but no newer signed manifest has been verified for this platform. Artifact bytes have not been downloaded or verified; installation remains disabled." };
}

export function verifyUpdateManifest(value: SignedUpdateManifest, policy: UpdatePolicy, targetPlatform: UpdatePlatform): UpdateStatus {
  validateUpdatePolicy(policy);
  if (!policy.ed25519PublicKeyPEM) return { state: "blocked", message: "Update verification is blocked because no release signing key is pinned." };
  if (!SUPPORTED_PLATFORMS.has(targetPlatform)) throw new Error(`Update target platform ${String(targetPlatform)} is unsupported.`);
  validateManifestShape(value);
  if (value.schemaVersion !== 1 || !parseSemver(value.version) || !Number.isFinite(Date.parse(value.publishedAt))) throw new Error("Update manifest metadata is invalid.");
  if (compareSemver(value.version, policy.currentVersion) <= 0) throw new Error("Update manifest version must be newer than the installed version.");
  if (Date.parse(value.publishedAt) > Date.now() + 24 * 60 * 60_000) throw new Error("Update manifest publication time is implausibly far in the future.");
  if (value.artifacts.length < 1 || value.artifacts.length > 6) throw new Error("Update manifest must contain 1-6 artifacts.");
  const platforms = new Set<string>();
  const channelOrigin = new URL(policy.channelManifestURL!).origin;
  for (const artifact of value.artifacts) {
    validateHTTPS(artifact.url, "Artifact");
    if (!SUPPORTED_PLATFORMS.has(artifact.platform)) throw new Error(`Update manifest has an unsupported platform ${artifact.platform}.`);
    if (platforms.has(artifact.platform)) throw new Error(`Update manifest repeats platform ${artifact.platform}.`);
    platforms.add(artifact.platform);
    if (new URL(artifact.url).origin !== channelOrigin) throw new Error("Update artifact origin must match the pinned channel origin.");
    if (!SHA256.test(artifact.sha256) || !Number.isInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 1_073_741_824) throw new Error("Update artifact integrity metadata is invalid.");
  }
  if (!platforms.has(targetPlatform)) throw new Error(`Update manifest does not contain an artifact declaration for active platform ${targetPlatform}.`);
  const payload = canonicalManifestPayload(value);
  const signature = strictBase64(value.signature);
  if (signature.length !== 64) throw new Error("Update signature has the wrong Ed25519 length.");
  const key = createPublicKey(policy.ed25519PublicKeyPEM);
  if (key.asymmetricKeyType !== "ed25519" || !verifySignature(null, payload, key, signature)) {
    return { state: "blocked", message: "Update manifest signature verification failed." };
  }
  return { state: "manifest-verified", version: value.version, message: `Manifest signature and bounded artifact declaration verified for ${targetPlatform}. Artifact bytes have not been downloaded or hashed; installation remains disabled until the platform installer independently verifies them.` };
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

function strictBase64(value: string): Buffer {
  if (!BASE64.test(value)) throw new Error("Update signature is not valid base64.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Update signature is not canonical base64.");
  }
  return decoded;
}

function validateHTTPS(raw: string, label: string): void {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`${label} URL must be credential-free HTTPS.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error(`${label} URL must be credential-free HTTPS.`);
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error("Update policy has an invalid version.");
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] - b[field];
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (!a.prerelease.length && !b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const longest = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < longest; index += 1) {
    const aIdentifier = a.prerelease[index];
    const bIdentifier = b.prerelease[index];
    if (aIdentifier === undefined) return -1;
    if (bIdentifier === undefined) return 1;
    if (aIdentifier === bIdentifier) continue;
    const aNumeric = /^\d+$/.test(aIdentifier);
    const bNumeric = /^\d+$/.test(bIdentifier);
    if (aNumeric && bNumeric) return Number(aIdentifier) - Number(bIdentifier);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return aIdentifier < bIdentifier ? -1 : 1;
  }
  return 0;
}

function parseSemver(value: string): ParsedSemver | null {
  const matched = value.match(SEMVER);
  if (!matched) return null;
  const numeric = [matched[1]!, matched[2]!, matched[3]!].map(Number);
  if (numeric.some((component) => !Number.isSafeInteger(component))) return null;
  const prerelease = matched[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && ((identifier.length > 1 && identifier.startsWith("0")) || !Number.isSafeInteger(Number(identifier))))) return null;
  return { major: numeric[0]!, minor: numeric[1]!, patch: numeric[2]!, prerelease };
}

function validateManifestShape(value: SignedUpdateManifest): void {
  if (!isRecord(value)) throw new Error("Update manifest must be an object.");
  assertExactFields(value, MANIFEST_FIELDS, "Update manifest");
  if (value.schemaVersion !== 1 || typeof value.version !== "string" || typeof value.publishedAt !== "string" || typeof value.signature !== "string" || !Array.isArray(value.artifacts)) {
    throw new Error("Update manifest metadata is invalid.");
  }
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact)) throw new Error("Update manifest artifact must be an object.");
    assertExactFields(artifact, ARTIFACT_FIELDS, "Update manifest artifact");
    if (typeof artifact.platform !== "string" || typeof artifact.url !== "string" || typeof artifact.sha256 !== "string" || typeof artifact.bytes !== "number") {
      throw new Error("Update manifest artifact metadata is invalid.");
    }
  }
}

function assertExactFields(value: Record<string, unknown>, expected: string[], label: string): void {
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) throw new Error(`${label} has an unexpected field ${field}.`);
  }
  for (const field of expected) {
    if (!(field in value)) throw new Error(`${label} is missing required field ${field}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
