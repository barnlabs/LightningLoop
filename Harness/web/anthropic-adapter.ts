import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentAdapter, AgentReply, AgentRequest } from "../core/loop-types.js";
import { SecretRedactor } from "../core/redaction.js";

/**
 * Web adapter for the LightningLoop harness.
 *
 * Speaks the Anthropic Messages API (`/v1/messages`). Provider-neutral: no
 * built-in defaults. Each person configures their own provider via
 * provider-sheet.json (gitignored) or LL_* env vars. See
 * provider-sheet.example.json and REDESIGN.md.
 *
 * Credential sources, in priority order:
 *   1. Constructor args (used when a connected client brings its own key).
 *   2. Environment variables (LL_API_KEY / LL_BASE_URL / LL_MODEL).
 *   3. The gitignored local provider-sheet.json.
 *
 * OpenAI-compatible providers (OpenAI, Groq, OpenRouter, Cerebras, Fireworks)
 * can be added as a sibling adapter later; this one covers Anthropic-format
 * endpoints.
 */

export interface AnthropicAdapterOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Optional override of the protocol path appended to baseURL. */
  messagesPath?: string;
  /** Anthropic API version header. Defaults to 2023-06-01. */
  anthropicVersion?: string;
}

const DEFAULT_VERSION = "2023-06-01";

/**
 * The engine's plan/revision prompts trust the model to reuse the exact
 * criterion schema, including a strict evidence_kind allow-list. Models
 * occasionally drift to an invented kind during revision. Append the allow-list
 * as a hard reminder ONLY when the request is building/revising the plan
 * (orchestrator role + a JSON contract in the user payload). Adapter-level only.
 */
const EVIDENCE_KIND_REMINDER =
  "\n\nCONSTRAINT: every criterion.evidence_kind MUST be exactly one of: source, behavior, build, syntax, file, render, user_acceptance. No other value is accepted. Output a single JSON object with no surrounding markdown or prose.";

function reinforceContract(system: string, user: string): string {
  if (/criteria|evidence_kind|acceptance_test/u.test(user)) {
    return system + EVIDENCE_KIND_REMINDER;
  }
  return system;
}

/**
 * Map of camelCase keys the model sometimes emits to the snake_case keys the
 * engine's parser requires. Applied to JSON that looks like a plan/review/
 * implementation payload. Adapter-level normalization only.
 */
const KEY_FIXES: Record<string, string> = {
  evidenceKind: "evidence_kind",
  evidenceTarget: "evidence_target",
  whyItMatters: "why_it_matters",
  criterionId: "criterion_id",
  requiredChange: "required_change",
  assertionId: "assertion_id",
  expectedOutput: "expected_output",
  sourceClaim: "claim", // engine reads `claim`, not `source_claim`
  acceptanceTest: "acceptance_test",
};

/**
 * If the extracted content is JSON containing criterion-shaped objects, rewrite
 * any camelCase keys the model drifted to back into the snake_case the engine
 * expects. Non-JSON content is returned unchanged.
 */
function normalizeCriterionKeys(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return content; // not valid JSON; let the engine's parser report it
  }
  walkAndFixKeys(parsed);
  return JSON.stringify(parsed);
}

function walkAndFixKeys(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) walkAndFixKeys(item);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const fixed = KEY_FIXES[key];
      if (fixed && fixed !== key) {
        obj[fixed] = obj[key];
        delete obj[key];
      }
      // The engine requires certain string fields (e.g. `claim`) to be trimmed;
      // Models sometimes pad them with whitespace. Trim top-level string values.
      const targetKey = fixed ?? key;
      const val = obj[targetKey];
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed !== val) obj[targetKey] = trimmed;
      }
      walkAndFixKeys(obj[targetKey]);
    }
  }
}

/**
 * Pull the first balanced JSON value out of a model response, tolerating the
 * ways models mis-format structured output:
 *   - leading Markdown headings / prose before the JSON ("## Revised Plan\n{...}")
 *   - fenced code blocks ("```json\n{...}\n```")
 *   - trailing prose after the closing brace
 * The engine's own parser only strips simple ``` fences and stays strict; this
 * adapter-level tolerance gives the engine clean input without weakening the
 * engine itself. Tracks string literals + nesting so braces inside string
 * values are handled.
 */
function extractJSON(content: string): string {
  let text = content.trim();
  // 1. Prefer the contents of a ```json (or plain ```) fenced block.
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fence && fence[1]) text = fence[1].trim();
  // 2. Find the first '{' or '[' and extract the balanced value from there.
  const start = text.search(/[{[]/);
  if (start === -1) return content; // nothing JSON-shaped; let the parser report it
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unterminated — return as-is and let the parser report it.
  return content;
}

interface LocalConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  models?: string[]; // legacy .zai-local.json shape
}

