import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateToolRequest, WorkspaceBoundary } from "./capability-policy.js";

test("read-only policy allows workspace reads and denies writes and shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightningloop-policy-"));
  const boundary = await WorkspaceBoundary.create(root);
  assert.equal((await evaluateToolRequest({ toolName: "read", input: { path: "." } }, boundary, "read_only")).action, "allow");
  assert.equal((await evaluateToolRequest({ toolName: "write", input: { path: "a.txt" } }, boundary, "read_only")).action, "deny");
  assert.equal((await evaluateToolRequest({ toolName: "bash", input: { command: "pwd" } }, boundary, "read_only")).action, "deny");
});

test("policy rejects traversal and symlink escape", async () => {
  const base = await mkdtemp(join(tmpdir(), "lightningloop-boundary-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, "escape"));
  const boundary = await WorkspaceBoundary.create(root);
  assert.equal((await evaluateToolRequest({ toolName: "read", input: { path: "../outside" } }, boundary, "read_only")).action, "deny");
  assert.equal((await evaluateToolRequest({ toolName: "read", input: { path: "escape" } }, boundary, "read_only")).action, "deny");
});

test("mutation mode still requires a per-call confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightningloop-confirm-"));
  const boundary = await WorkspaceBoundary.create(root);
  assert.equal(
    (await evaluateToolRequest({ toolName: "edit", input: { path: "file.swift" } }, boundary, "confirm_mutations")).action,
    "confirm",
  );
});

test("shell commands too large to review are denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightningloop-command-"));
  const boundary = await WorkspaceBoundary.create(root);
  const decision = await evaluateToolRequest(
    { toolName: "bash", input: { command: "x".repeat(2_001) } },
    boundary,
    "confirm_mutations",
  );
  assert.equal(decision.action, "deny");
});

test("credential-bearing workspace paths are denied to read and shell tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightningloop-policy-secret-"));
  try {
    const boundary = await WorkspaceBoundary.create(root);
    assert.equal((await evaluateToolRequest({ toolName: "read", input: { path: ".env.local" } }, boundary, "read_only")).action, "deny");
    assert.equal((await evaluateToolRequest({ toolName: "read", input: { path: "signing.pem" } }, boundary, "read_only")).action, "deny");
    assert.equal((await evaluateToolRequest({ toolName: "bash", input: { command: "cat .env" } }, boundary, "confirm_mutations")).action, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
