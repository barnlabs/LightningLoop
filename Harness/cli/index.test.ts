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
  assert.match(usage(), /agents select <researcher\|engineer\|verifier>/u);
  assert.match(usage(), /lightningloop browse URL/u);
  assert.match(usage(), /llp, lloop, and lightningloop are the same product/u);
  assert.match(usage(), /llp help/u);
  assert.match(usage(), /llp provider list/u);
  assert.match(usage(), /llp key set openrouter/u);
  assert.match(usage(), /llp free/u);
  assert.match(usage(), /llp doctor/u);
  assert.match(usage(), /llp loop "your goal"/u);
  assert.match(usage(), /never argv or a file/u);
  assert.doesNotMatch(usage(), /\bPi\b/u);
});

test("provider and install-doctor commands parse as bounded first-run operations", () => {
  assert.equal(parse(["provider", "list"]).providerAction, "list");
  assert.equal(parse(["provider", "select", "cerebras"]).providerArgument, "cerebras");
  assert.equal(parse(["provider", "select", "openrouter"]).providerArgument, "openrouter");
  assert.equal(parse(["provider", "models", "--free"]).providerAction, "models");
  assert.equal(parse(["provider", "models", "--free"]).providerFreeOnly, true);
  assert.equal(parse(["provider", "models"]).providerFreeOnly, false);
  assert.equal(parse(["provider", "select", "openrouter", "--model", "vendor/model-1:free"]).providerModel, "vendor/model-1:free");
  assert.equal(parse(["free"]).command, "free");
  assert.equal(parse(["free", "--model", "openrouter/free"]).providerModel, "openrouter/free");
  // "free" as the keyless search provider must not be swallowed by the `free` command.
  assert.equal(parse(["search", "free", "open source"]).command, "search");
  assert.equal(parse(["search", "free", "open source"]).searchProvider, "free");
  assert.equal(parse(["search", "free", "open source"]).searchQuery, "open source");
  assert.equal(parse(["loop", "hi", "--research", "free"]).researchProvider, "free");
  assert.throws(() => parse(["search", "bogus", "q"]), /exa, brave, firecrawl, or free/);
  // Model fusion opt-in list is captured and bounded.
  assert.equal(parse(["loop", "goal", "--fusion", "a/x,b/y"]).fusionModels, "a/x,b/y");
  assert.throws(() => parse(["loop", "goal", "--fusion", "bad\nlist"]), /bounded comma-separated model list/);
  assert.equal(parse(["key", "set", "openrouter"]).keyAction, "set");
  assert.equal(parse(["key", "status", "openrouter"]).keyProvider, "openrouter");
  assert.throws(() => parse(["key", "bogus", "openrouter"]), /set, status, or clear/);
  assert.equal(parse(["doctor", "--runtime-only"]).doctorRuntimeOnly, true);
  assert.equal(parse(["agents", "list"]).command, "agents");
  assert.equal(parse(["agents", "list"]).agentAction, "list");
  assert.equal(parse(["agents", "select", "researcher", "--model", "openrouter/free"]).agentRole, "researcher");
  assert.equal(parse(["agents", "select", "engineer", "--model", "openrouter/free"]).providerModel, "openrouter/free");
  assert.equal(parse(["browse", "https://www.rfc-editor.org/rfc/rfc9110"]).command, "browse");
  assert.equal(parse(["browse", "https://www.rfc-editor.org/rfc/rfc9110"]).browseURL, "https://www.rfc-editor.org/rfc/rfc9110");
  assert.throws(() => parse(["agents", "select", "intern"]), /researcher, engineer, or verifier/);
  assert.throws(() => parse(["browse", "https://a.example/", "https://b.example/"]), /one URL/);
  assert.throws(() => parse(["provider", "select", "custom"]), /must be one of/);
  assert.throws(() => parse(["provider", "list", "cerebras"]), /too many/);
  assert.throws(() => parse(["provider", "action-x"]), /list, select, or models/);
  assert.throws(() => parse(["provider", "select", "openrouter", "--model", "bad\nid"]), /bounded model ID/);
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
    assert.match(output, /Loop agents:/u);
    assert.match(output, /researcher:/u);
    assert.match(output, /Source policy: reputable primary hosts only/u);
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
  // First-run isolation: do not inherit suite fixture LIGHTNINGLOOP_PROVIDER_CONFIG_PATH.
  const env: NodeJS.ProcessEnv = { ...process.env, LIGHTNINGLOOP_DATA_DIR: dataDirectory };
  delete env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  try {
    const firstRun = spawnSync(process.execPath, [cli], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(firstRun.status, 2);
    assert.match(firstRun.stdout, /first run: choose a provider/u);
    assert.match(firstRun.stdout, /llp help/u);
    assert.match(firstRun.stdout, /provider select PRESET/u);
    assert.match(firstRun.stdout, /llp key set/u);
    assert.match(firstRun.stdout, /llp free/u);
    assert.match(firstRun.stdout, /llp doctor/u);
    assert.match(firstRun.stdout, /agents select researcher\|engineer\|verifier/u);
    assert.match(firstRun.stdout, /browse URL/u);
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

test("OpenRouter is listed and selectable with the free default without a runtime login", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "lightningloop-cli-openrouter-"));
  const cli = resolve(repositoryRoot, "dist/cli/index.js");
  const env: NodeJS.ProcessEnv = { ...process.env, LIGHTNINGLOOP_DATA_DIR: dataDirectory };
  delete env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  try {
    const list = spawnSync(process.execPath, [cli, "provider", "list"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /openrouter · OpenRouter/u);

    // Default select needs no network (no --model): it persists the free default.
    const select = spawnSync(process.execPath, [cli, "provider", "select", "openrouter"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(select.status, 0, select.stderr);
    assert.match(select.stdout, /OPENROUTER_API_KEY/u);
    assert.match(select.stdout, /provider models --free/u);

    const encoded = await readFile(join(dataDirectory, "provider.json"), "utf8");
    const parsed = JSON.parse(encoded) as { preset: string; modelID: string; piProviderID?: string };
    assert.equal(parsed.preset, "openrouter");
    assert.match(parsed.modelID, /:free$/u);
    assert.equal(parsed.piProviderID, undefined);
    assert.doesNotMatch(encoded, /(?:api.?key|authorization|bearer\s|(?:csk|sk)-)/iu);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("OpenRouter --model select validates against the live catalog when egress is available", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "lightningloop-cli-openrouter-live-"));
  const cli = resolve(repositoryRoot, "dist/cli/index.js");
  const env: NodeJS.ProcessEnv = { ...process.env, LIGHTNINGLOOP_DATA_DIR: dataDirectory };
  delete env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  try {
    const models = spawnSync(process.execPath, [cli, "provider", "models", "--free"], { cwd: repositoryRoot, env, encoding: "utf8" });
    if (models.status !== 0) {
      // No egress in this environment: the live catalog path is covered by the
      // resolveSelectableModel unit tests instead.
      return;
    }
    const freeId = models.stdout.split(/\r?\n/u).map((line) => line.trim().split(" ")[0]).find((id) => id?.endsWith(":free"));
    assert.ok(freeId, "expected at least one free model id from discovery");

    // A real free id is accepted under --free and persisted.
    const good = spawnSync(process.execPath, [cli, "provider", "select", "openrouter", "--model", freeId!, "--free"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    const parsed = JSON.parse(await readFile(join(dataDirectory, "provider.json"), "utf8")) as { modelID: string };
    assert.equal(parsed.modelID, freeId);

    // An unknown id is rejected (fail closed).
    const unknown = spawnSync(process.execPath, [cli, "provider", "select", "openrouter", "--model", "totally/made-up-model-xyz:free"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.notEqual(unknown.status, 0);
    assert.match(`${unknown.stderr}${unknown.stdout}`, /not in the current OpenRouter catalog/u);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("free mode pins a free OpenRouter model and doctor reflects it (egress-tolerant)", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "lightningloop-cli-free-"));
  const cli = resolve(repositoryRoot, "dist/cli/index.js");
  const env: NodeJS.ProcessEnv = { ...process.env, LIGHTNINGLOOP_DATA_DIR: dataDirectory };
  delete env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  try {
    const free = spawnSync(process.execPath, [cli, "free"], { cwd: repositoryRoot, env, encoding: "utf8" });
    if (free.status !== 0) return; // no egress here → free-mode logic is covered by unit tests
    assert.match(free.stdout, /Free mode ON/u);
    const parsed = JSON.parse(await readFile(join(dataDirectory, "provider.json"), "utf8")) as { preset: string; modelID: string; freeOnly?: boolean };
    assert.equal(parsed.preset, "openrouter");
    assert.equal(parsed.freeOnly, true);
    assert.match(parsed.modelID, /free/u);

    const doc = spawnSync(process.execPath, [cli, "doctor"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.match(doc.stdout, /Free mode: ON/u);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("key status reports the secure store and never displays a value", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "lightningloop-cli-key-"));
  const cli = resolve(repositoryRoot, "dist/cli/index.js");
  const env: NodeJS.ProcessEnv = { ...process.env, LIGHTNINGLOOP_DATA_DIR: dataDirectory };
  delete env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  try {
    const status = spawnSync(process.execPath, [cli, "key", "status", "openrouter"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Secure store:/u);
    assert.match(status.stdout, /Stored key: (?:PRESENT|none)/u);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("agents select persists a credential-free roster and browse refuses non-reputable hosts", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "lightningloop-cli-agents-"));
  const cli = resolve(repositoryRoot, "dist/cli/index.js");
  const env: NodeJS.ProcessEnv = { ...process.env, LIGHTNINGLOOP_DATA_DIR: dataDirectory };
  delete env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  try {
    const listed = spawnSync(process.execPath, [cli, "agents", "list"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /researcher:/u);
    assert.match(listed.stdout, /engineer:/u);
    assert.match(listed.stdout, /verifier:/u);

    const pinned = spawnSync(process.execPath, [cli, "agents", "select", "researcher", "--model", "openrouter/free"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.equal(pinned.status, 0, pinned.stderr);
    const roster = JSON.parse(await readFile(join(dataDirectory, "agents.json"), "utf8")) as {
      schemaVersion: number;
      agents: { researcher: { modelID: string } };
    };
    assert.equal(roster.schemaVersion, 1);
    assert.equal(roster.agents.researcher.modelID, "openrouter/free");
    assert.doesNotMatch(await readFile(join(dataDirectory, "agents.json"), "utf8"), /api.?key|bearer/iu);

    const refused = spawnSync(process.execPath, [cli, "browse", "https://example.com/"], { cwd: repositoryRoot, env, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stderr}${refused.stdout}`, /not a reputable primary source/u);
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
