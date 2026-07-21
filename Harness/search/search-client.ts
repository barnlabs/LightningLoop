import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { SecretRedactor } from "../core/redaction.js";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { registerRuntimeCredential, runtimeCredentialValuesForFiltering } from "../core/credential-safety.js";
import { lightningLoopCredentialServices, loadProviderProfile } from "../core/provider-profile.js";

export type SearchProvider = "exa" | "brave" | "firecrawl";

export interface SearchResult {
  provider: SearchProvider;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface SearchResponse {
  provider: SearchProvider;
  query: string;
  results: SearchResult[];
  requestID?: string;
  estimatedCost?: number;
  creditsUsed?: number;
}

export interface OpenedSource {
  url: string;
  retrievedAt: string;
  sha256: string;
  text: string;
  contentType: string;
  sourceClass: "official-or-primary-candidate" | "general-web";
}

type FetchLike = typeof fetch;
type CredentialReader = (service: string) => string | undefined;
type CredentialServiceCatalogReader = () => readonly string[];

/** A resolver result is deliberately small so deterministic tests can model DNS rebinding. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DNSResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

interface SourceResponse {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: Uint8Array;
}

/**
 * Test seam for a transport which has already pinned a resolver-approved address.
 * Production uses `requestPinnedHTTPS`; callers must not replace this outside tests.
 */
export type SourceTransport = (url: URL, pinned: ResolvedAddress, headers: Record<string, string>, timeoutMS: number, maximumBytes: number) => Promise<SourceResponse | undefined>;

export interface SearchClientLimits {
  providerDeadlineMS?: number;
  sourceDeadlineMS?: number;
  documentationDeadlineMS?: number;
}

const PROVIDER_MAXIMUM_BYTES = 1_048_576;
const PROVIDER_DEADLINE_MS = 30_000;
const SOURCE_MAXIMUM_BYTES = 524_288;
const SOURCE_DEADLINE_MS = 10_000;
const DOCUMENTATION_MAXIMUM_BYTES = 262_144;
const DOCUMENTATION_DEADLINE_MS = 8_000;

const services: Record<SearchProvider, string> = {
  exa: "com.barnlabs.LightningLoop.search.exa",
  brave: "com.barnlabs.LightningLoop.search.brave",
  firecrawl: "com.barnlabs.LightningLoop.search.firecrawl",
};

const runtimeSearchCredentials = new Map<SearchProvider, string>();

/** Capture search-only environment credentials before the TUI scrubs its tool environment. */
export function captureSearchCredentials(environment: NodeJS.ProcessEnv): void {
  const names: Record<SearchProvider, string> = { exa: "EXA_API_KEY", brave: "BRAVE_SEARCH_API_KEY", firecrawl: "FIRECRAWL_API_KEY" };
  for (const provider of Object.keys(names) as SearchProvider[]) {
    const name = names[provider];
    const value = environment[name]?.trim();
    if (value) {
      runtimeSearchCredentials.set(provider, value);
      registerRuntimeCredential(value);
    }
  }
}

function readCredential(service: string): string | undefined {
  const provider = service.split(".").at(-1) ?? "";
  const captured = provider === "exa" || provider === "brave" || provider === "firecrawl" ? runtimeSearchCredentials.get(provider) : undefined;
  if (captured) return captured;
  const environmentName = provider === "exa" ? "EXA_API_KEY" : provider === "brave" ? "BRAVE_SEARCH_API_KEY" : provider === "firecrawl" ? "FIRECRAWL_API_KEY" : "";
  const environmentCredential = environmentName ? process.env[environmentName]?.trim() : undefined;
  if (environmentCredential) return environmentCredential;
  if (process.platform !== "darwin") return undefined;
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16_384,
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/**
 * Decode percent escapes until they stop changing.  Providers are untrusted and
 * may double- (or repeatedly-) encode a reflected credential.  This stays
 * deliberately local: it is a detector, never a value transformation, so an
 * encoded secret cannot become visible in a returned search field.
 */
const MAX_PERCENT_DECODE_ROUNDS = 16;

interface DecodedForms {
  readonly forms: readonly string[];
  /** False means the provider value remains encoded past the bounded detector. */
  readonly complete: boolean;
}

function decodedForms(value: string): DecodedForms {
  const forms = [value];
  let current = value;
  // A bounded detector avoids attacker-controlled CPU amplification.  If the
  // value remains encoded after the cap, callers fail closed rather than
  // returning a form whose hidden credential has not yet been observed.
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    let decoded: string;
    try { decoded = decodeURIComponent(current); }
    catch { return { forms, complete: false }; }
    if (decoded === current) return { forms, complete: true };
    forms.push(decoded);
    current = decoded;
  }
  try {
    return { forms, complete: decodeURIComponent(current) === current };
  } catch {
    return { forms, complete: false };
  }
}

function containsCredential(value: string, credentials: Iterable<string>): boolean {
  const decoded = decodedForms(value);
  if (!decoded.complete) return true;
  for (const credential of credentials) {
    if (credential.length >= 1 && decoded.forms.some((form) => form.includes(credential))) return true;
  }
  return false;
}

/** Central normalization for every provider-controlled text field. */
function normalizeProviderText(value: unknown, redactor: SecretRedactor, credentials: Iterable<string>, fallback = "", maximum = 4_000): string {
  const raw = text(value, fallback).slice(0, maximum);
  // Do not merely redact the literal form: an encoded secret would remain in
  // model context.  Redact the complete untrusted field if any decoded view
  // contains an active credential or generic secret-shaped content.
  const decoded = decodedForms(raw);
  if (!decoded.complete || containsCredential(raw, credentials) || decoded.forms.some((form) => redactor.redact(form) !== form)) return "[REDACTED]";
  return redactor.redact(raw);
}

/**
 * Search-result URLs are model-visible untrusted metadata.  Detect reflected
 * credentials before canonicalization, then return only a public HTTP(S) URL
 * with credentials, query, and fragment removed.
 */
function normalizeProviderURL(value: unknown, credentials: Iterable<string>): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return undefined;
  if (containsCredential(value, credentials)) return undefined;
  try {
    const url = new URL(value);
    if (containsCredential(url.href, credentials)) return undefined;
    const host = url.hostname.toLowerCase();
    const publicHost = host.includes(".")
      && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local")
      && !host.endsWith(".localdomain") && !host.endsWith(".internal") && !host.endsWith(".home")
      && !host.endsWith(".lan") && isIP(host) === 0;
    if (!publicHost || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
    // Query and fragments are untrusted provider metadata.  They are neither
    // needed for evidence retrieval nor permitted in model-facing URLs.
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function ipv4Number(address: string): number | undefined {
  const pieces = address.split(".");
  if (pieces.length !== 4) return undefined;
  let result = 0;
  for (const piece of pieces) {
    if (!/^\d{1,3}$/.test(piece)) return undefined;
    const octet = Number(piece);
    if (octet > 255) return undefined;
    result = (result * 256) + octet;
  }
  return result;
}

function inIPv4Range(value: number, start: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (start & mask);
}

/** Accept only globally-routable addresses. Everything allocated for a local/special purpose fails closed. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (value === undefined) return false;
    const nonPublicRanges: readonly [number, number][] = [
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
      [0xc01fc400, 24], [0xc034c100, 24], [0xc0586300, 24], [0xc0a80000, 16],
      [0xc0af3000, 24], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
      [0xe0000000, 4], [0xf0000000, 4],
    ];
    return !nonPublicRanges.some(([start, prefix]) => inIPv4Range(value, start, prefix));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  // IPv4-mapped addresses are special IPv6 addresses; reject rather than letting
  // a mapped loopback/private value reach a v4 socket through an IPv6-looking input.
  if (normalized.startsWith("::ffff:")) return false;
  const [firstHextetText = "", secondHextetText = ""] = normalized.split(":");
  const firstHextet = Number.parseInt(firstHextetText, 16);
  const secondHextet = secondHextetText ? Number.parseInt(secondHextetText, 16) : 0;
  // 2001:0000::/23 is the IANA protocol-assignment block; 3fff:0000::/20 is documentation.
  // Do not overblock ordinary global addresses such as 2001:4860::/32.
  const ianaProtocolAssignment = firstHextet === 0x2001 && secondHextet >= 0 && secondHextet <= 0x01ff;
  const documentation3fff = firstHextet === 0x3fff && secondHextet >= 0 && secondHextet <= 0x0fff;
  // Native source opens accept only global-unicast IPv6 space. This excludes
  // unspecified, loopback, ULA, link-local, multicast, documentation, NAT64,
  // discard, and other special-use allocations before the socket is created.
  return /^[23]/.test(normalized) && normalized !== "::" && normalized !== "::1"
    && !normalized.startsWith("fc") && !normalized.startsWith("fd")
    && !/^fe[89ab]/.test(normalized)
    && !normalized.startsWith("ff")
    && !normalized.startsWith("2001:db8:")
    && !ianaProtocolAssignment
    && !normalized.startsWith("2002:")
    && !documentation3fff;
}

const resolveAddresses: DNSResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.flatMap((record): ResolvedAddress[] => record.family === 4 || record.family === 6
    ? [{ address: record.address, family: record.family }]
    : []);
};

async function resolvePinnedPublicAddress(hostname: string, resolver: DNSResolver): Promise<ResolvedAddress | undefined> {
  const records = await resolver(hostname).catch(() => [] as readonly ResolvedAddress[]);
  // A mixed public/private DNS answer is suspicious as well: fail before creating
  // a socket rather than selecting around a private rebinding target.
  if (records.length === 0 || records.some((record) => !isPublicAddress(record.address))) return undefined;
  return records[0];
}

function requestPinnedHTTPS(url: URL, pinned: ResolvedAddress, headers: Record<string, string>, timeoutMS: number, maximumBytes: number): Promise<SourceResponse | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest>;
    const finish = (value: SourceResponse | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    // An absolute deadline prevents a slow peer from extending the request by
    // sending one byte before each inactivity timeout.
    const deadline = setTimeout(() => {
      request?.destroy(new Error("source request deadline exceeded"));
      finish(undefined);
    }, timeoutMS);
    request = httpsRequest({
      protocol: "https:", hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`,
      method: "GET", headers, agent: false, servername: url.hostname, rejectUnauthorized: true,
      // The resolver answer is captured before the socket exists and this callback
      // returns that exact address, pinning the TCP/TLS connection against rebinding.
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, (response) => {
      const declared = Number.parseInt(response.headers["content-length"] ?? "0", 10);
      if (declared > maximumBytes) { response.destroy(); finish(undefined); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumBytes) response.destroy(new Error("source exceeds byte limit"));
        else chunks.push(chunk);
      });
      response.on("end", () => finish({ status: response.statusCode ?? 0, headers: response.headers, bytes: new Uint8Array(Buffer.concat(chunks)) }));
      response.on("error", () => finish(undefined));
    });
    request.on("error", () => finish(undefined));
    request.end();
  });
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(fallback, Math.floor(value)))
    : fallback;
}

function mediaType(value: string | undefined | null): string | undefined {
  if (!value || value.includes(",")) return undefined;
  const type = value.split(";", 1)[0]?.trim().toLowerCase();
  return type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type) ? type : undefined;
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineAt: number, abort?: () => void): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    abort?.();
    throw new Error("request deadline exceeded");
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      abort?.();
      reject(new Error("request deadline exceeded"));
    }, remaining);
    operation.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function rejectInvalidDeclaredLength(headers: Headers, maximumBytes: number): void {
  const raw = headers.get("content-length");
  if (raw !== null && (!/^\d+$/u.test(raw.trim()) || Number(raw) > maximumBytes)) {
    throw new Error("response byte limit rejected");
  }
}

async function boundedResponseBytes(response: Response, maximumBytes: number, deadlineAt: number, abort: () => void): Promise<Uint8Array> {
  rejectInvalidDeclaredLength(response.headers, maximumBytes);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await beforeDeadline(reader.read(), deadlineAt, abort);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) {
        abort();
        await reader.cancel().catch(() => undefined);
        throw new Error("response byte limit rejected");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function providerJSON(
  fetcher: FetchLike,
  input: Parameters<FetchLike>[0],
  init: RequestInit,
  provider: SearchProvider,
  timeoutMS: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMS;
  let response: Response;
  try {
    response = await beforeDeadline(fetcher(input, { ...init, redirect: "error", signal: controller.signal }), deadlineAt, () => controller.abort());
  } catch {
    throw new Error(`${provider} search request failed or exceeded its deadline. Provider response text was withheld.`);
  }
  if (response.redirected || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    controller.abort();
    throw new Error(`${provider} search rejected a redirect. Provider response text was withheld.`);
  }
  if (!response.ok) {
    controller.abort();
    throw new Error(`${provider} search failed with HTTP ${response.status}. Provider response text was withheld.`);
  }
  if (mediaType(response.headers.get("content-type")) !== "application/json") {
    controller.abort();
    throw new Error(`${provider} search rejected a non-JSON response. Provider response text was withheld.`);
  }
  try {
    const bytes = await boundedResponseBytes(response, PROVIDER_MAXIMUM_BYTES, deadlineAt, () => controller.abort());
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("provider JSON must be an object");
    return parsed as Record<string, unknown>;
  } catch {
    controller.abort();
    throw new Error(`${provider} search rejected an invalid, oversized, or late JSON response. Provider response text was withheld.`);
  }
}

export class SearchClient {
  private readonly sourceTransport: SourceTransport;
  private readonly resolver: DNSResolver;
  private readonly providerDeadlineMS: number;
  private readonly sourceDeadlineMS: number;
  private readonly documentationDeadlineMS: number;
  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly credentialReader: CredentialReader = readCredential,
    private readonly sourceHostAllowlist: readonly string[] = (process.env.LIGHTNINGLOOP_SOURCE_HOST_ALLOWLIST ?? "")
      .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
    resolver: DNSResolver = resolveAddresses,
    sourceTransport?: SourceTransport,
    limits: SearchClientLimits = {},
    private readonly credentialServiceCatalog: CredentialServiceCatalogReader = () => lightningLoopCredentialServices(loadProviderProfile()),
  ) {
    this.resolver = resolver;
    this.sourceTransport = sourceTransport ?? requestPinnedHTTPS;
    this.providerDeadlineMS = boundedTimeout(limits.providerDeadlineMS, PROVIDER_DEADLINE_MS);
    this.sourceDeadlineMS = boundedTimeout(limits.sourceDeadlineMS, SOURCE_DEADLINE_MS);
    this.documentationDeadlineMS = boundedTimeout(limits.documentationDeadlineMS, DOCUMENTATION_DEADLINE_MS);
  }

  /**
   * Re-read the complete bounded LightningLoop-owned credential catalog for
   * every operation. This covers selected and unselected search providers,
   * process-captured values, fixed legacy services, and registered historical
   * custom services without touching Pi credentials or ~/.pi.
   */
  private credentialFilterSet(): Set<string> {
    const catalog = this.credentialServiceCatalog();
    if (catalog.length > 256 || new Set(catalog).size !== catalog.length) {
      throw new Error("LightningLoop credential catalog is unsafe; research failed closed.");
    }
    const runtimeCredentials = runtimeCredentialValuesForFiltering();
    if (runtimeCredentials.length > 256 || runtimeCredentials.some((value) => value.length > 16_384)) {
      throw new Error("LightningLoop runtime credential set is unsafe; research failed closed.");
    }
    const credentials = new Set(runtimeCredentials);
    for (const service of catalog) {
      if (typeof service !== "string" || service.length > 512 || !service.startsWith("com.barnlabs.LightningLoop.")) {
        throw new Error("LightningLoop credential catalog is unsafe; research failed closed.");
      }
      const value = this.credentialReader(service)?.trim();
      if (value) {
        if (value.length > 16_384) throw new Error("LightningLoop credential value is unsafe; research failed closed.");
        credentials.add(value);
      }
    }
    return credentials;
  }

  private async fetchOpenedSource(url: URL, headers: Record<string, string>, timeoutMS: number, maximumBytes: number): Promise<SourceResponse | undefined> {
    const deadlineAt = Date.now() + timeoutMS;
    const pinned = await beforeDeadline(resolvePinnedPublicAddress(url.hostname, this.resolver), deadlineAt).catch(() => undefined);
    if (!pinned) return undefined;
    const response = await beforeDeadline(this.sourceTransport(url, pinned, headers, timeoutMS, maximumBytes), deadlineAt).catch(() => undefined);
    return response && response.bytes.length <= maximumBytes ? response : undefined;
  }

  async search(provider: SearchProvider, query: string, limit = 5): Promise<SearchResponse> {
    const cleanQuery = query.trim();
    if (!cleanQuery) throw new Error("Search query is required.");
    if (cleanQuery.length > 400) throw new Error("Search query exceeds the 400-character safety limit.");
    const cleanLimit = Math.max(1, Math.min(20, Math.floor(limit)));
    const credentials = this.credentialFilterSet();
    const credential = this.credentialReader(services[provider])?.trim();
    if (!credential) throw new Error(`The ${provider} credential is not configured.`);
    if (credential.length > 16_384) throw new Error(`The ${provider} credential exceeds the safety limit.`);
    credentials.add(credential);
    const redactor = new SecretRedactor([...credentials]);
    // Never silently rewrite an outbound query. A query that contains any
    // freshly loaded LightningLoop-owned credential or a recognized secret
    // shape is rejected before a provider request is constructed.
    if (containsCredential(cleanQuery, credentials) || redactor.redact(cleanQuery) !== cleanQuery) {
      throw new Error("Research query contains credential or secret-like content and was not sent.");
    }
    const safeText = (value: unknown, fallback = ""): string => normalizeProviderText(value, redactor, credentials, fallback);
    const safeClip = (value: unknown): string => normalizeProviderText(value, redactor, credentials, "", 4_000);
    const safeURL = (value: unknown): string | undefined => normalizeProviderURL(value, credentials);
    const safeMetadata = (value: unknown): string | undefined => {
      const normalized = normalizeProviderText(value, redactor, credentials, "", 512);
      return normalized ? normalized : undefined;
    };
    const safeNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    if (provider === "exa") {
      const body = await providerJSON(this.fetcher, "https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": credential },
        body: JSON.stringify({ query: cleanQuery, numResults: cleanLimit, type: "auto", moderation: true, contents: { highlights: true } }),
      }, provider, this.providerDeadlineMS);
      const results = Array.isArray(body.results) ? body.results : [];
      const cost = record(body.costDollars);
      const requestID = safeMetadata(body.requestId);
      const estimatedCost = safeNumber(cost.total);
      return {
        provider,
        query: normalizeProviderText(cleanQuery, redactor, credentials, "", 400),
        results: results.flatMap((item): SearchResult[] => {
          const entry = record(item);
          const url = safeURL(entry.url);
          if (!url) return [];
          const highlights = Array.isArray(entry.highlights) ? entry.highlights.filter((part) => typeof part === "string").join(" ") : "";
          const publishedAt = safeMetadata(entry.publishedDate);
          return [{
            provider,
            title: safeText(entry.title, url),
            url,
            snippet: safeClip(highlights || entry.summary || entry.text),
            ...(publishedAt ? { publishedAt } : {}),
          }];
        }),
        ...(requestID !== undefined ? { requestID } : {}),
        ...(estimatedCost !== undefined ? { estimatedCost } : {}),
      };
    }

    if (provider === "brave") {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", cleanQuery);
      url.searchParams.set("count", String(cleanLimit));
      url.searchParams.set("safesearch", "moderate");
      const body = await providerJSON(this.fetcher, url, {
        headers: { Accept: "application/json", "X-Subscription-Token": credential },
      }, provider, this.providerDeadlineMS);
      const web = record(body.web);
      const results = Array.isArray(web.results) ? web.results : [];
      return {
        provider,
        query: normalizeProviderText(cleanQuery, redactor, credentials, "", 400),
        results: results.flatMap((item): SearchResult[] => {
          const entry = record(item);
          const resultURL = safeURL(entry.url);
          if (!resultURL) return [];
          return [{ provider, title: safeText(entry.title, resultURL), url: resultURL, snippet: safeClip(entry.description) }];
        }),
      };
    }

    const body = await providerJSON(this.fetcher, "https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: cleanQuery, limit: cleanLimit, sources: ["web"], country: "US", timeout: 25_000 }),
    }, provider, this.providerDeadlineMS);
    const data = record(body.data);
    const results = Array.isArray(data.web) ? data.web : [];
    const requestID = safeMetadata(body.id);
    const creditsUsed = safeNumber(body.creditsUsed);
    return {
      provider,
      query: normalizeProviderText(cleanQuery, redactor, credentials, "", 400),
      results: results.flatMap((item): SearchResult[] => {
        const entry = record(item);
        const resultURL = safeURL(entry.url);
        if (!resultURL) return [];
        return [{ provider, title: safeText(entry.title, resultURL), url: resultURL, snippet: safeClip(entry.description || entry.markdown) }];
      }),
      ...(requestID !== undefined ? { requestID } : {}),
      ...(creditsUsed !== undefined ? { creditsUsed } : {}),
    };
  }

  async openSource(resultURL: string): Promise<OpenedSource | undefined> {
    let credentials: Set<string>;
    try { credentials = this.credentialFilterSet(); }
    catch { return undefined; }
    const safe = normalizeProviderURL(resultURL, credentials);
    if (!safe) return undefined;
    const url = new URL(safe);
    // Opened-source evidence is intentionally narrower than search result URLs.
    // Plain HTTP, credentials, redirects, local names, and IP literals fail closed.
    if (url.protocol !== "https:" || (url.port && url.port !== "443")) return undefined;
    const response = await this.fetchOpenedSource(url, { Accept: "text/html, text/plain;q=0.9, text/markdown;q=0.8" }, this.sourceDeadlineMS, SOURCE_MAXIMUM_BYTES);
    if (!response || response.status < 200 || response.status >= 300) return undefined;
    const declared = Number.parseInt(String(response.headers["content-length"] ?? "0"), 10);
    if (declared > SOURCE_MAXIMUM_BYTES) return undefined;
    const parsedMediaType = mediaType(String(response.headers["content-type"] ?? ""));
    if (!parsedMediaType || !["text/html", "text/plain", "text/markdown"].includes(parsedMediaType)) return undefined;
    const bytes = response.bytes;
    if (bytes.length < 1 || bytes.length > SOURCE_MAXIMUM_BYTES) return undefined;
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
    catch { return undefined; }
    if (!decoded) return undefined;
    if (containsCredential(decoded, credentials)) return undefined;
    const hostname = url.hostname.toLowerCase();
    const sourceClass = hostname.endsWith(".gov")
      || hostname.endsWith(".edu")
      || this.sourceHostAllowlist.includes(hostname)
      ? "official-or-primary-candidate" as const
      : "general-web" as const;
    return {
      url: url.href,
      retrievedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: decoded.slice(0, 64_000),
      contentType: parsedMediaType,
      sourceClass,
    };
  }

  async documentationContext(resultURL: string): Promise<{ url: string; text: string } | undefined> {
    let credentials: Set<string>;
    try { credentials = this.credentialFilterSet(); }
    catch { return undefined; }
    const safe = normalizeProviderURL(resultURL, credentials);
    if (!safe) return undefined;
    const result = new URL(safe);
    if (result.protocol !== "https:" || (result.port && result.port !== "443")) return undefined;
    const allowedHosts = (process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host))
      .slice(0, 20);
    if (!allowedHosts.includes(result.hostname.toLowerCase())) return undefined;
    const origin = result.origin;
    const llmsURL = new URL("/llms.txt", origin);
    const response = await this.fetchOpenedSource(llmsURL, { Accept: "text/plain, text/markdown;q=0.9" }, this.documentationDeadlineMS, DOCUMENTATION_MAXIMUM_BYTES);
    if (!response || response.status < 200 || response.status >= 300) return undefined;
    const declared = Number.parseInt(String(response.headers["content-length"] ?? "0"), 10);
    if (declared > DOCUMENTATION_MAXIMUM_BYTES) return undefined;
    const parsedMediaType = mediaType(String(response.headers["content-type"] ?? ""));
    if (!parsedMediaType || !["text/plain", "text/markdown"].includes(parsedMediaType)) return undefined;
    const bytes = response.bytes;
    if (bytes.length === 0 || bytes.length > DOCUMENTATION_MAXIMUM_BYTES) return undefined;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
    catch { return undefined; }
    if (containsCredential(text, credentials)) return undefined;
    return text ? { url: llmsURL.href, text: text.slice(0, 32_000) } : undefined;
  }
}
