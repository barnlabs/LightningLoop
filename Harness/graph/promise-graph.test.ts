import assert from "node:assert/strict";
import test from "node:test";
import { PromiseGraph } from "./promise-graph.js";

function isApprovalValue(value: unknown): value is { granted: boolean } {
  return Boolean(value && typeof value === "object" && "granted" in value && typeof value.granted === "boolean");
}


test("runs a bounded cyclic duty graph and records promise evidence", async () => {
  const graph = new PromiseGraph({
    id: "review-cycle",
    entry: "review",
    maxSteps: 5,
    nodes: [
      { id: "review", duty: "Judge the artifact", requires: ["draft"], provides: ["review"], maxVisits: 2, transitions: { revise: "repair", gold: null } },
      { id: "repair", duty: "Repair cited defects", requires: ["review"], provides: ["draft"], maxVisits: 1, transitions: { repaired: "review" } },
    ],
  });
  const result = await graph.run({ draft: "v1" }, {
    review: async ({ visit }) => visit === 1
      ? { route: "revise", promises: { review: "missing proof" }, evidence: ["criterion failed"] }
      : { route: "gold", promises: { review: "approved proof" }, evidence: ["criterion passed"] },
    repair: async () => ({ route: "repaired", promises: { draft: "v2" }, evidence: ["proof added"] }),
  });
  assert.equal(result.terminalRoute, "gold");
  assert.equal(result.promises.get("draft"), "v2");
  assert.deepEqual(result.trace.map((entry) => entry.nodeID), ["review", "repair", "review"]);
});

test("fails closed when a terminal outcome omits a declared promise", async () => {
  const graph = new PromiseGraph({
    id: "terminal-promise-guard",
    entry: "publish",
    maxSteps: 1,
    nodes: [
      { id: "publish", duty: "Publish the artifact", requires: ["draft"], provides: ["release"], maxVisits: 1, transitions: { complete: null } },
    ],
  });

  await assert.rejects(
    () => graph.run({ draft: "v1", release: "stale release" }, {
      publish: async () => ({ route: "complete", evidence: ["artifact is ready"] }),
    }),
    /terminal.*release/i,
  );
});

test("fails closed when a continuing outcome omits a declared promise", async () => {
  const graph = new PromiseGraph({
    id: "continuing-promise-guard",
    entry: "prepare",
    maxSteps: 2,
    nodes: [
      { id: "prepare", duty: "Prepare the artifact", requires: ["input"], provides: ["draft"], maxVisits: 1, transitions: { ready: "publish" } },
      { id: "publish", duty: "Publish the artifact", requires: ["draft"], provides: ["release"], maxVisits: 1, transitions: { complete: null } },
    ],
  });

  await assert.rejects(
    () => graph.run({ input: "source" }, {
      prepare: async () => ({ route: "ready", evidence: ["draft not produced"] }),
      publish: async () => ({ route: "complete", promises: { release: "release" } }),
    }),
    /node prepare omitted declared promises: draft/i,
  );
});

test("fails closed on missing, spoofed, and unbounded promises", async () => {
  const graph = new PromiseGraph({ id: "guard", entry: "a", maxSteps: 2, nodes: [
    { id: "a", duty: "Bounded duty", requires: ["input"], provides: ["output"], maxVisits: 1, transitions: { done: null } },
  ] });
  await assert.rejects(() => graph.run({}, { a: async () => ({ route: "done" }) }), /blocked on promises/);
  await assert.rejects(() => graph.run({ input: true }, { a: async () => ({ route: "done", promises: { admin: true } }) }), /undeclared promises/);
});

