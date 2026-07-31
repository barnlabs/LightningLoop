import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { LoopEngine } from "../core/loop-engine.js";
import type { AgentAdapter, Clarification, LoopRunResult } from "../core/loop-types.js";
import { AnthropicAdapter, resolveAdapterOptions, type AnthropicAdapterOptions } from "./anthropic-adapter.js";

/**
 * LightningLoop web POC server.
 *
 * One process serves:
 *   - HTTP static files (the UI) from this directory.
 *   - A WebSocket at `/run` that drives one LoopEngine run per connection.
 *
 * Wire protocol (JSON over WS), client -> server:
 *   { type: "start", goal: string, key?: string, baseURL?: string, model?: string }
 *   { type: "answers", answers: Record<string, string> }
 *   { type: "cancel" }
 *
 * server -> client:
 *   { type: "clarify", clarification: Clarification }
 *   { type: "stage", stage, message, round?, role? }   // streamed during execute
 *   { type: "result", result: LoopRunResult }
 *   { type: "error", message: string }
 *
 * Localhost only. No auth. Proof of concept.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// Static UI assets (html/css/js) live in the source tree, not in dist/. When
// running the compiled server (dist/web/server.js), resolve back up to the
// source Harness/web/ directory to serve them.
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
  // Block path traversal: only serve files directly in the web dir.
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
type ClientMessage = StartMessage | AnswersMessage | CancelMessage;

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/**
 * Build adapter options. Bring-your-own from the client takes priority,
 * otherwise fall back to the resolved default (ZAI local config / env).
 */
function adapterOptionsFor(msg: StartMessage): AnthropicAdapterOptions {
  return resolveAdapterOptions({
    ...(msg.baseURL ? { baseURL: msg.baseURL } : {}),
    ...(msg.model ? { model: msg.model } : {}),
    ...(msg.key ? { apiKey: msg.key } : {}),
  });
}

interface RunState {
  goal: string;
  clarification: Clarification;
  controller: AbortController;
  adapter: AgentAdapter;
}

/**
 * Generate 2-4 multiple-choice options for each clarifying question by asking
 * the model. The model returns JSON; a fallback ensures the client always gets
 * something renderable. Used only when mode === "multiple_choice".
 */
async function generateMCOptions(
  adapter: AgentAdapter,
  goal: string,
  clarification: Clarification,
  signal: AbortSignal,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const q of clarification.questions) {
    const request = {
      role: "orchestrator" as const,
      system: "You write concise multiple-choice answer options. Return ONLY a JSON object: {\"options\":[\"short option\",\"...\"]} with 2 to 4 options. One option should be the most useful answer. Keep each option under 12 words. Do not number them.",
      user: `Goal: ${goal}\nQuestion: ${q.question}\nWhy it matters: ${q.whyItMatters}\n\nReturn 2-4 distinct short answer options as JSON.`,
      temperature: 0.6,
      maxTokens: 400,
    };
    try {
      const reply = await adapter.complete(request, signal);
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

    if (msg.type === "start") {
      const goal = (msg.goal ?? "").trim();
      if (!goal) {
        send(ws, { type: "error", message: "Send a non-empty goal." });
        return;
      }
      let options: AnthropicAdapterOptions;
      try {
        options = adapterOptionsFor(msg);
      } catch (err) {
        send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        return;
      }
      const runID = crypto.randomUUID();
      const controller = new AbortController();
      try {
        const adapter = new AnthropicAdapter(options);
        const engine = new LoopEngine(adapter);
        const clarification = await engine.clarify(goal, controller.signal);
        runs.set(runID, { goal, clarification, controller, adapter });

        // Multiple-choice mode: generate options per question and decorate.
        if (msg.mode === "multiple_choice") {
          const optionsByQuestion = await generateMCOptions(adapter, goal, clarification, controller.signal);
          send(ws, { type: "clarify", runID, clarification, mode: "multiple_choice", optionsByQuestion });
        } else {
          send(ws, { type: "clarify", runID, clarification, mode: "open_ended" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(ws, { type: "error", message });
      }
      return;
    }

    if (msg.type === "answers") {
      // Single-run POC: take the first active run.
      const entry = runs.entries().next();
      if (entry.done) {
        send(ws, { type: "error", message: "No active run to continue." });
        return;
      }
      const [runID, state] = entry.value;
      const { goal, clarification, controller, adapter } = state;

      /**
       * The engine is intentionally strict about model output (valid evidence
       * kinds, exact canonical strings, valid JSON). GLM models occasionally
       * slip these contracts — the engine is correct to reject that, but a
       * single slip shouldn't kill a whole run. Retry up to 3 times on
       * contract errors. This is server-boundary tolerance only; the engine's
       * own validation is untouched.
       */
      const MAX_ATTEMPTS = 3;
      let attempt = 0;
      let result: LoopRunResult | null = null;
      let lastError = "";
      while (attempt < MAX_ATTEMPTS && !result) {
        attempt++;
        const engine = new LoopEngine(adapter);
        try {
          result = await engine.execute(
            goal,
            clarification,
            msg.answers,
            4, // maxReviewCycles — POC default
            (event) => {
              send(ws, {
                type: "stage",
                runID,
                stage: event.stage,
                message: event.message,
                ...(event.round !== undefined ? { round: event.round } : {}),
                ...(event.role ? { role: event.role } : {}),
                ...(attempt > 1 ? { attempt } : {}),
              });
            },
            controller.signal,
          );
        } catch (err) {
          if (controller.signal.aborted) {
            send(ws, { type: "error", message: "Run cancelled." });
            runs.delete(runID);
            return;
          }
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_ATTEMPTS) {
            send(ws, { type: "stage", runID, stage: "draft", message: `Model slipped the contract — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS}).` });
          }
        }
      }

      if (result) {
        send(ws, { type: "result", runID, result });
      } else {
        send(ws, { type: "error", message: `The loop could not complete after ${MAX_ATTEMPTS} attempts: ${lastError}` });
      }
      runs.delete(runID);
      return;
    }

    if (msg.type === "cancel") {
      const entry = runs.entries().next();
      if (!entry.done) entry.value[1].controller.abort();
      return;
    }

    send(ws, { type: "error", message: `Unknown message type: ${(msg as { type?: string }).type}` });
  });

  ws.on("error", () => { /* swallow; per-socket errors must not crash the server */ });
}

function main(): void {
  const server = createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: "/run" });
  wss.on("connection", handleConnection);

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`\n  ⚡ LightningLoop web POC`);
    console.log(`  → ${url}\n`);
    console.log(`  Provider default: ZAI (GLM). Clients may bring their own key.`);
    console.log(`  Press Ctrl+C to stop.\n`);
  });
}

main();
