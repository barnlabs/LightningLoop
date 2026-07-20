#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_ARCHIVE_BYTES = 128 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function assertRuntimeContract(reviewed, lockRoot, runtime) {
  for (const field of ["name", "version", "dependencies", "bin", "engines"]) {
    if (!sameJson(lockRoot?.[field], reviewed?.[field])) {
      throw new Error(`package-lock root ${field} does not match reviewed package.json.`);
    }
    if (!sameJson(runtime?.[field], reviewed?.[field])) {
      throw new Error(`Packed runtime ${field} does not match reviewed package.json.`);
    }
  }
}

function parseTarOctal(bytes, label) {
  const text = bytes.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Packed archive has invalid ${label}.`);
  return Number.parseInt(text, 8);
}

function parsePackedArchive(archiveBytes) {
  let unpacked;
  try {
    unpacked = gunzipSync(archiveBytes, { maxOutputLength: MAX_UNPACKED_ARCHIVE_BYTES });
  } catch {
    throw new Error("Packed runtime archive is not a bounded valid gzip stream.");
  }
  const records = [];
  const contents = new Map();
  const seen = new Set();
  let offset = 0;
  let foundEndMarker = false;
  while (offset + 512 <= unpacked.length) {
    const header = unpacked.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      foundEndMarker = true;
      if (!unpacked.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("Packed archive contains data after its tar end marker.");
      }
      break;
    }
    const storedChecksum = parseTarOctal(header.subarray(148, 156), "header checksum");
    let computedChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      computedChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (storedChecksum !== computedChecksum) throw new Error("Packed archive header checksum is invalid.");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const tarPath = prefix ? `${prefix}/${name}` : name;
    if (!tarPath.startsWith("package/")) throw new Error("Packed archive entry is outside package/.");
    const relative = tarPath.slice("package/".length);
    if (!relative || relative.startsWith("/") || relative.includes("\\")
        || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("Packed archive contains an unsafe path.");
    }
    if (seen.has(relative)) throw new Error(`Packed archive contains duplicate path ${relative}.`);
    seen.add(relative);
    const typeFlag = header[156];
    if (typeFlag !== 0 && typeFlag !== 48) throw new Error(`Packed archive contains unsupported non-file entry ${relative}.`);
    const size = parseTarOctal(header.subarray(124, 136), "entry size");
    const mode = parseTarOctal(header.subarray(100, 108), "entry mode") & 0o777;
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > unpacked.length) throw new Error("Packed archive entry exceeds the archive boundary.");
    const content = unpacked.subarray(contentStart, contentEnd);
    records.push({ path: relative, type: "file", mode, size, sha256: sha256(content) });
    contents.set(relative, content);
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (!foundEndMarker) throw new Error("Packed archive has no complete tar end marker.");
  if (records.length === 0 || !contents.has("package.json")) throw new Error("Packed archive has no package payload.");
  records.sort((left, right) => left.path.localeCompare(right.path));
  return { records, contents };
}

function normalizedArchiveRecords(archive) {
  const packedManifest = JSON.parse(archive.contents.get("package.json").toString("utf8"));
  const binPaths = new Set(Object.values(packedManifest.bin ?? {}));
  return archive.records.map((record) => ({
    ...record,
    mode: binPaths.has(record.path) ? 0o755 : record.mode,
  }));
}

async function extractPackedRoot(runtimeRoot, archive) {
  try {
    await lstat(runtimeRoot);
    throw new Error(`Refusing to extract over an existing runtime root: ${runtimeRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(runtimeRoot, { recursive: false, mode: 0o755 });
  for (const record of normalizedArchiveRecords(archive)) {
    const absolute = path.join(runtimeRoot, ...record.path.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o755 });
    await writeFile(absolute, archive.contents.get(record.path), { flag: "wx", mode: record.mode });
    if (process.platform !== "win32") await chmod(absolute, record.mode);
  }
}

