/**
 * Live host model catalogs for LightningLoop-managed OpenAI-compatible presets.
 * OpenRouter uses the public catalog in openrouter.ts. Pi-managed presets use
 * the installed runtime catalog and never call a native /models endpoint here.
 */
import type { ProviderProfile } from "./provider-profile.js";

const MAX_MODELS_RESPONSE_BYTES = 4_194_304;
const MODELS_REQUEST_TIMEOUT_MS = 15_000;
const MAX_MODELS = 10_000;

export interface HostModel {
  id: string;
  name: string;
}

export interface FetchHostModelsOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function assertHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS with no query or fragment.`);
  }
  return url;
}

export function parseOpenAiModelList(value: unknown): HostModel[] {
  if (typeof value !== "object" || value === null) {
    throw new Error("Host model list is not a JSON object.");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Host model list is missing its data array.");
  }
  if (data.length > MAX_MODELS) {
    throw new Error("Host model list exceeds the supported bound.");
  }
  const models: HostModel[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { id?: unknown; name?: unknown };
    if (typeof record.id !== "string") continue;
    const id = record.id.trim();
    if (!id || id.length > 200 || /[\r\n\0]/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 120)
      : id;
    models.push({ id, name });
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
}

/** GeneralCompute org inventory sometimes uses POST /v1/models/list. */
export function parseGeneralComputeModelList(value: unknown): HostModel[] {
  if (typeof value !== "object" || value === null) {
    throw new Error("GeneralCompute model list is not a JSON object.");
  }
  const root = value as { data?: unknown; models?: unknown };
  if (Array.isArray(root.data)) return parseOpenAiModelList(value);
  if (Array.isArray(root.models)) return parseOpenAiModelList({ data: root.models });
  throw new Error("GeneralCompute model list is missing its data array.");
}

async function readBoundedText(response: Response, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODELS_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the size bound.`);
  }
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_MODELS_RESPONSE_BYTES) {
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
      if (total > MAX_MODELS_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${label} response exceeded the size bound.`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  label: string,
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/application\/json/iu.test(contentType)) {
    throw new Error(`${label} returned a non-JSON response.`);
  }
  return JSON.parse(await readBoundedText(response, label)) as unknown;
}

/**
 * Discover account-visible model IDs from a LightningLoop-managed host.
 * Requires a key except when the caller already proved the catalog is public.
 */
export async function fetchHostModels(
  profile: ProviderProfile,
  apiKey: string,
  options: FetchHostModelsOptions = {},
): Promise<HostModel[]> {
  if (profile.preset !== "generalcompute" && profile.preset !== "custom" && profile.preset !== "openrouter") {
    throw new Error(`${profile.displayName} does not use a LightningLoop-managed host catalog. Use the installed runtime catalog.`);
  }
  const key = apiKey.trim();
  if (!key) {
    throw new Error(`${profile.displayName} model discovery requires a LightningLoop-managed API key.`);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to discover host models.");
  }
  const base = assertHttpsUrl(profile.baseURL, `${profile.displayName} base URL`);
  const modelsUrl = new URL("models", `${base.href.replace(/\/?$/u, "/")}`).href;
  assertHttpsUrl(modelsUrl, `${profile.displayName} models URL`);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException(`${profile.displayName} model discovery timed out.`, "TimeoutError")),
    MODELS_REQUEST_TIMEOUT_MS,
  );
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
  };
  try {
    try {
      const payload = await fetchJson(modelsUrl, {
        method: "GET",
        redirect: "error",
        headers,
        signal: controller.signal,
      }, fetchImpl, `${profile.displayName} model discovery`);
      return parseOpenAiModelList(payload);
    } catch (error) {
      if (profile.preset !== "generalcompute") throw error;
      const listUrl = new URL("models/list", `${base.href.replace(/\/?$/u, "/")}`).href;
      assertHttpsUrl(listUrl, "GeneralCompute models/list URL");
      const payload = await fetchJson(listUrl, {
        method: "POST",
        redirect: "error",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      }, fetchImpl, "GeneralCompute model discovery");
      return parseGeneralComputeModelList(payload);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveHostModel(models: readonly HostModel[], id: string, displayName: string): HostModel {
  const match = models.find((model) => model.id === id);
  if (!match) {
    throw new Error(`model_unavailable: Model '${id}' is not in the current ${displayName} catalog. Run 'lightningloop provider models' to list available IDs.`);
  }
  return match;
}
