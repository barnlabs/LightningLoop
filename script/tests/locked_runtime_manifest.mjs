#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_DEPENDENCY_COPY_FILES = 250_000;
const MAX_DEPENDENCY_COPY_BYTES = 1024 * 1024 * 1024;
const MAX_DEPENDENCY_FILE_BYTES = 256 * 1024 * 1024;

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

function parsePaxPath(content) {
  let offset = 0;
  let paxPath = null;
  while (offset < content.length) {
    const space = content.indexOf(32, offset);
    if (space < 0) throw new Error("Packed archive has a malformed PAX record length.");
    const lengthText = content.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) throw new Error("Packed archive has an invalid PAX record length.");
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > content.length || content[end - 1] !== 10) {
      throw new Error("Packed archive PAX record exceeds its header boundary.");
    }
    const record = content.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error("Packed archive has a malformed PAX record.");
    const key = record.slice(0, equals);
    if (key === "path") {
      if (paxPath !== null) throw new Error("Packed archive repeats a PAX path record.");
      paxPath = record.slice(equals + 1);
    }
    offset = end;
  }
  return paxPath;
}

function parsePackedArchive(archiveBytes, requiredPrefix = "package") {
  let unpacked;
  try {
    unpacked = gunzipSync(archiveBytes, { maxOutputLength: MAX_UNPACKED_ARCHIVE_BYTES });
  } catch {
    throw new Error("Packed runtime archive is not a bounded valid gzip stream.");
  }
  const records = [];
  const contents = new Map();
  const recordByPath = new Map();
  const seen = new Set();
  let archivePrefix = requiredPrefix;
  let pendingPaxPath = null;
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
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const typeFlag = header[156];
    const size = parseTarOctal(header.subarray(124, 136), "entry size");
    const mode = parseTarOctal(header.subarray(100, 108), "entry mode") & 0o777;
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > unpacked.length) throw new Error("Packed archive entry exceeds the archive boundary.");
    const content = unpacked.subarray(contentStart, contentEnd);
    offset = contentStart + Math.ceil(size / 512) * 512;
    if (typeFlag === 120) {
      if (pendingPaxPath !== null) throw new Error("Packed archive has consecutive PAX path headers.");
      pendingPaxPath = parsePaxPath(content);
      continue;
    }
    const tarPath = pendingPaxPath ?? headerPath;
    pendingPaxPath = null;
    const rawSegments = tarPath.split("/");
    if (typeFlag === 53 && rawSegments.at(-1) === "") rawSegments.pop();
    if (!tarPath || tarPath.startsWith("/") || tarPath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(tarPath)
        || rawSegments.some((segment) => segment === "" || segment === "..")) {
      throw new Error("Packed archive contains an unsafe path.");
    }
    const segments = rawSegments.filter((segment) => segment !== ".");
    if (segments.length === 0) throw new Error("Packed archive contains an empty normalized path.");
    if (archivePrefix === null) archivePrefix = segments[0];
    if (segments[0] !== archivePrefix) throw new Error("Packed archive contains more than one top-level directory.");
    const relative = segments.slice(1).join("/");
    if (seen.has(tarPath)) throw new Error(`Packed archive contains duplicate path ${tarPath}.`);
    seen.add(tarPath);
    if (typeFlag === 53) {
      if (size !== 0) throw new Error("Packed archive directory has nonzero content.");
    } else if (typeFlag === 0 || typeFlag === 48) {
      if (!relative) throw new Error("Packed archive file has no package-relative path.");
      const record = { path: relative, type: "file", mode, size, sha256: sha256(content) };
      const prior = recordByPath.get(relative);
      if (prior) {
        if (prior.mode !== record.mode || prior.size !== record.size || prior.sha256 !== record.sha256) {
          throw new Error(`Packed archive contains conflicting normalized path ${relative}.`);
        }
        continue;
      }
      records.push(record);
      recordByPath.set(relative, record);
      contents.set(relative, content);
    } else {
      throw new Error(`Packed archive contains unsupported non-file entry ${relative || archivePrefix}.`);
    }
  }
  if (pendingPaxPath !== null) throw new Error("Packed archive ends with an unapplied PAX path header.");
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

