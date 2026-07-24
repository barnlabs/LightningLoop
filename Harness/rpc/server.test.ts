import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter, AgentReply } from "../core/loop-types.js";
import { registerRuntimeCredential } from "../core/credential-safety.js";
import { loadProviderProfile } from "../core/provider-profile.js";
import { PROTOCOL_VERSION, type ProtocolEnvelope } from "../core/schema.js";
import { JsonlHarnessServer, type RuntimeModelCatalog } from "./server.js";

const reply = (content: unknown): AgentReply => ({ content: JSON.stringify(content), usage: { input: 1, output: 1, total: 2, cost: 0 } });

class FakeAgent implements AgentAdapter {
  constructor(private readonly replies: AgentReply[]) {}
  async complete(): Promise<AgentReply> {
    const next = this.replies.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  }
}

function requestPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (type !== "createRun" && type !== "continueRun") return payload;
  const profile = loadProviderProfile();
  return {
    expectedProviderID: profile.id,
    expectedModelID: profile.modelID,
    expectedSupportsImages: profile.supportsImages,
    expectedContextWindow: profile.contextWindow,
    expectedMaxOutputTokens: profile.maxOutputTokens,
    ...payload,
  };
}

function request(type: string, runID: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, runID, requestID: `${type}-1`, timestamp: new Date().toISOString(), payload: requestPayload(type, payload) });
}

function requestWithID(type: string, runID: string, requestID: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, runID, requestID, timestamp: new Date().toISOString(), payload: requestPayload(type, payload) });
}

function testServer(
  emit: ConstructorParameters<typeof JsonlHarnessServer>[0],
  agentFactory: ConstructorParameters<typeof JsonlHarnessServer>[1],
): JsonlHarnessServer {
  return new JsonlHarnessServer(emit, agentFactory, async (profile) => ({
    providerID: profile.id,
    models: profile.piProviderID ? [{
      modelID: profile.modelID,
      modelName: profile.modelName,
      supportsImages: profile.supportsImages,
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
    }] : [],
  }));
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
  const server = testServer((envelope) => outputs.push(envelope), async () => agent);
  await server.handleLine(request("createRun", "run-1", { goal: "Finish" }));
  await server.handleLine(request("continueRun", "run-1", { answers: { Q1: "Developers" }, maxReviewCycles: 1 }));
  assert.equal(outputs.some((output) => output.type === "runPaused"), true, JSON.stringify(outputs));
  assert.equal(outputs.at(-1)?.type, "response");
  assert.equal(outputs.at(-1)?.requestID, "continueRun-1");
});

test("concurrent createRun requests reserve one run ID before async model selection", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  let factoryInvocations = 0;
  const server = testServer((envelope) => outputs.push(envelope), async () => {
    factoryInvocations += 1;
    return new FakeAgent([
      reply({ summary: "Finish", questions: [{ id: "Q1", question: "Audience?", why_it_matters: "Defines fit" }] }),
    ]);
  });

  await Promise.all([
    server.handleLine(requestWithID("createRun", "concurrent-create", "first", { goal: "Finish" })),
    server.handleLine(requestWithID("createRun", "concurrent-create", "second", { goal: "Finish" })),
  ]);

  assert.equal(factoryInvocations, 1);
  assert.equal(outputs.filter((output) => output.type === "response" && output.runID === "concurrent-create").length, 1);
  const conflicts = outputs.filter((output) => output.type === "error"
    && (output.payload as { code?: string }).code === "run_conflict");
  assert.equal(conflicts.length, 1);
});