test("isolates the promise map from handler mutation attempts", async () => {
  const graph = new PromiseGraph({
    id: "immutable-context",
    entry: "prepare",
    maxSteps: 2,
    nodes: [
      { id: "prepare", duty: "Prepare bounded input", requires: ["input"], provides: [], maxVisits: 1, transitions: { ready: "publish" } },
      { id: "publish", duty: "Publish only a declared release", requires: ["draft"], provides: ["release"], maxVisits: 1, transitions: { complete: null } },
    ],
  });

  await assert.rejects(
    () => graph.run({ input: "source" }, {
      prepare: async (context) => {
        // Test cast simulates a malicious handler bypassing the readonly TypeScript view.
        const mutablePromises = context.promises as Map<string, unknown>;
        mutablePromises.set("draft", "forged");
        return { route: "ready" };
      },
      publish: async () => ({ route: "complete", promises: { release: "forged release" } }),
    }),
    /blocked on promises: draft/i,
  );
});

test("isolates object-valued promises from handler snapshots", async () => {
  const graph = new PromiseGraph({
    id: "immutable-object-context",
    entry: "prepare",
    maxSteps: 2,
    nodes: [
      { id: "prepare", duty: "Prepare bounded input", requires: ["approval"], provides: [], maxVisits: 1, transitions: { ready: "publish" } },
      { id: "publish", duty: "Publish only an approved release", requires: ["approval"], provides: ["release"], maxVisits: 1, transitions: { complete: null } },
    ],
  });
  const approval = { granted: false };

  await assert.rejects(
    () => graph.run({ approval }, {
      prepare: async (context) => {
        const candidate = context.promises.get("approval");
        if (!isApprovalValue(candidate)) throw new Error("Approval promise is malformed.");
        candidate.granted = true;
        return { route: "ready" };
      },
      publish: async (context) => {
        const candidate = context.promises.get("approval");
        if (!isApprovalValue(candidate)) throw new Error("Approval promise is malformed.");
        if (!candidate.granted) throw new Error("Release is not approved.");
        return { route: "complete", promises: { release: "release" } };
      },
    }),
    /release is not approved/i,
  );
  assert.equal(approval.granted, false);
});

test("undefined never fulfills a required promise", async () => {
  const graph = new PromiseGraph({
    id: "undefined-contract",
    entry: "finish",
    maxSteps: 1,
    nodes: [{ id: "finish", duty: "Require a real value", requires: ["input.ready"], provides: ["output.done"], maxVisits: 1, transitions: { done: null } }],
  });
  await assert.rejects(
    () => graph.run({ "input.ready": undefined }, { finish: async () => ({ route: "done", promises: { "output.done": true } }) }),
    /undefined|real value|promise/i,
  );
});

test("graph definitions are compiled immutably and routes require own declared keys", async () => {
  const transitions: Record<string, string | null> = { done: null };
  const definition = {
    id: "immutable-definition",
    entry: "finish",
    maxSteps: 1,
    nodes: [{ id: "finish", duty: "Use only compiled routes", requires: [], provides: ["output.done"], maxVisits: 1, transitions }],
  };
  const graph = new PromiseGraph(definition);
  transitions.injected = null;
  await assert.rejects(
    () => graph.run({}, { finish: async () => ({ route: "injected", promises: { "output.done": true } }) }),
    /undeclared route/i,
  );
  await assert.rejects(
    () => graph.run({}, { finish: async () => ({ route: "toString", promises: { "output.done": true } }) }),
    /undeclared route/i,
  );
});

test("snapshots a stateful promise object once before validation and commit", async () => {
  const graph = new PromiseGraph({
    id: "stateful-outcome",
    entry: "finish",
    maxSteps: 1,
    nodes: [{ id: "finish", duty: "Provide only the declared result", requires: [], provides: ["output"], maxVisits: 1, transitions: { done: null } }],
  });
  let enumeration = 0;
  const changing = new Proxy({ output: true, admin: true }, {
    ownKeys: () => (++enumeration === 1 ? ["output"] : ["output", "admin"]),
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
  });
  const result = await graph.run({}, { finish: async () => ({ route: "done", promises: changing }) });
  assert.deepEqual(result.trace[0]?.provided, ["output"]);
  assert.equal(result.promises.get("output"), true);
  assert.equal(result.promises.has("admin"), false);
  assert.equal(enumeration, 1);
});
