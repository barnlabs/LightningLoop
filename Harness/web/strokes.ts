/**
 * The 4-stroke flow: intake (classify) → compression (clarify) → combustion
 * (answer) → exhaust (honest review). These are pure-ish functions that take an
 * AgentAdapter and return structured results. The server wires them to the
 * WebSocket transport; these functions know nothing about sockets.
 *
 * Provider-neutral. No built-in defaults.
 */

import type { AgentAdapter, AgentReply, Clarification, LoopRunResult } from "../core/loop-types.js";
import { SearchClient, captureSearchCredentials, type SearchProvider, type SearchResult } from "../search/search-client.js";

export type GoalClass = "harmful" | "subjective" | "factual";

export interface SearchConfig {
  provider: SearchProvider;
  apiKey: string;
}

interface SimpleResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * FREE no-key web search via DuckDuckGo's HTML endpoint. No API key required,
 * works for everyone the moment they enter an LLM key. Lower quality than paid
 * providers (no structured metadata) but it's real web data that stops the
 * model from fabricating. Best-effort — never blocks the answer.
 */
async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SimpleResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "accept": "text/html",
      "accept-language": "en-US,en;q=0.9",
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) return [];
  const html = await response.text();
  // DuckDuckGo HTML results follow a predictable structure. Extract result
  // blocks, titles, URLs, and snippets without a DOM parser (no deps).
  const results: SimpleResult[] = [];
  const blocks = html.split(/class="result\s(?:results_links|web-result|")/i);
  for (const block of blocks) {
    if (results.length >= 5) break;
    // Title + URL: <a class="result__a" href="...">Title</a>
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    let rawUrl = titleMatch[1] ?? "";
    const title = stripTags(titleMatch[2] ?? "").trim();
    // DDG wraps URLs in a redirect; extract the actual URL.
    const udcParam = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (udcParam) rawUrl = decodeURIComponent(udcParam[1] ?? "");
    if (!rawUrl.startsWith("http") || !title) continue;
    // Snippet: <a class="result__snippet" ...>...</a>
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = stripTags(snippetMatch?.[1] ?? "").trim();
    results.push({ title, url: rawUrl, snippet: snippet.slice(0, 400) });
  }
  return results;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * Run a real web search to ground the answer in actual results. Returns the
 * formatted results to inject into the answer prompt, or undefined if search
 * fails entirely. Best-effort — never blocks the answer.
 *
 * Priority: a configured paid provider (Exa/Brave/Firecrawl) if the user
 * supplied a key; otherwise the free no-key DuckDuckGo layer that works for
 * everyone with just an LLM key.
 */
