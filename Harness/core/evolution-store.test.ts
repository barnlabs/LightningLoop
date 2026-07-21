import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyActiveSystemPromptAddenda, loadActiveGuidance, loadActiveSystemPromptAddenda } from "./evolution-store.js";

test("only bounded active system-prompt evolutions enter agent prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-evolution-"));
  const path = join(root, "evolutions.json");
  writeFileSync(path, JSON.stringify([
    { kind: "system_prompt", state: "draft", exactDiff: "draft instruction" },
    { kind: "skill", state: "active", exactDiff: "skill guidance" },
    { kind: "system_prompt", state: "active", exactDiff: "Prefer concise primary-source citations.", activatedAt: "2026-07-19T00:00:00Z" },
  ]));
  assert.deepEqual(loadActiveSystemPromptAddenda(path), ["Prefer concise primary-source citations."]);
  const evolved = applyActiveSystemPromptAddenda("BASE POLICY", path);
  assert.match(evolved, /BASE POLICY/);
  assert.match(evolved, /REVIEWED ACTIVE SYSTEM-PROMPT ADDENDUM/);
  assert.match(evolved, /REVIEWED ACTIVE SKILL GUIDANCE/);
  assert.match(evolved, /skill guidance/);
  assert.doesNotMatch(evolved, /draft instruction/);
  assert.equal(loadActiveGuidance(path).length, 2);
});

test("malformed and secret-bearing active evolutions fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-evolution-"));
  const malformed = join(root, "malformed.json");
  writeFileSync(malformed, "not json");
  assert.throws(() => loadActiveSystemPromptAddenda(malformed), /failed closed/);
  const secret = join(root, "secret.json");
  writeFileSync(secret, JSON.stringify([{ kind: "system_prompt", state: "active", exactDiff: "Bearer synthetic-secret-value-123456" }]));
  assert.throws(() => loadActiveSystemPromptAddenda(secret), /Secret-like/);
});
