import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseProviderProfile, profileForPreset } from "../core/provider-profile.js";
import { PiProviderAdapter } from "./model-adapter.js";

test("built-in Pi providers never inspect Pi authentication state", async () => {
  const profile = profileForPreset("openai-codex");
  let getAuthCalls = 0;
  const runtime = {
    getAuth: () => {
      getAuthCalls += 1;
      throw new Error("LightningLoop must not read Pi auth state");
    },
    getModel: (providerID: string, modelID: string) => {
      assert.equal(providerID, "openai-codex");
      assert.equal(modelID, profile.modelID);
      return {};
    },
    registerProvider: () => assert.fail("built-in Pi providers must not register a Keychain fallback"),
    completeSimple: async () => assert.fail("not exercised"),
  } as unknown as Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;

  const adapter = await PiProviderAdapter.create(profile, async () => runtime);
  assert.equal(adapter.supportsImages, true);
  assert.equal(getAuthCalls, 0);
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
    getModel: () => ({}),
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
    getModel: () => ({}),
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
    getModel: () => ({}),
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
    getModel: () => ({}),
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
