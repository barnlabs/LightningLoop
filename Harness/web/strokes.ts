/**
 * The 4-stroke flow: intake (classify) → compression (clarify) → combustion
 * (answer) → exhaust (honest review). These are pure-ish functions that take an
 * AgentAdapter and return structured results. The server wires them to the
 * WebSocket transport; these functions know nothing about sockets.
 *
 * Provider-neutral. No built-in defaults.
 */

import type { AgentAdapter, AgentReply, Clarification, LoopRunResult } from "../core/loop-types.js";

export type GoalClass = "harmful" | "subjective" | "factual";

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
        "You answer a question directly and helpfully, in the user's own terms.",
        "HONESTY IS THE TOP PRIORITY. You must never invent or fabricate.",
        "CRITICAL RULES:",
        "- Do NOT invent specific named entities — business names, restaurant names, product names, place names, people, addresses, phone numbers, URLs, prices, or hours — unless you are genuinely certain they are real. If you are not certain a specific place/thing exists, do not name it.",
        "- It is far better to describe TYPES of places and what to look for than to name a specific establishment that might not exist. For example, instead of inventing 'Try Mario's Bistro on 5th Street', say 'Look for a small family-run trattoria away from the main tourist squares — the kind locals queue at.'",
        "- If you DO name a specific real place you are confident about, flag it: 'I believe this exists, but verify before you go.'",
        "- Do not invent facts, sources, statistics, or quotes.",
        "- The user answered clarifying questions — use those answers as your parameters. Answer the question.",
        "- If this involves judgment or preference, give a clear, reasoned recommendation and say what it is based on. Do not pretend a preference is a proven fact.",
        "- If you genuinely do not know something concrete, say so plainly.",
        "Be useful. A real answer beats a refusal — but a honest answer beats a confident-sounding fabrication. When unsure about specifics, give guidance on how to find the real answer instead of inventing one.",
      ].join("\n"),
      user: `Goal: ${goal}\n\nClarifying answers (the user's parameters):\n${answersText}\n\nProvide a direct, helpful answer. Do not fabricate specific establishments or named entities you cannot verify.`,
      temperature: 0.3,
      maxTokens: 1500,
    },
    signal,
  );
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
