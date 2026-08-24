import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter, AgentReply, AgentRequest } from "./loop-types.js";
import {
  EMPTY_ROSTER,
  LOOP_AGENTS,
  RosterAdapter,
  formatRosterLines,
  isLoopAgent,
  loadLoopRoster,
  loopAgentForRequestRole,
  parseLoopRoster,
  resolveAgentModelID,
  saveLoopAgentModel,
} from "./loop-roster.js";

function reply(content: string): AgentReply {
  return { content, usage: { input: 1, output: 1, total: 2, cost: 0 } };
}

function mockAdapter(label: string): AgentAdapter {
  return {
    complete: async (request: AgentRequest) => reply(`${label}:${request.role}`),
  };
}

test("role mapping is Researcher / Engineer / Verifier", () => {
  assert.equal(loopAgentForRequestRole("orchestrator"), "researcher");
  assert.equal(loopAgentForRequestRole("implementer"), "engineer");
  assert.equal(loopAgentForRequestRole("reviewer"), "verifier");
  assert.equal(isLoopAgent("researcher"), true);
  assert.equal(isLoopAgent("orchestrator"), false);
});

test("roster parse is fail-closed and credential-free", () => {
  assert.deepEqual(parseLoopRoster({
    schemaVersion: 1,
    agents: { researcher: { modelID: "openrouter/free" } },
  }).agents.researcher.modelID, "openrouter/free");
  assert.throws(() => parseLoopRoster({ schemaVersion: 2, agents: {} }), /unsupported/);
  assert.throws(() => parseLoopRoster({
    schemaVersion: 1,
    agents: { researcher: { modelID: "bad\nid" } },
  }), /invalid/);
});

test("save/load pins one agent model without touching the others", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lightningloop-roster-"));
  const path = join(directory, "agents.json");
  try {
    assert.deepEqual(loadLoopRoster(path), EMPTY_ROSTER);
    const saved = saveLoopAgentModel("engineer", "vendor/model-a", path);
    assert.equal(saved.agents.engineer.modelID, "vendor/model-a");
    assert.equal(saved.agents.researcher.modelID, "");
    const encoded = await readFile(path, "utf8");
    assert.doesNotMatch(encoded, /api.?key|bearer/iu);
    assert.equal(loadLoopRoster(path).agents.engineer.modelID, "vendor/model-a");
    assert.throws(() => saveLoopAgentModel("engineer", "no spaces allowed!", path), /invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RosterAdapter routes each request to the matching agent model", async () => {
  const provenance: string[] = [];
  const adapter = new RosterAdapter(
    [
      { agent: "researcher", modelID: "r-model", adapter: mockAdapter("R") },
      { agent: "engineer", modelID: "e-model", adapter: mockAdapter("E") },
      { agent: "verifier", modelID: "v-model", adapter: mockAdapter("V") },
    ],
    mockAdapter("fallback"),
    (entry) => provenance.push(`${entry.agent}:${entry.modelID}`),
  );
  const request = (role: AgentRequest["role"]): AgentRequest => ({
    role, system: "s", user: "u", temperature: 0, maxTokens: 16,
  });
  assert.equal((await adapter.complete(request("orchestrator"))).content, "R:orchestrator");
  assert.equal((await adapter.complete(request("implementer"))).content, "E:implementer");
  assert.equal((await adapter.complete(request("reviewer"))).content, "V:reviewer");
  assert.deepEqual(provenance, ["researcher:r-model", "engineer:e-model", "verifier:v-model"]);
});

test("unpinned agents fall back to the provider model", () => {
  const roster = parseLoopRoster({
    schemaVersion: 1,
    agents: { verifier: { modelID: "pin-v" } },
  });
  assert.equal(resolveAgentModelID(roster, "researcher", "provider-default"), "provider-default");
  assert.equal(resolveAgentModelID(roster, "verifier", "provider-default"), "pin-v");
  assert.deepEqual(formatRosterLines(roster, "provider-default"), [
    "researcher: provider-default · provider default",
    "engineer: provider-default · provider default",
    "verifier: pin-v · pinned",
  ]);
  assert.deepEqual(LOOP_AGENTS.length, 3);
});
