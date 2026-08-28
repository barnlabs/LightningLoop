import assert from "node:assert/strict";
import test from "node:test";
import {
  isManagedKeyName,
  managedKeyNames,
  managedKeyService,
  managedKeySlot,
  missingKeyNextAction,
  parseManagedKeyName,
} from "./key-catalog.js";
import { profileForPreset, providerSelectionRequiredProfile } from "./provider-profile.js";

test("managed key names cover inference and research slots and reject unknown names", () => {
  assert.deepEqual([...managedKeyNames], [
    "openrouter", "generalcompute", "custom", "cerebras", "firecrawl", "exa", "brave",
  ]);
  assert.equal(isManagedKeyName("firecrawl"), true);
  assert.equal(isManagedKeyName("xai"), false);
  assert.equal(parseManagedKeyName("exa"), "exa");
  assert.throws(() => parseManagedKeyName("anthropic"), /openrouter, generalcompute, custom, cerebras, firecrawl, exa, brave/);
  assert.equal(managedKeySlot("firecrawl").kind, "research");
  assert.equal(managedKeySlot("openrouter").service, "com.barnlabs.LightningLoop.provider.openrouter.apiKey");
});

test("custom key service requires a saved custom profile and never invents a host", () => {
  assert.throws(() => managedKeyService("custom", providerSelectionRequiredProfile()), /Save the HTTPS host/);
  assert.throws(() => managedKeyService("custom", profileForPreset("openrouter")), /Save the HTTPS host/);
  assert.match(missingKeyNextAction("firecrawl"), /key set firecrawl/u);
  assert.doesNotMatch(missingKeyNextAction("firecrawl"), /sk-|api_key=/iu);
});
