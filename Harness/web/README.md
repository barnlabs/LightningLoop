# LightningLoop Web

A browser UI that runs the LightningLoop 4-stroke flow: type a question, and
watch it become a sophisticated answer. See `REDESIGN.md` for the full design.

## Deploy your own (one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/barnlabs/LightningLoop)

Click the button, sign in to Render, and it reads `render.yaml` from this repo.
You'll be asked to enter your own API keys as secrets (Render stores them
encrypted — they never appear in the repo):

- **`LL_API_KEY`** (required) — your LLM provider's key
- **`LL_BASE_URL`** (required) — e.g. `https://api.z.ai/api/anthropic`
- **`LL_MODEL`** (required) — e.g. `GLM-5.2`
- **`EXA_API_KEY`** / **`BRAVE_SEARCH_API_KEY`** / **`FIRECRAWL_API_KEY`** (optional) — for higher-quality search grounding

Render's free tier works for trying it out. Your instance is private to you.

## Run it locally

```bash
# 1. Configure YOUR provider (provider-neutral — no built-in defaults):
cp Harness/web/provider-sheet.example.json provider-sheet.json
#   then edit provider-sheet.json with your baseURL, apiKey, and model.
#   (provider-sheet.json is gitignored — your key never gets committed.)

# 2. Build and run:
npm install
npm run build:harness
npm run web
```

Open <http://localhost:7777>.

## How it answers

Every question goes through 4 strokes:

1. **Intake** — classified as `harmful`, `subjective`, or `factual`.
   - Harmful → hard-blocked with an explanation.
   - Subjective → answered in your terms (the clarifying questions narrow it).
   - Factual → strict Gold verification path.
2. **Compression** — clarifying questions make the question answerable.
   Open-ended or multiple-choice mode.
3. **Combustion** — the actual answer. Subjective: grounded + honest.
   Factual: airtight sourced Gold.
4. **Exhaust** — honesty review: judgment vs. fact, uncertainty flagged.

## Environment variables (alternative to provider-sheet.json)

| Variable      | Purpose                          |
| ------------- | -------------------------------- |
| `LL_API_KEY`  | API key for your provider        |
| `LL_BASE_URL` | Anthropic-format base URL        |
| `LL_MODEL`    | Model id                         |
| `PORT`        | HTTP port (default 7777)         |
| `HOST`        | Bind address (default 127.0.0.1) |

## Files

- `strokes.ts` — the 4-stroke logic (classify, answer, review).
- `server.ts` — WebSocket orchestrator.
- `anthropic-adapter.ts` — provider-neutral `AgentAdapter` (Anthropic Messages
  API) with tolerance for model output quirks.
- `provider-sheet.example.json` — the per-person config template.
- `index.html`, `client.js`, `styles.css` — the UI.

## Wire protocol (WebSocket at `/run`)

Client → server: `{ type:"start", goal, mode? }`, `{ type:"answers", answers }`, `{ type:"cancel" }`
Server → client: `{ type:"classified", classification, reason }`, `{ type:"clarify", ... }`, `{ type:"stage", ... }`, `{ type:"result", result }`, `{ type:"error", message }`
