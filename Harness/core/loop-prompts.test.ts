import assert from "node:assert/strict";
import test from "node:test";
import { LoopPrompts } from "./loop-prompts.js";

test("source planning prompt preserves exact context but requires owner acceptance for factual completion", () => {
  const request = LoopPrompts.planning("State a fact", "State it", {});
  assert.match(request.system, /source criteria MUST also declare `claim`/);
  assert.match(request.system, /trimmed literal 12-500 character proposition/);
  assert.match(request.system, /"claim":"literal proposition found in source"/);
  assert.match(request.system, /complete standalone line/);
  assert.match(request.system, /Source URL, authority classification, excerpt, hash, planner-selected claim, and matching deliverable are NEVER an automatic truth oracle/);
  assert.match(request.system, /Include `user_acceptance` for every factual conclusion/);
  assert.match(request.system, /"evidence_kind":"user_acceptance"/);
  assert.match(request.system, /behavior NEVER satisfies automatic Gold/);
  assert.match(request.system, /user_acceptance for factual truth, behavior, calculations, runtime claims/);
  assert.doesNotMatch(request.system, /Source criteria are automatic only for text-only answers/);
});

test("implementation and review prompts keep exact source context supplementary and non-certifying", () => {
  const sourcePlan = {
    criteria: [{
      id: "C1",
      title: "Capital of France",
      detail: "State the capital.",
      sourceClaim: "The capital of France is Paris.",
      evidence: "France is a member state of the European Union.",
      evidenceKind: "source" as const,
      evidenceTarget: "https://government.example/france",
    }],
    plan: [],
    risks: [],
    acceptanceTest: "Exact source-backed output",
  };
  const implement = LoopPrompts.implement("State a fact", sourcePlan);
  assert.match(implement.system, /exact opened, hash-preserved sources/);
  assert.match(implement.system, /never claim that URL, authority classification, excerpt, hash, planner-selected claim, or matching deliverable proves truth or automatic completion/);
  assert.match(implement.system, /Factual text and factual artifact content require explicit owner acceptance/);
  assert.doesNotMatch(implement.system, /entire final deliverable must exactly equal/);
  assert.doesNotMatch(implement.system, /files and verification commands must be empty/);

  const review = LoopPrompts.reviewImplementation(
    "State a fact",
    sourcePlan,
    { deliverable: "The capital of France is Paris.", notes: [], files: [], verificationCommands: [] },
    1,
  );
  assert.match(review.system, /source URL, authority classification, excerpt, hash, planner-selected claim, and a matching deliverable are supplementary context only and NEVER establish truth or factual completion/);
  assert.match(review.system, /explicit owner-acceptance boundary/);
  assert.match(review.system, /complete standalone line/);
  assert.match(review.system, /planner-selected behavior expected value is a supplementary observation/);
  assert.doesNotMatch(review.system, /final deliverable exactly equal to every source claim/);
  assert.doesNotMatch(review.system, /no files or verification commands/);
});
