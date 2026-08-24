import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveConfigValueUncached } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";
import { profileForPreset } from "../core/provider-profile.js";
import { PiProviderAdapter, providerEnvApiKey, supportsManualApiKeyOverride } from "./model-adapter.js";
import { prepareTuiRuntimeCredentials } from "../cli/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const extensionModuleUrl = pathToFileURL(join(repositoryRoot, "dist/pi/lightningloop-extension.js")).href;

function runtimeModel(profile: { supportsImages: boolean; contextWindow: number; maxOutputTokens: number }) {
  return {
    input: profile.supportsImages ? ["text", "image"] : ["text"],
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
  };
}

test("Cerebras is a manual-key override preset while GeneralCompute is not", () => {
  assert.equal(supportsManualApiKeyOverride(profileForPreset("cerebras")), true);
  assert.equal(supportsManualApiKeyOverride(profileForPreset("generalcompute")), false);
  assert.equal(supportsManualApiKeyOverride(profileForPreset("openrouter")), false);
});

test("providerEnvApiKey reads CEREBRAS_API_KEY and falls back to CEREBRAS_KEY", () => {
  const profile = profileForPreset("cerebras");
  const previousApi = process.env.CEREBRAS_API_KEY;
  const previousKey = process.env.CEREBRAS_KEY;
  try {
    delete process.env.CEREBRAS_KEY;
    process.env.CEREBRAS_API_KEY = "cerebras-primary-secret-123456";
    assert.equal(providerEnvApiKey(profile), "cerebras-primary-secret-123456");

    delete process.env.CEREBRAS_API_KEY;
    process.env.CEREBRAS_KEY = "cerebras-alias-secret-654321";
    assert.equal(providerEnvApiKey(profile), "cerebras-alias-secret-654321");

    delete process.env.CEREBRAS_KEY;
    assert.equal(providerEnvApiKey(profile), undefined);
  } finally {
    if (previousApi === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = previousApi;
    if (previousKey === undefined) delete process.env.CEREBRAS_KEY;
    else process.env.CEREBRAS_KEY = previousKey;
  }
});

test("Cerebras manual env key registers an OpenAI-compatible LightningLoop-managed provider", async () => {
  const credential = "cerebras-manual-live-key-1122334455";
  const profile = profileForPreset("cerebras");
  assert.equal(profile.piProviderID, "cerebras");
  const previousApi = process.env.CEREBRAS_API_KEY;
  const previousKey = process.env.CEREBRAS_KEY;
  try {
    delete process.env.CEREBRAS_KEY;
    process.env.CEREBRAS_API_KEY = credential;
    let registeredID: string | undefined;
    let registeredOptions: { apiKey?: string; baseUrl?: string; api?: string } | undefined;
    const runtime = {
      registerProvider: (providerID: string, opts: { apiKey?: string; baseUrl?: string; api?: string }) => {
        registeredID = providerID;
        registeredOptions = opts;
      },
      getModel: (providerID: string, modelID: string) => {
        assert.equal(providerID, "lightningloop-cerebras");
        assert.equal(modelID, profile.modelID);
        return runtimeModel(profile);
      },
      completeSimple: async () => assert.fail("not exercised"),
    } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
    await PiProviderAdapter.create(profile, async () => runtime);
    assert.equal(registeredID, "lightningloop-cerebras");
    assert.equal(registeredOptions?.baseUrl, "https://api.cerebras.ai/v1");
    assert.equal(registeredOptions?.api, "openai-completions");
    assert.equal(resolveConfigValueUncached(registeredOptions?.apiKey ?? "", {}), credential);
  } finally {
    if (previousApi === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = previousApi;
    if (previousKey === undefined) delete process.env.CEREBRAS_KEY;
    else process.env.CEREBRAS_KEY = previousKey;
  }
});

test("Cerebras manual key from the OS secret store registers the managed provider", async () => {
  const credential = "cerebras-stored-secret-9988776655";
  const profile = profileForPreset("cerebras");
  const previousApi = process.env.CEREBRAS_API_KEY;
  const previousKey = process.env.CEREBRAS_KEY;
  try {
    // No env key: the credential arrives only through the injected store reader.
    delete process.env.CEREBRAS_API_KEY;
    delete process.env.CEREBRAS_KEY;
    let registeredID: string | undefined;
    const runtime = {
      registerProvider: (providerID: string) => { registeredID = providerID; },
      getModel: (providerID: string, modelID: string) => {
        assert.equal(providerID, "lightningloop-cerebras");
        assert.equal(modelID, profile.modelID);
        return runtimeModel(profile);
      },
      completeSimple: async () => assert.fail("not exercised"),
    } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
    await PiProviderAdapter.create(profile, async () => runtime, () => credential);
    assert.equal(registeredID, "lightningloop-cerebras");
  } finally {
    if (previousApi === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = previousApi;
    if (previousKey === undefined) delete process.env.CEREBRAS_KEY;
    else process.env.CEREBRAS_KEY = previousKey;
  }
});

test("Cerebras with no manual key keeps the Pi-managed /login provider id", async () => {
  const profile = profileForPreset("cerebras");
  const runtime = {
    registerProvider: () => assert.fail("Cerebras without a manual key must not register a managed provider"),
    getModel: (providerID: string, modelID: string) => {
      assert.equal(providerID, "cerebras");
      assert.equal(modelID, profile.modelID);
      return runtimeModel(profile);
    },
    completeSimple: async () => assert.fail("not exercised"),
  } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
  // Inject an empty credential reader so neither env nor store yields a key.
  const adapter = await PiProviderAdapter.create(profile, async () => runtime, () => undefined);
  assert.equal(adapter.supportsImages, profile.supportsImages);
});

test("TUI preparation captures the Cerebras manual key and scrubs both aliases", () => {
  const env: NodeJS.ProcessEnv = {
    CEREBRAS_API_KEY: "cerebras-primary-tui-secret-123456",
    CEREBRAS_KEY: "cerebras-alias-tui-secret-654321",
  };
  const options = prepareTuiRuntimeCredentials(profileForPreset("cerebras"), env);
  assert.equal(env.CEREBRAS_API_KEY, undefined);
  assert.equal(env.CEREBRAS_KEY, undefined);
  assert.equal(options.cerebrasApiKey, "cerebras-primary-tui-secret-123456");
});

test("TUI preparation captures the CEREBRAS_KEY alias when it is the only manual key", () => {
  const env: NodeJS.ProcessEnv = { CEREBRAS_KEY: "cerebras-alias-only-tui-778899" };
  const options = prepareTuiRuntimeCredentials(profileForPreset("cerebras"), env);
  assert.equal(env.CEREBRAS_KEY, undefined);
  assert.equal(options.cerebrasApiKey, "cerebras-alias-only-tui-778899");
});

test("TUI preparation leaves Cerebras on the Pi path when no manual key is set", () => {
  const env: NodeJS.ProcessEnv = {};
  const options = prepareTuiRuntimeCredentials(profileForPreset("cerebras"), env);
  assert.deepEqual(options, {});
});

test("TUI extension registers a managed Cerebras provider only with a manual key", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-cerebras-extension-"));
  const config = join(directory, "provider.json");
  const script = join(directory, "cerebras-extension.mjs");
  writeFileSync(config, `${JSON.stringify({
    schemaVersion: 1,
    id: "cerebras",
    preset: "cerebras",
    displayName: "Cerebras Inference",
    baseURL: "https://api.cerebras.ai/v1",
    modelID: "gemma-4-31b",
    modelName: "Gemma 4 31B",
    supportsImages: true,
    contextWindow: 131_072,
    maxOutputTokens: 40_960,
  }, null, 2)}\n`);
  writeFileSync(script, `
import assert from "node:assert/strict";
const { createLightningLoopExtension } = await import(${JSON.stringify(extensionModuleUrl)});
const { resolveConfigValueUncached } = await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js")).href)});
const credential = "!cerebras_$NAME_ext_manual_246810";

function makePi(registrations) {
  return {
    registerTool: () => undefined,
    registerFlag: () => undefined,
    registerProvider: (id, options) => registrations.push({ id, options }),
    on: () => undefined,
    getFlag: () => false,
    registerCommand: () => undefined,
  };
}

const withKey = [];
createLightningLoopExtension({ cerebrasApiKey: credential })(makePi(withKey));
assert.equal(withKey.length, 1, "a manual key must register exactly one managed provider");
assert.equal(withKey[0].id, "lightningloop-cerebras");
assert.equal(withKey[0].options.baseUrl, "https://api.cerebras.ai/v1");
assert.equal(withKey[0].options.api, "openai-completions");
assert.notEqual(withKey[0].options.apiKey, credential);
assert.equal(resolveConfigValueUncached(withKey[0].options.apiKey, { NAME: "different-ambient-value" }), credential);

const withoutKey = [];
createLightningLoopExtension({})(makePi(withoutKey));
assert.equal(withoutKey.length, 0, "no manual key must keep the Pi-managed /login path");

console.log("cerebras-extension-ok");
`);
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: repositoryRoot,
      env: { ...process.env, LIGHTNINGLOOP_PROVIDER_CONFIG_PATH: config },
      timeout: 15_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /cerebras-extension-ok/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
