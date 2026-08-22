import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchOpenRouterModels,
  isFreeModel,
  OPENROUTER_MODELS_URL,
  parseOpenRouterModels,
  resolveSelectableModel,
  selectFreeModels,
} from "./openrouter.js";

const freeModel = { id: "vendor/free:free", name: "Free", contextWindow: 65536, promptPrice: 0, completionPrice: 0, free: true };
const paidModel = { id: "vendor/paid", name: "Paid", contextWindow: 128000, promptPrice: 0.0000004, completionPrice: 0.0000012, free: false };

test("isFreeModel is true only when both prices are exactly zero", () => {
  assert.equal(isFreeModel({ promptPrice: 0, completionPrice: 0 }), true);
  assert.equal(isFreeModel({ promptPrice: 0, completionPrice: 0.0000001 }), false);
  assert.equal(isFreeModel({ promptPrice: 0.0000001, completionPrice: 0 }), false);
  // Unparseable pricing surfaces as NaN and must never be treated as free.
  assert.equal(isFreeModel({ promptPrice: Number.NaN, completionPrice: 0 }), false);
});

test("parseOpenRouterModels normalizes entries and flags free models", () => {
  const models = parseOpenRouterModels({
    data: [
      { id: "vendor/free-model:free", name: "Free Model", context_length: 65536, pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/paid-model", name: "Paid Model", context_length: 128000, pricing: { prompt: "0.0000004", completion: "0.0000012" } },
      { id: "vendor/zero-strings", pricing: { prompt: "0.0", completion: "0" } },
    ],
  });
  assert.equal(models.length, 3);
  const free = models.find((m) => m.id === "vendor/free-model:free");
  assert.equal(free?.free, true);
  assert.equal(free?.contextWindow, 65536);
  const paid = models.find((m) => m.id === "vendor/paid-model");
  assert.equal(paid?.free, false);
  assert.equal(paid?.promptPrice, 0.0000004);
  // Missing name falls back to the id; "0.0" parses to zero → free.
  const zeroStrings = models.find((m) => m.id === "vendor/zero-strings");
  assert.equal(zeroStrings?.name, "vendor/zero-strings");
  assert.equal(zeroStrings?.free, true);
});

test("parseOpenRouterModels skips malformed entries and rejects a non-list payload", () => {
  const models = parseOpenRouterModels({
    data: [
      { id: "ok/model", pricing: { prompt: "0", completion: "0" } },
      { id: 42 },
      null,
      { name: "no id" },
      { id: "bad\nid", pricing: { prompt: "0", completion: "0" } },
    ],
  });
  assert.deepEqual(models.map((m) => m.id), ["ok/model"]);
  assert.throws(() => parseOpenRouterModels({}), /missing its data array/);
  assert.throws(() => parseOpenRouterModels([]), /missing its data array/);
  assert.throws(() => parseOpenRouterModels(null), /not a JSON object/);
  assert.throws(() => parseOpenRouterModels("not-an-object"), /not a JSON object/);
});

test("selectFreeModels keeps only free models, sorted by id", () => {
  const free = selectFreeModels([
    { id: "z/free:free", name: "z", contextWindow: 0, promptPrice: 0, completionPrice: 0, free: true },
    { id: "a/paid", name: "a", contextWindow: 0, promptPrice: 1, completionPrice: 1, free: false },
    { id: "a/free:free", name: "a", contextWindow: 0, promptPrice: 0, completionPrice: 0, free: true },
  ]);
  assert.deepEqual(free.map((m) => m.id), ["a/free:free", "z/free:free"]);
});

test("resolveSelectableModel validates against the catalog and enforces free-only", () => {
  const catalog = [freeModel, paidModel];
  // Happy path: a known free model is returned.
  assert.equal(resolveSelectableModel(catalog, "vendor/free:free", true).id, "vendor/free:free");
  // A paid model is allowed when free-only is off.
  assert.equal(resolveSelectableModel(catalog, "vendor/paid", false).id, "vendor/paid");
  // Fail closed: unknown id is rejected.
  assert.throws(() => resolveSelectableModel(catalog, "vendor/does-not-exist", false), /not in the current OpenRouter catalog/);
  // Fail closed: a non-free model under --free is rejected.
  assert.throws(() => resolveSelectableModel(catalog, "vendor/paid", true), /is not a free model/);
});

test("parseOpenRouterModels rejects a catalog that exceeds the entry bound", () => {
  const data = Array.from({ length: 10_001 }, (_unused, index) => ({ id: `vendor/model-${index}`, pricing: { prompt: "0", completion: "0" } }));
  assert.throws(() => parseOpenRouterModels({ data }), /exceeds the supported bound/);
});

test("fetchOpenRouterModels rejects an oversized declared body before parsing", async () => {
  const oversized: typeof fetch = async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(5 * 1024 * 1024) },
  });
  await assert.rejects(() => fetchOpenRouterModels({ fetchImpl: oversized }), /exceeded the size bound/);
});

test("fetchOpenRouterModels uses a bounded, no-redirect JSON request and rejects non-OK responses", async () => {
  let requestedURL: string | undefined;
  let requestInit: RequestInit | undefined;
  const okFetch: typeof fetch = async (input, init) => {
    requestedURL = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ data: [{ id: "vendor/free:free", pricing: { prompt: "0", completion: "0" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const models = await fetchOpenRouterModels({ fetchImpl: okFetch });
  assert.equal(requestedURL, OPENROUTER_MODELS_URL);
  assert.equal((requestInit as { redirect?: string }).redirect, "error");
  assert.equal(models[0]?.free, true);

  const badStatus: typeof fetch = async () => new Response("nope", { status: 500, headers: { "content-type": "application/json" } });
  await assert.rejects(() => fetchOpenRouterModels({ fetchImpl: badStatus }), /HTTP 500/);

  const nonJson: typeof fetch = async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(() => fetchOpenRouterModels({ fetchImpl: nonJson }), /non-JSON/);
});
