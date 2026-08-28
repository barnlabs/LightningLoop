import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeSecret,
  assertSafeService,
  clearProviderCredential,
  clearSecret,
  readSecret,
  readStoredProviderCredential,
  secretPresent,
  storeProviderCredential,
  storeSecret,
  unavailableBackend,
  type SecretBackend,
} from "./key-store.js";
import { profileForPreset } from "./provider-profile.js";

function memoryBackend(available = true): SecretBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    name: "in-memory (test)",
    store,
    isAvailable: () => available,
    set(service, secret) { store.set(service, secret); },
    get(service) { return store.get(service); },
    clear(service) { store.delete(service); },
  };
}

test("store/read/clear round-trip through the secret backend for the right service", () => {
  const backend = memoryBackend();
  const profile = profileForPreset("openrouter");
  assert.equal(readStoredProviderCredential(profile, backend), undefined);
  storeProviderCredential(profile, "sk-or-test-abc123", backend);
  assert.equal(backend.store.get("com.barnlabs.LightningLoop.provider.openrouter.apiKey"), "sk-or-test-abc123");
  assert.equal(readStoredProviderCredential(profile, backend), "sk-or-test-abc123");
  clearProviderCredential(profile, backend);
  assert.equal(readStoredProviderCredential(profile, backend), undefined);
});

test("an unavailable backend fails set closed and never returns a value", () => {
  const profile = profileForPreset("openrouter");
  assert.throws(() => storeProviderCredential(profile, "sk-or-test", memoryBackend(false)), /unavailable|not available|environment variable/i);
  assert.throws(() => unavailableBackend.set("svc", "secret"), /environment variable/);
  assert.equal(unavailableBackend.get("svc"), undefined);
  assert.equal(readStoredProviderCredential(profile, unavailableBackend), undefined);
});

test("generic store/read/clear works for research services without a provider profile", () => {
  const backend = memoryBackend();
  const service = "com.barnlabs.LightningLoop.search.firecrawl";
  assert.equal(secretPresent(service, backend), false);
  storeSecret(service, "fc-test-secret-1234", backend);
  assert.equal(readSecret(service, backend), "fc-test-secret-1234");
  assert.equal(secretPresent(service, backend), true);
  clearSecret(service, backend);
  assert.equal(readSecret(service, backend), undefined);
});

test("secret and service inputs are validated", () => {
  assert.throws(() => assertSafeSecret(""), /empty/);
  assert.throws(() => assertSafeSecret("has\nnewline"), /control characters/);
  assert.throws(() => assertSafeSecret("x".repeat(8_193)), /too long/);
  assert.doesNotThrow(() => assertSafeSecret("sk-or-v1-abcDEF123"));
  assert.throws(() => assertSafeService("bad service!"), /Invalid credential service/);
  assert.doesNotThrow(() => assertSafeService("com.barnlabs.LightningLoop.provider.openrouter.apiKey"));
});
