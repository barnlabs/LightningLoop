# LightningLoop Web — 4-Stroke Redesign

## The idea
"Watch a prompt become a sophisticated answer." A tool that takes any question
and turns it into a real, useful answer — in the user's terms, truth-based, and
honest about what it doesn't know.

## Why the POC wasn't enough
The original POC ran every question through Donovan's strict `LoopEngine`,
which demands machine-verifiable HTTPS sources for every claim. That's the right
bar for factual research — and the wrong bar for subjective questions like
"where's the best coffee." The result: a useful-sounding tool that kept refusing
to answer normal questions ("I can't answer that as posed") and throwing
contract-validation errors when the model couldn't produce real sources for a
preference question.

## The 4-stroke flow
The web layer now owns a 4-stroke flow instead of routing everything through one
rigid engine:

1. **INTAKE (classify)** — one model call sorts each goal into one of:
   - `harmful` → hard block. Never proceeds. Explains why + offers a reframe.
   - `subjective` → answered in the user's terms (preference, taste, judgment).
   - `factual` → strict Gold path (Donovan's engine) for airtight sourced answers.

2. **COMPRESSION (clarify)** — the clarifying questions narrow a vague question
   into something answerable. Both open-ended and multiple-choice modes are
   supported. This is the mechanism that makes subjective questions answerable:
   the user's answers become the parameters of the answer.

3. **COMBUSTION (answer)** —
   - Subjective: one grounded model call. Answers helpfully in the user's terms,
     bases reasoning on real facts, labels judgment honestly, never invents.
   - Factual: the unchanged `LoopEngine.execute()` runs the full Gold loop.

4. **EXHAUST (review)** — a light honesty pass over subjective answers: did it
   actually address the question? What's judgment vs. fact? What's uncertain?

## Error handling (the "valves")
Every model call goes through a targeted retry (`callWithRetry` in `strokes.ts`):
on failure, the specific error feeds back so the model corrects the real
problem, instead of blind re-rolls. The adapter's JSON-extraction and
key-normalization remain as defense-in-depth.

## Provider configuration (per-person, provider-neutral)
There are **no built-in provider defaults**. Each person configures their own:

1. Copy `Harness/web/provider-sheet.example.json` to `provider-sheet.json` in
   the repo root.
2. Fill in `baseURL`, `apiKey`, and `model` for your provider.
3. `provider-sheet.json` is gitignored — your key never gets committed.

Alternatively, set `LL_API_KEY`, `LL_BASE_URL`, and `LL_MODEL` env vars.

## Files
- `strokes.ts` — the 4-stroke logic (`classifyGoal`, `answerSubjective`,
  `reviewHonesty`, `subjectiveResult`, `callWithRetry`).
- `server.ts` — the WebSocket orchestrator wiring the strokes together.
- `anthropic-adapter.ts` — provider-neutral `AgentAdapter` (Anthropic Messages
  API) with JSON-extraction and key-normalization tolerance.
- `provider-sheet.example.json` — the per-person config template.
- `index.html`, `client.js`, `styles.css` — the UI.

## What this does NOT change
Donovan's engine, CLI, and native app are untouched. The strict Gold path is
used as-is for factual questions. This is purely additive web-layer work.
