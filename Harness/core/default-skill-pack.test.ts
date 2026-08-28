import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SKILL_PACK,
  disabledDefaultSkillIds,
  filterEnabledShippedSkills,
  formatDefaultSkillPack,
  parseDefaultSkillId,
  setDefaultSkillEnabled,
} from "./default-skill-pack.js";
import { SHIPPED_SKILLS } from "./skill-disclosure.js";

test("default pack is the shipped set and never a marketplace", () => {
  assert.deepEqual(DEFAULT_SKILL_PACK.map((skill) => skill.id), [
    "lloop-research",
    "lloop-engineer",
    "lloop-verify",
    "lloop-sources",
    "lloop-browse",
    "maintain-lightningloop",
  ]);
  assert.equal(DEFAULT_SKILL_PACK.length, 6);
  assert.doesNotMatch(JSON.stringify(DEFAULT_SKILL_PACK), /api.?key|bearer\s|(?:csk|sk)-/iu);
});

test("unknown skill IDs fail closed", () => {
  assert.throws(() => parseDefaultSkillId("marketplace-plugin"), /Unknown skill/);
  assert.throws(() => parseDefaultSkillId(undefined), /Unknown skill/);
});

test("missing skill-pack means every shipped skill is enabled", () => {
  const path = join(tmpdir(), `missing-skill-pack-${Date.now()}.json`);
  assert.deepEqual(disabledDefaultSkillIds(path), []);
  assert.equal(filterEnabledShippedSkills(SHIPPED_SKILLS, path).length, SHIPPED_SKILLS.length);
});

test("disable and enable are explicit and never write a secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lightningloop-skill-pack-"));
  const path = join(directory, "skill-pack.json");
  try {
    const disabled = setDefaultSkillEnabled("lloop-research", false, path);
    assert.deepEqual(disabled.disabled, ["lloop-research"]);
    const listed = formatDefaultSkillPack(path);
    assert.match(listed, /DISABLED  lloop-research/u);
    assert.match(listed, /ENABLED  lloop-engineer/u);
    assert.doesNotMatch(listed, /api.?key|bearer\s|(?:csk|sk)-/iu);
    const filtered = filterEnabledShippedSkills(SHIPPED_SKILLS, path);
    assert.equal(filtered.some((skill) => skill.id === "lloop-research"), false);
    assert.equal(filtered.some((skill) => skill.id === "lloop-engineer"), true);
    setDefaultSkillEnabled("lloop-research", true, path);
    assert.deepEqual(disabledDefaultSkillIds(path), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed skill-pack fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lightningloop-skill-pack-bad-"));
  const path = join(directory, "skill-pack.json");
  try {
    await writeFile(path, "{not-json", "utf8");
    assert.throws(() => disabledDefaultSkillIds(path), /malformed/);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, disabled: ["invented-skill"] }), "utf8");
    assert.throws(() => disabledDefaultSkillIds(path), /default-pack IDs only/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
