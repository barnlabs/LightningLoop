import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { doctor, isSupportedNodeVersion, parse, usage } from "./index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("no arguments select the read-only interactive TUI without launching it", () => {
  const options = parse([]);
  assert.equal(options.command, "tui");
  assert.equal(options.allowExecution, false);
  assert.deepEqual(options.passthrough, []);
});

test("help remains a noninteractive command", () => {
  assert.equal(parse(["help"]).command, "help");
  assert.equal(parse(["--help"]).command, "help");
  assert.match(usage(), /llp \| lloop \| lightningloop \[tui\]/u);
  assert.match(usage(), /RUNTIME_OPTIONS/u);
  assert.match(usage(), /Provider sign-in uses the managed LightningLoop runtime/u);
  assert.doesNotMatch(usage(), /\bPi\b/u);
});

test("provider and install-doctor commands parse as bounded first-run operations", () => {
  assert.equal(parse(["provider", "list"]).providerAction, "list");
  assert.equal(parse(["provider", "select", "cerebras"]).providerArgument, "cerebras");
  assert.equal(parse(["doctor", "--runtime-only"]).doctorRuntimeOnly, true);
  assert.throws(() => parse(["provider", "select", "custom"]), /must be one of/);
  assert.throws(() => parse(["provider", "list", "cerebras"]), /too many/);
  assert.throws(() => parse(["tui", "--runtime-only"]), /valid only with doctor/);
});

test("packed package exposes the stable and short TUI commands", async () => {
  const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };
  assert.deepEqual(packageManifest.bin, {
    lightningloop: "dist/cli/index.js",
    lloop: "dist/cli/index.js",
    llp: "dist/cli/index.js",
  });
  const packageLock = JSON.parse(await readFile(resolve(repositoryRoot, "package-lock.json"), "utf8")) as {
    packages?: Record<string, {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      bin?: Record<string, string>;
      engines?: Record<string, string>;
    }>;
  };
  const lockRoot = packageLock.packages?.[""];
  for (const field of ["name", "version", "dependencies", "bin", "engines"] as const) {
    assert.deepEqual(lockRoot?.[field], packageManifest[field], `package-lock root ${field}`);
  }
});

test("doctor's Node gate matches the installer minimum", () => {
  assert.equal(isSupportedNodeVersion("v22.18.99"), false);
  assert.equal(isSupportedNodeVersion("v22.19.0"), true);
  assert.equal(isSupportedNodeVersion("V22.19.0"), true);
  assert.equal(isSupportedNodeVersion("22.19.1+build"), true);
  assert.equal(isSupportedNodeVersion("v23.0.0"), true);
  assert.equal(isSupportedNodeVersion("v21.99.99"), false);
  assert.equal(isSupportedNodeVersion("not-a-version"), false);
});

test("doctor reports runtime-managed provider sign-in as opaque without probing it", { concurrency: false }, async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "lightningloop-cli-provider-"));
  const configPath = join(configDirectory, "provider.json");
  const originalConfigPath = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  const originalWrite = process.stdout.write;
  let output = "";
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "openai-codex",
      preset: "openai-codex",
      displayName: "OpenAI Codex",
      baseURL: "https://api.openai.com/v1",
      modelID: "gpt-5.6-terra",
      modelName: "GPT-5.6 Terra",
      supportsImages: true,
      contextWindow: 400_000,
      maxOutputTokens: 131_072,
    }), "utf8");
    process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = configPath;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    assert.equal(await doctor(), 0);
    assert.match(output, /Provider sign-in: MANAGED BY RUNTIME\/UNKNOWN/u);
    assert.doesNotMatch(output, /\bPi\b/u);
  } finally {
    process.stdout.write = originalWrite;
    if (originalConfigPath === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = originalConfigPath;
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("runtime-only doctor passes supported installation before provider onboarding", { concurrency: false }, async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "lightningloop-cli-doctor-clean-"));
  const originalConfigPath = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  const originalWrite = process.stdout.write;
  let output = "";
  try {
    process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = join(configDirectory, "missing-provider.json");
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    assert.equal(await doctor(), 1);
    assert.equal(await doctor(true), 0);
    assert.match(output, /SELECTION REQUIRED/u);
    assert.match(output, /Install\/runtime-only health/u);
  } finally {
    process.stdout.write = originalWrite;
    if (originalConfigPath === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = originalConfigPath;
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("CLI parser directs unsupported runtime options after the passthrough separator", () => {
  assert.throws(() => parse(["--unsupported-runtime-option"]), /Put runtime options after --\./u);
});

test("clean cross-platform data flow requires selection, lists presets, and stores no credential", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "lightningloop-cli-first-run-"));
  const cli = resolve(repositoryRoot, "dist/cli/index.js");
  const env = { ...process.env, LIGHTNINGLOOP_DATA_DIR: dataDirectory };
  try {
    const firstRun = spawnSync(process.execPath, [cli], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(firstRun.status, 2);
    assert.match(firstRun.stdout, /first run: choose a provider/u);
    assert.match(firstRun.stdout, /provider select PRESET/u);
    assert.doesNotMatch(`${firstRun.stdout}${firstRun.stderr}`, /--provider\s+selection-required|--model\s*(?:\r?\n|$)/u);

    const list = spawnSync(process.execPath, [cli, "provider", "list"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /cerebras · Cerebras Inference/u);
    assert.match(list.stdout, /openai-codex/u);
    await assert.rejects(readFile(join(dataDirectory, "provider.json"), "utf8"), { code: "ENOENT" });

    const select = spawnSync(process.execPath, [cli, "provider", "select", "cerebras"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(select.status, 0, select.stderr);
    const encoded = await readFile(join(dataDirectory, "provider.json"), "utf8");
    assert.equal(JSON.parse(encoded).preset, "cerebras");
    assert.doesNotMatch(encoded, /(?:api.?key|authorization|bearer\s|(?:csk|sk)-)/iu);

    const selectedDoctor = spawnSync(process.execPath, [cli, "doctor"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(selectedDoctor.status, 0, selectedDoctor.stderr);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("production provider paths contain no Pi getAuth calls", async () => {
  for (const relativePath of ["Harness/pi/model-adapter.ts", "Harness/rpc/server.ts", "Harness/cli/index.ts"]) {
    const source = await readFile(resolve(repositoryRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /getAuth\s*\(/u, relativePath);
  }
});
