import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultProviderProfile,
  historicalReadOnlyProviderCredentialServices,
  isProviderSelectionRequired,
  lightningLoopCredentialServices,
  loadHistoricalCustomCredentialServices,
  loadProviderProfile,
  parseProviderProfile,
  profileForPreset,
  providerCredentialService,
  providerHeaders,
  runtimeModelSelectionNotice,
  saveProviderPreset,
  selectableProviderPresets,
} from "./provider-profile.js";

test("default profile selects Pi's OpenAI Codex login preset without embedding a credential", () => {
  const profile = defaultProviderProfile();
  assert.equal(profile.preset, "openai-codex");
  assert.equal(profile.piProviderID, "openai-codex");
  assert.equal(profile.modelID, "gpt-5.6-terra");
  assert.doesNotMatch(JSON.stringify(profile), /(?:api.?key|(?:csk|sk)-)/i);
});

test("OpenAI Codex preset uses the shared 131072-token output limit", () => {
  assert.equal(profileForPreset("openai-codex").maxOutputTokens, 131_072);
});

test("missing provider configuration enters explicit provider selection", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-provider-"));
  try {
    const profile = loadProviderProfile(join(directory, "provider.json"));
    assert.equal(isProviderSelectionRequired(profile), true);
    assert.equal(profile.displayName, "Choose a provider");
    assert.equal(profile.piProviderID, undefined);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Groq remains available as an optional API-key preset", () => {
  const profile = profileForPreset("groq");
  assert.equal(profile.preset, "groq");
  assert.equal(profile.piProviderID, "groq");
  assert.equal(providerCredentialService(profile), "com.barnlabs.LightningLoop.provider.groq.apiKey");
});

test("Cerebras starts with a guarded public-preview Gemma 4 31B preference", () => {
  const profile = profileForPreset("cerebras");
  assert.equal(profile.baseURL, "https://api.cerebras.ai/v1");
  assert.equal(profile.modelID, "gemma-4-31b");
  assert.equal(profile.modelName, "Gemma 4 31B");
  assert.equal(profile.supportsImages, true);
  assert.equal(profile.maxOutputTokens, 40_960);
  assert.equal(providerCredentialService(profile), "com.barnlabs.LightningLoop.provider.cerebras.apiKey");
  assert.deepEqual(providerHeaders(profile), {});
  assert.match(runtimeModelSelectionNotice(profile) ?? "", /public-preview/i);
  assert.doesNotMatch(JSON.stringify(profile), /csk-/u);
});

