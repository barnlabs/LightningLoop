import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceArtifactExecutor } from "../artifacts/workspace-artifact-executor.js";
import { LoopEngine } from "./loop-engine.js";
import type { AgentAdapter, AgentReply } from "./loop-types.js";

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

class InspectingAgent implements AgentAdapter {
  readonly supportsImages = true;
  readonly requests: Parameters<AgentAdapter["complete"]>[0][] = [];
  constructor(private readonly replies: AgentReply[]) {}
  async complete(request: Parameters<AgentAdapter["complete"]>[0]): Promise<AgentReply> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (!next) throw new Error("Unexpected agent call");
    return next;
  }
}

class ReviewMutationAgent implements AgentAdapter {
  private calls = 0;
  constructor(private readonly replies: AgentReply[], private readonly mutateDuringImplementationReview: () => Promise<void>) {}
  async complete(): Promise<AgentReply> {
    this.calls += 1;
    const next = this.replies.shift();
    if (!next) throw new Error("Unexpected agent call");
    if (this.calls === 4) await this.mutateDuringImplementationReview();
    return next;
  }
}

const behaviorCriterion = (target: string) => ({
  id: "C1", title: "Harness behavior predicate", detail: `The isolated JavaScript export predicate ${target} must evaluate to its declared scalar.`, evidence: `Harness-isolated export invocation for ${target}.`, evidence_kind: "behavior", evidence_target: target,
});

const syntaxCriterion = (target: string) => ({
  id: "C1", title: "Harness syntax predicate", detail: `${target} must parse without syntax errors.`, evidence: `Harness-owned parser check ${target} succeeds without workspace mutation.`, evidence_kind: "syntax", evidence_target: target,
});

const fileCriterion = (target: string) => ({
  id: "C1", title: "Supplementary file integrity", detail: `${target} must exist with hash-recorded bytes; this does not satisfy Gold by itself.`, evidence: `Recorded SHA-256 for ${target}.`, evidence_kind: "file", evidence_target: target,
});

const renderCriterion = (target: string) => ({
  id: "C1", title: "Hash-bound visual review", detail: `${target} must have an attached hash-bound output preview with no material visual defect.`, evidence: `Independent picture review of the hash-bound preview for ${target}.`, evidence_kind: "render", evidence_target: target,
});

const buildCriterion = () => ({
  id: "C1", title: "Harness build predicate", detail: "The Cargo project must pass its locked offline build and test predicate.", evidence: "Harness-owned cargo test --offline --locked succeeds without workspace mutation.", evidence_kind: "build", evidence_target: "build:cargo",
});

const plan = {
  criteria: [behaviorCriterion("js-export:result.mjs#status=\"Done\"")],
  plan: [{ id: "P1", title: "Write", detail: "Write the result", proof: "Inspect final text" }],
  risks: [],
  acceptance_test: "Final output contains Done",
};

const passedReview = {
  verdict: "pass",
  score: 9,
  summary: "Complete",
  findings: [],
  required_changes: [],
};