function platformAllows(values, current) {
  if (!Array.isArray(values) || values.length === 0) return true;
  if (values.includes(`!${current}`)) return false;
  const positive = values.filter((value) => typeof value === "string" && !value.startsWith("!"));
  return positive.length === 0 || positive.includes(current);
}

function cacheObjectPath(cacheRoot, integrity) {
  if (typeof integrity !== "string" || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
    throw new Error("Reviewed lock dependency has an unsupported integrity value.");
  }
  const separator = integrity.indexOf("-");
  const algorithm = integrity.slice(0, separator);
  const expectedDigest = Buffer.from(integrity.slice(separator + 1), "base64");
  const expectedLength = { sha256: 32, sha384: 48, sha512: 64 }[algorithm];
  if (expectedDigest.length !== expectedLength) throw new Error("Reviewed lock dependency has malformed integrity bytes.");
  const hex = expectedDigest.toString("hex");
  return {
    algorithm,
    expectedDigest,
    path: path.join(cacheRoot, "_cacache", "content-v2", algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)),
  };
}

function assertSafePackageLockPath(packageLockPath, nodeModulesRoot) {
  if (packageLockPath.includes("\\")
      || packageLockPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Reviewed lock contains an unsafe package path: ${packageLockPath}`);
  }
  const destinationPackage = path.join(path.dirname(nodeModulesRoot), ...packageLockPath.split("/"));
  const relative = path.relative(nodeModulesRoot, destinationPackage);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Reviewed lock package escapes node_modules: ${packageLockPath}`);
  }
  return destinationPackage;
}

async function loadProductionArchive(cacheRoot, packageLockPath, lockEntry) {
  const compatible = platformAllows(lockEntry.os, process.platform) && platformAllows(lockEntry.cpu, process.arch);
  if (!compatible) {
    if (lockEntry.optional === true) return null;
    throw new Error(`Required dependency is incompatible with ${process.platform}/${process.arch}: ${packageLockPath}`);
  }
  const cacheObject = cacheObjectPath(cacheRoot, lockEntry.integrity);
  let archiveBytes;
  try {
    archiveBytes = await readRegularFile(cacheObject.path, MAX_ARCHIVE_BYTES);
  } catch (error) {
    if (error?.code === "ENOENT" && lockEntry.optional === true) return null;
    throw error;
  }
  const actualDigest = createHash(cacheObject.algorithm).update(archiveBytes).digest();
  if (!actualDigest.equals(cacheObject.expectedDigest)) {
    throw new Error(`Cached dependency bytes fail reviewed integrity: ${packageLockPath}`);
  }
  let archive;
  try {
    archive = parsePackedArchive(archiveBytes, null);
  } catch (error) {
    throw new Error(`Cached dependency archive is structurally unsafe for ${packageLockPath}: ${error.message}`);
  }
  const manifest = JSON.parse(archive.contents.get("package.json").toString("utf8"));
  if (manifest.version !== lockEntry.version) throw new Error(`Cached dependency version differs from the reviewed lock: ${packageLockPath}`);
  return archive;
}