test("reviewed presets can be selected without storing credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-provider-select-"));
  const config = join(directory, "provider.json");
  try {
    assert.deepEqual(selectableProviderPresets, ["cerebras", "groq", "fireworks", "generalcompute", "openrouter", "xai", "openai-codex", "anthropic"]);
    const selected = saveProviderPreset("cerebras", config);
    assert.equal(selected.preset, "cerebras");
    assert.equal(loadProviderProfile(config).modelID, "gemma-4-31b");
    const encoded = readFileSync(config, "utf8");
    assert.doesNotMatch(encoded, /(?:api.?key|authorization|bearer\s|(?:csk|sk)-)/iu);
    if (process.platform !== "win32") assert.equal(statSync(config).mode & 0o777, 0o600);

    saveProviderPreset("anthropic", config);
    assert.equal(loadProviderProfile(config).preset, "anthropic");

    rmSync(config);
    const target = join(directory, "target.json");
    writeFileSync(target, "{}", "utf8");
    symlinkSync(target, config);
    assert.throws(() => saveProviderPreset("groq", config), /unsafe/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("GeneralCompute is a LightningLoop-managed fixed API-key preset without Pi ownership", () => {
  const profile = profileForPreset("generalcompute");
  assert.equal(profile.preset, "generalcompute");
  assert.equal(profile.id, "generalcompute");
  assert.equal(profile.displayName, "GeneralCompute");
  assert.equal(profile.baseURL, "https://api.generalcompute.com/v1");
  assert.equal(profile.modelID, "minimax-m2.7");
  assert.equal(profile.modelName, "MiniMax M2.7");
  assert.equal(profile.supportsImages, false);
  assert.equal(profile.contextWindow, 192_000);
  assert.equal(profile.maxOutputTokens, 131_072);
  assert.equal(profile.piProviderID, undefined);
  assert.equal(providerCredentialService(profile), "com.barnlabs.LightningLoop.provider.generalcompute.apiKey");
  assert.ok(selectableProviderPresets.includes("generalcompute"));
  assert.throws(
    () => parseProviderProfile({ ...profile, baseURL: "https://example.com/v1" }),
    /verified API base URL/,
  );
  const roundTrip = parseProviderProfile(profile);
  assert.equal(roundTrip.piProviderID, undefined);
  assert.equal(roundTrip.baseURL, "https://api.generalcompute.com/v1");
});

test("OpenRouter is a LightningLoop-managed OpenAI-compatible preset with a free default model", () => {
  const profile = profileForPreset("openrouter");
  assert.equal(profile.preset, "openrouter");
  assert.equal(profile.id, "openrouter");
  assert.equal(profile.displayName, "OpenRouter");
  assert.equal(profile.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(profile.piProviderID, undefined);
  assert.match(profile.modelID, /:free$/u);
  assert.equal(providerCredentialService(profile), "com.barnlabs.LightningLoop.provider.openrouter.apiKey");
  assert.ok(selectableProviderPresets.includes("openrouter"));
  const roundTrip = parseProviderProfile(profile);
  assert.equal(roundTrip.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(roundTrip.piProviderID, undefined);
  assert.throws(() => parseProviderProfile({ ...profile, baseURL: "https://example.com/v1" }), /verified API base URL/);
});

test("free mode persists a freeOnly OpenRouter profile and rejects freeOnly on other presets", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-freeonly-"));
  const config = join(directory, "provider.json");
  try {
    const selected = saveProviderPreset("openrouter", config, { modelID: "openrouter/free", modelName: "Free Router", freeOnly: true });
    assert.equal(selected.freeOnly, true);
    const reloaded = loadProviderProfile(config);
    assert.equal(reloaded.freeOnly, true);
    assert.equal(reloaded.preset, "openrouter");
    // Round-trips through the parser.
    assert.equal(parseProviderProfile(selected).freeOnly, true);
    // freeOnly is OpenRouter-only.
    assert.throws(() => saveProviderPreset("generalcompute", config, { modelID: "minimax-m2.7", freeOnly: true }), /only supported for the OpenRouter/);
    assert.throws(() => parseProviderProfile({ ...profileForPreset("generalcompute"), freeOnly: true }), /only supported for the OpenRouter/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("provider select openrouter can persist a chosen model and rejects it for runtime-managed presets", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-openrouter-select-"));
  const config = join(directory, "provider.json");
  try {
    const selected = saveProviderPreset("openrouter", config, { modelID: "meta/llama-guard-4:free" });
    assert.equal(selected.preset, "openrouter");
    assert.equal(selected.modelID, "meta/llama-guard-4:free");
    assert.equal(loadProviderProfile(config).modelID, "meta/llama-guard-4:free");
    const encoded = readFileSync(config, "utf8");
    assert.doesNotMatch(encoded, /(?:api.?key|authorization|bearer\s|(?:csk|sk)-)/iu);
    // A model override is meaningless for a runtime-managed (Pi) preset.
    assert.throws(() => saveProviderPreset("cerebras", config, { modelID: "gemma-4-31b" }), /runtime-managed provider/);
    // Unsafe model IDs are rejected.
    assert.throws(() => saveProviderPreset("openrouter", config, { modelID: "bad\nid" }), /1-200 safe characters/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("official login providers map directly onto Pi's built-in provider IDs", () => {
  assert.equal(profileForPreset("xai").piProviderID, "xai");
  assert.equal(profileForPreset("openai-codex").piProviderID, "openai-codex");
  assert.equal(profileForPreset("anthropic").piProviderID, "anthropic");
  assert.equal(profileForPreset("generalcompute").piProviderID, undefined);
});

test("historical official-provider services remain filter-only and never become current auth", () => {
  const expected = [
    "com.barnlabs.LightningLoop.provider.xai.apiKey",
    "com.barnlabs.LightningLoop.provider.openai-codex.apiKey",
    "com.barnlabs.LightningLoop.provider.anthropic.apiKey",
  ];
  assert.deepEqual([...historicalReadOnlyProviderCredentialServices], expected);
  const services = lightningLoopCredentialServices(defaultProviderProfile(), join(tmpdir(), `missing-${process.pid}-${Date.now()}.json`));
  assert.ok(expected.every((service) => services.includes(service)));
  for (const preset of ["xai", "openai-codex", "anthropic"] as const) {
    const profile = profileForPreset(preset);
    assert.equal(profile.piProviderID, preset);
    assert.equal(providerCredentialService(profile), `com.barnlabs.LightningLoop.provider.${preset}.apiKey`);
  }
});

test("custom providers accept bounded HTTPS profiles and reject credential-bearing URLs", () => {
  const valid = parseProviderProfile({
    schemaVersion: 1,
    id: "fast-lab",
    preset: "custom",
    displayName: "Fast Lab",
    baseURL: "https://inference.example.com/openai/v1/",
    modelID: "lab/model-1",
    modelName: "Lab Model 1",
    supportsImages: true,
    contextWindow: 65_536,
    maxOutputTokens: 8_192,
  });
  assert.equal(valid.baseURL, "https://inference.example.com/openai/v1");
  assert.equal(providerCredentialService(valid), "com.barnlabs.LightningLoop.provider.custom.fast-lab.inference.example.com.apiKey");
  assert.throws(() => parseProviderProfile({ ...valid, baseURL: "https://token@example.com/v1" }), /credential-free/);
  assert.throws(() => parseProviderProfile({ ...valid, baseURL: "http://example.com/v1" }), /credential-free HTTPS/);
  assert.throws(() => parseProviderProfile({ ...valid, baseURL: "https://localhost/v1" }), /public DNS hostname/);
  assert.throws(() => parseProviderProfile({ ...valid, baseURL: "https://127.0.0.1/v1" }), /public DNS hostname/);
  assert.throws(() => parseProviderProfile({ ...valid, baseURL: "https://inference.local/v1" }), /public DNS hostname/);
  assert.throws(() => parseProviderProfile({ ...valid, id: "../escape" }), /lowercase letters/);
});

test("preset endpoints cannot be silently redirected to another host", () => {
  const profile = defaultProviderProfile();
  assert.throws(() => parseProviderProfile({ ...profile, baseURL: "https://example.com/v1" }), /verified API base URL/);
});

test("historical custom credential registry is bounded and fails closed when unsafe", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-credential-registry-"));
  const registry = join(directory, "custom-credential-services.json");
  const historical = "com.barnlabs.LightningLoop.provider.custom.old-lab.old.example.com.apiKey";
  try {
    assert.deepEqual(loadHistoricalCustomCredentialServices(registry), []);
    writeFileSync(registry, JSON.stringify([historical]));
    assert.deepEqual(loadHistoricalCustomCredentialServices(registry), [historical]);
    assert.ok(lightningLoopCredentialServices(defaultProviderProfile(), registry).includes(historical));

    writeFileSync(registry, "not-json");
    assert.throws(() => loadHistoricalCustomCredentialServices(registry), /failed closed/);
    writeFileSync(registry, JSON.stringify(["com.barnlabs.LightningLoop.pi-managed.openai-codex"]));
    assert.throws(() => loadHistoricalCustomCredentialServices(registry), /failed closed/);
    writeFileSync(registry, JSON.stringify([historical, historical]));
    assert.throws(() => loadHistoricalCustomCredentialServices(registry), /failed closed/);
    writeFileSync(registry, "x".repeat(32_769));
    assert.throws(() => loadHistoricalCustomCredentialServices(registry), /failed closed/);

    rmSync(registry);
    const target = join(directory, "target.json");
    writeFileSync(target, JSON.stringify([historical]));
    symlinkSync(target, registry);
    assert.throws(() => loadHistoricalCustomCredentialServices(registry), /failed closed/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
