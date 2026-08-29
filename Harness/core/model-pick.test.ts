import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyProviderPick,
  catalogPickHint,
  discoverActiveCatalog,
  formatCatalogList,
  MODEL_UNAVAILABLE,
  persistCataloguedPick,
  resolveCatalogPick,
  splitProviderPickTokens,
  type DiscoveredCatalog,
} from "./model-pick.js";
import { profileForPreset, saveProviderPreset } from "./provider-profile.js";

function catalog(overrides: Partial<DiscoveredCatalog> = {}): DiscoveredCatalog {
  return {
    source: "runtime",
    label: "installed runtime catalog",
    providerDisplayName: "Cerebras Inference",
    preset: "cerebras",
    models: [
      { id: "gemma-4-31b", name: "Gemma 4 31B", supportsImages: true, contextWindow: 131_072 },
      { id: "gpt-oss-120b", name: "OpenAI GPT OSS", supportsImages: false, contextWindow: 131_072 },
    ],
    ...overrides,
  };
}

test("splitProviderPickTokens treats a preset as select, then an optional pick", () => {
  assert.deepEqual(splitProviderPickTokens([]), {});
  assert.deepEqual(splitProviderPickTokens(["cerebras"]), { preset: "cerebras" });
  assert.deepEqual(splitProviderPickTokens(["cerebras", "2"]), { preset: "cerebras", pick: "2" });
  assert.deepEqual(splitProviderPickTokens(["gemma-4-31b"]), { pick: "gemma-4-31b" });
  assert.deepEqual(splitProviderPickTokens(["3"]), { pick: "3" });
});

test("formatCatalogList numbers every catalogued ID", () => {
  const listed = formatCatalogList(catalog());
  assert.match(listed, /Cerebras Inference models · installed runtime catalog · 2/u);
  assert.match(listed, /  1\. gemma-4-31b · Gemma 4 31B · ctx 131072 · image\+text/u);
  assert.match(listed, /  2\. gpt-oss-120b · OpenAI GPT OSS · ctx 131072/u);
  assert.match(catalogPickHint(catalog()), /llp provider pick <n\|id>/u);
});

test("resolveCatalogPick accepts a listed index or exact ID and fails closed otherwise", () => {
  const listed = catalog();
  assert.equal(resolveCatalogPick(listed, "1").id, "gemma-4-31b");
  assert.equal(resolveCatalogPick(listed, "2").id, "gpt-oss-120b");
  assert.equal(resolveCatalogPick(listed, "gpt-oss-120b").id, "gpt-oss-120b");
  assert.throws(() => resolveCatalogPick(listed, "3"), /model_unavailable: No catalog entry 3/u);
  assert.throws(() => resolveCatalogPick(listed, "totally-made-up-model-xyz"), /model_unavailable: Model 'totally-made-up-model-xyz' is not in the current Cerebras Inference catalog/u);
  assert.throws(() => resolveCatalogPick(listed, "bad\nid"), /model_unavailable: Pick requires a catalog index/u);
  assert.equal(MODEL_UNAVAILABLE, "model_unavailable");
});

test("persistCataloguedPick writes a credential-free catalogued ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lightningloop-model-pick-"));
  const previous = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = join(directory, "provider.json");
  try {
    const saved = persistCataloguedPick(profileForPreset("cerebras"), {
      id: "gpt-oss-120b",
      name: "OpenAI GPT OSS",
      supportsImages: false,
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
    });
    assert.equal(saved.modelID, "gpt-oss-120b");
    assert.equal(saved.modelName, "OpenAI GPT OSS");
    const encoded = await readFile(join(directory, "provider.json"), "utf8");
    assert.doesNotMatch(encoded, /(?:api.?key|authorization|bearer\s|(?:csk|sk)-)/iu);
    const parsed = JSON.parse(encoded) as { modelID: string; preset: string };
    assert.equal(parsed.preset, "cerebras");
    assert.equal(parsed.modelID, "gpt-oss-120b");
  } finally {
    if (previous === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime catalog pull lists installed IDs and host pull fails closed without a key", async () => {
  const catalog = await discoverActiveCatalog(profileForPreset("cerebras"));
  assert.equal(catalog.source, "runtime");
  assert.ok(catalog.models.length > 0);
  assert.ok(catalog.models.every((model) => model.id));
  await assert.rejects(
    discoverActiveCatalog(profileForPreset("generalcompute")),
    /key set generalcompute/u,
  );
});

test("applyProviderPick writes a listed runtime ID after select", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lightningloop-model-pick-apply-"));
  const previous = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = join(directory, "provider.json");
  try {
    saveProviderPreset("cerebras");
    const catalog = await discoverActiveCatalog(profileForPreset("cerebras"));
    const first = catalog.models[0];
    assert.ok(first);
    const result = await applyProviderPick(profileForPreset("cerebras"), first.id);
    assert.equal(result.saved.modelID, first.id);
    const encoded = await readFile(join(directory, "provider.json"), "utf8");
    assert.doesNotMatch(encoded, /(?:api.?key|authorization|bearer\s|(?:csk|sk)-)/iu);
  } finally {
    if (previous === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
