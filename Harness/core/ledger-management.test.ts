import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addManagedMemory,
  advanceManagedEvolution,
  approveManagedMemory,
  deleteManagedMemory,
  listManagedEvolutions,
  listManagedMemory,
  proposeManagedEvolution,
  rollbackManagedEvolution,
  updateManagedEvolutionEvidence,
} from "./ledger-management.js";

function ledgerPaths(): { memory: string; evolution: string } {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-ledger-"));
  return { memory: join(directory, "memory.json"), evolution: join(directory, "evolutions.json") };
}

test("memory additions are Swift-compatible, inactive until promotion, and protected", () => {
  const { memory } = ledgerPaths();
  const added = addManagedMemory({
    scope: "project",
    statement: "Prefer deterministic acceptance tests.",
    sourceArtifact: "User note",
    tags: ["quality"],
  }, memory);
  assert.equal(added.promotionApprovedByUser, false);
  assert.equal(lstatSync(memory).mode & 0o777, 0o600);
  assert.match(added.createdAt, /Z$/);
  assert.doesNotMatch(added.createdAt, /\.\d+Z$/);

  const promoted = approveManagedMemory(added.id, memory);
  assert.equal(promoted.promotionApprovedByUser, true);
  assert.ok(promoted.reviewedAt);
  assert.equal(listManagedMemory(memory).length, 1);
  deleteManagedMemory(added.id, memory);
  assert.deepEqual(listManagedMemory(memory), []);
});

test("run memory requires a source run UUID", () => {
  const { memory } = ledgerPaths();
  assert.throws(
    () => addManagedMemory({ scope: "run", statement: "Bound fact" }, memory),
    /source run/,
  );
});

test("secret-shaped memory and evolution content are rejected", () => {
  const { memory, evolution } = ledgerPaths();
  assert.throws(
    () => addManagedMemory({ scope: "user", statement: "api_key=abcdefghijklmnop" }, memory),
    /secret-like/,
  );
  assert.throws(
    () => proposeManagedEvolution({ kind: "skill", name: "bad", exactDiff: "Bearer abcdefghijklmnop" }, evolution),
    /secret-like/,
  );
});

test("evolution lifecycle enforces evidence, review, activation, and rollback", () => {
  const { evolution } = ledgerPaths();
  const proposal = proposeManagedEvolution({
    kind: "system_prompt",
    name: "Evidence first",
    source: "User-provided",
    reason: "Reduce unsupported claims",
    exactDiff: "Require named evidence for material assertions.",
  }, evolution);
  assert.equal(advanceManagedEvolution(proposal.id, evolution).state, "source_reviewed");
  assert.throws(() => advanceManagedEvolution(proposal.id, evolution), /evaluation suite/);

  updateManagedEvolutionEvidence(proposal.id, {
    evaluationSuite: "prompt-invariant-v1",
    evaluationSummary: "12 of 12 fixtures passed.",
    rollbackTarget: "Remove this addendum and restore version 0.1.0-draft.",
    permissions: [],
    reviewerHasMaterialFinding: false,
  }, evolution);
  assert.equal(advanceManagedEvolution(proposal.id, evolution).state, "sandbox_tested");
  assert.equal(advanceManagedEvolution(proposal.id, evolution).state, "adversarially_reviewed");
  assert.equal(advanceManagedEvolution(proposal.id, evolution).state, "user_approved");
  const active = advanceManagedEvolution(proposal.id, evolution);
  assert.equal(active.state, "active");
  assert.ok(active.activatedAt);
  assert.equal(rollbackManagedEvolution(proposal.id, evolution).state, "rolled_back");
  assert.equal(listManagedEvolutions(evolution)[0]?.state, "rolled_back");
});

test("material findings block adversarial review", () => {
  const { evolution } = ledgerPaths();
  const proposal = proposeManagedEvolution({ kind: "skill", name: "Candidate", exactDiff: "Candidate guidance" }, evolution);
  advanceManagedEvolution(proposal.id, evolution);
  updateManagedEvolutionEvidence(proposal.id, {
    evaluationSuite: "fixture-set",
    evaluationSummary: "Tests ran.",
    rollbackTarget: "Remove the guidance.",
    reviewerHasMaterialFinding: true,
  }, evolution);
  advanceManagedEvolution(proposal.id, evolution);
  assert.throws(() => advanceManagedEvolution(proposal.id, evolution), /material reviewer finding/);
});

test("malformed and symlink ledgers fail closed without overwriting", () => {
  const { memory } = ledgerPaths();
  writeFileSync(memory, "not-json\n", { mode: 0o600 });
  assert.throws(() => listManagedMemory(memory), /malformed/);
  assert.throws(() => addManagedMemory({ scope: "user", statement: "Safe" }, memory), /malformed/);
  assert.equal(readFileSync(memory, "utf8"), "not-json\n");

  const { memory: target } = ledgerPaths();
  writeFileSync(target, "[]\n", { mode: 0o600 });
  const link = `${target}.link`;
  symlinkSync(target, link);
  assert.throws(() => listManagedMemory(link), /non-symlink/);
});

test("permission repair remains fail-closed and deterministic", () => {
  const { memory } = ledgerPaths();
  addManagedMemory({ scope: "user", statement: "Safe local preference" }, memory);
  chmodSync(memory, 0o644);
  addManagedMemory({ scope: "project", statement: "Project preference" }, memory);
  assert.equal(lstatSync(memory).mode & 0o777, 0o600);
});