async function runSearch(
  search: SearchConfig | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let results: SimpleResult[] = [];
  // 1. Paid provider if configured.
  if (search) {
    try {
      const envName = search.provider === "exa" ? "EXA_API_KEY" : search.provider === "brave" ? "BRAVE_SEARCH_API_KEY" : "FIRECRAWL_API_KEY";
      captureSearchCredentials({ [envName]: search.apiKey });
      const client = new SearchClient();
      const response = await client.search(search.provider, query, 5);
      results = (response.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
    } catch {
      // fall through to free search
    }
  }
  // 2. Free no-key fallback — always available.
  if (results.length === 0) {
    try {
      results = await searchDuckDuckGo(query, signal);
    } catch {
      // search failed entirely
    }
  }
  if (results.length === 0) return undefined;
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
    .join("\n\n");
}

/**
 * COMPRESSION (subjective path): richer clarifying questions than the engine's
 * default. Asks about the dimensions that make a subjective answer actually
 * useful — who's involved, what constraints apply, what scenario the answer
 * needs to fit. This is how "where should we eat?" surfaces "one person is
 * vegan" before the answer is composed.
 *
 * Returns a Clarification (same shape the engine uses) but with up to 6
 * scenario-aware questions.
 */
export async function clarifySubjective(
  adapter: AgentAdapter,
  goal: string,
  signal?: AbortSignal,
): Promise<Clarification> {
  const reply = await callWithRetry(adapter, {
    role: "orchestrator",
    system: [
      "You ask clarifying questions that make a subjective question answerable.",
      "Think about what a person would actually need to know to give a great answer: who is involved (number of people, any needs/preferences/dietary requirements), what constraints apply (budget, location, time, distance), and what scenario this is for (casual, special occasion, quick, leisurely).",
      "Ask only questions whose answers would genuinely change the recommendation. Don't ask obvious things the goal already states.",
      "Return ONLY a JSON object, no prose:",
      '{"summary":"one sentence rephrasing what the user wants","questions":[{"id":"Q1","question":"...","why_it_matters":"..."}, ...]}',
      "You MUST ask at least 5 questions. Aim for 6. Cover all relevant dimensions: people/constraints/scenario/timing/precedence. Keep each question short and plain.",
    ].join("\n"),
    user: `Question to clarify:\n${goal}`,
    temperature: 0.3,
    maxTokens: 800,
  }, signal);
  const parsed = parseJSONLoose(reply.content);
  const summary = typeof parsed?.summary === "string" ? parsed.summary : goal;
  const rawQs = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const questions = rawQs
    .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null)
    .map((q, i) => ({
      id: typeof q.id === "string" && q.id ? q.id : `Q${i + 1}`,
      question: typeof q.question === "string" ? q.question : "",
      whyItMatters: typeof q.why_it_matters === "string" ? q.why_it_matters : "",
    }))
    .filter((q) => q.question)
    .slice(0, 6);
  if (questions.length === 0) {
    return { summary, questions: [{ id: "Q1", question: "Is there anything specific you're looking for?", whyItMatters: "Helps tailor the answer." }] };
  }
  return { summary, questions };
}

export interface ClassificationResult {
  classification: GoalClass;
  /** Why this classification was chosen — shown to the user for transparency. */
  reason: string;
  /** For harmful goals: a constructive reframe offered to the user, if any. */
  reframe?: string;
}

/** INTAKE: classify the goal before doing anything else. Hard gate on harmful. */
export async function classifyGoal(
  adapter: AgentAdapter,
  goal: string,
  signal?: AbortSignal,
): Promise<ClassificationResult> {
  const reply = await callWithRetry(
    adapter,
    {
      role: "orchestrator",
      system: [
        "You classify a user's question into exactly one category. Respond with ONLY a JSON object, no prose.",
        "Categories:",
        "- \"harmful\": the question asks to rank, judge, demean, or discriminate against people by race, ethnicity, religion, gender, sexuality, disability, or nationality; or promotes hate, violence, or supremacy. Examples: 'best human race', 'which religion is worst', 'why are [group] inferior'.",
        "- \"subjective\": the answer depends on personal preference, taste, opinion, or judgment. No single objectively-correct answer exists. Examples: 'best coffee near me', 'greatest country', 'most beautiful city'.",
        "- \"factual\": the answer is a verifiable fact that could be backed by a specific source. Examples: 'GDP of Kenya', 'when was Rome founded', 'chemical formula for water'.",
        'Return exactly: {"classification":"harmful|subjective|factual","reason":"one short sentence","reframe":"optional constructive reframe, only for harmful"}',
      ].join("\n"),
      user: `Classify this question:\n${goal}`,
      temperature: 0,
      maxTokens: 300,
    },
    signal,
  );
  const parsed = parseJSONLoose(reply.content);
  const classification = (parsed?.classification as GoalClass) ?? "subjective";
  const reason = typeof parsed?.reason === "string" ? parsed.reason : "Unclassified — defaulting to subjective.";
  const reframe = typeof parsed?.reframe === "string" && parsed.reframe.trim() ? parsed.reframe.trim() : undefined;
  if (classification !== "harmful" && classification !== "subjective" && classification !== "factual") {
    return { classification: "subjective", reason: `${reason} (unrecognized class, defaulted to subjective)` };
  }
  return { classification, reason, ...(reframe ? { reframe } : {}) };
}

