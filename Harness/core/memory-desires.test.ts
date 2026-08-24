import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveProjectIdentity } from "./project-identity.js";
import { addManagedMemory, approveManagedMemory, type ManagedMemoryRecord } from "./ledger-management.js";
import { loadEligibleMemoryContext } from "./memory-store.js";

function withLedger(run: (path: string) => void): void {
  const dir = join(tmpdir(), `ll-desires-${randomUUID()}`);
  const path = join(dir, "memory.json");
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Add a desire and immediately approve it (the explicit-promotion gate). */
function addApprovedDesire(
  path: string,
  input: { scope: "user" | "project"; statement: string; projectID?: string },
): ManagedMemoryRecord {
  const record = addManagedMemory({ ...input, kind: "desire" }, path);
  approveManagedMemory(record.id, path);
  return record;
}

test("deriveProjectIdentity is deterministic per directory and distinct across directories", () => {
  const a = deriveProjectIdentity("/tmp/project-a");
  const b = deriveProjectIdentity("/tmp/project-a/");
  const c = deriveProjectIdentity("/tmp/project-b");
  assert.equal(a.id, b.id, "a trailing slash must not change the identity");
  assert.notEqual(a.id, c.id, "different roots must yield different identities");
  assert.match(a.id, /^proj_[0-9a-f]{16}$/u);
});

test("addManagedMemory records desires and rejects a project identity on non-project scope", () => {
  withLedger((path) => {
    const global = addManagedMemory({ scope: "user", kind: "desire", statement: "Prefer concise deliverables." }, path);
    assert.equal(global.kind, "desire");
    assert.equal(global.projectID, undefined);
    const scoped = addManagedMemory({ scope: "project", kind: "desire", statement: "Use tabs.", projectID: "proj_abc" }, path);
    assert.equal(scoped.projectID, "proj_abc");
    assert.throws(
      () => addManagedMemory({ scope: "user", kind: "desire", statement: "x", projectID: "proj_abc" }, path),
      /Only project-scoped memory may carry a project identity/,
    );
  });
});

test("global desires apply everywhere; project desires resolve to their project only, and both inject", () => {
  withLedger((path) => {
    const projectA = deriveProjectIdentity("/work/alpha").id;
    const projectB = deriveProjectIdentity("/work/beta").id;
    addApprovedDesire(path, { scope: "user", statement: "Always write deterministic tests." });
    addApprovedDesire(path, { scope: "project", statement: "Alpha ships with the BarnLabs palette.", projectID: projectA });
    addApprovedDesire(path, { scope: "project", statement: "Beta targets the accessibility theme.", projectID: projectB });

    // In project A: global desire + A's project desire; NOT B's.
    const inA = loadEligibleMemoryContext(undefined, path, new Date(), projectA);
    assert.equal(inA.some((line) => /Always write deterministic tests/.test(line)), true);
    assert.equal(inA.some((line) => /BarnLabs palette/.test(line)), true);
    assert.equal(inA.some((line) => /accessibility theme/.test(line)), false);
    // Labels distinguish global vs project desires.
    assert.equal(inA.some((line) => /^\[user desire;/.test(line)), true);
    assert.equal(inA.some((line) => /^\[project desire;/.test(line)), true);

    // In project B: global desire + B's project desire; NOT A's.
    const inB = loadEligibleMemoryContext(undefined, path, new Date(), projectB);
    assert.equal(inB.some((line) => /accessibility theme/.test(line)), true);
    assert.equal(inB.some((line) => /BarnLabs palette/.test(line)), false);

    // With no project context, project desires are withheld (fail-closed) but the global one still applies.
    const noProject = loadEligibleMemoryContext(undefined, path, new Date(), undefined);
    assert.equal(noProject.some((line) => /Always write deterministic tests/.test(line)), true);
    assert.equal(noProject.some((line) => /BarnLabs palette|accessibility theme/.test(line)), false);
  });
});

test("an unpromoted desire is never injected (explicit-promotion gate preserved)", () => {
  withLedger((path) => {
    const projectA = deriveProjectIdentity("/work/alpha").id;
    // Added but NOT approved.
    addManagedMemory({ scope: "user", kind: "desire", statement: "Unpromoted global desire." }, path);
    addManagedMemory({ scope: "project", kind: "desire", statement: "Unpromoted project desire.", projectID: projectA }, path);
    const context = loadEligibleMemoryContext(undefined, path, new Date(), projectA);
    assert.deepEqual(context, []);
  });
});

test("credential-safety still rejects secret-like desire content", () => {
  withLedger((path) => {
    assert.throws(
      () => addManagedMemory({ scope: "user", kind: "desire", statement: "api_key=abcdefghijklmnop" }, path),
      /secret-like/,
    );
  });
});

test("a legacy project record without an identity stays project-agnostic (backward compatible)", () => {
  withLedger((path) => {
    // A note without kind/projectID (pre-O9 shape) added via the normal path.
    const legacy = addManagedMemory({ scope: "project", statement: "Legacy project note." }, path);
    approveManagedMemory(legacy.id, path);
    const anyProject = deriveProjectIdentity("/somewhere/else").id;
    const context = loadEligibleMemoryContext(undefined, path, new Date(), anyProject);
    assert.equal(context.some((line) => /Legacy project note/.test(line)), true);
  });
});
