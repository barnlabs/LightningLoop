import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCredentialSafeInput, assertNoConfiguredCredential, registerRuntimeCredential } from "./credential-safety.js";
import { defaultProviderProfile, lightningLoopCredentialServices, parseProviderProfile } from "./provider-profile.js";

test("credential safety detects credentials stored under the current LightningLoop service", () => {
  const service = "com.barnlabs.LightningLoop.search.brave";
  const credential = "current-service-credential-12345";
  const requested: string[] = [];
  const reader = (candidate: string): string | undefined => {
    requested.push(candidate);
    return candidate === service ? credential : undefined;
  };

  assert.throws(
    () => assertNoConfiguredCredential([`Remember ${credential}`], defaultProviderProfile(), reader),
    /Configured credential content/,
  );
  assert.ok(requested.includes(service));
});

test("credential safety rejects inactive built-in provider credentials in memory and evolution input", () => {
  const profile = defaultProviderProfile();
  assert.equal(profile.preset, "openai-codex");
  const cerebrasCredential = "synthetic-inactive-cerebras-credential-12345";
  const fireworksCredential = "synthetic-inactive-fireworks-credential-67890";
  const requested: string[] = [];
  const reader = (service: string): string | undefined => {
    requested.push(service);
    if (service === "com.barnlabs.LightningLoop.provider.cerebras.apiKey") return cerebrasCredential;
    if (service === "com.barnlabs.LightningLoop.provider.fireworks.apiKey") return fireworksCredential;
    return undefined;
  };

  assert.throws(
    () => assertNoConfiguredCredential([`Evolution memory: ${cerebrasCredential}`], profile, reader),
    /Configured credential content/,
  );
  assert.throws(
    () => assertNoConfiguredCredential([`Evolution input: ${fireworksCredential}`], profile, reader),
    /Configured credential content/,
  );
  assert.ok(requested.includes("com.barnlabs.LightningLoop.provider.cerebras.apiKey"));
  assert.ok(requested.includes("com.barnlabs.LightningLoop.provider.fireworks.apiKey"));
});

test("credential-service catalog keeps the legacy custom service and active custom service without Pi services", () => {
  const custom = parseProviderProfile({
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
  const services = lightningLoopCredentialServices(custom);
  assert.ok(services.includes("com.barnlabs.LightningLoop.provider.custom.apiKey"));
  assert.ok(services.includes("com.barnlabs.LightningLoop.provider.custom.example-lab.inference.example.com.apiKey"));
  assert.ok(services.includes("com.barnlabs.LightningLoop.provider.cerebras.apiKey"));
  assert.ok(services.includes("com.barnlabs.LightningLoop.provider.groq.apiKey"));
  assert.ok(services.includes("com.barnlabs.LightningLoop.provider.fireworks.apiKey"));
  assert.ok(services.every((service) => !service.includes(".pi-managed.")));
});

test("runtime-captured credentials are prohibited without relying on a recognizable prefix", () => {
  const credential = "plain-runtime-value-with-no-provider-prefix-24680";
  registerRuntimeCredential(credential);
  assert.throws(
    () => assertNoConfiguredCredential([`Memory contains ${credential}`], defaultProviderProfile(), () => undefined),
    /Configured credential content/,
  );
});

test("credential safety reads historical custom services after switching from provider A to B", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-historical-credential-"));
  const registry = join(directory, "custom-credential-services.json");
  const historicalService = "com.barnlabs.LightningLoop.provider.custom.provider-a.a.example.com.apiKey";
  const historicalCredential = "historical-custom-credential-without-prefix-13579";
  const current = parseProviderProfile({
    schemaVersion: 1,
    id: "provider-b",
    preset: "custom",
    displayName: "Provider B",
    baseURL: "https://b.example.com/v1",
    modelID: "b/model",
    modelName: "B Model",
    supportsImages: false,
    contextWindow: 16_384,
    maxOutputTokens: 4_096,
  });
  try {
    writeFileSync(registry, JSON.stringify([historicalService]));
    assert.throws(
      () => assertNoConfiguredCredential(
        [`Evolution record ${historicalCredential}`],
        current,
        (service) => service === historicalService ? historicalCredential : undefined,
        registry,
      ),
      /Configured credential content/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("fresh input boundary rejects selected, unselected, runtime, and historical arbitrary credential values", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-input-credential-"));
  const registry = join(directory, "custom-credential-services.json");
  const historicalService = "com.barnlabs.LightningLoop.provider.custom.provider-old.old.example.com.apiKey";
  const credentials = {
    selected: "selected-arbitrary-value-13579",
    unselected: "unselected-arbitrary-value-24680",
    historical: "historical-arbitrary-value-97531",
    runtime: "runtime-arbitrary-value-86420",
  };
  registerRuntimeCredential(credentials.runtime);
  try {
    writeFileSync(registry, JSON.stringify([historicalService]));
    const reader = (service: string): string | undefined => {
      if (service === "com.barnlabs.LightningLoop.provider.openai-codex.apiKey") return credentials.selected;
      if (service === "com.barnlabs.LightningLoop.provider.cerebras.apiKey") return credentials.unselected;
      if (service === historicalService) return credentials.historical;
      return undefined;
    };
    for (const credential of Object.values(credentials)) {
      const encoded = encodeURIComponent(credential.replaceAll("-", "%2D"));
      assert.throws(
        () => assertCredentialSafeInput({ goal: `Use ${encoded}` }, defaultProviderProfile(), reader, registry),
        /Credential-bearing input is prohibited/,
      );
    }
    const safe = { goal: "Explain credential isolation without including any credential value." };
    assert.equal(assertCredentialSafeInput(safe, defaultProviderProfile(), reader, registry), safe);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("fresh input boundary rejects secret shapes and fails closed on an invalid historical registry", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-input-registry-"));
  const registry = join(directory, "custom-credential-services.json");
  try {
    assert.throws(
      () => assertCredentialSafeInput({ goal: "Use csk%2Dsynthetic123456789" }, defaultProviderProfile(), () => undefined, join(directory, "missing.json")),
      /Secret-like value prohibited/,
    );
    assert.throws(
      () => assertCredentialSafeInput({ goal: "Malformed %ZZ" }, defaultProviderProfile(), () => undefined, join(directory, "missing.json")),
      /malformed percent encoding/i,
    );
    const tooDeep = Array.from({ length: 16 }).reduce<string>((encoded) => encodeURIComponent(encoded), "csk%2Dsynthetic123456789");
    assert.throws(
      () => assertCredentialSafeInput({ goal: tooDeep }, defaultProviderProfile(), () => undefined, join(directory, "missing.json")),
      /over-depth/i,
    );
    writeFileSync(registry, "not-json");
    assert.throws(
      () => assertCredentialSafeInput({ goal: "Safe semantic input" }, defaultProviderProfile(), () => undefined, registry),
      /registry.*failed closed/i,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