test("syntax-only artifact evidence pauses after harsh review without an owner objective contract", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-gold-"));
  const syntaxPlan = { ...plan, criteria: [syntaxCriterion("syntax:result.mjs")] };
  const agent = new FakeAgent([
    reply(syntaxPlan),
    reply({ ...passedReview, verdict: "revise", score: 7, required_changes: ["Make proof specific"] }),
    reply(syntaxPlan),
    reply(passedReview),
    reply({ deliverable: "Draft", notes: [], files: [{ path: "result.mjs", content: "export const status = () => 'Draft';\n" }], verification_commands: [] }),
    reply({
      verdict: "revise", score: 7, summary: "Missing word", criteria: [{ criterion_id: "C1", status: "unsatisfied", evidence: "Done is absent" }],
      findings: [{ severity: "high", criterion_id: "C1", title: "Incomplete", issue: "Done is absent", required_change: "Add Done" }],
      required_changes: ["Add Done"],
    }),
    reply({ deliverable: "Done", notes: [], files: [{ path: "result.mjs", content: "export const status = () => 'Done';\n" }], verification_commands: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Harness-owned syntax assertion parsed result.mjs", evidence_refs: ["command:1"] }] }),
  ]);
  try {
    const engine = new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true) });
    const result = await engine.execute("Finish", { summary: "Finish", questions: [] }, {}, 2);
    assert.equal(result.completed, false);
    assert.equal(result.stage, "paused");
    assert.equal(result.implementation.deliverable, "Done");
    assert.equal(result.reviews.length, 4);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.usage.total, 120);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("review receives the exact generated output preview but visual evidence cannot self-award Gold", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-picture-"));
  const visualPlan = {
    ...plan,
    criteria: [renderCriterion("index.html")],
  };
  try {
    const agent = new InspectingAgent([
      reply(visualPlan),
      reply(passedReview),
      reply({
        deliverable: "Created the interface.", notes: [],
        files: [{ path: "index.html", content: "<!doctype html><html><body><main><h1>Reviewed output</h1></main></body></html>" }],
        verification_commands: [],
      }),
      reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Inspected the attached hash-bound generated screenshot.", evidence_refs: ["preview:1"] }] }),
    ]);
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const result = await new LoopEngine(agent, { artifactExecutor: executor }).execute("Build the UI", { summary: "Build it", questions: [] }, {}, 1);
    assert.equal(result.completed, false, result.message);
    assert.equal(agent.requests[3]?.images?.length, 1);
    assert.match(agent.requests[3]?.images?.[0]?.path ?? "", /_lightningloop\/previews\/.*\.png$/u);
    assert.match(agent.requests[3]?.user ?? "", /reviewer_image_attached=true/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("review exhaustion pauses instead of passing", async () => {
  const rejected = reply({
    verdict: "revise", score: 8, summary: "Still vague", findings: [], required_changes: ["Add proof"],
  });
  const engine = new LoopEngine(new FakeAgent([reply(plan), rejected]));
  const result = await engine.execute("Finish", { summary: "Finish", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.equal(result.stage, "paused");
  assert.match(result.message, /exhaustion never becomes approval/);
});

test("a reviewer pass without criterion evidence cannot become Gold", async () => {
  const engine = new LoopEngine(new FakeAgent([
    reply(plan),
    reply(passedReview),
    reply({ deliverable: "Done", notes: [] }),
    reply({ ...passedReview, criteria: [] }),
  ]));
  const result = await engine.execute("Finish", { summary: "Finish", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /no passing evidence/i);
});

test("conflicting duplicate criterion assessments cannot become Gold", async () => {
  const engine = new LoopEngine(new FakeAgent([
    reply(plan),
    reply(passedReview),
    reply({ deliverable: "Done", notes: [] }),
    reply({
      ...passedReview,
      criteria: [
        { criterion_id: "C1", status: "unsatisfied", evidence: "The requested proof is incomplete.", evidence_refs: ["deliverable"] },
        { criterion_id: "C1", status: "satisfied", evidence: "The deliverable says Done.", evidence_refs: ["deliverable"] },
      ],
    }),
  ]));
  const result = await engine.execute("Finish", { summary: "Finish", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /conflicting|duplicate|evidence/i);
});

test("reviewer prose cannot cite evidence outside the deterministic catalog", async () => {
  const engine = new LoopEngine(new FakeAgent([
    reply(plan),
    reply(passedReview),
    reply({ deliverable: "Done", notes: [] }),
    reply({
      ...passedReview,
      criteria: [{
        criterion_id: "C1",
        status: "satisfied",
        evidence: "A test passed somewhere.",
        evidence_refs: ["command:999"],
      }],
    }),
  ]));
  const result = await engine.execute("Finish", { summary: "Finish", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /no passing evidence|catalog|reference/i);
});

test("visual criteria require source-image or rendered-preview evidence", async () => {
  const visualPlan = {
    ...plan,
    criteria: [renderCriterion("index.html")],
  };
  const engine = new LoopEngine(new FakeAgent([
    reply(visualPlan),
    reply(passedReview),
    reply({ deliverable: "Done", notes: [] }),
    reply({
      ...passedReview,
      criteria: [{
        criterion_id: "C1",
        status: "satisfied",
        evidence: "The prose says the interface looks right.",
        evidence_refs: ["deliverable"],
      }],
    }),
  ]));
  const result = await engine.execute("Build the UI", { summary: "Build it", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /visual|preview|image|evidence/i);
});

test("search snippets remain unverified and cannot be promoted to passing evidence", async () => {
  const agent = new InspectingAgent([
    reply({ queries: ["official source for current fact"] }),
    reply(plan),
    reply(passedReview),
    reply({ deliverable: "Done", notes: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Done", evidence_refs: ["deliverable", "research:1"] }] }),
  ]);
  const queries: string[] = [];
  const engine = new LoopEngine(agent, {
    research: {
      provider: "brave",
      search: async (query) => {
        queries.push(query);
        return [{ provider: "brave", title: "Primary", url: "https://agency.gov/source", snippet: "Current fact" }];
      },
    },
  });
  const result = await engine.execute("Research then finish", { summary: "Finish", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.deepEqual(queries, ["official source for current fact"]);
  assert.doesNotMatch(agent.requests[0]?.user ?? "", /agency\.gov/);
  assert.match(agent.requests[1]?.user ?? "", /UNTRUSTED RESEARCH EVIDENCE/);
  assert.match(agent.requests[1]?.user ?? "", /https:\/\/agency\.gov\/source/);
});

test("research drops non-reputable search hits before they enter evidence", async () => {
  const agent = new InspectingAgent([
    reply({ queries: ["current official fact"] }),
    reply(plan),
    reply(passedReview),
    reply({ deliverable: "Done", notes: [] }),
    reply(passedReview),
  ]);
  const engine = new LoopEngine(agent, {
    research: {
      provider: "free",
      search: async () => [
        { provider: "free", title: "Blog", url: "https://example.com/post", snippet: "ignore me" },
        { provider: "free", title: "Primary", url: "https://agency.gov/fact", snippet: "keep me" },
      ],
    },
  });
  await engine.execute("Research then finish", { summary: "Finish", questions: [] }, {}, 1);
  const evidence = agent.requests.find((request) => request.user.includes("UNTRUSTED RESEARCH EVIDENCE"))?.user ?? "";
  assert.match(evidence, /agency\.gov\/fact/);
  assert.doesNotMatch(evidence, /example\.com\/post/);
});

test("reviewers can trigger deduplicated bounded research between repair rounds", async () => {
  const sourcePlan = {
    ...plan,
    criteria: [{ id: "C1", title: "Current constraint", detail: "State the verified runtime constraint", claim: "Verified source content", evidence: "Verified source content", evidence_kind: "source", evidence_target: "https://agency.gov/2" }],
  };
  const agent = new InspectingAgent([
    reply({ queries: ["initial primary source"] }),
    reply(sourcePlan),
    reply({
      ...passedReview,
      verdict: "revise",
      score: 8,
      required_changes: ["Verify the current runtime constraint"],
      research_queries: ["official current runtime constraint"],
    }),
    reply(sourcePlan),
    reply({ ...passedReview, research_queries: [] }),
    reply({ deliverable: "Verified source content", notes: [] }),
    reply({
      ...passedReview,
      research_queries: [],
      criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Second source was opened and hash-preserved", evidence_refs: ["research:4"] }],
    }),
    reply({ deliverable: "Verified source content", notes: [] }),
    reply({
      ...passedReview,
      research_queries: [],
      criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Second source was opened and hash-preserved", evidence_refs: ["research:4"] }],
    }),
  ]);
  const queries: string[] = [];
  const engine = new LoopEngine(agent, {
    research: {
      provider: "brave",
      search: async (query) => {
        queries.push(query);
        return [{
          provider: "brave",
          title: query,
          url: `https://agency.gov/${queries.length}`,
          snippet: `Evidence for ${query}`,
        }];
      },
      openSource: async (url) => ({
        url,
        retrievedAt: "2026-07-20T12:00:00.000Z",
        sha256: "a".repeat(64),
        text: "Verified source content",
        contentType: "text/plain",
        sourceClass: "official-or-primary-candidate",
      }),
    },
  });
  const result = await engine.execute("Research, repair, and finish", { summary: "Finish", questions: [] }, {}, 2);
  assert.equal(result.completed, false);
  assert.deepEqual(queries, ["initial primary source", "official current runtime constraint"]);
  assert.match(agent.requests[3]?.user ?? "", /official current runtime constraint/);
});

test("factual correctness cannot be proved by implementer prose", async () => {
  const factualPlan = {
    ...plan,
    criteria: [{ id: "C1", title: "Capital named", detail: "State capital of France and reject Atlantis", claim: "The capital of France is Paris.", evidence: "Opened authoritative source proof", evidence_kind: "source", evidence_target: "https://agency.gov/france" }],
  };
  const engine = new LoopEngine(new FakeAgent([
    reply(factualPlan),
    reply(passedReview),
    reply({ deliverable: "unsupported assertion", notes: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "The assertion exists.", evidence_refs: ["deliverable"] }] }),
  ]));
  const result = await engine.execute("Produce a factually correct answer", { summary: "Answer", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /source evidence|evidence/i);
});

test("a fractional score below nine is never rounded across the Gold gate", async () => {
  const engine = new LoopEngine(new FakeAgent([
    reply(plan),
    reply(passedReview),
    reply({ deliverable: "Done", notes: [] }),
    reply({ ...passedReview, score: 8.6, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Done is present.", evidence_refs: ["deliverable"] }] }),
  ]));
  const result = await engine.execute("Finish", { summary: "Finish", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.equal(result.reviews.at(-1)?.score, 8.6);
});

test("eligible managed memory is labeled untrusted in the system channel", async () => {
  const agent = new InspectingAgent([
    reply({ summary: "Remembered", questions: [{ id: "Q1", question: "Audience?", why_it_matters: "Scope" }] }),
  ]);
  const engine = new LoopEngine(agent, { memories: ["[project; source: user] Use the BarnLabs palette."] });
  await engine.clarify("Create a brief");
  assert.match(agent.requests[0]?.system ?? "", /USER-MANAGED MEMORY CONTEXT/);
  assert.match(agent.requests[0]?.system ?? "", /Use the BarnLabs palette/);
  assert.doesNotMatch(agent.requests[0]?.user ?? "", /BarnLabs palette/);
});

test("artifact mode materializes and reports files but pauses without owner objective acceptance", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-artifact-"));
  try {
    const agent = new InspectingAgent([
      reply({ ...plan, criteria: [syntaxCriterion("syntax:app.js")] }),
      reply(passedReview),
      reply({
        deliverable: "Created a valid JavaScript artifact.",
        notes: [],
        files: [{ path: "app.js", content: "console.log('Done');\n" }],
        verification_commands: [{ executable: "node", arguments: ["--check", "app.js"], purpose: "Parse the generated JavaScript" }],
      }),
      reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Harness report contains app.js hash and a harness-owned node --check command.", evidence_refs: ["file:app.js", "command:2"] }] }),
    ]);
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const result = await new LoopEngine(agent, { artifactExecutor: executor }).execute(
      "Create a small program",
      { summary: "Create it", questions: [] },
      {},
      1,
    );
    assert.equal(result.completed, false);
    assert.equal(result.artifactReport?.passed, true);
    assert.equal(await readFile(join(workspace, "app.js"), "utf8"), "console.log('Done');\n");
    assert.match(agent.requests[3]?.user ?? "", /HARNESS ARTIFACT REPORT/);
    assert.match(agent.requests[3]?.user ?? "", /sha256/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("engine reopens the exact artifact manifest after reviewer latency", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-terminal-revalidation-"));
  const syntaxPlan = { ...plan, criteria: [syntaxCriterion("syntax:answer.js")] };
  try {
    const agent = new ReviewMutationAgent([
      reply(syntaxPlan),
      reply(passedReview),
      reply({
        deliverable: "Paris",
        notes: [],
        files: [{ path: "answer.js", content: "export const answer = 'Paris';\n" }],
        verification_commands: [],
      }),
      reply({
        ...passedReview,
        criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "answer.js parsed", evidence_refs: ["command:1"] }],
      }),
    ], async () => {
      await writeFile(join(workspace, "answer.js"), "export const answer = 'Atlantis';\n", { mode: 0o600 });
    });
    const result = await new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true) })
      .execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
    assert.equal(result.completed, false);
    assert.match(result.message, /terminal manifest revalidation|changed after its passing report/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("syntax success and a mismatched runtime result cannot satisfy a behavior assertion", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-behavior-"));
  const behaviorPlan = {
    ...plan,
    criteria: [behaviorCriterion("js-export:app.mjs#answer=42")],
  };
  try {
    const agent = new FakeAgent([
      reply(behaviorPlan),
      reply(passedReview),
      reply({
        deliverable: "The program returns 42.",
        notes: [],
        files: [{ path: "app.mjs", content: "export const answer = () => 0;\nconsole.log('answer=42');\n" }],
        verification_commands: [{
          executable: "node",
          arguments: ["app.mjs"],
          purpose: "Self-report the desired answer",
          assertion_id: "js-export:app.mjs#answer=42",
          expected_output: "answer=42",
        }],
      }),
      reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "The implementation self-reported 42 and syntax passed", evidence_refs: ["command:1", "command:2"] }] }),
    ]);
    const result = await new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true) })
      .execute("Return 42", { summary: "Run the file", questions: [] }, {}, 1);
    assert.equal(result.completed, false);
    assert.equal(result.artifactReport?.commands.some((command) => command.origin === "harness" && command.assertionID === "js-export:app.mjs#answer=42" && !command.passed), true);
    assert.match(result.message, /passing evidence|behavior|deterministic/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a planner-controlled behavior expectation cannot certify an Atlantis result", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-planner-oracle-"));
  const behaviorPlan = {
    ...plan,
    criteria: [behaviorCriterion("js-export:answer.mjs#capital=\"Atlantis\"")],
  };
  const agent = new FakeAgent([
    reply(behaviorPlan),
    reply(passedReview),
    reply({
      deliverable: "The capital of France is Atlantis.",
      notes: [],
      files: [{ path: "answer.mjs", content: "export const capital = () => 'Atlantis';\n" }],
      verification_commands: [],
    }),
    reply({
      ...passedReview,
      criteria: [{
        criterion_id: "C1",
        status: "satisfied",
        evidence: "The planner-selected expected value matched the isolated export.",
        evidence_refs: ["command:2"],
      }],
    }),
  ]);
  try {
    const result = await new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true) })
      .execute("State the capital of France", { summary: "Answer accurately", questions: [] }, {}, 1);
    assert.equal(result.artifactReport?.commands.some((command) => command.assertionID === "js-export:answer.mjs#capital=\"Atlantis\"" && command.passed), true);
    assert.equal(result.completed, false);
    assert.match(result.message, /behavior|independent|evidence/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a planner cannot downgrade a factual objective to a passing syntax predicate", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-syntax-downgrade-"));
  const agent = new FakeAgent([
    reply({ ...plan, criteria: [syntaxCriterion("syntax:answer.js")] }),
    reply(passedReview),
    reply({
      deliverable: "The capital of France is Atlantis.",
      notes: [],
      files: [{ path: "answer.js", content: "export const capital = 'Atlantis';\n" }],
      verification_commands: [],
    }),
    reply({
      ...passedReview,
      criteria: [{
        criterion_id: "C1",
        status: "satisfied",
        evidence: "The planner-selected JavaScript parsed successfully.",
        evidence_refs: ["command:1"],
      }],
    }),
  ]);
  try {
    const result = await new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true) })
      .execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
    assert.equal(result.artifactReport?.commands.some((command) => command.assertionID === "syntax:answer.js" && command.passed), true);
    assert.equal(result.completed, false);
    assert.match(result.message, /harness-owned objective contract|owner acceptance/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("user acceptance is an owner boundary and never auto-passes from reviewer prose", async () => {
  const acceptancePlan = {
    ...plan,
    criteria: [{
      id: "C1",
      title: "Owner acceptance",
      detail: "The owner accepts the artifact as satisfying the requested objective.",
      evidence: "Explicit owner acceptance in the active run.",
      evidence_kind: "user_acceptance",
      evidence_target: "owner:active-run",
    }],
  };
  const result = await new LoopEngine(new FakeAgent([
    reply(acceptancePlan),
    reply(passedReview),
    reply({ deliverable: "The reviewer says the owner accepts this.", notes: [] }),
    reply({
      ...passedReview,
      criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "I approve on the owner's behalf.", evidence_refs: ["deliverable"] }],
    }),
  ])).execute("Approve this subjective result", { summary: "Owner decides", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /user_acceptance|owner acceptance|passing evidence/i);
});

test("a hash of false factual prose cannot downgrade a source claim to file evidence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-file-downgrade-"));
  const downgradedPlan = {
    ...plan,
    criteria: [{ id: "C1", title: "State the capital of France", detail: "Answer names the correct city", evidence: "Hash answer.txt", evidence_kind: "file", evidence_target: "answer.txt" }],
  };
  try {
    const agent = new FakeAgent([
      reply(downgradedPlan),
      reply(passedReview),
      reply({ deliverable: "Atlantis", notes: [], files: [{ path: "answer.txt", content: "Atlantis\n" }], verification_commands: [] }),
      reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "answer.txt is hash-recorded", evidence_refs: ["file:answer.txt"] }] }),
    ]);
    await assert.rejects(
      new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace) })
        .execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1),
      /exact harness-owned title, detail, and evidence/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a factual claim cannot be relabeled as a syntax predicate", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-syntax-downgrade-"));
  const downgradedPlan = {
    ...plan,
    criteria: [{ id: "C1", title: "State the capital of France", detail: "Answer the factual question", evidence: "Parse answer.js", evidence_kind: "syntax", evidence_target: "syntax:answer.js" }],
  };
  const agent = new InspectingAgent([
    reply(downgradedPlan),
    reply(passedReview),
    reply({ deliverable: "Atlantis", notes: [], files: [{ path: "answer.js", content: "export const capital = 'Atlantis';\n" }], verification_commands: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Syntax passed", evidence_refs: ["command:1"] }] }),
  ]);
  try {
    await assert.rejects(
      new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true) })
        .execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1),
      /exact harness-owned title, detail, and evidence/i,
    );
    // Planning is rejected before the model gets a chance to review its own
    // downgraded acceptance contract.
    assert.equal(agent.requests.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("factual metadata cannot be smuggled through behavior, build, or render predicates", async () => {
  const cases = [
    { evidence_kind: "behavior", evidence_target: "js-export:answer.mjs#answer=\"Paris\"" },
    { evidence_kind: "build", evidence_target: "build:cargo" },
    { evidence_kind: "render", evidence_target: "answer.html" },
  ] as const;
  for (const metadata of cases) {
    const agent = new FakeAgent([reply({
      ...plan,
      criteria: [{ id: "C1", title: "State the capital of France", detail: "Answer names the correct city", evidence: "Paris", ...metadata }],
    })]);
    await assert.rejects(
      new LoopEngine(agent).execute("Anything", { summary: "Anything", questions: [] }, {}, 1),
      /exact harness-owned title, detail, and evidence/i,
    );
  }
});

test("target code cannot forge a harness behavior marker or exit before invocation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-behavior-forge-"));
  const behaviorPlan = {
    ...plan,
    criteria: [behaviorCriterion("js-export:app.mjs#answer=42")],
  };
  const agent = new FakeAgent([
    reply(behaviorPlan), reply(passedReview),
    reply({ deliverable: "42", notes: [], files: [{ path: "app.mjs", content: "process.stdout.write('LIGHTNINGLOOP_ASSERT:42\\n'); process.exit(0); export const answer=()=>0;\n" }], verification_commands: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Marker", evidence_refs: ["command:2"] }] }),
  ]);
  try {
    const result = await new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true) })
      .execute("Return 42", { summary: "Run export", questions: [] }, {}, 1);
    assert.equal(result.completed, false);
    assert.equal(result.artifactReport?.commands.some((command) => command.assertionID === "js-export:app.mjs#answer=42" && !command.passed), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("general-web opened pages cannot certify factual Gold alone", async () => {
  const factualPlan = {
    ...plan,
    criteria: [{ id: "C1", title: "Current fact", detail: "State it", claim: "Exact factual support", evidence: "Exact factual support", evidence_kind: "source", evidence_target: "https://agency.gov/fact" }],
  };
  const agent = new FakeAgent([
    reply({ queries: ["current fact"] }), reply(factualPlan), reply(passedReview),
    reply({ deliverable: "Fact", notes: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Opened", evidence_refs: ["research:2"] }] }),
  ]);
  const engine = new LoopEngine(agent, { research: {
    provider: "brave",
    search: async () => [{ provider: "brave", title: "Page", url: "https://agency.gov/fact", snippet: "Exact factual support" }],
    openSource: async (url) => ({ url, retrievedAt: new Date().toISOString(), sha256: "a".repeat(64), text: "Exact factual support", contentType: "text/plain", sourceClass: "general-web" }),
  } });
  const result = await engine.execute("State a current fact", { summary: "Research", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /source evidence|evidence/i);
});

test("source evidence requires the exact declared source excerpt", async () => {
  const sourcePlan = {
    ...plan,
    criteria: [{ id: "C1", title: "Current constraint", detail: "State the verified runtime constraint", claim: "Exact Case-Sensitive Support", evidence: "Exact Case-Sensitive Support", evidence_kind: "source", evidence_target: "https://developer.mozilla.org/constraint" }],
  };
  const agent = new FakeAgent([
    reply({ queries: ["official current constraint"] }), reply(sourcePlan), reply(passedReview),
    reply({ deliverable: "A result", notes: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Opened source", evidence_refs: ["research:2"] }] }),
  ]);
  const result = await new LoopEngine(agent, { research: {
    provider: "brave",
    search: async () => [{ provider: "brave", title: "Official docs", url: "https://developer.mozilla.org/constraint", snippet: "support" }],
    openSource: async (url) => ({ url, retrievedAt: new Date().toISOString(), sha256: "a".repeat(64), text: "exact case-sensitive support", contentType: "text/plain", sourceClass: "official-or-primary-candidate" }),
  } }).execute("State the current constraint", { summary: "Research", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /source evidence|evidence/i);
});

test("an authoritative but unrelated excerpt cannot certify an Atlantis deliverable", async () => {
  const sourcePlan = {
    ...plan,
    criteria: [{
      id: "C1",
      title: "Capital of France",
      detail: "State the source-backed capital.",
      claim: "The capital of France is Paris.",
      evidence: "France is a member state of the European Union.",
      evidence_kind: "source",
      evidence_target: "https://agency.gov/france",
    }],
  };
  const agent = new FakeAgent([
    reply({ queries: ["official France capital"] }), reply(sourcePlan), reply(passedReview),
    reply({ deliverable: "The capital of France is Atlantis.", notes: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Opened primary source", evidence_refs: ["research:2"] }] }),
  ]);
  const result = await new LoopEngine(agent, { research: {
    provider: "brave",
    search: async () => [{ provider: "brave", title: "Government facts", url: "https://agency.gov/france", snippet: "France facts" }],
    openSource: async (url) => ({
      url,
      retrievedAt: "2026-07-20T12:00:00.000Z",
      sha256: "a".repeat(64),
      text: "France is a member state of the European Union. The capital of France is Paris.",
      contentType: "text/plain",
      sourceClass: "official-or-primary-candidate",
    }),
  } }).execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /literal claim|source evidence|evidence/i);
});

test("a literal authoritative source claim remains review context and cannot auto-certify truth", async () => {
  const sourcePlan = {
    ...plan,
    criteria: [{
      id: "C1",
      title: "Capital of France",
      detail: "State the source-backed capital.",
      claim: "The capital of France is Paris.",
      evidence: "France is a member state of the European Union.",
      evidence_kind: "source",
      evidence_target: "https://agency.gov/france",
    }],
  };
  const agent = new FakeAgent([
    reply({ queries: ["official France capital"] }), reply(sourcePlan), reply(passedReview),
    reply({ deliverable: "The capital of France is Paris.", notes: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Opened primary source", evidence_refs: ["research:2"] }] }),
  ]);
  const result = await new LoopEngine(agent, { research: {
    provider: "brave",
    search: async () => [{ provider: "brave", title: "Government facts", url: "https://agency.gov/france", snippet: "France facts" }],
    openSource: async (url) => ({
      url,
      retrievedAt: "2026-07-20T12:00:00.000Z",
      sha256: "b".repeat(64),
      text: "France is a member state of the European Union.\nThe capital of France is Paris.",
      contentType: "text/plain",
      sourceClass: "official-or-primary-candidate",
    }),
  } }).execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /owner acceptance|objective oracle/i);
});

test("an exact Atlantis claim never reaches Gold from candidate source classifications", async () => {
  const claim = "The capital of France is Atlantis.";
  for (const sourceClass of ["official-or-primary-candidate", "general-web"] as const) {
    const sourcePlan = {
      ...plan,
      criteria: [{
        id: "C1",
        title: "Capital of France",
        detail: "State the source-backed capital.",
        claim,
        evidence: claim,
        evidence_kind: "source",
        evidence_target: "https://agency.gov/france",
      }],
    };
    const agent = new FakeAgent([
      reply({ queries: ["official France capital"] }), reply(sourcePlan), reply(passedReview),
      reply({ deliverable: claim, notes: [] }),
      reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "The candidate source contains the exact claim.", evidence_refs: ["research:2"] }] }),
    ]);
    const result = await new LoopEngine(agent, { research: {
      provider: "brave",
      search: async () => [{ provider: "brave", title: "Candidate source", url: "https://agency.gov/france", snippet: claim }],
      openSource: async (url) => ({
        url,
        retrievedAt: "2026-07-20T12:00:00.000Z",
        sha256: "7".repeat(64),
        text: claim,
        contentType: "text/plain",
        sourceClass,
      }),
    } }).execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
    assert.equal(result.completed, false, sourceClass);
    assert.match(result.message, /source authority classification|owner acceptance|objective oracle/i, sourceClass);
  }
});

test("punctuation-shaped source claims remain non-certifying without a truth oracle", async () => {
  const hostileClaims = [
    "The capital of France is Paris. The capital of France is Atlantis.",
    "The capital of France is Paris; Atlantis.",
    "The capital of France is Paris: Atlantis.",
    "The capital of France is D.C..",
  ];
  for (const claim of hostileClaims) {
    const sourcePlan = {
      ...plan,
      criteria: [{
        id: "C1",
        title: "Capital of France",
        detail: "State the source-backed capital.",
        claim,
        evidence: claim,
        evidence_kind: "source",
        evidence_target: "https://agency.gov/france",
      }],
    };
    const agent = new FakeAgent([
      reply({ queries: ["official France capital"] }), reply(sourcePlan), reply(passedReview),
      reply({ deliverable: claim, notes: [] }),
      reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "The exact declared line is present.", evidence_refs: ["research:2"] }] }),
    ]);
    const result = await new LoopEngine(agent, { research: {
      provider: "brave",
      search: async () => [{ provider: "brave", title: "Government facts", url: "https://agency.gov/france", snippet: claim }],
      openSource: async (url) => ({
        url,
        retrievedAt: "2026-07-20T12:00:00.000Z",
        sha256: "8".repeat(64),
        text: claim,
        contentType: "text/plain",
        sourceClass: "official-or-primary-candidate",
      }),
    } }).execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
    assert.equal(result.completed, false, claim);
    assert.match(result.message, /harness-owned objective contract|owner acceptance/i, claim);
  }
});

test("a source claim embedded only in Atlantis negation cannot certify Gold", async () => {
  const claim = "The capital of France is Paris.";
  const sourcePlan = {
    ...plan,
    criteria: [{
      id: "C1",
      title: "Capital of France",
      detail: "State the source-backed capital.",
      claim,
      evidence: claim,
      evidence_kind: "source",
      evidence_target: "https://agency.gov/france",
    }],
  };
  const agent = new FakeAgent([
    reply({ queries: ["official France capital"] }), reply(sourcePlan), reply(passedReview),
    reply({ deliverable: claim, notes: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "The source contains the claim bytes.", evidence_refs: ["research:2"] }] }),
  ]);
  const result = await new LoopEngine(agent, { research: {
    provider: "brave",
    search: async () => [{ provider: "brave", title: "Government facts", url: "https://agency.gov/france", snippet: "France facts" }],
    openSource: async (url) => ({
      url,
      retrievedAt: "2026-07-20T12:00:00.000Z",
      sha256: "f".repeat(64),
      text: `It is false that ${claim} Atlantis is the real capital.`,
      contentType: "text/plain",
      sourceClass: "official-or-primary-candidate",
    }),
  } }).execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /source evidence|standalone|evidence/i);
});

