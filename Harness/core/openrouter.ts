/**
 * OpenRouter model discovery.
 *
 * OpenRouter is an OpenAI-compatible aggregator. Its model list endpoint is
 * public (no credential required), which lets LightningLoop discover which
 * models are available — and, crucially, which are **free** — before a run.
 *
 * Everything here is bounded and fail-closed: HTTPS only, no redirects, a hard
 * response-size cap, and a wall-clock deadline. The pure parsing/filtering
 * functions carry the tested logic; the network fetch is a thin bounded wrapper
 * so the free-model policy can be unit-tested without egress.
 */

import type { ProviderProfile } from "./provider-profile.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** OpenRouter's built-in router that auto-selects among currently free models. */
export const OPENROUTER_FREE_ROUTER_ID = "openrouter/free";

/** Maximum bytes we will read from the models endpoint (the live list is well under this). */
const MAX_MODELS_RESPONSE_BYTES = 4_194_304; // 4 MiB
const MODELS_REQUEST_TIMEOUT_MS = 15_000;
const MAX_MODELS = 10_000;

export interface OpenRouterModel {
  id: string;
  name: string;
  contextWindow: number;
  /** USD per prompt token, parsed from the string OpenRouter returns. */
  promptPrice: number;
  /** USD per completion token. */
  completionPrice: number;
  /** True only when both prompt and completion pricing are exactly zero. */
  free: boolean;
}

function priceToNumber(value: unknown): number {
  // OpenRouter returns prices as decimal strings (e.g. "0", "0.0000004").
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return Number.NaN;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/**
 * A model is free only when both its prompt and completion prices parse to
 * exactly zero. Missing or unparseable pricing is treated as NOT free
 * (fail-closed): we never claim a paid model is free.
 */
export function isFreeModel(model: { promptPrice: number; completionPrice: number }): boolean {
  return model.promptPrice === 0 && model.completionPrice === 0;
}

/**
 * Parse and normalize the OpenRouter `/models` payload. Rejects a payload that
 * is not the expected `{ data: [...] }` shape or that exceeds the bound.
 * Individual malformed entries are skipped rather than failing the whole list.
 */
export function parseOpenRouterModels(value: unknown): OpenRouterModel[] {
  if (typeof value !== "object" || value === null) {
    throw new Error("OpenRouter model list is not a JSON object.");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("OpenRouter model list is missing its data array.");
  }
  if (data.length > MAX_MODELS) {
    throw new Error("OpenRouter model list exceeds the supported bound.");
  }
  const models: OpenRouterModel[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      id?: unknown;
      name?: unknown;
      context_length?: unknown;
      pricing?: unknown;
    };
    if (typeof record.id !== "string" || record.id.trim() === "") continue;
    if (record.id.length > 200 || /[\r\n\0]/u.test(record.id)) continue;
    const pricing = (typeof record.pricing === "object" && record.pricing !== null)
      ? record.pricing as { prompt?: unknown; completion?: unknown }
      : {};
    const promptPrice = priceToNumber(pricing.prompt);
    const completionPrice = priceToNumber(pricing.completion);
    const contextWindowRaw = typeof record.context_length === "number" && Number.isInteger(record.context_length)
      ? record.context_length
      : 0;
    const name = typeof record.name === "string" && record.name.trim() !== ""
      ? record.name.trim().slice(0, 120)
      : record.id;
    const model: OpenRouterModel = {
      id: record.id,
      name,
      contextWindow: contextWindowRaw,
      promptPrice,
      completionPrice,
      free: false,
    };
    model.free = isFreeModel(model);
    models.push(model);
  }
  return models;
}

/** Keep only free models, sorted by id for stable, deterministic output. */
export function selectFreeModels(models: readonly OpenRouterModel[]): OpenRouterModel[] {
  return models.filter((model) => model.free).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve a chosen model id against a discovered catalog. Throws when the id is
 * not in the catalog, or (when freeOnly) when the model is not free. This is the
 * fail-closed validation behind `provider select openrouter --model <id> [--free]`.
 */
export function resolveSelectableModel(
  models: readonly OpenRouterModel[],
  id: string,
  freeOnly: boolean,
): OpenRouterModel {
  const match = models.find((model) => model.id === id);
  if (!match) {
    throw new Error(`Model '${id}' is not in the current OpenRouter catalog. Run 'lightningloop provider models --free' to list available IDs.`);
  }
  if (freeOnly && !match.free) {
    throw new Error(`Model '${match.id}' is not a free model. Remove --free or choose one from 'lightningloop provider models --free'.`);
  }
  return match;
}

/**
 * Choose the model that backs "just free mode". Prefers OpenRouter's free router
 * (`openrouter/free`) when it is present and free, otherwise the first free model
 * (alphabetical for determinism). Throws when the catalog exposes no free model.
 */
export function pickFreeModeModel(models: readonly OpenRouterModel[]): OpenRouterModel {
  const router = models.find((model) => model.id === OPENROUTER_FREE_ROUTER_ID && model.free);
  if (router) return router;
  const free = selectFreeModels(models);
  if (free.length === 0) {
    throw new Error("OpenRouter currently exposes no free models. Try again later or choose a specific model.");
  }
  return free[0]!;
}

/**
 * Assert a model id is present in the catalog AND free. Used to re-verify a
 * free-only profile at run time so a model that lost its free tier is refused.
 */
export function assertModelFreeInCatalog(models: readonly OpenRouterModel[], id: string): void {
  const match = models.find((model) => model.id === id);
  if (!match) {
    throw new Error(`Free mode: model '${id}' is no longer in the OpenRouter catalog. Re-select a free model with 'lightningloop free'.`);
  }
  if (!match.free) {
    throw new Error(`Free mode: model '${id}' is no longer free. Re-select a free model with 'lightningloop free'.`);
  }
}

/**
 * Enforce "just free mode" at run time for a free-only OpenRouter profile: refuse
 * to run if the pinned model is no longer free. A network failure is tolerated
 * (the model was validated free when it was selected), so free mode never becomes
 * an offline outage — but a definitive "not free" verdict throws.
 */
export async function enforceFreeMode(
  profile: Pick<ProviderProfile, "preset" | "freeOnly" | "modelID">,
  options: FetchOpenRouterModelsOptions = {},
): Promise<void> {
  if (!profile.freeOnly || profile.preset !== "openrouter") return;
  let catalog: OpenRouterModel[];
  try {
    catalog = await fetchOpenRouterModels(options);
  } catch {
    return;
  }
  assertModelFreeInCatalog(catalog, profile.modelID);
}

/** Read a response body with a hard byte cap enforced while streaming, not after. */
async function readBoundedText(response: Response, maxBytes: number, label = "OpenRouter model discovery"): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} response exceeded the size bound.`);
  }
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`${label} response exceeded the size bound.`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeded the size bound.`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface FetchOpenRouterModelsOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Fetch and normalize the public OpenRouter model catalog. No credential is
 * sent. The request is HTTPS-only with redirects disabled, an absolute
 * deadline, and a response-size cap.
 */