/** COMBUSTION (subjective path): a grounded, fact-based answer in the user's terms. */
export async function answerSubjective(
  adapter: AgentAdapter,
  goal: string,
  clarification: Clarification,
  answers: Record<string, string>,
  search: SearchConfig | undefined,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const answersText = clarification.questions
    .map((q) => `Q: ${q.question}\nA: ${answers[q.id] ?? "(no answer)"}`)
    .join("\n");
  return callWithRetry(
    adapter,
    {
      role: "orchestrator",
      system: [
        "You are a thorough expert answering a question in the user's own terms. Research and reason in depth before answering.",
        "HONESTY IS THE TOP PRIORITY. You must never invent or fabricate.",
        "DEPTH OF RESEARCH — work through these steps in your reasoning before writing the final answer:",
        "1. RECALL: What do you actually know about this from your training? Pull up the relevant facts, definitions, and context.",
        "2. ANGLES: Consider the question from multiple viewpoints (cost, quality, convenience, the user's stated parameters, edge cases). Don't just give the first answer that comes to mind.",
        "3. ALTERNATIVES: What are the realistic alternatives or trade-offs? Weigh them honestly.",
        "4. VERIFY: Cross-check any specific claim against what you genuinely know. If you're unsure a detail is real, treat it as uncertain.",
        "5. TAILOR: Apply the user's clarifying answers as hard constraints. Reject options that violate them.",
        "OUTPUT RULES:",
        "- Do NOT invent specific named entities (businesses, addresses, prices, hours, URLs) unless genuinely certain they are real. Describe types of places when you can't verify a specific one.",
        "- If you DO name a specific real place you are confident about, flag it: 'I believe this exists, but verify before you go.'",
        "- Do not invent facts, sources, statistics, or quotes.",
        "- Lead with the direct answer, then the reasoning and the trade-offs.",
        "- If you genuinely do not know something concrete, say so plainly.",
        "Be useful. A real, well-reasoned answer beats a refusal — but an honest answer beats a confident fabrication.",
      ].join("\n"),
      user: await buildAnswerUserPrompt(goal, answersText, search, signal),
      temperature: 0.4,
      maxTokens: 2500,
    },
    signal,
  );
}

/** Build the user prompt, grounding it in real search results. Search always
 * runs now — the free DuckDuckGo layer covers the no-paid-key case. */
async function buildAnswerUserPrompt(
  goal: string,
  answersText: string,
  search: SearchConfig | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const base = `Goal: ${goal}\n\nClarifying answers (the user's parameters):\n${answersText}`;
  // Search always runs — paid provider if configured, free DuckDuckGo otherwise.
  const query = goal;
  const results = await runSearch(search, query, signal);
  if (!results) {
    return `${base}\n\nProvide a direct, helpful answer. Do not fabricate specific establishments or named entities you cannot verify.`;
  }
  return `${base}\n\nREAL SEARCH RESULTS (use these as your source of truth — only reference places/details that appear here):\n${results}\n\nProvide a direct, helpful answer grounded in the search results above. Prefer naming real places from the results over describing generic types. If the results don't clearly answer the question, say what you found and what's still uncertain.`;
}

/** EXHAUST: a rigorous honesty pass over a subjective answer. */
export interface HonestyReview {
  /** Did the answer actually address the question in the user's terms? */
  addressed: boolean;
  /** What's the model's own judgment vs. established fact? */
  judgmentNotes: string;
  /** What's genuinely uncertain or caveated? */
  uncertainty: string;
  /** Did the answer name specific entities (places, businesses, etc.)? */
  namedEntities: string;
  /** Are those named entities plausibly real, or likely fabricated? */
  fabricationRisk: "none" | "low" | "high";
  /** If fabrication risk is high, a correction the answer should carry. */
  correction?: string;
}