async function copyProductionDependencies(lockPath, cacheRoot, runtimeRoot) {
  const lockBytes = await readRegularFile(lockPath, MAX_LOCK_BYTES);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  if (!lock.packages || typeof lock.packages !== "object") throw new Error("package-lock.json has no packages map.");
  const destinationNodeModules = path.join(runtimeRoot, "node_modules");
  for (const directory of [cacheRoot, runtimeRoot]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Dependency extraction root must be a real directory: ${directory}`);
    }
  }
  await mkdir(destinationNodeModules, { recursive: false, mode: 0o755 });
  let copiedFiles = 0;
  let copiedBytes = 0;
  let copiedPackages = 0;

  const packages = Object.entries(lock.packages)
    .filter(([lockPath_, entry]) => lockPath_.startsWith("node_modules/") && entry?.dev !== true)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [packageLockPath, lockEntry] of packages) {
    const destinationPackage = assertSafePackageLockPath(packageLockPath, destinationNodeModules);
    const archive = await loadProductionArchive(cacheRoot, packageLockPath, lockEntry);
    if (archive === null) continue;
    await mkdir(path.dirname(destinationPackage), { recursive: true, mode: 0o755 });
    await mkdir(destinationPackage, { recursive: false, mode: 0o755 });
    for (const record of normalizedArchiveRecords(archive)) {
      copiedFiles += 1;
      copiedBytes += record.size;
      if (copiedFiles > MAX_DEPENDENCY_COPY_FILES || copiedBytes > MAX_DEPENDENCY_COPY_BYTES
          || record.size > MAX_DEPENDENCY_FILE_BYTES) {
        throw new Error("Production dependency extraction exceeded its reviewed file or byte boundary.");
      }
      const destination = path.join(destinationPackage, ...record.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, archive.contents.get(record.path), { flag: "wx", mode: record.mode });
      if (process.platform !== "win32") await chmod(destination, record.mode);
    }
    copiedPackages += 1;
  }
  await writeFile(path.join(destinationNodeModules, ".package-lock.json"), lockBytes, { flag: "wx", mode: 0o444 });
  console.log(`Extracted ${copiedPackages} SRI-verified production dependency archives under bounded create-new semantics.`);
}

async function validatePackageAgainstArchive(packageDirectory, archive, packageLockPath) {
  const expectedFiles = new Map(normalizedArchiveRecords(archive).map((record) => [record.path, record]));
  const expectedDirectories = new Set();
  const treeRecords = [];
  for (const record of expectedFiles.values()) {
    let parent = path.posix.dirname(record.path);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (relativeDirectory === "" && entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Extracted dependency contains an unsupported path type: ${packageLockPath}/${relative}`);
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relative)) throw new Error(`Extracted dependency contains an unreviewed directory: ${packageLockPath}/${relative}`);
        treeRecords.push(`d\0${relative}\0${(stat.mode & 0o777).toString(8)}\0`);
        await visit(absolute, relative);
        continue;
      }
      const expected = expectedFiles.get(relative);
      if (!expected || stat.size !== expected.size || (process.platform !== "win32" && (stat.mode & 0o777) !== expected.mode)) {
        throw new Error(`Extracted dependency differs from its SRI archive at ${packageLockPath}/${relative}`);
      }
      const bytes = await readFile(absolute);
      const bytesSha256 = sha256(bytes);
      if (bytes.length !== expected.size || bytesSha256 !== expected.sha256) {
        throw new Error(`Extracted dependency differs from its SRI archive at ${packageLockPath}/${relative}`);
      }
      treeRecords.push(`f\0${relative}\0${(stat.mode & 0o777).toString(8)}\0${bytesSha256}\0`);
      expectedFiles.delete(relative);
    }
  }

  await visit(packageDirectory, "");
  if (expectedFiles.size > 0) {
    throw new Error(`Extracted dependency omits SRI archive paths for ${packageLockPath}: ${[...expectedFiles.keys()].join(", ")}`);
  }
  return sha256(Buffer.from(treeRecords.join(""), "utf8"));
}