test("contradictory source lines cannot auto-certify factual Gold", async () => {
  const claim = "The capital of France is Paris.";
  const sourcePlan = {
    ...plan,
    criteria: [{
      id: "C1",
      title: "Capital of France",
      detail: "State the source-backed capital.",
      claim,
      evidence: claim,
      evidence_kind: "source",
      evidence_target: "https://agency.gov/france",
    }],
  };
  const agent = new FakeAgent([
    reply({ queries: ["official France capital"] }), reply(sourcePlan), reply(passedReview),
    reply({ deliverable: claim, notes: [] }),
    reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "The exact affirmative line is present.", evidence_refs: ["research:2"] }] }),
  ]);
  const result = await new LoopEngine(agent, { research: {
    provider: "brave",
    search: async () => [{ provider: "brave", title: "Government facts", url: "https://agency.gov/france", snippet: "France facts" }],
    openSource: async (url) => ({
      url,
      retrievedAt: "2026-07-20T12:00:00.000Z",
      sha256: "9".repeat(64),
      text: `${claim}\nIt is false that the capital of France is Paris.\nThe capital of France is Atlantis.`,
      contentType: "text/plain",
      sourceClass: "official-or-primary-candidate",
    }),
  } }).execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
  assert.equal(result.completed, false);
  assert.match(result.message, /source evidence|source contract|evidence/i);
});