async function validatePackedRoot(runtimeRoot, archive, lockBytes, manifestPath) {
  const expected = normalizedArchiveRecords(archive);
  const expectedByPath = new Map(expected.map((record) => [record.path, record]));
  const expectedDirectories = new Set();
  for (const record of expected) {
    let parent = path.posix.dirname(record.path);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const installed = [];

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (relativeDirectory === "" && entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (path.resolve(absolute) === path.resolve(manifestPath)) continue;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Packed runtime root contains unsupported path type ${relative}.`);
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relative)) throw new Error(`Packed runtime root contains extra directory ${relative}.`);
        await visit(absolute, relative);
      } else {
        const expectedRecord = expectedByPath.get(relative);
        if (!expectedRecord && relative !== "package-lock.json") {
          throw new Error(`Packed runtime root contains unreviewed payload: ${relative}.`);
        }
        const maximumBytes = expectedRecord?.size ?? MAX_LOCK_BYTES;
        if (stat.size > maximumBytes) {
          throw new Error(`Packed runtime root file exceeds its reviewed size: ${relative}.`);
        }
        const bytes = await readFile(absolute);
        installed.push({
          path: relative,
          type: "file",
          mode: stat.mode & 0o777,
          size: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  }
  await visit(runtimeRoot, "");
  installed.sort((left, right) => left.path.localeCompare(right.path));
  const installedByPath = new Map(installed.map((record) => [record.path, record]));
  for (const expectedRecord of expected) {
    const actual = installedByPath.get(expectedRecord.path);
    if (!actual || actual.type !== expectedRecord.type || actual.size !== expectedRecord.size
        || actual.sha256 !== expectedRecord.sha256
        || (process.platform !== "win32" && actual.mode !== expectedRecord.mode)) {
      throw new Error(`Installed packed payload differs from archive provenance at ${expectedRecord.path}.`);
    }
    installedByPath.delete(expectedRecord.path);
  }
  const installedLock = installedByPath.get("package-lock.json");
  if (!installedLock || installedLock.sha256 !== sha256(lockBytes) || installedLock.size !== lockBytes.length) {
    throw new Error("Installed package-lock.json differs from the reviewed lock.");
  }
  installedByPath.delete("package-lock.json");
  if (installedByPath.size > 0) {
    throw new Error(`Packed runtime root contains unreviewed payload: ${[...installedByPath.keys()].join(", ")}.`);
  }
  return { packedPayload: expected, installedPackageLock: installedLock };
}

async function readRegularFile(filePath, maximumBytes) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Expected a regular file: ${filePath}`);
  }
  if (stat.size > maximumBytes) {
    throw new Error(`File exceeds the ${maximumBytes}-byte limit: ${filePath}`);
  }
  return readFile(filePath);
}

