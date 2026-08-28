import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertSafeSecret,
  assertSafeService,
  clearProviderCredential,
  clearSecret,
  linuxSecretToolBackend,
  macOSKeychainBackend,
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

test("OS secret backends never look up a password and get returns nothing", () => {
  assert.equal(macOSKeychainBackend.get("com.barnlabs.LightningLoop.search.firecrawl"), undefined);
  assert.equal(linuxSecretToolBackend.get("com.barnlabs.LightningLoop.search.exa"), undefined);
  assert.equal(readSecret("com.barnlabs.LightningLoop.search.brave"), undefined);
});

test("harness sources never invoke security find-generic-password", () => {
  const files = [
    "./key-store.js",
    "./credential-safety.js",
    "./key-catalog.js",
    "../cli/index.js",
    "../search/search-client.js",
    "../pi/lightningloop-extension.js",
    "../pi/model-adapter.js",
  ];
  for (const relative of files) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /["']find-generic-password["']/u, relative);
  }
});
