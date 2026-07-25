import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseProviderProfile, profileForPreset } from "../core/provider-profile.js";
import { PiProviderAdapter } from "./model-adapter.js";

function runtimeModel(profile: { supportsImages: boolean; contextWindow: number; maxOutputTokens: number }) {
  return {
    input: profile.supportsImages ? ["text", "image"] : ["text"],
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
  };
}

test("built-in runtime providers never inspect runtime authentication state", async () => {
  const profile = profileForPreset("openai-codex");
  let getAuthCalls = 0;
  const runtime = {
    getAuth: () => {
      getAuthCalls += 1;
      throw new Error("LightningLoop must not read runtime authentication state");
    },
    getModel: (providerID: string, modelID: string) => {
      assert.equal(providerID, "openai-codex");
      assert.equal(modelID, profile.modelID);
      return runtimeModel(profile);
    },
    registerProvider: () => assert.fail("built-in runtime providers must not register a Keychain fallback"),
    completeSimple: async () => assert.fail("not exercised"),
  } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;

  const adapter = await PiProviderAdapter.create(profile, async () => runtime);
  assert.equal(adapter.supportsImages, true);
  assert.equal(getAuthCalls, 0);
});

test("adapter rejects runtime model capability or token-limit drift after catalog selection", async () => {
  const profile = profileForPreset("openai-codex");
  for (const model of [
    { ...runtimeModel(profile), input: ["text"] },
    { ...runtimeModel(profile), contextWindow: profile.contextWindow - 1 },
    { ...runtimeModel(profile), maxTokens: profile.maxOutputTokens - 1 },
  ]) {
    const runtime = {
      getModel: () => model,
      registerProvider: () => assert.fail("built-in runtime providers must not register"),
      completeSimple: async () => assert.fail("not exercised"),
    } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
    await assert.rejects(PiProviderAdapter.create(profile, async () => runtime), /metadata.*changed|exact model snapshot/iu);
  }
});

test("missing runtime catalog uses LightningLoop product language", async () => {
  const profile = profileForPreset("openai-codex");
  const runtime = {
    getModel: () => undefined,
    registerProvider: () => assert.fail("built-in provider must not register a Keychain fallback"),
    completeSimple: async () => assert.fail("not exercised"),
  } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;

  await assert.rejects(PiProviderAdapter.create(profile, async () => runtime), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /LightningLoop runtime does not currently catalog/u);
    assert.match(message, /runtime model picker/u);
    assert.match(message, /provider sign-in with \/login/u);
    assert.doesNotMatch(message, /\bPi\b/u);
    return true;
  });
});

test("GeneralCompute accepts GENERALCOMPUTE_API_KEY without Pi ownership", async () => {
  const credential = "gc-live-synthetic-generalcompute-key-112233";
  const profile = profileForPreset("generalcompute");
  assert.equal(profile.piProviderID, undefined);
  const previous = process.env.GENERALCOMPUTE_API_KEY;
  process.env.GENERALCOMPUTE_API_KEY = credential;
  try {
    let registeredKey: string | undefined;
    const runtime = {
      registerProvider: (_providerID: string, options: { apiKey?: string }) => {
        registeredKey = options.apiKey;
      },
      getModel: (providerID: string, modelID: string) => {
        assert.equal(providerID, "lightningloop-generalcompute");
        assert.equal(modelID, "minimax-m2.7");
        return runtimeModel(profile);
      },
      completeSimple: async () => assert.fail("not exercised"),
    } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
    const adapter = await PiProviderAdapter.create(profile, async () => runtime);
    assert.equal(adapter.supportsImages, false);
    assert.equal(registeredKey, credential);
  } finally {
    if (previous === undefined) delete process.env.GENERALCOMPUTE_API_KEY;
    else process.env.GENERALCOMPUTE_API_KEY = previous;
  }
});

