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

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

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
    const raw = await response.text();
    if (raw.length > MAX_MODELS_RESPONSE_BYTES) {
      throw new Error("OpenRouter model discovery response exceeded the size bound.");
    }
    return parseOpenRouterModels(JSON.parse(raw) as unknown);
  } finally {
    clearTimeout(timeout);
  }
}
