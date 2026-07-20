import assert from "node:assert/strict";
import test from "node:test";
import { eligibleMemory } from "./memory.js";
import type { MemoryEntry } from "./schema.js";

const base: MemoryEntry = {
  id: "M1",
  scope: "project",
  statement: "Build with Xcode 16",
  tags: ["toolchain"],
  sourceArtifact: "README.md",
  sourceRunID: "R1",
  author: "verifier",
  confidence: 1,
  verification: "verified",
  sensitivity: "private",
  createdAt: "2026-07-19T00:00:00Z",
  promotionApprovedByUser: true,
};

test("memory retrieval excludes expired, contradicted, secret, and unapproved promoted entries", () => {
  const result = eligibleMemory(
    [
      base,
      { ...base, id: "M2", verification: "contradicted" },
      { ...base, id: "M3", sensitivity: "secret_prohibited" },
      { ...base, id: "M4", promotionApprovedByUser: false },
      { ...base, id: "M5", expiresAt: "2020-01-01T00:00:00Z" },
    ],
    ["project"],
    new Date("2026-07-19T01:00:00Z"),
  );
  assert.deepEqual(result.map((entry) => entry.id), ["M1"]);
});