export async function reviewHonesty(
  adapter: AgentAdapter,
  goal: string,
  answer: string,
  signal?: AbortSignal,
): Promise<HonestyReview> {
  const reply = await callWithRetry(
    adapter,
    {
      role: "reviewer",
      system: [
        "You are a rigorous honesty reviewer. Your job is to catch FABRICATION.",
        "Review the answer and respond with ONLY a JSON object, no prose:",
        '{"addressed":true|false,"judgment_notes":"...","uncertainty":"...","named_entities":"list any specific named places/businesses/products/people, or empty","fabrication_risk":"none|low|high","correction":"if fabrication_risk is high, what warning to add"}',
        "fabrication_risk = HIGH if the answer names specific businesses, restaurants, products, addresses, phone numbers, or URLs that may not be real or that you cannot confirm exist. Models frequently invent plausible-sounding establishment names — treat any specific named business as suspect unless it is a globally famous landmark.",
        "fabrication_risk = LOW if it only names famous/well-known places, or describes types of places without naming specific establishments.",
        "fabrication_risk = NONE if there are no specific named entities at all.",
        "Be strict. When in doubt about whether a named place is real, set fabrication_risk to high and write a correction that warns the user to verify before relying on it.",
      ].join("\n"),
      user: `Question: ${goal}\n\nAnswer to review:\n${answer}`,
      temperature: 0,
      maxTokens: 500,
    },
    signal,
  );
  const parsed = parseJSONLoose(reply.content);
  const risk = (parsed?.fabrication_risk as HonestyReview["fabricationRisk"]) ?? "low";
  const correction = typeof parsed?.correction === "string" && parsed.correction.trim() ? parsed.correction.trim() : undefined;
  return {
    addressed: Boolean(parsed?.addressed),
    judgmentNotes: typeof parsed?.judgment_notes === "string" ? parsed.judgment_notes : "",
    uncertainty: typeof parsed?.uncertainty === "string" ? parsed.uncertainty : "",
    namedEntities: typeof parsed?.named_entities === "string" ? parsed.named_entities : "",
    fabricationRisk: (risk === "none" || risk === "low" || risk === "high") ? risk : "low",
    ...(correction ? { correction } : {}),
  };
}

/** Build a LoopRunResult-shaped object for the subjective path so the UI renders it unchanged. */
export function subjectiveResult(
  answer: string,
  review: HonestyReview,
  usage: AgentReply["usage"],
): LoopRunResult {
  const notes: string[] = ["Answered in the user's terms (subjective path)."];
  if (review.judgmentNotes) notes.push(`Judgment vs. fact: ${review.judgmentNotes}`);
  if (review.uncertainty) notes.push(`Uncertainty: ${review.uncertainty}`);
  if (!review.addressed) notes.push("Note: the honesty review flagged that the answer may not fully address the question.");

  // If the honesty review caught likely fabrication, append a visible warning
  // to the answer itself so the user is never quietly misled.
  let deliverable = answer;
  if (review.fabricationRisk === "high") {
    const warning = review.correction
      ? `\n\n---\n\n⚠️ **Honesty check:** ${review.correction}`
      : "\n\n---\n\n⚠️ **Honesty check:** The named specifics above may not be real — please verify any establishment, address, or detail before relying on it.";
    deliverable = answer + warning;
    notes.push("Fabrication risk: HIGH — a verification warning was appended to the answer.");
  } else if (review.fabricationRisk === "low" && review.namedEntities) {
    notes.push("Fabrication risk: LOW (only well-known entities named).");
  }

  return {
    completed: true,
    stage: "gold",
    message: "Direct answer in the user's terms, with an honesty review.",
    planning: { criteria: [], plan: [], risks: [], acceptanceTest: "Subjective path — answered with stated reasoning, not machine-proven." },
    implementation: { deliverable, notes, files: [], verificationCommands: [] },
    reviews: [],
    evidence: [],
    usage,
  };
}

// ─── internals ────────────────────────────────────────────────────────────

/**
 * The "valve": call the model, and on failure, retry up to 3 times feeding the
 * SPECIFIC error back to the model so it can correct the actual problem. This
 * is what kills the blind-retry whack-a-mole.
 */
const MAX_RETRIES = 3;

async function callWithRetry(
  adapter: AgentAdapter,
  request: Parameters<AgentAdapter["complete"]>[0],
  signal?: AbortSignal,
): Promise<AgentReply> {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await adapter.complete(request, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        // Surface the specific error to the caller via a property the server can read.
        (request as { __lastError?: string }).__lastError = lastError;
      }
    }
  }
  throw new Error(`Model call failed after ${MAX_RETRIES} attempts. Last error: ${lastError}`);
}

/** Parse JSON tolerantly: strip fences, find the first balanced object. */
function parseJSONLoose(content: string): Record<string, unknown> | null {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
