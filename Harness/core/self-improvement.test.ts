import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LoopRunResult } from "./loop-types.js";
import type { ReviewFinding, ReviewRecord, Severity } from "./schema.js";
import { deriveSelfImprovementProposals, recordSelfImprovementProposals } from "./self-improvement.js";
import { advanceManagedEvolution, listManagedEvolutions, proposeManagedEvolution } from "./ledger-management.js";
import { applyActiveSystemPromptAddenda, loadActiveGuidance } from "./evolution-store.js";

function finding(severity: Severity, title: string, requiredChange: string, id = randomUUID()): ReviewFinding {
  return { id, severity, title, issue: `${title} — issue detail`, requiredChange };
}

function review(findings: ReviewFinding[], requiredChanges: string[], verdict: "pass" | "revise" = "revise"): ReviewRecord {
  return { target: "implementation", round: 1, score: verdict === "pass" ? 9 : 4, verdict, summary: "reviewer summary", findings, requiredChanges };
}

function makeResult(reviews: ReviewRecord[], completed = false): LoopRunResult {
  return {
    completed,
    stage: completed ? "gold" : "paused",
    message: completed ? "Gold reached." : "Paused with unresolved findings.",
    planning: { criteria: [], plan: [], risks: [], acceptanceTest: "" },
    implementation: { deliverable: "", notes: [], files: [], verificationCommands: [] },
    reviews,
    evidence: [],
    usage: { input: 0, output: 0, total: 0, cost: 0 },
  };
}

function withLedger(run: (path: string) => void): void {
  const dir = join(tmpdir(), `ll-selfimprove-${randomUUID()}`);
  const path = join(dir, "evolutions.json");
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("deriveSelfImprovementProposals is deterministic and yields one system_prompt + three agent skill drafts", () => {
  const result = makeResult([
    review(
      [finding("high", "Missing verification command", "Add a build verification command"), finding("low", "Nit: wording", "Reword the note")],
      ["Add a passing test that proves the fix"],
    ),
  ]);
  const first = deriveSelfImprovementProposals(result);
  const second = deriveSelfImprovementProposals(result);
  assert.deepEqual(first, second, "identical input must yield identical proposals");
  assert.deepEqual(first.map((p) => p.kind), ["system_prompt", "skill", "skill", "skill"]);
  assert.deepEqual(first.slice(1).map((p) => p.name), [
    "lloop-research improvement from paused run",
    "lloop-engineer improvement from paused run",
    "lloop-verify improvement from paused run",
  ]);
  // The paused outcome and the high-severity theme surface; the low finding is not "material".
  assert.match(first[0]!.exactDiff, /paused LightningLoop run/);
  assert.match(first[0]!.exactDiff, /Missing verification command/);
  assert.doesNotMatch(first[0]!.exactDiff, /Nit: wording/);
  assert.match(first[1]!.exactDiff, /^audience: researcher/u);
  assert.match(first[2]!.exactDiff, /^audience: engineer/u);
  assert.match(first[3]!.exactDiff, /^audience: verifier/u);
  assert.match(first[1]!.exactDiff, /Advisory only/);
});

test("a completed run with no findings still produces a coherent, positive proposal set", () => {
  const proposals = deriveSelfImprovementProposals(makeResult([review([], [], "pass")], true));
  assert.deepEqual(proposals.map((p) => p.kind), ["system_prompt", "skill", "skill", "skill"]);
  assert.match(proposals[0]!.exactDiff, /gold LightningLoop run/);
  assert.match(proposals[0]!.exactDiff, /no material finding/);
  assert.match(proposals[1]!.exactDiff, /Reproduce the deliverable end-to-end/);
});

test("SECURITY: recorded proposals are INERT drafts — never active, never injected into a run", () => {
  withLedger((path) => {
    const result = makeResult([review([finding("blocking", "Unproven claim", "Attach exact command output")], ["Prove it end to end"])]);
    const records = recordSelfImprovementProposals(result, path);

    // Every recorded proposal is a draft with the reviewed-lifecycle defaults.
    assert.equal(records.length, 4);
    for (const record of records) {
      assert.equal(record.state, "draft");
      assert.equal(record.version, "0.1.0-draft");
      assert.equal(record.activatedAt, undefined);
      assert.equal(record.evaluationSuite, "Not yet assigned");
      assert.equal(record.evaluationSummary, undefined);
      assert.equal(record.rollbackTarget, undefined);
      assert.equal(record.reviewerHasMaterialFinding, false);
    }
    assert.deepEqual(records.map((r) => r.kind).sort(), ["skill", "skill", "skill", "system_prompt"]);

    // The ledger holds exactly the four drafts, and NONE are active.
    const stored = listManagedEvolutions(path);
    assert.equal(stored.length, 4);
    assert.equal(stored.filter((r) => r.state === "active").length, 0);

    // The active-guidance loader (the only path that injects into a run) sees nothing,
    // so the system prompt is byte-for-byte unchanged: a draft cannot influence a run.
    assert.deepEqual(loadActiveGuidance(path), []);
    const base = "BASE SYSTEM PROMPT";
    assert.equal(applyActiveSystemPromptAddenda(base, path), base);
  });
});

test("SECURITY: activation gating is unchanged — a recorded draft cannot bypass the sandbox/approval gates", () => {
  withLedger((path) => {
    const [systemPrompt] = recordSelfImprovementProposals(makeResult([review([finding("high", "Gap", "Close the gap")], [])]), path);
    assert.ok(systemPrompt);

    // The reviewed lifecycle still requires each step. draft → source_reviewed is the review
    // step (not activation); advancing further fails closed because the recorder supplied NO
    // sandbox evidence — proving no pre-baked bypass toward "active".
    const reviewed = advanceManagedEvolution(systemPrompt.id, path);
    assert.equal(reviewed.state, "source_reviewed");
    assert.throws(() => advanceManagedEvolution(systemPrompt.id, path), /Sandbox-tested requires a named evaluation suite/);

    // Still nothing active after attempting to push it forward.
    assert.equal(listManagedEvolutions(path).filter((r) => r.state === "active").length, 0);
    assert.deepEqual(loadActiveGuidance(path), []);
  });
});

test("SECURITY: secret-shaped run text is redacted before it reaches the ledger (defense in depth)", () => {
  withLedger((path) => {
    const secret = "api_key=SUPERSECRETVALUE1";
    const records = recordSelfImprovementProposals(
      makeResult([review([finding("high", "Leak risk", `Do not hardcode ${secret}`)], [`Rotate ${secret}`])]),
      path,
    );
    for (const record of records) {
      assert.doesNotMatch(record.exactDiff, /SUPERSECRETVALUE1/);
      assert.match(record.exactDiff, /\[redacted\]/);
    }
    // The ledger's own guard remains the enforcement boundary: an un-redacted secret is rejected.
    assert.throws(
      () => proposeManagedEvolution({ kind: "skill", name: "raw", exactDiff: secret }, path),
      /secret-like content/,
    );
  });
});