async function validateProductionDependenciesAgainstCache(lock, cacheRoot, runtimeRoot) {
  const destinationNodeModules = path.join(runtimeRoot, "node_modules");
  const topology = await collectInstalledPackages(runtimeRoot, lock);
  const topologyPaths = new Set(topology.packages.map((entry) => entry.path));
  const packages = Object.entries(lock.packages)
    .filter(([lockPath_, entry]) => lockPath_.startsWith("node_modules/") && entry?.dev !== true)
    .sort(([left], [right]) => left.localeCompare(right));
  const validated = [];
  for (const [packageLockPath, lockEntry] of packages) {
    const destinationPackage = assertSafePackageLockPath(packageLockPath, destinationNodeModules);
    const archive = await loadProductionArchive(cacheRoot, packageLockPath, lockEntry);
    if (archive === null) {
      try {
        await lstat(destinationPackage);
        throw new Error(`Dependency without an applicable SRI archive was installed: ${packageLockPath}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      continue;
    }
    const stat = await lstat(destinationPackage);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`SRI-bound dependency is not a real directory: ${packageLockPath}`);
    const treeSha256 = await validatePackageAgainstArchive(destinationPackage, archive, packageLockPath);
    const manifestBytes = archive.contents.get("package.json");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    validated.push({
      path: packageLockPath,
      name: manifest.name,
      version: manifest.version,
      integrity: lockEntry.integrity,
      packageJsonSha256: sha256(manifestBytes),
      treeSha256,
    });
    topologyPaths.delete(packageLockPath);
  }
  if (topologyPaths.size > 0) throw new Error(`Installed dependency topology lacks SRI authority: ${[...topologyPaths].join(", ")}`);
  validated.sort((left, right) => left.path.localeCompare(right.path));
  console.log(`Revalidated ${validated.length} installed dependency trees against SRI-verified archives.`);
  return { packages: validated, containers: topology.containers };
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
  const containers = [];
  const topNodeModules = path.join(runtimeRoot, "node_modules");

  function containerRecord(absolute, stat, kind) {
    return {
      path: path.relative(runtimeRoot, absolute).split(path.sep).join("/"),
      kind,
      mode: stat.mode & 0o777,
      device: stat.dev,
      inode: stat.ino,
    };
  }

  function assertSameContainer(before, after, absolute) {
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`Dependency container identity changed during inspection: ${absolute}`);
    }
  }

  async function scanNodeModules(nodeModulesDirectory, lockPrefix, required = false) {
    let before;
    try {
      before = await lstat(nodeModulesDirectory);
    } catch (error) {
      if (error?.code === "ENOENT" && !required) return;
      throw error;
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`node_modules container must be a real directory: ${nodeModulesDirectory}`);
    }
    const entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolute = path.join(nodeModulesDirectory, entry.name);
      if (entry.name === ".package-lock.json") {
        if (path.resolve(nodeModulesDirectory) !== path.resolve(topNodeModules)) {
          throw new Error(`Nested npm lock metadata is not permitted in the deterministic runtime: ${absolute}`);
        }
        continue;
      }
      if (entry.name === ".bin") {
        throw new Error(`Executable dependency shims are not permitted in the deterministic runtime: ${path.join(nodeModulesDirectory, entry.name)}`);
      }
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Installed dependency entry must not be a symlink: ${absolute}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Unexpected file in node_modules: ${absolute}`);
      }
      if (entry.name.startsWith("@")) {
        const scopeBefore = stat;
        const scoped = await readdir(absolute, { withFileTypes: true });
        scoped.sort((left, right) => left.name.localeCompare(right.name));
        if (scoped.length === 0) throw new Error(`Empty dependency scope is not permitted: ${absolute}`);
        for (const child of scoped) {
          if (!child.isDirectory() || child.isSymbolicLink()) {
            throw new Error(`Invalid scoped dependency entry: ${path.join(absolute, child.name)}`);
          }
          await inspectPackage(
            path.join(absolute, child.name),
            path.posix.join(lockPrefix, entry.name, child.name),
          );
        }
        const scopeAfter = await lstat(absolute);
        assertSameContainer(scopeBefore, scopeAfter, absolute);
        containers.push(containerRecord(absolute, scopeBefore, "scope"));
      } else {
        await inspectPackage(absolute, path.posix.join(lockPrefix, entry.name));
      }
    }
    const after = await lstat(nodeModulesDirectory);
    assertSameContainer(before, after, nodeModulesDirectory);
    containers.push(containerRecord(nodeModulesDirectory, before, "node_modules"));
  }

  async function inspectPackage(packageDirectory, lockPath) {
    const packageBefore = await lstat(packageDirectory);
    if (!packageBefore.isDirectory() || packageBefore.isSymbolicLink()) {
      throw new Error(`Dependency package must be a real directory: ${packageDirectory}`);
    }
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
    const packageAfter = await lstat(packageDirectory);
    assertSameContainer(packageBefore, packageAfter, packageDirectory);
    containers.push(containerRecord(packageDirectory, packageBefore, "package"));
  }

  await scanNodeModules(topNodeModules, "node_modules", true);
  packages.sort((left, right) => left.path.localeCompare(right.path));
  containers.sort((left, right) => left.path.localeCompare(right.path));
  return { packages, containers };
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

async function snapshot(lockPath, runtimeRoot, manifestPath, archivePath, cacheRoot = null) {
  if (path.dirname(manifestPath) !== runtimeRoot || path.basename(manifestPath) !== ".lightningloop-runtime-manifest.json") {
    throw new Error("Runtime manifest must use the reserved file directly beneath the runtime root.");
  }
  const contract = await readArchiveContract(lockPath, archivePath);
  const { lockBytes, lock, reviewedManifestBytes, archiveBytes, archive } = contract;
  const runtimeManifestBytes = await readRegularFile(path.join(runtimeRoot, "package.json"), 1024 * 1024);
  const runtimeManifest = JSON.parse(runtimeManifestBytes.toString("utf8"));
  assertRuntimeContract(contract.reviewedManifest, lock.packages[""], runtimeManifest);
  const rootPayload = await validatePackedRoot(runtimeRoot, archive, lockBytes, manifestPath);
  const installedLockMetadata = await readRegularFile(path.join(runtimeRoot, "node_modules", ".package-lock.json"), MAX_LOCK_BYTES);
  if (!installedLockMetadata.equals(lockBytes)) throw new Error("Installed npm lock metadata differs from the reviewed lock.");
  const dependencySnapshot = cacheRoot !== null
    ? await validateProductionDependenciesAgainstCache(lock, cacheRoot, runtimeRoot)
    : await collectInstalledPackages(runtimeRoot, lock);
  return {
    schemaVersion: 2,
    packedArchiveSha256: sha256(archiveBytes),
    packageLockSha256: sha256(lockBytes),
    reviewedPackageJsonSha256: sha256(reviewedManifestBytes),
    runtimePackageJsonSha256: sha256(runtimeManifestBytes),
    runtimeName: runtimeManifest.name,
    runtimeVersion: runtimeManifest.version,
    installedLockMetadataSha256: sha256(installedLockMetadata),
    ...rootPayload,
    dependencyContainers: dependencySnapshot.containers,
    packages: dependencySnapshot.packages,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const [mode, lockPathArgument, runtimeRootArgument, manifestPathArgument, archivePathArgument, cacheRootArgument] = process.argv.slice(2);
if (!new Set(["archive", "copy-production", "extract", "write", "verify"]).has(mode) || !lockPathArgument || !runtimeRootArgument
    || ((mode === "extract" || mode === "copy-production") && !manifestPathArgument)
    || ((mode === "write" || mode === "verify") && (!manifestPathArgument || !archivePathArgument))
    || (mode === "write" && !cacheRootArgument)) {
  throw new Error("Usage: locked_runtime_manifest.mjs archive LOCK_PATH ARCHIVE_PATH | extract LOCK_PATH RUNTIME_ROOT ARCHIVE_PATH | copy-production LOCK_PATH NPM_CACHE_ROOT RUNTIME_ROOT | write LOCK_PATH RUNTIME_ROOT MANIFEST_PATH ARCHIVE_PATH NPM_CACHE_ROOT | verify LOCK_PATH RUNTIME_ROOT MANIFEST_PATH ARCHIVE_PATH");
}

const lockPath = path.resolve(lockPathArgument);
if (mode === "archive") {
  const contract = await readArchiveContract(lockPath, path.resolve(runtimeRootArgument));
  console.log(`Verified packed archive ${sha256(contract.archiveBytes)} with ${contract.archive.records.length} complete payload entries.`);
  process.exit(0);
}
const runtimeRoot = path.resolve(runtimeRootArgument);
if (mode === "copy-production") {
  await copyProductionDependencies(lockPath, runtimeRoot, path.resolve(manifestPathArgument));
  process.exit(0);
}
if (mode === "extract") {
  const contract = await readArchiveContract(lockPath, path.resolve(manifestPathArgument));
  await extractPackedRoot(runtimeRoot, contract.archive);
  console.log(`Extracted ${contract.archive.records.length} reviewed packed payload entries.`);
  process.exit(0);
}
const manifestPath = path.resolve(manifestPathArgument);
const archivePath = path.resolve(archivePathArgument);
const actual = await snapshot(
  lockPath,
  runtimeRoot,
  manifestPath,
  archivePath,
  mode === "write" ? path.resolve(cacheRootArgument) : null,
);

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
