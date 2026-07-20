import assert from "node:assert/strict";
import test from "node:test";
import { decideGold } from "./gold.js";
import type { GoldInput } from "./schema.js";

function passingInput(): GoldInput {
  return {
    criteria: [{ id: "C1", title: "Build", detail: "Build it", evidence: "Passing build", evidenceKind: "build", evidenceTarget: "build:test" }],
    evidence: [
      {
        criterionID: "C1",
        kind: "build",
        summary: "Build passed",
        verifier: "xcodebuild",
        passed: true,
        capturedAt: "2026-07-19T00:00:00Z",
      },
    ],
    review: {
      target: "implementation",
      round: 1,
      score: 9,
      verdict: "pass",
      summary: "Accepted",
      findings: [],
      requiredChanges: [],
    },
    verificationComplete: true,
    capabilityAmbiguities: [],
  };
}

test("Gold passes only when every deterministic gate passes", () => {
  assert.deepEqual(decideGold(passingInput()), { passed: true, reasons: [] });
});

test("reviewer pass cannot override missing evidence or a blocking finding", () => {
  const input = passingInput();
  input.evidence = [];
  input.review.findings = [
    {
      id: "F1",
      severity: "blocking",
      title: "Missing proof",
      issue: "No executable proof",
      requiredChange: "Run the verifier",
    },
  ];
  const decision = decideGold(input);
  assert.equal(decision.passed, false);
  assert.equal(decision.reasons.length, 2);
});

test("Gold rejects an unresolved medium finding as material", () => {
  const input = passingInput();
  input.review.findings = [
    {
      id: "F1",
      severity: "medium",
      title: "Incomplete failure proof",
      issue: "The unhappy path was not exercised.",
      requiredChange: "Run and capture the failure-path check.",
    },
  ];
  const decision = decideGold(input);
  assert.equal(decision.passed, false);
  assert.match(decision.reasons.join(" "), /medium/i);
});
