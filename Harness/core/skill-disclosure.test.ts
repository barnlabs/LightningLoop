import assert from "node:assert/strict";
import test from "node:test";
import { LOOP_TOOL_CATALOG, SHIPPED_SKILLS, discloseSkills, skillIdsForRole } from "./skill-disclosure.js";

test("progressive disclosure loads only the matching role skills plus the shared source rule", () => {
  const researcher = discloseSkills("researcher");
  assert.deepEqual(researcher.catalog.map((item) => item.id), SHIPPED_SKILLS.map((skill) => skill.id));
  assert.deepEqual(skillIdsForRole("researcher").sort(), ["lloop-browse", "lloop-research", "lloop-sources"]);
  assert.deepEqual(skillIdsForRole("engineer").sort(), ["lloop-engineer", "lloop-sources"]);
  assert.deepEqual(skillIdsForRole("verifier").sort(), ["lloop-browse", "lloop-sources", "lloop-verify"]);
  assert.match(researcher.promptBlock, /LOOP AGENT: researcher/);
  assert.match(researcher.promptBlock, /lloop-engineer: Implement the approved contract/);
  assert.doesNotMatch(researcher.promptBlock, /LOADED SKILLS FOR THIS ROLE:[\s\S]*Produce the complete deliverable/);
  assert.match(discloseSkills("engineer").promptBlock, /Produce the complete deliverable/);
});

test("each role receives a bounded tool catalog and the source rule", () => {
  assert.deepEqual([...LOOP_TOOL_CATALOG.researcher], ["search", "browse", "read"]);
  assert.deepEqual([...LOOP_TOOL_CATALOG.engineer], ["read", "grep", "find", "ls", "write", "edit", "bash"]);
  assert.deepEqual([...LOOP_TOOL_CATALOG.verifier], ["read", "grep", "browse"]);
  for (const role of ["researcher", "engineer", "verifier"] as const) {
    const disclosed = discloseSkills(role);
    assert.match(disclosed.promptBlock, /reputable primary sources/);
    assert.deepEqual([...disclosed.tools], [...LOOP_TOOL_CATALOG[role]]);
  }
});

test("shipped catalog is small and has no credential-shaped text", () => {
  assert.equal(SHIPPED_SKILLS.length, 5);
  const blob = JSON.stringify(SHIPPED_SKILLS);
  assert.doesNotMatch(blob, /api.?key|bearer\s|(?:csk|sk)-/iu);
});