export async function fetchOpenRouterModels(options: FetchOpenRouterModelsOptions = {}): Promise<OpenRouterModel[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to discover OpenRouter models.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("OpenRouter model discovery timed out.", "TimeoutError")), MODELS_REQUEST_TIMEOUT_MS);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
  }
  try {
    const response = await fetchImpl(OPENROUTER_MODELS_URL, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenRouter model discovery failed with HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/application\/json/iu.test(contentType)) {
      throw new Error("OpenRouter model discovery returned a non-JSON response.");
    }
    const raw = await readBoundedText(response, MAX_MODELS_RESPONSE_BYTES);
    return parseOpenRouterModels(JSON.parse(raw) as unknown);
  } finally {
    clearTimeout(timeout);
  }
}

/** OpenRouter's authenticated key-info endpoint (usage + limit for the calling key). */
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/auth/key";
/** The auth/key payload is tiny; cap it well below the models catalog cap. */
const MAX_KEY_RESPONSE_BYTES = 65_536; // 64 KiB

export interface OpenRouterKeyCredits {
  /** Lifetime USD spent on this key. */
  usage: number;
  /** USD spending cap for this key, or null when uncapped. */
  limit: number | null;
  /** USD credit remaining, or null when the key is uncapped. */
  remaining: number | null;
  /** True when the key is a free-tier key. */
  isFreeTier: boolean;
}

/** Accept only finite, non-negative numbers; anything else is undefined. */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Parse the OpenRouter `GET /auth/key` payload into a normalized credit view.
 * Fail-closed: a malformed shape throws rather than guessing a balance. When the
 * account is uncapped (`limit` null) remaining is null (unlimited); when a cap
 * exists but the API omits `limit_remaining` we derive it as `limit - usage`.
 */
export function parseOpenRouterKeyCredits(value: unknown): OpenRouterKeyCredits {
  if (typeof value !== "object" || value === null) {
    throw new Error("OpenRouter key info is not a JSON object.");
  }
  const data = (value as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) {
    throw new Error("OpenRouter key info is missing its data object.");
  }
  const record = data as Record<string, unknown>;
  const usage = finiteNonNegative(record.usage) ?? 0;
  let limit: number | null;
  if (record.limit === null || record.limit === undefined) {
    limit = null;
  } else {
    const parsedLimit = finiteNonNegative(record.limit);
    if (parsedLimit === undefined) throw new Error("OpenRouter key info has an invalid limit.");
    limit = parsedLimit;
  }
  const remainingRaw = record.limit_remaining;
  let remaining: number | null;
  if (remainingRaw === null || remainingRaw === undefined) {
    remaining = limit === null ? null : Math.max(0, limit - usage);
  } else {
    const parsedRemaining = finiteNonNegative(remainingRaw);
    if (parsedRemaining === undefined) throw new Error("OpenRouter key info has an invalid remaining credit.");
    remaining = parsedRemaining;
  }
  return { usage, limit, remaining, isFreeTier: record.is_free_tier === true };
}

export interface FetchOpenRouterKeyCreditsOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Read the calling key's OpenRouter credit balance. The API key travels only in
 * the Authorization header (never a query string or log). Same bounded gates as
 * the catalog fetch: HTTPS-only endpoint, redirects disabled, an absolute
 * deadline, a response-size cap, and a strict JSON content-type check.
 */
export async function fetchOpenRouterKeyCredits(
  apiKey: string,
  options: FetchOpenRouterKeyCreditsOptions = {},
): Promise<OpenRouterKeyCredits> {
  const key = apiKey.trim();
  if (!key) throw new Error("An OpenRouter API key is required to read credit balance.");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to read OpenRouter credit balance.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("OpenRouter credit read timed out.", "TimeoutError")), MODELS_REQUEST_TIMEOUT_MS);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
  }
  try {
    const response = await fetchImpl(OPENROUTER_KEY_URL, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenRouter credit read failed with HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/application\/json/iu.test(contentType)) {
      throw new Error("OpenRouter credit read returned a non-JSON response.");
    }
    const raw = await readBoundedText(response, MAX_KEY_RESPONSE_BYTES, "OpenRouter credit read");
    return parseOpenRouterKeyCredits(JSON.parse(raw) as unknown);
  } finally {
    clearTimeout(timeout);
  }
}
