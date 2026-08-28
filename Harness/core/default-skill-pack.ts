/**
 * The shipped LightningLoop skill pack. Not a marketplace.
 * Enable/disable is explicit. Missing state means every shipped skill is on.
 * Evolution drafts never write this file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { lightningLoopDataPath } from "./platform-paths.js";
import { SHIPPED_SKILLS, type ShippedSkill } from "./skill-disclosure.js";

export const DEFAULT_SKILL_PACK = [
  { id: "lloop-research", title: "Researcher", kind: "loop" },
  { id: "lloop-engineer", title: "Engineer", kind: "loop" },
  { id: "lloop-verify", title: "Verifier", kind: "loop" },
  { id: "lloop-sources", title: "Source trust", kind: "loop" },
  { id: "lloop-browse", title: "Browse", kind: "loop" },
  { id: "maintain-lightningloop", title: "Maintainer", kind: "maintainer" },
] as const;

export type DefaultSkillId = typeof DEFAULT_SKILL_PACK[number]["id"];

const SCHEMA_VERSION = 1;

export interface SkillPackRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  disabled: DefaultSkillId[];
}

export function skillPackPath(): string {
  return lightningLoopDataPath("skill-pack.json");
}

export function isDefaultSkillId(value: string): value is DefaultSkillId {
  return DEFAULT_SKILL_PACK.some((skill) => skill.id === value);
}

export function parseDefaultSkillId(value: string | undefined): DefaultSkillId {
  if (!value || !isDefaultSkillId(value)) {
    throw new Error(`Unknown skill. Default pack: ${DEFAULT_SKILL_PACK.map((skill) => skill.id).join(", ")}.`);
  }
  return value;
}

function readRecord(path = skillPackPath()): SkillPackRecord {
  if (!existsSync(path)) return { schemaVersion: SCHEMA_VERSION, disabled: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("skill-pack.json is malformed. Fix or delete it; LightningLoop will not guess.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("skill-pack.json must be an object.");
  }
  const record = parsed as { schemaVersion?: unknown; disabled?: unknown };
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("skill-pack.json schemaVersion is not 1.");
  }
  if (!Array.isArray(record.disabled) || record.disabled.some((id) => typeof id !== "string" || !isDefaultSkillId(id))) {
    throw new Error("skill-pack.json disabled must be default-pack IDs only.");
  }
  return { schemaVersion: SCHEMA_VERSION, disabled: [...new Set(record.disabled)] };
}

function writeRecord(record: SkillPackRecord, path = skillPackPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.skill-pack.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function disabledDefaultSkillIds(path = skillPackPath()): readonly DefaultSkillId[] {
  return readRecord(path).disabled;
}

export function isDefaultSkillEnabled(id: DefaultSkillId, path = skillPackPath()): boolean {
  return !disabledDefaultSkillIds(path).includes(id);
}

/** Explicit only. Never called from evolution draft activation. */
export function setDefaultSkillEnabled(id: string, enabled: boolean, path = skillPackPath()): SkillPackRecord {
  const skillId = parseDefaultSkillId(id);
  const current = new Set(readRecord(path).disabled);
  if (enabled) current.delete(skillId);
  else current.add(skillId);
  const record: SkillPackRecord = { schemaVersion: SCHEMA_VERSION, disabled: [...current].sort() };
  writeRecord(record, path);
  return record;
}

export function filterEnabledShippedSkills(
  skills: readonly ShippedSkill[] = SHIPPED_SKILLS,
  path = skillPackPath(),
): ShippedSkill[] {
  const disabled = new Set<string>(disabledDefaultSkillIds(path));
  return skills.filter((skill) => !disabled.has(skill.id));
}

export function enabledDefaultSkillDirectories(skillsRoot: string, path = skillPackPath()): string[] {
  return DEFAULT_SKILL_PACK
    .filter((skill) => isDefaultSkillEnabled(skill.id, path))
    .map((skill) => join(skillsRoot, skill.id))
    .filter((directory) => existsSync(directory));
}

export function formatDefaultSkillPack(path = skillPackPath()): string {
  const lines = ["LightningLoop default skill pack"];
  for (const skill of DEFAULT_SKILL_PACK) {
    const state = isDefaultSkillEnabled(skill.id, path) ? "ENABLED" : "DISABLED";
    lines.push(`  ${state}  ${skill.id} · ${skill.title}`);
  }
  lines.push("Drafts never auto-enable. llp skills enable|disable ID");
  return lines.join("\n");
}
