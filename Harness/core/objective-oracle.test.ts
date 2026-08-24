import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { LoopEngine } from "./loop-engine.js";
import {
  NO_OBJECTIVE_CONTRACT_REASON,
  evaluateObjectiveContract,
  parseObjectiveContract,
  type ObjectiveContract,
} from "./objective-oracle.js";
import type {
  AgentAdapter,
  AgentReply,
  ArtifactExecutionReport,
  ArtifactExecutor,
  ImplementationDraft,
} from "./loop-types.js";

const sha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const APP_CONTENT = "console.log('Done');\n";
const APP_SHA = sha256(APP_CONTENT);

function report(overrides: Partial<ArtifactExecutionReport> = {}): ArtifactExecutionReport {
  return {
    enabled: true,
    passed: true,
    summary: "Artifacts materialized and independently verified.",
    files: [{ path: "app.js", bytes: Buffer.byteLength(APP_CONTENT, "utf8"), sha256: APP_SHA }],
    commands: [{
      executable: "node",
      arguments: ["--check", "app.js"],
      purpose: "Parse the generated JavaScript",
      assertionID: "syntax:app.js",
      exitCode: 0,
      output: "syntax ok\n",
      passed: true,
      origin: "harness",
      durationMs: 3,
    }],
    previews: [],
    workspaceAudit: { passed: true, files: 1, bytes: Buffer.byteLength(APP_CONTENT, "utf8"), message: "Workspace within budget." },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseObjectiveContract — untrusted contract validation (fail-closed).
// ---------------------------------------------------------------------------

test("parseObjectiveContract accepts a well-formed multi-check contract", () => {
  const contract = parseObjectiveContract({
    version: 1,
    description: "Owner completion contract",
    checks: [
      { type: "file_sha256", path: "app.js", sha256: APP_SHA },
      { type: "command_output_contains", substring: "ok", purpose: "Parse the generated JavaScript" },
      { type: "command_output_equals", value: "42" },
    ],
  });
  assert.equal(contract.version, 1);
  assert.equal(contract.description, "Owner completion contract");
  assert.equal(contract.checks.length, 3);
  assert.deepEqual(contract.checks[0], { type: "file_sha256", path: "app.js", sha256: APP_SHA });
});

test("parseObjectiveContract lowercases and validates the sha256 shape", () => {
  const contract = parseObjectiveContract({ version: 1, checks: [{ type: "file_sha256", path: "a.txt", sha256: APP_SHA.toUpperCase() }] });
  assert.equal((contract.checks[0] as { sha256: string }).sha256, APP_SHA);
  assert.throws(() => parseObjectiveContract({ version: 1, checks: [{ type: "file_sha256", path: "a.txt", sha256: "xyz" }] }), /64 lowercase hex/u);
});

test("parseObjectiveContract fails closed on malformed contracts", () => {
  assert.throws(() => parseObjectiveContract(null), /objective contract/u);
  assert.throws(() => parseObjectiveContract({ version: 2, checks: [{ type: "command_output_equals", value: "x" }] }), /version must be 1/u);
  assert.throws(() => parseObjectiveContract({ version: 1, checks: [] }), /at least one check/u);
  assert.throws(() => parseObjectiveContract({ version: 1, checks: [{ type: "nope" }] }), /unsupported/u);
  const tooMany = Array.from({ length: 17 }, () => ({ type: "command_output_equals", value: "x" }));
  assert.throws(() => parseObjectiveContract({ version: 1, checks: tooMany }), /at most 16 checks/u);
});

// ---------------------------------------------------------------------------
// evaluateObjectiveContract — judges harness-observed evidence only.
// ---------------------------------------------------------------------------

test("evaluateObjectiveContract fails closed with no contract and preserves the exact legacy reason", () => {
  const evaluation = evaluateObjectiveContract(undefined, report());
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.reason, NO_OBJECTIVE_CONTRACT_REASON);
});

test("evaluateObjectiveContract fails closed when there is no harness artifact report", () => {
  const contract: ObjectiveContract = { version: 1, checks: [{ type: "file_sha256", path: "app.js", sha256: APP_SHA }] };
  const evaluation = evaluateObjectiveContract(contract, undefined);
  assert.equal(evaluation.passed, false);
  assert.match(evaluation.reason, /requires harness-executed artifact evidence/u);
});

test("evaluateObjectiveContract passes only when the harness-recorded file digest matches", () => {
  const good: ObjectiveContract = { version: 1, checks: [{ type: "file_sha256", path: "app.js", sha256: APP_SHA }] };
  assert.equal(evaluateObjectiveContract(good, report()).passed, true);

  const wrong: ObjectiveContract = { version: 1, checks: [{ type: "file_sha256", path: "app.js", sha256: "b".repeat(64) }] };
  const mismatch = evaluateObjectiveContract(wrong, report());
  assert.equal(mismatch.passed, false);
  assert.match(mismatch.reason, /does not match/u);

  const missing: ObjectiveContract = { version: 1, checks: [{ type: "file_sha256", path: "absent.js", sha256: APP_SHA }] };
  assert.match(evaluateObjectiveContract(missing, report()).reason, /no harness-recorded file/u);
});

test("evaluateObjectiveContract only honors passing harness command output", () => {
  const contains: ObjectiveContract = { version: 1, checks: [{ type: "command_output_contains", substring: "syntax ok" }] };
  assert.equal(evaluateObjectiveContract(contains, report()).passed, true);

  // A model-claimed but failed command cannot satisfy the oracle (fail-closed).
  const failedReport = report({ commands: [{ ...report().commands[0]!, passed: false }] });
  assert.equal(evaluateObjectiveContract(contains, failedReport).passed, false);
});

test("evaluateObjectiveContract matches equals (trimmed) and purpose-scoped output", () => {
  const rep = report({ commands: [{
    executable: "node", arguments: ["answer.js"], purpose: "State the answer",
    exitCode: 0, output: "  42  \n", passed: true, origin: "harness", durationMs: 1,
  }] });
  const equals: ObjectiveContract = { version: 1, checks: [{ type: "command_output_equals", value: "42", purpose: "State the answer" }] };
  assert.equal(evaluateObjectiveContract(equals, rep).passed, true);

  const wrongPurpose: ObjectiveContract = { version: 1, checks: [{ type: "command_output_equals", value: "42", purpose: "Different purpose" }] };
  assert.equal(evaluateObjectiveContract(wrongPurpose, rep).passed, false);
});

test("evaluateObjectiveContract requires every check to pass (AND semantics)", () => {
  const contract: ObjectiveContract = {
    version: 1,
    checks: [
      { type: "file_sha256", path: "app.js", sha256: APP_SHA },
      { type: "command_output_contains", substring: "never-present" },
    ],
  };
  const evaluation = evaluateObjectiveContract(contract, report());
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.satisfied.length, 1);
  assert.match(evaluation.reason, /Objective oracle failed/u);
});