async function packageTreeHash(packageDirectory) {
  const records = [];

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (relativeDirectory === "" && entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Dependency contains an unsupported path type: ${absolute}`);
      }
      if (stat.isDirectory()) {
        records.push(`d\0${relative}\0${(stat.mode & 0o777).toString(8)}\0`);
        await visit(absolute, relative);
      } else {
        const bytes = await readFile(absolute);
        records.push(`f\0${relative}\0${(stat.mode & 0o777).toString(8)}\0${sha256(bytes)}\0`);
      }
    }
  }

  await visit(packageDirectory, "");
  return sha256(Buffer.from(records.join(""), "utf8"));
}

async function collectInstalledPackages(runtimeRoot, lock) {
  const packages = [];
  const topNodeModules = path.join(runtimeRoot, "node_modules");

  async function scanNodeModules(nodeModulesDirectory, lockPrefix) {
    let entries;
    try {
      entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
      const absolute = path.join(nodeModulesDirectory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Installed dependency entry must not be a symlink: ${absolute}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Unexpected file in node_modules: ${absolute}`);
      }
      if (entry.name.startsWith("@")) {
        const scoped = await readdir(absolute, { withFileTypes: true });
        scoped.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of scoped) {
          if (!child.isDirectory() || child.isSymbolicLink()) {
            throw new Error(`Invalid scoped dependency entry: ${path.join(absolute, child.name)}`);
          }
          await inspectPackage(
            path.join(absolute, child.name),
            path.posix.join(lockPrefix, entry.name, child.name),
          );
        }
      } else {
        await inspectPackage(absolute, path.posix.join(lockPrefix, entry.name));
      }
    }
  }

  async function inspectPackage(packageDirectory, lockPath) {
    const lockEntry = lock.packages?.[lockPath];
    if (!lockEntry || typeof lockEntry !== "object") {
      throw new Error(`Installed dependency is absent from package-lock.json: ${lockPath}`);
    }
    if (lockEntry.dev === true) {
      throw new Error(`Development-only dependency was installed in the runtime tree: ${lockPath}`);
    }
    const manifestBytes = await readRegularFile(path.join(packageDirectory, "package.json"), 1024 * 1024);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Dependency package.json lacks name/version: ${lockPath}`);
    }
    if (lockEntry.version !== manifest.version) {
      throw new Error(`Locked and installed versions differ for ${lockPath}`);
    }
    if (typeof lockEntry.integrity !== "string" || !/^sha(?:256|384|512)-/.test(lockEntry.integrity)) {
      throw new Error(`Locked dependency lacks integrity metadata: ${lockPath}`);
    }
    packages.push({
      path: lockPath,
      name: manifest.name,
      version: manifest.version,
      integrity: lockEntry.integrity,
      packageJsonSha256: sha256(manifestBytes),
      treeSha256: await packageTreeHash(packageDirectory),
    });
    await scanNodeModules(path.join(packageDirectory, "node_modules"), path.posix.join(lockPath, "node_modules"));
  }

  await scanNodeModules(topNodeModules, "node_modules");
  packages.sort((left, right) => left.path.localeCompare(right.path));
  return packages;
}

async function readArchiveContract(lockPath, archivePath) {
  const lockBytes = await readRegularFile(lockPath, MAX_LOCK_BYTES);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json has no packages map.");
  }
  const reviewedManifestBytes = await readRegularFile(path.join(path.dirname(lockPath), "package.json"), 1024 * 1024);
  const reviewedManifest = JSON.parse(reviewedManifestBytes.toString("utf8"));
  const archiveBytes = await readRegularFile(archivePath, MAX_ARCHIVE_BYTES);
  const archive = parsePackedArchive(archiveBytes);
  const packedManifest = JSON.parse(archive.contents.get("package.json").toString("utf8"));
  const rootLock = lock.packages[""];
  assertRuntimeContract(reviewedManifest, rootLock, packedManifest);
  return { lockBytes, lock, reviewedManifestBytes, reviewedManifest, archiveBytes, archive, packedManifest };
}

async function snapshot(lockPath, runtimeRoot, manifestPath, archivePath) {
  if (path.dirname(manifestPath) !== runtimeRoot || path.basename(manifestPath) !== ".lightningloop-runtime-manifest.json") {
    throw new Error("Runtime manifest must use the reserved file directly beneath the runtime root.");
  }
  const contract = await readArchiveContract(lockPath, archivePath);
  const { lockBytes, lock, reviewedManifestBytes, archiveBytes, archive } = contract;
  const runtimeManifestBytes = await readRegularFile(path.join(runtimeRoot, "package.json"), 1024 * 1024);
  const runtimeManifest = JSON.parse(runtimeManifestBytes.toString("utf8"));
  assertRuntimeContract(contract.reviewedManifest, lock.packages[""], runtimeManifest);
  const rootPayload = await validatePackedRoot(runtimeRoot, archive, lockBytes, manifestPath);
  return {
    schemaVersion: 2,
    packedArchiveSha256: sha256(archiveBytes),
    packageLockSha256: sha256(lockBytes),
    reviewedPackageJsonSha256: sha256(reviewedManifestBytes),
    runtimePackageJsonSha256: sha256(runtimeManifestBytes),
    runtimeName: runtimeManifest.name,
    runtimeVersion: runtimeManifest.version,
    installedLockMetadataSha256: sha256(
      await readRegularFile(path.join(runtimeRoot, "node_modules", ".package-lock.json"), MAX_LOCK_BYTES),
    ),
    ...rootPayload,
    packages: await collectInstalledPackages(runtimeRoot, lock),
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const [mode, lockPathArgument, runtimeRootArgument, manifestPathArgument, archivePathArgument] = process.argv.slice(2);
if (!new Set(["archive", "extract", "write", "verify"]).has(mode) || !lockPathArgument || !runtimeRootArgument
    || (mode === "extract" && !manifestPathArgument)
    || ((mode === "write" || mode === "verify") && (!manifestPathArgument || !archivePathArgument))) {
  throw new Error("Usage: locked_runtime_manifest.mjs archive LOCK_PATH ARCHIVE_PATH | extract LOCK_PATH RUNTIME_ROOT ARCHIVE_PATH | write|verify LOCK_PATH RUNTIME_ROOT MANIFEST_PATH ARCHIVE_PATH");
}

const lockPath = path.resolve(lockPathArgument);
if (mode === "archive") {
  const contract = await readArchiveContract(lockPath, path.resolve(runtimeRootArgument));
  console.log(`Verified packed archive ${sha256(contract.archiveBytes)} with ${contract.archive.records.length} complete payload entries.`);
  process.exit(0);
}
const runtimeRoot = path.resolve(runtimeRootArgument);
if (mode === "extract") {
  const contract = await readArchiveContract(lockPath, path.resolve(manifestPathArgument));
  await extractPackedRoot(runtimeRoot, contract.archive);
  console.log(`Extracted ${contract.archive.records.length} reviewed packed payload entries.`);
  process.exit(0);
}
const manifestPath = path.resolve(manifestPathArgument);
const archivePath = path.resolve(archivePathArgument);
const actual = await snapshot(lockPath, runtimeRoot, manifestPath, archivePath);

if (mode === "write") {
  await writeFile(manifestPath, stableJson(actual), { encoding: "utf8", mode: 0o444, flag: "wx" });
  console.log(`Recorded ${actual.packages.length} lock-bound runtime dependencies.`);
} else {
  const expectedBytes = await readRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  const expected = JSON.parse(expectedBytes.toString("utf8"));
  if (stableJson(expected) !== stableJson(actual)) {
    throw new Error("Installed runtime dependency tree differs from its staged lock-bound manifest.");
  }
  console.log(`Verified ${actual.packages.length} installed runtime dependencies against package-lock.json.`);
}
