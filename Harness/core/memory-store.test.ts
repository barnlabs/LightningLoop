import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyManagedMemoryContext, loadEligibleMemoryContext } from "./memory-store.js";

test("memory context is bounded, promoted, and session scoped", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-memory-"));
  const path = join(root, "memory.json");
  writeFileSync(path, JSON.stringify([
    { scope: "run", statement: "Same-run constraint", sourceArtifact: "session", sourceRunID: "run-a", verification: "verified", confidence: 1, promotionApprovedByUser: true },
    { scope: "run", statement: "Other-run constraint", sourceArtifact: "other", sourceRunID: "run-b", verification: "verified", confidence: 1, promotionApprovedByUser: true },
    { scope: "project", statement: "Use BarnLabs palette", sourceArtifact: "brand guide", verification: "source_backed", confidence: 0.9, promotionApprovedByUser: true },
    { scope: "user", statement: "Unapproved preference", sourceArtifact: "note", verification: "unverified", confidence: 1, promotionApprovedByUser: false },
    { scope: "project", statement: "Contradicted claim", sourceArtifact: "note", verification: "contradicted", confidence: 1, promotionApprovedByUser: true },
  ]));
  const context = loadEligibleMemoryContext("run-a", path);
  assert.equal(context.length, 2);
  assert.match(context[0]!, /Same-run constraint/);
  assert.match(context[1]!, /BarnLabs palette/);
  assert.doesNotMatch(context.join("\n"), /Other-run|Unapproved|Contradicted/);
  assert.match(applyManagedMemoryContext("BASE", context), /USER-MANAGED MEMORY CONTEXT/);
});

test("malformed memory fails closed and secret-shaped memory is excluded", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-memory-"));
  const malformed = join(root, "malformed.json");
  writeFileSync(malformed, "not-json");
  assert.throws(() => loadEligibleMemoryContext(undefined, malformed), /failed closed/);
  const path = join(root, "memory.json");
  writeFileSync(path, JSON.stringify([
    { scope: "project", statement: "Bearer synthetic-secret-value-123456", promotionApprovedByUser: true },
  ]));
  assert.deepEqual(loadEligibleMemoryContext(undefined, path), []);
});
