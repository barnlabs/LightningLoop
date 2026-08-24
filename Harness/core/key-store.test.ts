import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeSecret,
  assertSafeService,
  clearProviderCredential,
  readStoredProviderCredential,
  storeProviderCredential,
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

test("secret and service inputs are validated", () => {
  assert.throws(() => assertSafeSecret(""), /empty/);
  assert.throws(() => assertSafeSecret("has\nnewline"), /control characters/);
  assert.throws(() => assertSafeSecret("x".repeat(8_193)), /too long/);
  assert.doesNotThrow(() => assertSafeSecret("sk-or-v1-abcDEF123"));
  assert.throws(() => assertSafeService("bad service!"), /Invalid credential service/);
  assert.doesNotThrow(() => assertSafeService("com.barnlabs.LightningLoop.provider.openrouter.apiKey"));
});
