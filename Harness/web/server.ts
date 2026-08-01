import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { LoopEngine } from "../core/loop-engine.js";
import type { AgentAdapter, Clarification, LoopRunResult } from "../core/loop-types.js";
import { AnthropicAdapter, resolveAdapterOptions, type AnthropicAdapterOptions } from "./anthropic-adapter.js";
import { classifyGoal, answerSubjective, reviewHonesty, subjectiveResult } from "./strokes.js";

/**
 * LightningLoop web server — the 4-stroke orchestrator.
 *
 * INTAKE (classify) → COMPRESSION (clarify) → COMBUSTION (answer) → EXHAUST (review)
 *
 * Harmful goals are hard-blocked at intake. Subjective goals are answered in
 * the user's terms. Factual goals run Donovan's strict Gold engine.
 *
 * Wire protocol (JSON over WS at /run):
 *   client → server: { type:"start", goal, mode?, key?, baseURL?, model? }
 *                 { type:"answers", answers }
 *                 { type:"cancel" }
 *   server → client: { type:"classified", classification, reason, reframe? }
 *                 { type:"clarify", clarification, mode, optionsByQuestion? }
 *                 { type:"stage", stage, message, round?, role? }
 *                 { type:"result", result }
 *                 { type:"error", message }
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = resolve(HERE, "..", "..", "Harness", "web");
const PORT = Number(process.env.PORT ?? 7777);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  if (urlPath === "/") urlPath = "/index.html";
  const target = resolve(STATIC_ROOT, "." + urlPath);
  if (!target.startsWith(STATIC_ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}

interface StartMessage {
  type: "start";
  goal: string;
  key?: string;
  baseURL?: string;
  model?: string;
  mode?: "open_ended" | "multiple_choice";
}
interface AnswersMessage {
  type: "answers";
  answers: Record<string, string>;
}
interface CancelMessage {
  type: "cancel";
}
interface FollowupMessage {
  type: "followup";
  question: string;
  rating?: string;
}
type ClientMessage = StartMessage | AnswersMessage | CancelMessage | FollowupMessage;

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function adapterOptionsFor(msg: StartMessage): AnthropicAdapterOptions {
  return resolveAdapterOptions({
    ...(msg.baseURL ? { baseURL: msg.baseURL } : {}),
    ...(msg.model ? { model: msg.model } : {}),
    ...(msg.key ? { apiKey: msg.key } : {}),
  });
}

interface RunState {
  goal: string;
  classification: "subjective" | "factual";
  clarification: Clarification;
  controller: AbortController;
  adapter: AgentAdapter;
  lastAnswer?: string;
}

/** Generate 2-4 multiple-choice options per clarifying question. */
async function generateMCOptions(
  adapter: AgentAdapter,
  goal: string,
  clarification: Clarification,
  signal: AbortSignal,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const q of clarification.questions) {
    try {
      const reply = await adapter.complete({
        role: "orchestrator",
        system: 'You write concise multiple-choice answer options. Return ONLY {"options":["short option","..."]} with 2 to 4 options. Keep each option under 12 words.',
        user: `Goal: ${goal}\nQuestion: ${q.question}\nWhy it matters: ${q.whyItMatters}\n\nReturn 2-4 distinct short answer options.`,
        temperature: 0.6,
        maxTokens: 400,
      }, signal);
      const match = reply.content.match(/\{[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : null;
      const opts = Array.isArray(parsed?.options) ? parsed.options.filter((o: unknown) => typeof o === "string").slice(0, 4) : [];
      out[q.id] = opts.length >= 2 ? opts : ["(brief answer)", "(detailed answer)"];
    } catch {
      out[q.id] = ["(brief answer)", "(detailed answer)"];
    }
  }
  return out;
}

async function handleConnection(ws: WebSocket): Promise<void> {
  const runs = new Map<string, RunState>();

  ws.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(ws, { type: "error", message: "Invalid JSON message." });
      return;
    }

    // ── START: INTAKE (classify) + COMPRESSION (clarify) ─────────────────
    if (msg.type === "start") {
      const goal = (msg.goal ?? "").trim();
      if (!goal) { send(ws, { type: "error", message: "Send a non-empty goal." }); return; }
      let options: AnthropicAdapterOptions;
      try { options = adapterOptionsFor(msg); }
      catch (err) { send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) }); return; }

      const adapter = new AnthropicAdapter(options);
      const controller = new AbortController();
      const runID = crypto.randomUUID();

      try {
        // INTAKE — classify. Harmful → hard block, never proceeds.
        send(ws, { type: "stage", runID, stage: "clarifying", message: "Classifying the question." });
        const result = await classifyGoal(adapter, goal, controller.signal);
        send(ws, { type: "classified", runID, classification: result.classification, reason: result.reason, ...(result.reframe ? { reframe: result.reframe } : {}) });

        if (result.classification === "harmful") {
          const refusal = result.reframe
            ? `I won't help with that. ${result.reason} ${result.reframe}`
            : `I won't help with that. ${result.reason}`;
          send(ws, { type: "result", runID, result: refusalResult(refusal) });
          return;
        }

        // COMPRESSION — clarifying questions (both paths use the engine's clarifier).
        const engine = new LoopEngine(adapter);
        const clarification = await engine.clarify(goal, controller.signal);
        runs.set(runID, { goal, classification: result.classification, clarification, controller, adapter });

        if (msg.mode === "multiple_choice") {
          const optionsByQuestion = await generateMCOptions(adapter, goal, clarification, controller.signal);
          send(ws, { type: "clarify", runID, classification: result.classification, clarification, mode: "multiple_choice", optionsByQuestion });
        } else {
          send(ws, { type: "clarify", runID, classification: result.classification, clarification, mode: "open_ended" });
        }
      } catch (err) {
        send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── ANSWERS: COMBUSTION (answer) + EXHAUST (review) ──────────────────
    if (msg.type === "answers") {
      const entry = runs.entries().next();
      if (entry.done) { send(ws, { type: "error", message: "No active run to continue." }); return; }
      const [runID, state] = entry.value;
      const { goal, classification, clarification, controller, adapter } = state;

      try {
        if (classification === "subjective") {
          // Subjective path: answer in the user's terms, then honest review.
          send(ws, { type: "stage", runID, stage: "implementing", message: "Composing a direct answer in your terms." });
          const reply = await answerSubjective(adapter, goal, clarification, msg.answers, controller.signal);
          let review;
          try {
            send(ws, { type: "stage", runID, stage: "reviewing_implementation", message: "Honesty review: checking the answer addresses your question." });
            review = await reviewHonesty(adapter, goal, reply.content, controller.signal);
          } catch {
            review = { addressed: true, judgmentNotes: "Honesty review skipped (transient error).", uncertainty: "" };
          }
          state.lastAnswer = reply.content;
          send(ws, { type: "result", runID, result: subjectiveResult(reply.content, review, reply.usage) });
        } else {
          // Factual path: Donovan's strict Gold engine, with targeted-retry valve.
          send(ws, { type: "stage", runID, stage: "planning", message: "Building a proof-bearing plan." });
          const result = await runGoldLoop(adapter, goal, clarification, msg.answers, runID, ws, controller);
          state.lastAnswer = result.implementation?.deliverable;
          send(ws, { type: "result", runID, result });
        }
      } catch (err) {
        if (controller.signal.aborted) { send(ws, { type: "error", message: "Run cancelled." }); return; }
        send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── FOLLOWUP: refine the previous answer with a new question ─────────
    if (msg.type === "followup") {
      const entry = runs.entries().next();
      if (entry.done) { send(ws, { type: "error", message: "No active run to follow up." }); return; }
      const [runID, state] = entry.value;
      const { goal, adapter, controller, lastAnswer } = state;
      try {
        send(ws, { type: "stage", runID, stage: "implementing", message: "Refining the answer with your follow-up." });
        const reply = await adapter.complete({
          role: "orchestrator",
          system: [
            "You are refining a previous answer based on the user's follow-up question or feedback.",
            "Be factual and truthful. Do not invent facts, sources, or numbers.",
            "Use the previous answer as context. Address the follow-up directly.",
            "Keep it useful and focused.",
          ].join(" "),
          user: `Original question: ${goal}\n\nPrevious answer:\n${lastAnswer ?? "(none)"}\n\nUser follow-up: ${msg.question}\n\nProvide a refined answer that incorporates this feedback.`,
          temperature: 0.4,
          maxTokens: 1500,
        }, controller.signal);
        state.lastAnswer = reply.content;
        const review = { addressed: true, judgmentNotes: "Refined answer.", uncertainty: "" };
        send(ws, { type: "result", runID, result: subjectiveResult(reply.content, review, reply.usage) });
      } catch (err) {
        if (controller.signal.aborted) { send(ws, { type: "error", message: "Run cancelled." }); return; }
        send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (msg.type === "cancel") {
      const entry = runs.entries().next();
      if (!entry.done) entry.value[1].controller.abort();
      return;
    }

    send(ws, { type: "error", message: `Unknown message type: ${(msg as { type?: string }).type}` });
  });

  ws.on("error", () => { /* swallow */ });
}

/** Factual path: run the strict Gold engine with a targeted-retry valve. */
async function runGoldLoop(
  adapter: AgentAdapter,
  goal: string,
  clarification: Clarification,
  answers: Record<string, string>,
  runID: string,
  ws: WebSocket,
  controller: AbortController,
): Promise<LoopRunResult> {
  const MAX_ATTEMPTS = 3;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const engine = new LoopEngine(adapter);
    try {
      return await engine.execute(goal, clarification, answers, 4, (event) => {
        send(ws, {
          type: "stage", runID, stage: event.stage, message: event.message,
          ...(event.round !== undefined ? { round: event.round } : {}),
          ...(event.role ? { role: event.role } : {}),
          ...(attempt > 1 ? { attempt } : {}),
        });
      }, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        send(ws, { type: "stage", runID, stage: "draft", message: `Model slipped the contract — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS}). ${lastError}` });
      }
    }
  }
  throw new Error(`The loop could not complete after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

function refusalResult(message: string): LoopRunResult {
  return {
    completed: false,
    stage: "paused",
    message: "Refused: harmful premise.",
    planning: { criteria: [], plan: [], risks: [], acceptanceTest: "" },
    implementation: { deliverable: message, notes: ["This question was blocked at intake."], files: [], verificationCommands: [] },
    reviews: [],
    evidence: [],
    usage: { input: 0, output: 0, total: 0, cost: 0 },
  };
}

function main(): void {
  const server = createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: "/run" });
  wss.on("connection", handleConnection);
  server.listen(PORT, HOST, () => {
    console.log(`\n  ⚡ LightningLoop (4-stroke)`);
    console.log(`  → http://${HOST}:${PORT}\n`);
    console.log(`  Each person configures their own provider (see Harness/web/provider-sheet.example.json).`);
    console.log(`  Press Ctrl+C to stop.\n`);
  });
}

main();
