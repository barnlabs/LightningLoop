import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter, AgentReply } from "../core/loop-types.js";
import { registerRuntimeCredential } from "../core/credential-safety.js";
import { PROTOCOL_VERSION, type ProtocolEnvelope } from "../core/schema.js";
import { JsonlHarnessServer } from "./server.js";

const reply = (content: unknown): AgentReply => ({ content: JSON.stringify(content), usage: { input: 1, output: 1, total: 2, cost: 0 } });

class FakeAgent implements AgentAdapter {
  constructor(private readonly replies: AgentReply[]) {}
  async complete(): Promise<AgentReply> {
    const next = this.replies.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  }
}

function request(type: string, runID: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, runID, requestID: `${type}-1`, timestamp: new Date().toISOString(), payload });
}

function requestWithID(type: string, runID: string, requestID: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, runID, requestID, timestamp: new Date().toISOString(), payload });
}

test("JSONL server keeps subjective text in a correlated paused state", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const agent = new FakeAgent([
    reply({ summary: "Finish", questions: [{ id: "Q1", question: "Audience?", why_it_matters: "Defines fit" }] }),
    reply({ criteria: [{ id: "C1", title: "Done", detail: "Finish", evidence: "User accepts final copy", evidence_kind: "user_acceptance", evidence_target: "final-copy" }], plan: [{ id: "P1", title: "Write", detail: "Write", proof: "Inspect" }], risks: [], acceptance_test: "Done" }),
    reply({ verdict: "pass", score: 9, summary: "Approved", findings: [], required_changes: [] }),
    reply({ deliverable: "Done", notes: [] }),
    reply({ verdict: "pass", score: 10, summary: "Gold", criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Result says Done", evidence_refs: ["deliverable"] }], findings: [], required_changes: [] }),
  ]);
  const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => agent);
  await server.handleLine(request("createRun", "run-1", { goal: "Finish" }));
  await server.handleLine(request("continueRun", "run-1", { answers: { Q1: "Developers" }, maxReviewCycles: 1 }));
  assert.equal(outputs.some((output) => output.type === "runPaused"), true);
  assert.equal(outputs.at(-1)?.type, "response");
  assert.equal(outputs.at(-1)?.requestID, "continueRun-1");
});

test("JSONL server rejects versions, secret fields, and oversized input without crashing", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
  await server.handleLine(JSON.stringify({ protocolVersion: 99, type: "hello", runID: "r", requestID: "q", timestamp: new Date().toISOString(), payload: {} }));
  await server.handleLine(request("createRun", "r", { api_key: "synthetic-secret-value" }));
  await server.handleLine("x".repeat(1_048_577));
  assert.deepEqual(outputs.map((output) => output.type), ["error", "error", "error"]);
  assert.deepEqual(outputs.map((output) => (output.payload as { code: string }).code), ["unsupported_version", "request_failed", "message_too_large"]);
});

test("JSONL server rejects arbitrary runtime credentials in goals and answers before model use", async () => {
  const goalCredential = "csk-syntheticrpcgoal123456789";
  const answerCredential = "csk-syntheticrpcanswer123456789";
  const encodedGoalCredential = goalCredential.replace("-", "%2D");
  const encodedAnswerCredential = answerCredential.replace("-", "%2D");
  registerRuntimeCredential(goalCredential);
  registerRuntimeCredential(answerCredential);

  const goalOutputs: ProtocolEnvelope<string, unknown>[] = [];
  let goalAgentCalls = 0;
  const goalServer = new JsonlHarnessServer((envelope) => goalOutputs.push(envelope), async () => ({
    complete: async () => {
      goalAgentCalls += 1;
      return reply({ summary: "Unexpected", questions: [] });
    },
  }));
  await goalServer.handleLine(request("createRun", "credential-goal", { goal: `Explain ${encodedGoalCredential}` }));
  assert.equal(goalAgentCalls, 0);
  assert.equal(goalOutputs.at(-1)?.type, "error");

  const answerOutputs: ProtocolEnvelope<string, unknown>[] = [];
  const answerAgent = new FakeAgent([
    reply({ summary: "Safe clarification", questions: [{ id: "Q1", question: "Audience?", why_it_matters: "Scope" }] }),
  ]);
  const answerServer = new JsonlHarnessServer((envelope) => answerOutputs.push(envelope), async () => answerAgent);
  await answerServer.handleLine(request("createRun", "credential-answer", { goal: "Write a safe explanation" }));
  await answerServer.handleLine(request("continueRun", "credential-answer", { answers: { Q1: `Developers ${encodedAnswerCredential}` } }));
  assert.equal(answerOutputs.at(-1)?.type, "error");
  assert.equal(answerOutputs.some((output) => JSON.stringify(output).includes(answerCredential)), false);
  assert.equal(answerOutputs.some((output) => JSON.stringify(output).includes(encodedAnswerCredential)), false);
});

