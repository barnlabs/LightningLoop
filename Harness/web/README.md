# LightningLoop Web UI — Proof of Concept

A browser UI that runs the real LightningLoop engine. Type a goal, answer the
clarifying questions, and watch the loop run live:
**Clarify → Plan → Review → Implement → Review → Gold.**

This is a **proof of concept** — localhost only, no auth, no production hardening.
It is intentionally additive and does not modify the engine, the CLI, or the
native app.

## Run it

```bash
# from the repo root
npm install
npm run build:harness
npm run web
```

Then open <http://localhost:7777>.

The server uses the built-in **ZAI (GLM)** provider by default — it works out of
the box with a local gitignored `.zai-local.json` or the `LL_API_KEY` env var.
Anyone else can bring their own provider from the UI's "Bring your own provider"
panel.

## Environment variables

| Variable      | Default                          | Purpose                                  |
| ------------- | -------------------------------- | ---------------------------------------- |
| `LL_API_KEY`  | (from `.zai-local.json`)         | API key for the default provider         |
| `LL_BASE_URL` | `https://api.z.ai/api/anthropic` | Anthropic-format base URL                |
| `LL_MODEL`    | `GLM-5.2`                        | Model id                                 |
| `PORT`        | `7777`                           | HTTP port                                |
| `HOST`        | `127.0.0.1`                      | Bind address (localhost only by default) |

## Files

- `anthropic-adapter.ts` — `AgentAdapter` that speaks the Anthropic Messages
  API (the ZAI default protocol). Bring-your-own via constructor / UI.
- `server.ts` — `node:http` static server + a `/run` WebSocket that drives one
  `LoopEngine` run per connection, streaming `LoopEvent`s to the client.
- `index.html`, `client.js`, `styles.css` — the UI. No framework.

## Wire protocol (WebSocket at `/run`)

Client → server:

```jsonc
{ "type": "start", "goal": "...", "key": "...", "baseURL": "...", "model": "..." }
{ "type": "answers", "answers": { "q1": "..." } }
{ "type": "cancel" }
```

Server → client:

```jsonc
{ "type": "clarify", "runID": "...", "clarification": { ... } }
{ "type": "stage", "stage": "planning", "message": "...", "round": 1 }
{ "type": "result", "runID": "...", "result": { ... } }
{ "type": "error", "message": "..." }
```

## What the POC does NOT do

No file writing / artifact execution, no research connector, no memory store,
no auth. The real version comes later.