test("concurrent stateless continueRun requests reserve one run ID before async model selection", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  let factoryInvocations = 0;
  const server = testServer((envelope) => outputs.push(envelope), async () => {
    factoryInvocations += 1;
    return new FakeAgent([
      reply({ criteria: [{ id: "C1", title: "Done", detail: "Finish", evidence: "Owner accepts", evidence_kind: "user_acceptance", evidence_target: "final" }], plan: [{ id: "P1", title: "Write", detail: "Write", proof: "Inspect" }], risks: [], acceptance_test: "Done" }),
      reply({ verdict: "pass", score: 9, summary: "Approved", findings: [], required_changes: [] }),
      reply({ deliverable: "Done", notes: [] }),
      reply({ verdict: "pass", score: 10, summary: "Reviewed", criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Done", evidence_refs: ["deliverable"] }], findings: [], required_changes: [] }),
    ]);
  });
  const payload = {
    goal: "Finish",
    clarification: { summary: "Ready", questions: [{ id: "Q1", question: "Continue?", whyItMatters: "Scope" }] },
    answers: { Q1: "Yes" },
    maxReviewCycles: 1,
  };

  await Promise.all([
    server.handleLine(requestWithID("continueRun", "concurrent-continue", "first", payload)),
    server.handleLine(requestWithID("continueRun", "concurrent-continue", "second", payload)),
  ]);

  assert.equal(factoryInvocations, 1);
  assert.equal(outputs.filter((output) => output.type === "response" && output.runID === "concurrent-continue").length, 1);
  const conflicts = outputs.filter((output) => output.type === "error"
    && (output.payload as { code?: string }).code === "run_conflict");
  assert.equal(conflicts.length, 1);
});

test("JSONL server rejects versions, secret fields, and oversized input without crashing", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const server = testServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
  await server.handleLine(JSON.stringify({ protocolVersion: 99, type: "hello", runID: "r", requestID: "q", timestamp: new Date().toISOString(), payload: {} }));
  await server.handleLine(request("createRun", "r", { api_key: "synthetic-secret-value" }));
  await server.handleLine("x".repeat(1_048_577));
  assert.deepEqual(outputs.map((output) => output.type), ["error", "error", "error"]);
  assert.deepEqual(outputs.map((output) => (output.payload as { code: string }).code), ["unsupported_version", "request_failed", "message_too_large"]);
});

test("JSONL server enforces strict UTF-8 and exact envelope and payload fields", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const server = testServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
  await server.handleRawLine(Uint8Array.from([0x7b, 0xff, 0x7d]));
  await server.handleLine(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "hello",
    runID: "exact",
    requestID: "extra-envelope",
    timestamp: new Date().toISOString(),
    payload: {},
    extra: true,
  }));
  await server.handleLine(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "createRun",
    runID: "exact",
    requestID: "missing-capabilities",
    timestamp: new Date().toISOString(),
    payload: { goal: "Do not launch", expectedProviderID: "cerebras", expectedModelID: "model" },
  }));
  assert.deepEqual(outputs.map((output) => (output.payload as { code: string }).code), [
    "invalid_utf8",
    "invalid_input",
    "invalid_input",
  ]);
  assert.ok(outputs.every((output) => output.runID === "protocol" || output.runID === "exact"));
});