test("JSONL server rejects raw and encoded credentials in correlation metadata before retention or reflection", async () => {
  const credential = "opaqueRpcCorrelationCredential123456789";
  registerRuntimeCredential(credential);
  let agentCalls = 0;
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => ({
    complete: async () => {
      agentCalls += 1;
      return reply({ summary: "Unexpected", questions: [] });
    },
  }));
  await server.handleLine(requestWithID("hello", encodeURIComponent(credential), "safe-request", {}));
  await server.handleLine(requestWithID("hello", "safe-run", credential.replace("C", "%43"), {}));
  await server.handleLine(requestWithID("hello", "safe-run", "%25".repeat(17), {}));
  assert.equal(agentCalls, 0);
  assert.equal(outputs.length, 3);
  assert.ok(outputs.every((output) => output.type === "error" && output.runID === "protocol" && output.requestID === "unknown"));
  assert.ok(outputs.every((output) => !JSON.stringify(output).includes(credential)));
});

test("stateless clarification summaries are credential-checked before restoring run state", async () => {
  const credential = "csk-syntheticrpcsummary123456789";
  const encodedCredential = credential.replace("-", "%2D");
  registerRuntimeCredential(credential);
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  let calls = 0;
  const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => ({
    complete: async () => {
      calls += 1;
      return reply({});
    },
  }));
  await server.handleLine(request("continueRun", "credential-summary", {
    goal: "Write a safe explanation",
    clarification: {
      summary: `Unsafe ${encodedCredential}`,
      questions: [{ id: "Q1", question: "Audience?", whyItMatters: "Scope" }],
    },
    answers: { Q1: "Developers" },
  }));
  assert.equal(calls, 0);
  assert.equal(outputs.at(-1)?.type, "error");
});

test("JSONL server rejects malformed, unknown, duplicate, and over-broad input", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
  await server.handleLine("not json");
  await server.handleLine(request("futureRequest", "r", {}));
  await server.handleLine(requestWithID("hello", "r", "same", {}));
  await server.handleLine(requestWithID("hello", "r", "same", {}));
  await server.handleLine(requestWithID("createRun", "large", "large-1", { goal: "x".repeat(50_001) }));
  assert.deepEqual(
    outputs.filter((output) => output.type === "error").map((output) => (output.payload as { code: string }).code),
    ["invalid_json", "unknown_request", "duplicate_request", "invalid_input"],
  );
});

