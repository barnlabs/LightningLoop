import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter, AgentReply, AgentRequest, AgentUsage } from "./loop-types.js";
import {
  FusionAdapter,
  buildOpenRouterFusionMembers,
  parseFusionModelIds,
  type FusionCallProvenance,
} from "./fusion-adapter.js";
import { profileForPreset } from "./provider-profile.js";
import { LoopEngine } from "./loop-engine.js";

function usage(input: number, output: number, cost = 0): AgentUsage {
  return { input, output, total: input + output, cost };
}

class ScriptedAdapter implements AgentAdapter {
  readonly supportsImages = false;
  calls = 0;
  private readonly replies: AgentReply[];
  constructor(replies: AgentReply[]) {
    this.replies = [...replies];
  }
  async complete(): Promise<AgentReply> {
    this.calls += 1;
    const next = this.replies.shift();
    if (!next) throw new Error("Unexpected fusion member call");
    return next;
  }
}

class MockAdapter implements AgentAdapter {
  readonly supportsImages?: boolean;
  private readonly outcome: AgentReply | Error;
  calls = 0;
  constructor(outcome: AgentReply | Error, supportsImages?: boolean) {
    this.outcome = outcome;
    if (supportsImages !== undefined) this.supportsImages = supportsImages;
  }
  async complete(_request: AgentRequest): Promise<AgentReply> {
    this.calls += 1;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

const request: AgentRequest = {
  role: "implementer",
  system: "system",
  user: "user",
  temperature: 0,
  maxTokens: 128,
};

test("FusionAdapter requires at least two members and rejects duplicates", () => {
  const only = new MockAdapter({ content: "one", usage: usage(1, 1) });
  assert.throws(() => new FusionAdapter([{ model: "a", adapter: only }]), /at least 2 member/u);
  assert.throws(
    () => new FusionAdapter([
      { model: "dup", adapter: only },
      { model: "dup", adapter: new MockAdapter({ content: "two", usage: usage(1, 1) }) },
    ]),
    /unique/u,
  );
});

test("FusionAdapter longest strategy runs both members, selects longest, records provenance and aggregate usage", async () => {
  const short = new MockAdapter({ content: "short", usage: usage(10, 5, 0.01) });
  const long = new MockAdapter({ content: "a much longer reply body", usage: usage(20, 30, 0.02) });
  const captured: FusionCallProvenance[] = [];
  const fusion = new FusionAdapter(
    [{ model: "free/model", adapter: short }, { model: "paid/model", adapter: long }],
    { strategy: "longest", onProvenance: (p) => captured.push(p) },
  );
  const reply = await fusion.complete(request);
  // Both members were actually run for the request.
  assert.equal(short.calls, 1);
  assert.equal(long.calls, 1);
  // The longest reply is selected as content; usage is aggregated across models.
  assert.equal(reply.content, "a much longer reply body");
  assert.deepEqual(reply.usage, usage(30, 35, 0.03));
  // Provenance records both members and which one was selected.
  assert.equal(captured.length, 1);
  const provenance = captured[0]!;
  assert.equal(provenance.selectedModel, "paid/model");
  assert.equal(provenance.strategy, "longest");
  assert.deepEqual(provenance.members.map((m) => [m.model, m.status, m.selected]), [
    ["free/model", "ok", false],
    ["paid/model", "ok", true],
  ]);
  assert.deepEqual(provenance.aggregateUsage, usage(30, 35, 0.03));
  // The internal log mirrors the sink.
  assert.equal(fusion.provenance().length, 1);
});

test("FusionAdapter first strategy selects the first member deterministically", async () => {
  const first = new MockAdapter({ content: "first-wins", usage: usage(3, 4) });
  const second = new MockAdapter({ content: "a considerably longer body that would win longest", usage: usage(5, 6) });
  const fusion = new FusionAdapter(
    [{ model: "m1", adapter: first }, { model: "m2", adapter: second }],
    { strategy: "first" },
  );
  const reply = await fusion.complete(request);
  assert.equal(reply.content, "first-wins");
  assert.equal(fusion.provenance()[0]?.selectedModel, "m1");
});

test("FusionAdapter advertises image support only when every member supports images", () => {
  const imageCapable = new MockAdapter({ content: "x", usage: usage(1, 1) }, true);
  const textOnly = new MockAdapter({ content: "y", usage: usage(1, 1) }, false);
  assert.equal(new FusionAdapter([{ model: "a", adapter: imageCapable }, { model: "b", adapter: new MockAdapter({ content: "z", usage: usage(1, 1) }, true) }]).supportsImages, true);
  assert.equal(new FusionAdapter([{ model: "a", adapter: imageCapable }, { model: "b", adapter: textOnly }]).supportsImages, false);
});

test("FusionAdapter fails closed when a member errors, recording the failure in provenance", async () => {
  const ok = new MockAdapter({ content: "ok reply", usage: usage(2, 2, 0.01) });
  const broken = new MockAdapter(new Error("provider exploded"));
  const captured: FusionCallProvenance[] = [];
  const fusion = new FusionAdapter(
    [{ model: "good", adapter: ok }, { model: "bad", adapter: broken }],
    { onProvenance: (p) => captured.push(p) },
  );
  await assert.rejects(fusion.complete(request), /failed closed/u);
  // The successful member still ran, but no partial reply was returned.
  assert.equal(ok.calls, 1);
  assert.equal(broken.calls, 1);
  // The failure is recorded and no member is marked selected.
  assert.equal(captured.length, 1);
  const provenance = captured[0]!;
  assert.equal(provenance.selectedModel, "");
  assert.equal(provenance.members.every((m) => m.selected === false), true);
  const badMember = provenance.members.find((m) => m.model === "bad");
  assert.equal(badMember?.status, "error");
  assert.match(badMember?.error ?? "", /provider exploded/u);
});

test("parseFusionModelIds accepts a valid list and rejects malformed input", () => {
  assert.deepEqual(parseFusionModelIds("meta/llama:free, deepseek/v3"), ["meta/llama:free", "deepseek/v3"]);
  assert.throws(() => parseFusionModelIds("only-one"), /at least 2/u);
  assert.throws(() => parseFusionModelIds("dup, dup"), /unique/u);
  assert.throws(() => parseFusionModelIds("bad id!, other/model"), /invalid/u);
  assert.throws(() => parseFusionModelIds("a,b,c,d,e"), /at most 4/u);
});

test("buildOpenRouterFusionMembers maps ids to per-model adapters via an injected factory", async () => {
  const base = profileForPreset("openrouter");
  const seenModelIDs: string[] = [];
  const members = await buildOpenRouterFusionMembers(base, ["deepseek/v3:free", "anthropic/claude"], async (profile) => {
    seenModelIDs.push(profile.modelID);
    assert.equal(profile.preset, "openrouter");
    assert.equal(profile.freeOnly, undefined);
    return new MockAdapter({ content: profile.modelID, usage: usage(1, 1) });
  });
  assert.deepEqual(seenModelIDs, ["deepseek/v3:free", "anthropic/claude"]);
  assert.deepEqual(members.map((m) => m.model), ["deepseek/v3:free", "anthropic/claude"]);
  // The members compose into a working fusion adapter.
  const fusion = new FusionAdapter(members, { strategy: "first" });
  const reply = await fusion.complete(request);
  assert.equal(reply.content, "deepseek/v3:free");
});

test("buildOpenRouterFusionMembers rejects a non-OpenRouter base profile", async () => {
  await assert.rejects(
    buildOpenRouterFusionMembers(profileForPreset("cerebras"), ["a", "b"], async () => new MockAdapter({ content: "x", usage: usage(1, 1) })),
    /OpenRouter/u,
  );
});

test("LoopEngine drives a FusionAdapter as a normal adapter with per-turn provenance and unchanged gates", async () => {
  const behaviorTarget = 'js-export:result.mjs#status="Done"';
  const plan = {
    criteria: [{
      id: "C1",
      title: "Harness behavior predicate",
      detail: `The isolated JavaScript export predicate ${behaviorTarget} must evaluate to its declared scalar.`,
      evidence: `Harness-isolated export invocation for ${behaviorTarget}.`,
      evidence_kind: "behavior",
      evidence_target: behaviorTarget,
    }],
    plan: [{ id: "P1", title: "Write", detail: "Write the result", proof: "Inspect final text" }],
    risks: [],
    acceptance_test: "Final output contains Done",
  };
  const rejectedReview = { verdict: "revise", score: 8, summary: "Still vague", findings: [], required_changes: ["Add proof"] };
  const jsonReply = (content: unknown): AgentReply => ({ content: JSON.stringify(content), usage: usage(10, 5, 0.001) });

  // Two members, each scripted with a plan then a plan review. "first" strategy
  // makes member A authoritative; member B is consulted and recorded but its
  // content is never parsed by the engine.
  const memberA = new ScriptedAdapter([jsonReply(plan), jsonReply(rejectedReview)]);
  const memberB = new ScriptedAdapter([jsonReply({ ...plan, acceptance_test: "variant" }), jsonReply({ ...rejectedReview, summary: "variant" })]);
  const captured: FusionCallProvenance[] = [];
  const fusion = new FusionAdapter(
    [{ model: "free/a", adapter: memberA }, { model: "paid/b", adapter: memberB }],
    { strategy: "first", onProvenance: (p) => captured.push(p) },
  );

  const result = await new LoopEngine(fusion).execute("Finish", { summary: "Finish", questions: [] }, {}, 1);

  // Deterministic gates unchanged: exhausted plan review pauses (never false pass).
  assert.equal(result.completed, false);
  assert.equal(result.stage, "paused");
  assert.match(result.message, /exhaustion never becomes approval/u);
  // Fusion ran BOTH members for every engine turn.
  assert.equal(memberA.calls, 2);
  assert.equal(memberB.calls, 2);
  // Provenance recorded per turn with both contributions and the selected model.
  assert.equal(captured.length, 2);
  for (const provenance of captured) {
    assert.equal(provenance.members.length, 2);
    assert.equal(provenance.selectedModel, "free/a");
    assert.deepEqual(provenance.members.map((m) => m.model), ["free/a", "paid/b"]);
    assert.deepEqual(provenance.aggregateUsage, usage(20, 10, 0.002));
  }
  // Engine-observed usage aggregates across both models for both turns.
  assert.deepEqual(result.usage, usage(40, 20, 0.004));
});