test("noncanonical source prose and artifact bytes never auto-certify factual Gold", async () => {
  const sourcePlan = {
    ...plan,
    criteria: [{
      id: "C1",
      title: "Capital of France",
      detail: "State the source-backed capital.",
      claim: "The capital of France is Paris.",
      evidence: "France is a member state of the European Union.",
      evidence_kind: "source",
      evidence_target: "https://agency.gov/france",
    }],
  };
  const nonCanonicalAnswers = [
    { label: "negation", deliverable: "It is not true that The capital of France is Paris.", files: [] },
    { label: "quotation", deliverable: "\"The capital of France is Paris.\"", files: [] },
    { label: "conditional", deliverable: "If asked, The capital of France is Paris.", files: [] },
    { label: "surrounding prose", deliverable: "Answer: The capital of France is Paris.", files: [] },
    { label: "artifact content", deliverable: "See answer.txt.", files: [{ path: "answer.txt", content: "The capital of France is Paris.\n" }] },
  ];
  const source = {
    provider: "brave" as const,
    search: async () => [{ provider: "brave" as const, title: "Government facts", url: "https://agency.gov/france", snippet: "France facts" }],
    openSource: async (url: string) => ({
      url,
      retrievedAt: "2026-07-20T12:00:00.000Z",
      sha256: "c".repeat(64),
      text: "France is a member state of the European Union. The capital of France is Paris.",
      contentType: "text/plain",
      sourceClass: "official-or-primary-candidate" as const,
    }),
  };
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-source-canonical-"));
  try {
    for (const answer of nonCanonicalAnswers) {
      const agent = new FakeAgent([
        reply({ queries: ["official France capital"] }), reply(sourcePlan), reply(passedReview),
        reply({ deliverable: answer.deliverable, notes: [], files: answer.files, verification_commands: [] }),
        reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Opened primary source", evidence_refs: ["research:2"] }] }),
      ]);
      const result = await new LoopEngine(agent, {
        research: source,
        artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true),
      }).execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
      assert.equal(result.completed, false, answer.label);
      assert.match(result.message, /exactly equal all source claims|source evidence|evidence/i, answer.label);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a canonical source answer plus contradictory artifact evidence cannot reach Gold", async () => {
  const sourceAndSyntaxPlan = {
    ...plan,
    criteria: [
      {
        id: "C1",
        title: "Capital of France",
        detail: "State the source-backed capital.",
        claim: "The capital of France is Paris.",
        evidence: "France is a member state of the European Union.",
        evidence_kind: "source",
        evidence_target: "https://agency.gov/france",
      },
      { ...syntaxCriterion("syntax:answer.js"), id: "C2" },
    ],
  };
  const agent = new FakeAgent([
    reply({ queries: ["official France capital"] }), reply(sourceAndSyntaxPlan), reply(passedReview),
    reply({
      deliverable: "The capital of France is Paris.",
      notes: [],
      files: [{ path: "answer.js", content: "export const capital = 'Atlantis';\n" }],
      verification_commands: [],
    }),
    reply({ ...passedReview, criteria: [
      { criterion_id: "C1", status: "satisfied", evidence: "Opened primary source", evidence_refs: ["research:2"] },
      { criterion_id: "C2", status: "satisfied", evidence: "Harness syntax check", evidence_refs: ["command:1"] },
    ] }),
  ]);
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-source-artifact-conflict-"));
  try {
    const result = await new LoopEngine(agent, {
      artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true),
      research: {
        provider: "brave",
        search: async () => [{ provider: "brave", title: "Government facts", url: "https://agency.gov/france", snippet: "France facts" }],
        openSource: async (url) => ({
          url,
          retrievedAt: "2026-07-20T12:00:00.000Z",
          sha256: "e".repeat(64),
          text: "France is a member state of the European Union. The capital of France is Paris.",
          contentType: "text/plain",
          sourceClass: "official-or-primary-candidate",
        }),
      },
    }).execute("What is the capital of France?", { summary: "Answer accurately", questions: [] }, {}, 1);
    assert.equal(result.artifactReport?.passed, true);
    assert.equal(result.completed, false);
    assert.match(result.message, /text-only implementation|source evidence|evidence/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("multiple planner-selected source facts never auto-certify factual Gold", async () => {
  const sourcePlan = {
    ...plan,
    criteria: [
      { id: "C1", title: "Capital", detail: "State capital", claim: "The capital of France is Paris.", evidence: "France is a member state of the European Union.", evidence_kind: "source", evidence_target: "https://agency.gov/france" },
      { id: "C2", title: "Currency", detail: "State currency", claim: "France uses the euro.", evidence: "France uses the euro.", evidence_kind: "source", evidence_target: "https://agency.gov/france" },
    ],
  };
  const makeEngine = (deliverable: string) => new LoopEngine(new FakeAgent([
    reply({ queries: ["official France facts"] }), reply(sourcePlan), reply(passedReview),
    reply({ deliverable, notes: [] }),
    reply({ ...passedReview, criteria: [
      { criterion_id: "C1", status: "satisfied", evidence: "Opened primary source", evidence_refs: ["research:2"] },
      { criterion_id: "C2", status: "satisfied", evidence: "Opened primary source", evidence_refs: ["research:2"] },
    ] }),
  ]), { research: {
    provider: "brave",
    search: async () => [{ provider: "brave", title: "Government facts", url: "https://agency.gov/france", snippet: "France facts" }],
    openSource: async (url) => ({ url, retrievedAt: "2026-07-20T12:00:00.000Z", sha256: "d".repeat(64), text: "France is a member state of the European Union.\nThe capital of France is Paris.\nFrance uses the euro.", contentType: "text/plain", sourceClass: "official-or-primary-candidate" }),
  } });
  const canonical = "The capital of France is Paris.\nFrance uses the euro.";
  assert.equal((await makeEngine(canonical).execute("State France facts", { summary: "Answer", questions: [] }, {}, 1)).completed, false);
  assert.equal((await makeEngine("France uses the euro.\nThe capital of France is Paris.").execute("State France facts", { summary: "Answer", questions: [] }, {}, 1)).completed, false);
});

test("an implementer-controlled npm script cannot satisfy a harness build predicate", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-loop-build-downgrade-"));
  const buildPlan = {
    ...plan,
    criteria: [buildCriterion()],
  };
  try {
    const agent = new FakeAgent([
      reply(buildPlan),
      reply(passedReview),
      reply({
        deliverable: "Build passed.",
        notes: [],
        files: [{ path: "package.json", content: "{\"scripts\":{\"test\":\"echo passed\"}}\n" }],
        verification_commands: [{ executable: "npm", arguments: ["test"], purpose: "Self-reported build", assertion_id: "build:cargo", expected_output: "passed" }],
      }),
      reply({ ...passedReview, criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "npm printed passed", evidence_refs: ["command:1"] }] }),
    ]);
    const result = await new LoopEngine(agent, { artifactExecutor: await WorkspaceArtifactExecutor.create(workspace, true) })
      .execute("Build the project", { summary: "Compile it", questions: [] }, {}, 1);
    assert.equal(result.completed, false);
    assert.match(result.message, /build evidence|evidence/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