// ---------------------------------------------------------------------------
// Integration with LoopEngine using a mock artifact executor (portable — no
// workspace sandbox). Proves: passing oracle -> gold, failing oracle -> paused,
// no oracle -> paused (the pre-oracle fail-closed behavior).
// ---------------------------------------------------------------------------

const reply = (content: unknown): AgentReply => ({
  content: JSON.stringify(content),
  usage: { input: 10, output: 5, total: 15, cost: 0.001 },
});

class FakeAgent implements AgentAdapter {
  constructor(private readonly replies: AgentReply[]) {}
  async complete(): Promise<AgentReply> {
    const next = this.replies.shift();
    if (!next) throw new Error("Unexpected agent call");
    return next;
  }
}

class MockArtifactExecutor implements ArtifactExecutor {
  readonly allowVerificationCommands = true;
  describe(): string { return "Mock artifact executor for objective-oracle integration tests."; }
  async apply(_implementation: ImplementationDraft): Promise<ArtifactExecutionReport> { return report(); }
  async revalidateLastReport(): Promise<{ passed: boolean; message: string }> {
    return { passed: true, message: "Mock manifest revalidated." };
  }
}

const syntaxCriterion = {
  id: "C1",
  title: "Harness syntax predicate",
  detail: "syntax:app.js must parse without syntax errors.",
  evidence: "Harness-owned parser check syntax:app.js succeeds without workspace mutation.",
  evidence_kind: "syntax",
  evidence_target: "syntax:app.js",
};

const plan = {
  criteria: [syntaxCriterion],
  plan: [{ id: "P1", title: "Write", detail: "Write the app", proof: "Harness parses app.js" }],
  risks: [],
  acceptance_test: "app.js parses",
};

const passedReview = { verdict: "pass", score: 9, summary: "Complete", findings: [], required_changes: [] };

function scriptedAgent(): FakeAgent {
  return new FakeAgent([
    reply(plan),
    reply(passedReview),
    reply({
      deliverable: "Created a valid JavaScript artifact.",
      notes: [],
      files: [{ path: "app.js", content: APP_CONTENT }],
      verification_commands: [{ executable: "node", arguments: ["--check", "app.js"], purpose: "Parse the generated JavaScript" }],
    }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Harness parsed app.js.", evidence_refs: ["command:1"] }] }),
  ]);
}

test("passing objective oracle + passing review + passing gates reaches Gold", async () => {
  const objective: ObjectiveContract = {
    version: 1,
    checks: [
      { type: "file_sha256", path: "app.js", sha256: APP_SHA },
      { type: "command_output_contains", substring: "syntax ok", purpose: "Parse the generated JavaScript" },
    ],
  };
  const result = await new LoopEngine(scriptedAgent(), { artifactExecutor: new MockArtifactExecutor(), objective })
    .execute("Create a small program", { summary: "Create it", questions: [] }, {}, 1);
  assert.equal(result.completed, true, result.message);
  assert.equal(result.stage, "gold");
  assert.equal(result.artifactReport?.passed, true);
});

test("a failing objective oracle keeps the run paused (fail-closed)", async () => {
  const objective: ObjectiveContract = { version: 1, checks: [{ type: "file_sha256", path: "app.js", sha256: "c".repeat(64) }] };
  const result = await new LoopEngine(scriptedAgent(), { artifactExecutor: new MockArtifactExecutor(), objective })
    .execute("Create a small program", { summary: "Create it", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.equal(result.stage, "paused");
  assert.match(result.message, /Objective oracle failed/u);
});

test("no objective oracle keeps the run paused exactly as before the oracle existed", async () => {
  const result = await new LoopEngine(scriptedAgent(), { artifactExecutor: new MockArtifactExecutor() })
    .execute("Create a small program", { summary: "Create it", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.equal(result.stage, "paused");
  assert.match(result.message, /Automatic Gold is disabled until an immutable harness- or owner-supplied objective oracle exists/u);
});
