#!/usr/bin/env node

import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const npmCli = process.platform === "win32"
  ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  : undefined;
const npm = process.platform === "win32" ? process.execPath : "npm";
const root = await mkdtemp(path.join(tmpdir(), "lightningloop-dirty-cache-"));
const dependency = path.join(root, "dependency");
const application = path.join(root, "application");
const cache = path.join(root, "cache");
const verifier = path.join(path.dirname(fileURLToPath(import.meta.url)), "locked_runtime_manifest.mjs");
await mkdir(dependency, { recursive: true });
await mkdir(application, { recursive: true });
await mkdir(cache, { recursive: true });
await writeFile(path.join(dependency, "package.json"), '{"name":"lightningloop-cache-fixture","version":"1.0.0"}\n');

function run(args, cwd, expectedSuccess = true) {
  const result = spawnSync(npm, npmCli ? [npmCli, ...args] : args, { cwd, encoding: "utf8" });
  if (expectedSuccess && result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed:\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  if (!expectedSuccess && result.status === 0) {
    throw new Error(`npm ${args.join(" ")} unexpectedly accepted poisoned cached bytes.`);
  }
  return result;
}

run(["pack", "--ignore-scripts", "--silent", "--pack-destination", root], dependency);
const archive = path.join(root, "lightningloop-cache-fixture-1.0.0.tgz");
await writeFile(
  path.join(application, "package.json"),
  `${JSON.stringify({
    name: "lightningloop-cache-consumer",
    version: "1.0.0",
    private: true,
    dependencies: { "lightningloop-cache-fixture": "file:../lightningloop-cache-fixture-1.0.0.tgz" },
  })}\n`,
);
run(["install", "--package-lock-only", "--ignore-scripts", "--cache", cache], application);
run(["cache", "add", archive, "--cache", cache], root);
run(["ci", "--offline", "--ignore-scripts", "--cache", cache], application);
const verifiedRuntime = path.join(root, "verified-runtime");
await mkdir(verifiedRuntime);
const verified = spawnSync(process.execPath, [verifier, "copy-production", path.join(application, "package-lock.json"), cache, verifiedRuntime], { encoding: "utf8" });
if (verified.status !== 0) throw new Error(`SRI cache extraction fixture failed before poisoning:\n${verified.stderr}`);

// Remove the original archive so the next install can use only the cache, then
// corrupt that cache. npm must reject the bytes using package-lock integrity.
await rename(archive, `${archive}.unavailable`);
const contentRoot = path.join(cache, "_cacache", "content-v2");
async function firstFile(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile()) return candidate;
    if (entry.isDirectory()) {
      const nested = await firstFile(candidate);
      if (nested) return nested;
    }
  }
  return undefined;
}
const cachedTarball = await firstFile(contentRoot);
if (!cachedTarball) throw new Error("Fixture did not populate npm's content cache.");
await appendFile(cachedTarball, "poisoned-cache-bytes");
const poisonedRuntime = path.join(root, "poisoned-runtime");
await mkdir(poisonedRuntime);
const poisoned = spawnSync(process.execPath, [verifier, "copy-production", path.join(application, "package-lock.json"), cache, poisonedRuntime], { encoding: "utf8" });
if (poisoned.status === 0 || !poisoned.stderr.includes("fail reviewed integrity")) {
  throw new Error(`LightningLoop cache extraction did not reject poisoned SRI bytes:\n${poisoned.stdout}\n${poisoned.stderr}`);
}
run(["ci", "--offline", "--ignore-scripts", "--cache", cache], application, false);
await rm(root, { recursive: true, force: true });
console.log("PASS: npm ci and LightningLoop extraction rejected poisoned cache bytes using lockfile integrity.");
