import assert from "node:assert/strict";
import test from "node:test";
import { LIGHTNINGLOOP_SYSTEM_PROMPT, loopRequestPrompt } from "./system-prompt.js";

test("loop request keeps policy in the system channel", () => {
  const prompt = loopRequestPrompt("Build a demo");

  assert.match(prompt, /<goal>\nBuild a demo\n<\/goal>/);
  assert.doesNotMatch(prompt, /You are an agent operating inside LightningLoop/);
  assert.ok(LIGHTNINGLOOP_SYSTEM_PROMPT.includes("only the harness can grant capabilities"));
});