test("continueRun emits one ordered terminal stage before matching terminal and response envelopes", async () => {
  const outputs: ProtocolEnvelope<string, unknown>[] = [];
  const agent = new FakeAgent([
    reply({ criteria: [{ id: "C1", title: "Done", detail: "Finish", evidence: "Owner acceptance", evidence_kind: "user_acceptance", evidence_target: "final" }], plan: [{ id: "P1", title: "Write", detail: "Write", proof: "Inspect" }], risks: [], acceptance_test: "Done" }),
    reply({ verdict: "pass", score: 9, summary: "Approved", findings: [], required_changes: [] }),
    reply({ deliverable: "Done", notes: [] }),
    reply({ verdict: "pass", score: 10, summary: "Reviewed", criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Done", evidence_refs: ["deliverable"] }], findings: [], required_changes: [] }),
  ]);
  const server = testServer((envelope) => outputs.push(envelope), async () => agent);
  await server.handleLine(request("continueRun", "stage-sequence", {
    goal: "Finish",
    clarification: { summary: "Ready", questions: [{ id: "Q1", question: "Continue?", whyItMatters: "Scope" }] },
    answers: { Q1: "Yes" },
    maxReviewCycles: 1,
  }));
  const terminalStageIndexes = outputs.flatMap((output, index) => output.type === "stageChanged"
    && ["gold", "paused"].includes(String((output.payload as { stage?: string }).stage)) ? [index] : []);
  assert.equal(terminalStageIndexes.length, 1);
  const terminalIndex = terminalStageIndexes[0];
  assert.ok(terminalIndex !== undefined);
  assert.equal((outputs[terminalIndex]?.payload as { stage: string }).stage, "paused");
  assert.equal(outputs[terminalIndex + 1]?.type, "runPaused");
  assert.equal(outputs[terminalIndex + 2]?.type, "response");
  assert.deepEqual(outputs[terminalIndex + 1]?.payload, (outputs[terminalIndex + 2]?.payload as { result: unknown }).result);
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
  const goalServer = testServer((envelope) => goalOutputs.push(envelope), async () => ({
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
  const answerServer = testServer((envelope) => answerOutputs.push(envelope), async () => answerAgent);
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
  const server = testServer((envelope) => outputs.push(envelope), async () => ({
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
  const server = testServer((envelope) => outputs.push(envelope), async () => ({
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
  const server = testServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
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

test("run RPCs bind the caller-selected provider and model before agent creation", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "lightningloop-rpc-expected-model-"));
  const configPath = join(configDirectory, "provider.json");
  const originalConfigPath = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  const profile = {
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
  };
  const catalog: RuntimeModelCatalog = {
    providerID: profile.id,
    models: [{
      modelID: profile.modelID,
      modelName: profile.modelName,
      supportsImages: profile.supportsImages,
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
    }],
  };
  try {
    await writeFile(configPath, JSON.stringify(profile), "utf8");
    process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = configPath;

    const positiveOutputs: ProtocolEnvelope<string, unknown>[] = [];
    const positiveAgent = new FakeAgent([
      reply({ summary: "Finish", questions: [{ id: "Q1", question: "Audience?", why_it_matters: "Defines fit" }] }),
      reply({ criteria: [{ id: "C1", title: "Done", detail: "Finish", evidence: "User accepts final copy", evidence_kind: "user_acceptance", evidence_target: "final-copy" }], plan: [{ id: "P1", title: "Write", detail: "Write", proof: "Inspect" }], risks: [], acceptance_test: "Done" }),
      reply({ verdict: "pass", score: 9, summary: "Approved", findings: [], required_changes: [] }),
      reply({ deliverable: "Done", notes: [] }),
      reply({ verdict: "pass", score: 10, summary: "Gold", criteria: [{ criterion_id: "C1", status: "satisfied", evidence: "Result says Done", evidence_refs: ["deliverable"] }], findings: [], required_changes: [] }),
    ]);
    const factorySelections: Array<{ providerID: string; modelID: string; supportsImages: boolean; contextWindow: number; maxOutputTokens: number }> = [];
    const positiveServer = new JsonlHarnessServer(
      (envelope) => positiveOutputs.push(envelope),
      async (selectedProfile) => {
        factorySelections.push({
          providerID: selectedProfile.id,
          modelID: selectedProfile.modelID,
          supportsImages: selectedProfile.supportsImages,
          contextWindow: selectedProfile.contextWindow,
          maxOutputTokens: selectedProfile.maxOutputTokens,
        });
        return positiveAgent;
      },
      async () => catalog,
    );
    await positiveServer.handleLine(request("createRun", "bound-positive", { goal: "Finish" }));
    await positiveServer.handleLine(request("continueRun", "bound-positive", { answers: { Q1: "Developers" }, maxReviewCycles: 1 }));
    assert.deepEqual(factorySelections, [
      { providerID: profile.id, modelID: profile.modelID, supportsImages: true, contextWindow: 400_000, maxOutputTokens: 131_072 },
      { providerID: profile.id, modelID: profile.modelID, supportsImages: true, contextWindow: 400_000, maxOutputTokens: 131_072 },
    ]);
    assert.equal(positiveOutputs.at(-1)?.type, "response");

    const mismatchOutputs: ProtocolEnvelope<string, unknown>[] = [];
    let mismatchAgentFactoryCalls = 0;
    let mismatchCatalogCalls = 0;
    const mismatchServer = new JsonlHarnessServer(
      (envelope) => mismatchOutputs.push(envelope),
      async () => {
        mismatchAgentFactoryCalls += 1;
        return new FakeAgent([]);
      },
      async () => {
        mismatchCatalogCalls += 1;
        return catalog;
      },
    );
    await mismatchServer.handleLine(request("createRun", "bound-create-mismatch", {
      goal: "Must not launch",
      expectedModelID: "different-model",
    }));
    await mismatchServer.handleLine(request("continueRun", "bound-continue-mismatch", {
      goal: "Must not launch",
      clarification: { summary: "Ready", questions: [{ id: "Q1", question: "Continue?", whyItMatters: "Scope" }] },
      answers: { Q1: "Yes" },
      expectedProviderID: "cerebras",
    }));
    assert.deepEqual(
      mismatchOutputs.map((output) => (output.payload as { code?: string }).code),
      ["model_selection_mismatch", "model_selection_mismatch"],
    );
    assert.equal(mismatchCatalogCalls, 0);
    assert.equal(mismatchAgentFactoryCalls, 0);

    const driftOutputs: ProtocolEnvelope<string, unknown>[] = [];
    let driftAgentCalls = 0;
    const driftServer = new JsonlHarnessServer(
      (envelope) => driftOutputs.push(envelope),
      async () => {
        driftAgentCalls += 1;
        return new FakeAgent([]);
      },
      async () => catalog,
    );
    await driftServer.handleLine(request("createRun", "bound-capability-drift", {
      goal: "Must not launch on stale capability metadata",
      expectedSupportsImages: !profile.supportsImages,
    }));
    await driftServer.handleLine(request("createRun", "bound-limit-drift", {
      goal: "Must not launch on stale token limits",
      expectedContextWindow: profile.contextWindow - 1,
    }));
    assert.deepEqual(driftOutputs.map((output) => (output.payload as { code: string }).code), [
      "model_catalog_drift",
      "model_catalog_drift",
    ]);
    assert.equal(driftAgentCalls, 0);
  } finally {
    if (originalConfigPath === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = originalConfigPath;
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("credential status leaves built-in runtime authentication opaque", async () => {
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
    const server = testServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
    await server.handleLine(request("credentialStatus", "auth", {}));
    const payload = outputs.at(-1)?.payload as { providers: { inference: unknown; piManaged: unknown } };
    assert.equal(payload.providers.inference, "runtime-managed/unknown");
    assert.equal(payload.providers.piManaged, true);
  } finally {
    if (originalConfigPath === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = originalConfigPath;
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("runtime model catalog guards the Cerebras public-preview Gemma preference and only launches an exactly catalogued model", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "lightningloop-rpc-model-catalog-"));
  const configPath = join(configDirectory, "provider.json");
  const originalConfigPath = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  let agentCalls = 0;
  const catalog: RuntimeModelCatalog = {
    providerID: "cerebras",
    models: [{
      modelID: "gpt-oss-120b",
      modelName: "OpenAI GPT OSS",
      supportsImages: false,
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
    }],
  };
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "cerebras",
      preset: "cerebras",
      displayName: "Cerebras Inference",
      baseURL: "https://api.cerebras.ai/v1",
      modelID: "gemma-4-31b",
      modelName: "Gemma 4 31B",
      supportsImages: true,
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
    }), "utf8");
    process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = configPath;
    const outputs: ProtocolEnvelope<string, unknown>[] = [];
    const server = new JsonlHarnessServer(
      (envelope) => outputs.push(envelope),
      async () => ({
        complete: async () => {
          agentCalls += 1;
          return reply({ summary: "Unexpected", questions: [] });
        },
      }),
      async () => catalog,
    );

    await server.handleLine(request("hello", "gemma", {}));
    const hello = outputs.at(-1)?.payload as { model: unknown };
    assert.equal(hello.model, "gemma-4-31b");

    await server.handleLine(request("providerModels", "gemma", {}));
    const modelPayload = outputs.at(-1)?.payload as {
      selectedModelCatalogued: unknown;
      selectionNotice: unknown;
      models: Array<{ modelID: string }>;
    };
    assert.equal(modelPayload.selectedModelCatalogued, false);
    assert.match(String(modelPayload.selectionNotice), /public-preview/i);
    assert.deepEqual(modelPayload.models.map((model) => model.modelID), ["gpt-oss-120b"]);

    await server.handleLine(request("createRun", "gemma", { goal: "Do not launch an unavailable model" }));
    const error = outputs.at(-1)?.payload as { code: unknown; message: unknown };
    assert.equal(error.code, "model_unavailable");
    assert.match(String(error.message), /Google\/Gemma 4 31B|Gemma 4 31B/i);
    assert.equal(agentCalls, 0);

    let cataloguedAgentCalls = 0;
    const cataloguedOutputs: ProtocolEnvelope<string, unknown>[] = [];
    const cataloguedServer = new JsonlHarnessServer(
      (envelope) => cataloguedOutputs.push(envelope),
      async () => ({
        complete: async () => {
          cataloguedAgentCalls += 1;
          return reply({ summary: "Ready", questions: [{ id: "Q1", question: "What scope?", why_it_matters: "Defines the task" }] });
        },
      }),
      async () => ({
        providerID: "cerebras",
        models: [{
          modelID: "gemma-4-31b",
          modelName: "Gemma 4 31B",
          supportsImages: true,
          contextWindow: 131_072,
          maxOutputTokens: 32_768,
        }],
      }),
    );
    await cataloguedServer.handleLine(request("createRun", "gemma-catalogued", { goal: "Launch the exact catalogued model" }));
    assert.equal(cataloguedAgentCalls, 1);
    assert.equal(cataloguedOutputs.at(-1)?.type, "response");
    assert.equal((cataloguedOutputs.at(-1)?.payload as { stage: unknown }).stage, "awaiting_answers");

    let factoryProfileID = "";
    let factoryModelID = "";
    const racedOutputs: ProtocolEnvelope<string, unknown>[] = [];
    const racedServer = new JsonlHarnessServer(
      (envelope) => racedOutputs.push(envelope),
      async (profile) => {
        factoryProfileID = profile.id;
        factoryModelID = profile.modelID;
        return {
          complete: async () => reply({ summary: "Snapshot preserved", questions: [{ id: "Q1", question: "Continue?", why_it_matters: "Confirms the run" }] }),
        };
      },
      async () => {
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
        return {
          providerID: "cerebras",
          models: [{
            modelID: "gemma-4-31b",
            modelName: "Gemma 4 31B",
            supportsImages: true,
            contextWindow: 131_072,
            maxOutputTokens: 32_768,
          }],
        };
      },
    );
    await racedServer.handleLine(request("createRun", "profile-snapshot", { goal: "Keep catalog validation and launch on one profile snapshot" }));
    assert.equal(factoryProfileID, "cerebras");
    assert.equal(factoryModelID, "gemma-4-31b");
    assert.equal(racedOutputs.at(-1)?.type, "response");
  } finally {
    if (originalConfigPath === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = originalConfigPath;
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("runtime model catalog rejects malformed or duplicate catalog entries", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "lightningloop-rpc-invalid-model-catalog-"));
  const configPath = join(configDirectory, "provider.json");
  const originalConfigPath = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "cerebras",
      preset: "cerebras",
      displayName: "Cerebras Inference",
      baseURL: "https://api.cerebras.ai/v1",
      modelID: "gpt-oss-120b",
      modelName: "GPT OSS 120B",
      supportsImages: false,
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
    }), "utf8");
    process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = configPath;
    const invalidCatalogs: RuntimeModelCatalog[] = [
      {
        providerID: "cerebras",
        models: [{ modelID: "duplicate", modelName: "First", supportsImages: false, contextWindow: 1_024, maxOutputTokens: 256 }, { modelID: "duplicate", modelName: "Second", supportsImages: false, contextWindow: 1_024, maxOutputTokens: 256 }],
      },
      {
        providerID: "cerebras",
        models: [{ modelID: "valid-id", modelName: "", supportsImages: false, contextWindow: 1_024, maxOutputTokens: 256 }],
      },
    ];
    for (const [index, catalog] of invalidCatalogs.entries()) {
      const outputs: ProtocolEnvelope<string, unknown>[] = [];
      const server = new JsonlHarnessServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]), async () => catalog);
      await server.handleLine(request("providerModels", `invalid-${index}`, {}));
      const error = outputs.at(-1)?.payload as { code: unknown };
      assert.equal(error.code, "invalid_runtime_catalog");
    }
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
  const server = testServer((envelope) => outputs.push(envelope), async () => agent);
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
  const server = testServer((envelope) => outputs.push(envelope), async () => agent);
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
    const server = testServer((envelope) => outputs.push(envelope), async () => agent);
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
  const server = testServer((envelope) => outputs.push(envelope), async () => new FakeAgent([]));
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
