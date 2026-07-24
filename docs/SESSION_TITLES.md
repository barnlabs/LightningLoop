# Session titles

LightningLoop keeps loop titles short for the sidebar. Titles are **not** Gold evidence.

## Layers

| Layer | When | Mechanism |
|-------|------|-----------|
| Provisional | Goal edit (unlocked) | Offline heuristic: strip common prefixes, first sentence / ≤8 words, cap 56 chars |
| Structured | After clarification summary or plan/criteria arrive | Prefer first plan step title, else criterion title, else summary/goal heuristic |
| LLM (optional) | Same moments, Settings toggle on | Tiny completion via custom-provider `ProviderClient` only; JSON `{"title":"..."}`; fail soft; **generation token** drops stale completions |
| Manual | User rename | Locks auto updates until **Unlock auto-title**; invalidates in-flight LLM titles |

Summary-only titles use source **structured** (not provisional) so later goal edits do not clobber them.

## Settings

- **LLM short titles (custom providers only)** — `UserDefaults` key `autoTitleLLMEnabled` (default off).
- Built-in/Pi-managed providers never receive a native title completion (credentials stay in the runtime). They still get provisional + structured titles.

## Persistence

`LoopSession` stores `title`, `titleSource` (`provisional|structured|llm|manual`), and `titleLocked`. Older archives without the new fields decode as provisional / unlocked.