/**
 * Read the person's provider config. Tries provider-sheet.json first (the
 * documented per-person sheet), then falls back to legacy .zai-local.json.
 * Never throws.
 */
function readLocalConfig(): LocalConfig {
  for (const name of ["provider-sheet.json", ".zai-local.json"]) {
    try {
      const raw = readFileSync(resolve(process.cwd(), name), "utf8");
      const parsed = JSON.parse(raw) as LocalConfig;
      // Normalize legacy shape (models[] → model)
      if (!parsed.model && Array.isArray(parsed.models) && parsed.models.length) {
        const first: string | undefined = parsed.models[0];
        if (first) parsed.model = first;
      }
      return parsed;
    } catch {
      // try next
    }
  }
  return {};
}

/**
 * Resolve adapter options from constructor args, env vars, then the person's
 * provider sheet. Throws only if no API key is available anywhere — the caller
 * decides whether that's fatal (no provider at all) or recoverable (bring-your-own from UI).
 *
 * Provider-neutral: no built-in defaults. Each person fills in provider-sheet.json
 * (gitignored) or sets LL_* env vars. See provider-sheet.example.json.
 */
export function resolveAdapterOptions(overrides?: Partial<AnthropicAdapterOptions>): AnthropicAdapterOptions {
  const local = readLocalConfig();
  const baseURL =
    overrides?.baseURL ??
    process.env.LL_BASE_URL ??
    local.baseURL;
  const apiKey =
    overrides?.apiKey ??
    process.env.LL_API_KEY ??
    local.apiKey;
  const model =
    overrides?.model ??
    process.env.LL_MODEL ??
    local.model;
  if (!apiKey || !baseURL || !model) {
    throw new Error(
      "No provider configured. Copy Harness/web/provider-sheet.example.json to provider-sheet.json (repo root) and fill in your provider, or set LL_API_KEY, LL_BASE_URL, and LL_MODEL env vars.",
    );
  }
  const result: AnthropicAdapterOptions = { baseURL, apiKey, model };
  if (overrides?.messagesPath !== undefined) result.messagesPath = overrides.messagesPath;
  if (overrides?.anthropicVersion !== undefined) result.anthropicVersion = overrides.anthropicVersion;
  return result;
}

interface AnthropicMessagesResponse {
  id: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class AnthropicAdapter implements AgentAdapter {
  readonly supportsImages = false;
  private readonly redactor: SecretRedactor;

  constructor(private readonly options: AnthropicAdapterOptions) {
    this.redactor = new SecretRedactor([options.apiKey]);
  }

  async complete(request: AgentRequest, signal?: AbortSignal): Promise<AgentReply> {
    const path = this.options.messagesPath ?? "/v1/messages";
    const url = this.options.baseURL.replace(/\/+$/u, "") + path;
    // Models sometimes emit a criterion with an evidence_kind outside the
    // engine's strict allow-list during plan revision. Reinforce the contract
    // at the adapter boundary so the model stays on-schema. This does not alter
    // the engine's prompts or its validation; it only nudges this provider.
    const system = reinforceContract(request.system, request.user);
    const body = {
      model: this.options.model,
      max_tokens: Math.min(request.maxTokens, 8192),
      temperature: request.temperature,
      system,
      messages: [{ role: "user", content: request.user }],
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": this.options.anthropicVersion ?? DEFAULT_VERSION,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw new DOMException("Provider request was cancelled.", "AbortError");
      throw new Error(`Provider request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      throw new Error(`${this.options.model} returned an empty response (status ${response.status}).`);
    }
    const json = (await response.json()) as AnthropicMessagesResponse;

    if (!response.ok || json.error) {
      const msg = json.error?.message ?? `Provider error (status ${response.status}).`;
      throw new Error(this.redactor.redact(msg));
    }
    if (signal?.aborted) throw new DOMException("Provider request was cancelled.", "AbortError");

    const text = (json.content ?? [])
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error(`${this.options.model} returned no text content.`);

    // The LightningLoop engine asks models to return a single JSON object.
    // Models sometimes append trailing prose after the closing brace.
    // Extract the leading balanced JSON object so the engine's strict parser
    // gets clean input. This is adapter-level tolerance only — the engine's
    // own validation stays unchanged for every other adapter.
    const safeText = this.redactor.redact(normalizeCriterionKeys(extractJSON(text)));
    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    return {
      content: safeText,
      usage: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
        // POC: no price table. The real version maps model -> cost.
        cost: 0,
      },
    };
  }
}
