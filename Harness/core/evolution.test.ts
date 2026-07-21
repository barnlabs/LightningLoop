import assert from "node:assert/strict";
import test from "node:test";
import { transitionEvolution } from "./evolution.js";
import type { EvolutionRecord } from "./schema.js";

function record(): EvolutionRecord {
  return {
    id: "E1",
    kind: "system_prompt",
    name: "baseline",
    version: "2",
    state: "user_approved",
    source: "user proposal",
    reason: "Improve evidence discipline",
    exactDiff: "+ require evidence",
    permissions: [],
    dependencies: [],
    evaluationSuite: "prompt-holdout-v1",
    evaluationSummary: "12/12 invariants passed",
    reviewerFindings: [],
    rollbackTarget: "baseline@1",
    createdAt: "2026-07-19T00:00:00Z",
  };
}

test("reviewed evolution with rollback can activate", () => {
  assert.equal(transitionEvolution(record(), "active").state, "active");
});

test("evolution cannot skip review or activate without rollback", () => {
  const draft = { ...record(), state: "draft" as const };
  assert.throws(() => transitionEvolution(draft, "active"), /Invalid evolution transition/);
  const { rollbackTarget: _, ...noRollback } = record();
  assert.throws(() => transitionEvolution(noRollback, "active"), /rollback target/);
});
