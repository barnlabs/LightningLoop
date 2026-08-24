import assert from "node:assert/strict";
import test from "node:test";
import { LoopEngine } from "./loop-engine.js";
import type { AgentAdapter, AgentReply } from "./loop-types.js";

const reply = (content: unknown): AgentReply => ({
  content: JSON.stringify(content),
  usage: { input: 1, output: 1, total: 2, cost: 0 },
});

class InspectingAgent implements AgentAdapter {
  readonly requests: Parameters<AgentAdapter["complete"]>[0][] = [];
  constructor(private readonly replies: AgentReply[]) {}
  async complete(request: Parameters<AgentAdapter["complete"]>[0]): Promise<AgentReply> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (!next) throw new Error("Unexpected agent call");
    return next;
  }
}

test("clarification (Researcher) loads approved researcher skills and hides Engineer bodies", async () => {
  const agent = new InspectingAgent([
    reply({ summary: "Scoped", questions: [{ id: "Q1", question: "Audience?", why_it_matters: "Scope" }] }),
  ]);
  const engine = new LoopEngine(agent, {
    approvedSkills: [
      "audience: researcher\nOnly open .gov primary sources for this project.",
      "audience: engineer\nNever invent files.",
    ],
  });
  await engine.clarify("Create a brief");
  assert.match(agent.requests[0]?.system ?? "", /LOOP AGENT: researcher/);
  assert.match(agent.requests[0]?.system ?? "", /AVAILABLE TOOLS \(this role\): search, browse, read/);
  assert.match(agent.requests[0]?.system ?? "", /Only open \.gov primary sources/);
  assert.doesNotMatch(agent.requests[0]?.system ?? "", /Never invent files/);
});
