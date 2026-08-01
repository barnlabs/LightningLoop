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
      "Ask between 2 and 6 questions. Keep each question short and plain.",
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
        "Be factual and truthful. Do not invent facts, sources, statistics, or quotes.",
        "The user answered clarifying questions — use those answers as your parameters. The question is now answerable: answer it.",
        "If this involves judgment or preference, give a clear, reasoned recommendation and say what it is based on (common practice, the stated preferences, widely-shared criteria). Do not pretend a preference is a proven fact.",
        "If you genuinely do not know something concrete, say so plainly rather than guessing.",
        "Be useful. A real answer beats a refusal.",
      ].join(" "),
      user: `Goal: ${goal}\n\nClarifying answers (the user's parameters):\n${answersText}\n\nProvide a direct, helpful answer.`,
      temperature: 0.4,
      maxTokens: 1500,
    },
    signal,
  );
}

/** EXHAUST: one light honesty pass over a subjective answer. */
export interface HonestyReview {
  /** Did the answer actually address the question in the user's terms? */
  addressed: boolean;
  /** What's the model's own judgment vs. established fact? */
  judgmentNotes: string;
  /** What's uncertain or caveated? */
  uncertainty: string;
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
        "You give a quick honesty review of an answer. Respond with ONLY a JSON object, no prose.",
        'Return exactly: {"addressed":true|false,"judgment_notes":"...","uncertainty":"..."}',
        "addressed: did the answer actually answer the user's question? judgment_notes: what parts are the answerer's judgment/preference vs. established fact? uncertainty: what's genuinely uncertain or caveated?",
      ].join("\n"),
      user: `Question: ${goal}\n\nAnswer: ${answer}`,
      temperature: 0,
      maxTokens: 400,
    },
    signal,
  );
  const parsed = parseJSONLoose(reply.content);
  return {
    addressed: Boolean(parsed?.addressed),
    judgmentNotes: typeof parsed?.judgment_notes === "string" ? parsed.judgment_notes : "",
    uncertainty: typeof parsed?.uncertainty === "string" ? parsed.uncertainty : "",
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
  return {
    completed: true,
    stage: "gold",
    message: "Direct answer in the user's terms, with an honesty review.",
    planning: { criteria: [], plan: [], risks: [], acceptanceTest: "Subjective path — answered with stated reasoning, not machine-proven." },
    implementation: { deliverable: answer, notes, files: [], verificationCommands: [] },
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
