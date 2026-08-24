import assert from "node:assert/strict";
import test from "node:test";
import {
  assertModelFreeInCatalog,
  enforceFreeMode,
  fetchOpenRouterKeyCredits,
  fetchOpenRouterModels,
  isFreeModel,
  OPENROUTER_FREE_ROUTER_ID,
  OPENROUTER_KEY_URL,
  OPENROUTER_MODELS_URL,
  parseOpenRouterKeyCredits,
  parseOpenRouterModels,
  pickFreeModeModel,
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

test("pickFreeModeModel prefers the free router, then the first free model, else throws", () => {
  const router = { id: OPENROUTER_FREE_ROUTER_ID, name: "Free Router", contextWindow: 200000, promptPrice: 0, completionPrice: 0, free: true };
  assert.equal(pickFreeModeModel([paidModel, router, freeModel]).id, OPENROUTER_FREE_ROUTER_ID);
  assert.equal(pickFreeModeModel([paidModel, freeModel]).id, freeModel.id);
  assert.throws(() => pickFreeModeModel([paidModel]), /no free models/);
});

test("assertModelFreeInCatalog fails closed for unknown or newly-paid models", () => {
  assert.doesNotThrow(() => assertModelFreeInCatalog([freeModel], freeModel.id));
  assert.throws(() => assertModelFreeInCatalog([freeModel], "vendor/unknown"), /no longer in the OpenRouter catalog/);
  assert.throws(() => assertModelFreeInCatalog([paidModel], paidModel.id), /no longer free/);
});

test("enforceFreeMode throws on a non-free pinned model but tolerates a network failure", async () => {
  const freeResponse: typeof fetch = async () => new Response(JSON.stringify({ data: [{ id: "vendor/free:free", pricing: { prompt: "0", completion: "0" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  const paidResponse: typeof fetch = async () => new Response(JSON.stringify({ data: [{ id: "vendor/free:free", pricing: { prompt: "0.1", completion: "0.1" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  const networkError: typeof fetch = async () => { throw new Error("offline"); };

  // Non-free-mode profile is a no-op (no fetch needed).
  await assert.doesNotReject(() => enforceFreeMode({ preset: "openrouter", modelID: "x", freeOnly: false }, { fetchImpl: freeResponse }));
  // Free-mode profile with a still-free model passes.
  await assert.doesNotReject(() => enforceFreeMode({ preset: "openrouter", modelID: "vendor/free:free", freeOnly: true }, { fetchImpl: freeResponse }));
  // Free-mode profile whose model turned paid is refused.
  await assert.rejects(() => enforceFreeMode({ preset: "openrouter", modelID: "vendor/free:free", freeOnly: true }, { fetchImpl: paidResponse }), /no longer free/);
  // Network failure is tolerated (validated at selection).
  await assert.doesNotReject(() => enforceFreeMode({ preset: "openrouter", modelID: "vendor/free:free", freeOnly: true }, { fetchImpl: networkError }));
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

// A representative OpenRouter `GET /auth/key` payload (capped account).
const KEY_FIXTURE = {
  data: { label: "sk-or-...abcd", usage: 3.5, limit: 10, is_free_tier: false, limit_remaining: 6.5 },
};

test("parseOpenRouterKeyCredits reads a capped account with explicit remaining credit", () => {
  const credits = parseOpenRouterKeyCredits(KEY_FIXTURE);
  assert.deepEqual(credits, { usage: 3.5, limit: 10, remaining: 6.5, isFreeTier: false });
});

test("parseOpenRouterKeyCredits derives remaining from limit - usage when the API omits it", () => {
  const credits = parseOpenRouterKeyCredits({ data: { usage: 4, limit: 10 } });
  assert.deepEqual(credits, { usage: 4, limit: 10, remaining: 6, isFreeTier: false });
  // Overspend never yields a negative balance.
  const clamped = parseOpenRouterKeyCredits({ data: { usage: 12, limit: 10 } });
  assert.equal(clamped.remaining, 0);
});

test("parseOpenRouterKeyCredits treats a null limit as an uncapped (unlimited) key", () => {
  const credits = parseOpenRouterKeyCredits({ data: { usage: 2.25, limit: null, is_free_tier: true } });
  assert.deepEqual(credits, { usage: 2.25, limit: null, remaining: null, isFreeTier: true });
  // A missing usage defaults to zero rather than throwing.
  assert.equal(parseOpenRouterKeyCredits({ data: {} }).usage, 0);
});

test("parseOpenRouterKeyCredits fails closed on a malformed payload or invalid numbers", () => {
  assert.throws(() => parseOpenRouterKeyCredits(null), /not a JSON object/);
  assert.throws(() => parseOpenRouterKeyCredits({}), /missing its data object/);
  assert.throws(() => parseOpenRouterKeyCredits({ data: { limit: -1 } }), /invalid limit/);
  assert.throws(() => parseOpenRouterKeyCredits({ data: { limit: "10" } }), /invalid limit/);
  assert.throws(() => parseOpenRouterKeyCredits({ data: { usage: 1, limit_remaining: -5 } }), /invalid remaining/);
});

test("fetchOpenRouterKeyCredits sends the key in a bounded, no-redirect Authorization request (fixture, no live call)", async () => {
  let requestedURL: string | undefined;
  let requestInit: RequestInit | undefined;
  const okFetch: typeof fetch = async (input, init) => {
    requestedURL = String(input);
    requestInit = init;
    return new Response(JSON.stringify(KEY_FIXTURE), { status: 200, headers: { "content-type": "application/json" } });
  };
  const credits = await fetchOpenRouterKeyCredits("sk-or-secret", { fetchImpl: okFetch });
  assert.equal(requestedURL, OPENROUTER_KEY_URL);
  assert.equal((requestInit as { redirect?: string }).redirect, "error");
  const headers = (requestInit as { headers?: Record<string, string> }).headers ?? {};
  assert.equal(headers.Authorization, "Bearer sk-or-secret");
  assert.equal(credits.remaining, 6.5);
});

test("fetchOpenRouterKeyCredits fails closed without a key, on non-JSON, on non-OK, and rejects redirects", async () => {
  const unused: typeof fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(() => fetchOpenRouterKeyCredits("   ", { fetchImpl: unused }), /API key is required/);

  const nonJson: typeof fetch = async () => new Response("nope", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(() => fetchOpenRouterKeyCredits("k", { fetchImpl: nonJson }), /non-JSON/);

  const badStatus: typeof fetch = async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
  await assert.rejects(() => fetchOpenRouterKeyCredits("k", { fetchImpl: badStatus }), /HTTP 401/);

  // redirect: "error" makes fetch throw on a 3xx; the reader surfaces it as a failure.
  const redirecting: typeof fetch = async () => { throw new TypeError("redirect not allowed"); };
  await assert.rejects(() => fetchOpenRouterKeyCredits("k", { fetchImpl: redirecting }));
});
