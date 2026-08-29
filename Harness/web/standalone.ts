/**
 * Standalone entry point for Bun-compiled desktop builds.
 *
 * This file is compiled into a single self-contained executable via
 * `bun build --compile`. When run, it:
 *   1. Starts the LightningLoop web server on port 7777.
 *   2. Opens the user's default browser to the app.
 *   3. Prints the URL. The user pastes their own API key in Settings.
 *
 * No Node runtime required — the executable bundles everything.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { LoopEngine } from "../core/loop-engine.js";
import type { AgentAdapter, Clarification, LoopRunResult } from "../core/loop-types.js";
import { AnthropicAdapter, resolveConfig } from "./anthropic-adapter.js";
import { classifyGoal, clarifySubjective, answerSubjective, reviewHonesty, subjectiveResult, type SearchConfig } from "./strokes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_STATIC = resolve(HERE, "..", "..", "Harness", "web");
const STATIC_ROOT = existsSync(resolve(HERE, "index.html")) ? HERE : SOURCE_STATIC;
const PORT = Number(process.env.PORT ?? 7777);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(req: any, res: any): Promise<void> {
  let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const target = resolve(STATIC_ROOT, "." + p);
  if (!target.startsWith(STATIC_ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("Not found"); }
}

function send(ws: WebSocket, payload: unknown) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)); }

interface RunState { goal: string; classification: "subjective" | "factual"; clarification: Clarification; controller: AbortController; adapter: AgentAdapter; search?: SearchConfig; lastAnswer?: string; }

async function handleConnection(ws: WebSocket) {
  const runs = new Map<string, RunState>();
  ws.on("message", async (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { send(ws, { type: "error", message: "Invalid JSON." }); return; }

    if (msg.type === "start") {
      const goal = (msg.goal ?? "").trim();
      if (!goal) { send(ws, { type: "error", message: "Empty goal." }); return; }
      let config;
      try { config = resolveConfig({ ...(msg.baseURL ? { baseURL: msg.baseURL } : {}), ...(msg.model ? { model: msg.model } : {}), ...(msg.key ? { apiKey: msg.key } : {}), ...(msg.searchProvider ? { searchProvider: msg.searchProvider } : {}), ...(msg.searchKey ? { searchKey: msg.searchKey } : {}) }); }
      catch (e: any) { send(ws, { type: "error", message: e.message }); return; }
      const adapter = new AnthropicAdapter(config.adapter);
      const controller = new AbortController();
      const runID = crypto.randomUUID();
      try {
        send(ws, { type: "stage", runID, stage: "clarifying", message: "Classifying the question." });
        const result = await classifyGoal(adapter, goal, controller.signal);
        send(ws, { type: "classified", runID, classification: result.classification, reason: result.reason, ...(result.reframe ? { reframe: result.reframe } : {}) });
        if (result.classification === "harmful") {
          send(ws, { type: "result", runID, result: { completed: false, stage: "paused", message: "Refused.", planning: { criteria: [], plan: [], risks: [], acceptanceTest: "" }, implementation: { deliverable: `I won't help with that. ${result.reason}`, notes: [], files: [], verificationCommands: [] }, reviews: [], evidence: [], usage: { input: 0, output: 0, total: 0, cost: 0 } } });
          return;
        }
        const clarification = result.classification === "subjective" ? await clarifySubjective(adapter, goal, controller.signal) : await new LoopEngine(adapter).clarify(goal, controller.signal);
        runs.set(runID, { goal, classification: result.classification, clarification, controller, adapter, ...(config.search ? { search: config.search } : {}) });
        send(ws, { type: "clarify", runID, classification: result.classification, clarification, mode: msg.mode || "open_ended" });
      } catch (e: any) { send(ws, { type: "error", message: e.message }); }
      return;
    }

    if (msg.type === "answers") {
      const entry = runs.entries().next();
      if (entry.done) { send(ws, { type: "error", message: "No active run." }); return; }
      const [runID, state] = entry.value;
      const { goal, classification, clarification, controller, adapter, search } = state;
      runs.delete(runID);
      try {
        if (classification === "subjective") {
          send(ws, { type: "stage", runID, stage: "implementing", message: "Composing your answer." });
          const reply = await answerSubjective(adapter, goal, clarification, msg.answers, search, controller.signal);
          let review;
          try { send(ws, { type: "stage", runID, stage: "reviewing_implementation", message: "Honesty check." }); review = await reviewHonesty(adapter, goal, reply.content, controller.signal); }
          catch { review = { addressed: true, judgmentNotes: "Skipped.", uncertainty: "", namedEntities: "", fabricationRisk: "low" as const }; }
          state.lastAnswer = reply.content;
          send(ws, { type: "result", runID, result: subjectiveResult(reply.content, review, reply.usage) });
        } else {
          send(ws, { type: "stage", runID, stage: "planning", message: "Building a proof-bearing plan." });
          const engine = new LoopEngine(adapter);
          const result = await engine.execute(goal, clarification, msg.answers, 4, (event) => send(ws, { type: "stage", runID, stage: event.stage, message: event.message, ...(event.round !== undefined ? { round: event.round } : {}), ...(event.role ? { role: event.role } : {}) }), controller.signal);
          send(ws, { type: "result", runID, result });
        }
      } catch (e: any) { send(ws, { type: "error", message: e.message }); }
      return;
    }
    if (msg.type === "cancel") { const e = runs.entries().next(); if (!e.done) e.value[1].controller.abort(); return; }
  });
}

const server = createServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/run" });
wss.on("connection", handleConnection);

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  ⚡ LightningLoop\n  → ${url}\n\n  Paste your API key in Settings. Press Ctrl+C to stop.\n`);
  // Open the browser automatically.
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
});