test("credential status leaves built-in Pi authentication opaque", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "lightningloop-rpc-provider-"));
  const configPath = join(configDirectory, "provider.json");
  const originalConfigPath = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "openai-codex",
      preset: "openai-codex",
      displayName: "OpenAI Codex",
      baseURL: "https://api.openai.com/v1",
      modelID: "gpt-5.6-terra",
      modelName: "GPT-5.6 Terra",
      supportsImages: true,
      contextWindow: 400_000,
      maxOutputTokens: 131_072,
    }), "utf8");
    process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = configPath;
    const outputs: ProtocolEnvelope<string, unknown>[] = [];
    const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
    await server.handleLine(request("credentialStatus", "auth", {}));
    const payload = outputs.at(-1)?.payload as { providers: { inference: unknown; piManaged: unknown } };
    assert.equal(payload.providers.inference, "Pi-managed/unknown");
    assert.equal(payload.providers.piManaged, true);
  } finally {
    if (originalConfigPath === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = originalConfigPath;
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("continueRun can recover statelessly into a fail-closed paused state", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const agent = new FakeAgent([
    reply({ criteria: [{ id: "C1", title: "Done", detail: "Finish", evidence: "User accepts final copy", evidence_kind: "user_acceptance", evidence_target: "final-copy" }], plan: [{ id: "P1", title: "Write", detail: "Write", proof: "Inspect" }], risks: [], acceptance_test: "Done" }),
    reply({ verdict: "pass", score: 9, summary: "Approved", findings: [], required_changes: [] }),
    reply({ deliverable: "Done", notes: [] }),
    reply({ verdict: "pass", score: 10, summary: "Gold", criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Result says Done", evidence_refs: ["deliverable"] }], findings: [], required_changes: [] }),
  ]);
  const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => agent);
  await server.handleLine(request("continueRun", "recovered", {
    goal: "Finish",
    clarification: {
      summary: "Finish",
      questions: [{ id: "Q1", question: "Audience?", whyItMatters: "Defines fit" }],
    },
    answers: { Q1: "Developers" },
    maxReviewCycles: 1,
  }));
  assert.equal(outputs.some((output) => output.type === "runPaused"), true);
});

test("cancelRun aborts an active model request and reports cancellation", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const agent: AgentAdapter = {
    complete: async (_request, signal) => new Promise<AgentReply>((_resolve, reject) => {
      signalStarted?.();
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  };
  const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => agent);
  const running = server.handleLine(requestWithID("createRun", "cancelled", "create", { goal: "Wait" }));
  await started;
  await server.handleLine(requestWithID("cancelRun", "cancelled", "cancel", {}));
  await running;
  assert.equal(outputs.some((output) => output.type === "response" && output.requestID === "cancel"), true);
  assert.equal(outputs.some((output) => output.type === "error" && (output.payload as { code: string }).code === "cancelled"), true);
});

test("JSONL artifact capability writes and verifies a real file but pauses for owner objective acceptance", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-rpc-artifact-"));
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const agent = new FakeAgent([
    reply({ criteria: [{ id: "C1", title: "Harness syntax predicate", detail: "syntax:app.js must parse without syntax errors.", evidence: "Harness-owned parser check syntax:app.js succeeds without workspace mutation.", evidence_kind: "syntax", evidence_target: "syntax:app.js" }], plan: [{ id: "P1", title: "Write", detail: "Write app.js", proof: "Hash and parse check" }], risks: [], acceptance_test: "app.js parses" }),
    reply({ verdict: "pass", score: 9, summary: "Approved", findings: [], required_changes: [] }),
    reply({
      deliverable: "Created app.js",
      notes: [],
      files: [{ path: "app.js", content: "console.log('Done');\n" }],
      verification_commands: [{ executable: "node", arguments: ["--check", "app.js"], purpose: "Parse app.js" }],
    }),
    reply({ verdict: "pass", score: 10, summary: "Gold", criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Harness report records app.js and harness-owned parse check", evidence_refs: ["file:app.js", "command:2"] }], findings: [], required_changes: [] }),
  ]);
  try {
    const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => agent);
    await server.handleLine(request("continueRun", "artifact-run", {
      goal: "Create app.js",
      clarification: { summary: "Create it", questions: [{ id: "Q1", question: "Audience?", whyItMatters: "Scope" }] },
      answers: { Q1: "Developers" },
      artifactWorkspace: workspace,
      approveArtifactWrites: true,
      approveVerificationCommands: true,
      maxReviewCycles: 1,
    }));
    assert.equal(await readFile(join(workspace, "app.js"), "utf8"), "console.log('Done');\n");
    const paused = outputs.find((output) => output.type === "runPaused"
      && Boolean((output.payload as { artifactReport?: unknown } | undefined)?.artifactReport));
    const payload = paused?.payload as { completed?: boolean; artifactReport?: { passed: boolean } } | undefined;
    assert.ok(payload, "Expected the terminal paused result with its verified artifact report.");
    assert.equal(payload.completed, false);
    assert.equal(payload?.artifactReport?.passed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("JSONL server rejects artifact paths or verification without matching grants", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
  const recovered = {
    goal: "Create a file",
    clarification: { summary: "Create it", questions: [{ id: "Q1", question: "Audience?", whyItMatters: "Scope" }] },
    answers: { Q1: "Developers" },
  };
  await server.handleLine(requestWithID("continueRun", "artifact-denied", "commands", {
    ...recovered,
    approveVerificationCommands: true,
  }));
  await server.handleLine(requestWithID("continueRun", "artifact-denied-2", "path", {
    ...recovered,
    artifactWorkspace: "/tmp/not-granted",
  }));
  const errors = outputs.filter((output) => output.type === "error").map((output) => (output.payload as { code: string }).code);
  assert.deepEqual(errors, ["capability_denied", "capability_denied"]);
});