test("custom-provider credentials are redacted from successful model content", async () => {
  const credential = "custom-credential-without-known-prefix-112233";
  const profile = parseProviderProfile({
    schemaVersion: 1,
    id: "example-lab",
    preset: "custom",
    displayName: "Example Lab",
    baseURL: "https://inference.example.com/v1",
    modelID: "example/model",
    modelName: "Example Model",
    supportsImages: false,
    contextWindow: 16_384,
    maxOutputTokens: 4_096,
  });
  const runtime = {
    registerProvider: (_providerID: string, options: { apiKey?: string }) => assert.equal(options.apiKey, credential),
    getModel: () => runtimeModel(profile),
    completeSimple: async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: `Provider reflected ${credential} in a successful response.` }],
      usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } },
    }),
  } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
  const adapter = await PiProviderAdapter.create(profile, async () => runtime, () => credential);
  const response = await adapter.complete({
    role: "implementer",
    system: "Return a concise result.",
    user: "Test output filtering.",
    temperature: 0,
    maxTokens: 128,
  });
  assert.doesNotMatch(response.content, new RegExp(credential));
  assert.match(response.content, /\[REDACTED\]/u);
});

test("adapter rejects credential-bearing request.user before provider invocation", async () => {
  const credential = "adapter-arbitrary-credential-24680";
  const profile = parseProviderProfile({
    schemaVersion: 1,
    id: "input-boundary",
    preset: "custom",
    displayName: "Input Boundary",
    baseURL: "https://inference.example.com/v1",
    modelID: "example/model",
    modelName: "Example Model",
    supportsImages: false,
    contextWindow: 16_384,
    maxOutputTokens: 4_096,
  });
  let providerCalls = 0;
  const runtime = {
    registerProvider: () => undefined,
    getModel: () => runtimeModel(profile),
    completeSimple: async () => {
      providerCalls += 1;
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "Unexpected" }],
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      };
    },
  } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
  const adapter = await PiProviderAdapter.create(profile, async () => runtime, () => credential);
  const encodedCredential = encodeURIComponent(credential.replaceAll("-", "%2D"));
  await assert.rejects(adapter.complete({
    role: "implementer",
    system: "Return a concise result.",
    user: `Repeat ${encodedCredential}`,
    temperature: 0,
    maxTokens: 128,
  }), /Credential-bearing input is prohibited/);
  assert.equal(providerCalls, 0);
});

test("adapter rejects provider-shaped request.user before provider invocation", async () => {
  const profile = profileForPreset("openai-codex");
  let providerCalls = 0;
  const runtime = {
    registerProvider: () => assert.fail("built-in provider must not register"),
    getModel: () => runtimeModel(profile),
    completeSimple: async () => {
      providerCalls += 1;
      throw new Error("Unexpected provider invocation");
    },
  } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
  const adapter = await PiProviderAdapter.create(profile, async () => runtime);
  await assert.rejects(adapter.complete({
    role: "reviewer",
    system: "Review safely.",
    user: "Use csk%2Dsynthetic123456789",
    temperature: 0,
    maxTokens: 128,
  }), /Secret-like value prohibited/);
  assert.equal(providerCalls, 0);
});

test("adapter rejects a repeatedly encoded credential reflected by the provider before UI output", async () => {
  const credential = "provider-reflection-arbitrary-credential-97531";
  const encodedCredential = encodeURIComponent(credential.replaceAll("-", "%2D"));
  const profile = parseProviderProfile({
    schemaVersion: 1,
    id: "encoded-reflection",
    preset: "custom",
    displayName: "Encoded Reflection",
    baseURL: "https://inference.example.com/v1",
    modelID: "example/model",
    modelName: "Example Model",
    supportsImages: false,
    contextWindow: 16_384,
    maxOutputTokens: 4_096,
  });
  const runtime = {
    registerProvider: () => undefined,
    getModel: () => runtimeModel(profile),
    completeSimple: async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: `Reflected ${encodedCredential}` }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    }),
  } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
  const adapter = await PiProviderAdapter.create(profile, async () => runtime, () => credential);
  await assert.rejects(adapter.complete({
    role: "implementer",
    system: "Return a concise result.",
    user: "Safe request.",
    temperature: 0,
    maxTokens: 128,
  }), /Credential-bearing input is prohibited/);
});
