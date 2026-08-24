import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { lightningLoopDataPath } from "./platform-paths.js";

const MAX_LEDGER_BYTES = 1_048_576;
const MAX_RECORDS = 500;
const SECRET_SHAPE = /(?:\bcsk-|\bgsk_|\bfc-|\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}|\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{8,}/i;

export type ManagedMemoryScope = "run" | "project" | "user";
export type ManagedEvolutionKind = "system_prompt" | "skill" | "tool" | "mcp" | "memory_policy";
export type ManagedEvolutionState =
  | "draft"
  | "source_reviewed"
  | "sandbox_tested"
  | "adversarially_reviewed"
  | "user_approved"
  | "active"
  | "superseded"
  | "rolled_back";

export type ManagedMemoryKind = "note" | "desire";

export interface ManagedMemoryRecord {
  id: string;
  scope: ManagedMemoryScope;
  /** "desire" marks a first-class user preference; "note" is a plain memory. */
  kind: ManagedMemoryKind;
  statement: string;
  tags: string[];
  sourceArtifact: string;
  /** Deterministic project identity; present only on project-scoped records. */
  projectID?: string;
  sourceRunID?: string;
  confidence: number;
  verification: "unverified" | "source_backed" | "verified" | "contradicted";
  createdAt: string;
  reviewedAt?: string;
  expiresAt?: string;
  supersededBy?: string;
  promotionApprovedByUser: boolean;
}

export interface ManagedEvolutionRecord {
  id: string;
  kind: ManagedEvolutionKind;
  name: string;
  version: string;
  state: ManagedEvolutionState;
  source: string;
  reason: string;
  exactDiff: string;
  permissions: string[];
  evaluationSuite: string;
  evaluationSummary?: string;
  reviewerHasMaterialFinding: boolean;
  rollbackTarget?: string;
  createdAt: string;
  activatedAt?: string;
}

export function managedMemoryPath(): string {
  return lightningLoopDataPath("memory.json");
}

export function managedEvolutionPath(): string {
  return lightningLoopDataPath("evolutions.json");
}

export function listManagedMemory(path = managedMemoryPath()): ManagedMemoryRecord[] {
  return readLedger(path, isMemoryRecord, "memory");
}

export function addManagedMemory(
  input: {
    scope: ManagedMemoryScope;
    statement: string;
    sourceArtifact?: string;
    tags?: readonly string[];
    sourceRunID?: string;
    kind?: ManagedMemoryKind;
    projectID?: string;
  },
  path = managedMemoryPath(),
): ManagedMemoryRecord {
  const statement = cleanRequired(input.statement, 10_000, "Memory statement");
  const sourceArtifact = cleanRequired(input.sourceArtifact || "User-provided note", 200, "Memory source");
  if (input.scope === "run" && !isUUID(input.sourceRunID)) {
    throw new Error("Run memory requires the UUID of its source run.");
  }
  const kind: ManagedMemoryKind = input.kind === "desire" ? "desire" : "note";
  let projectID: string | undefined;
  if (input.scope === "project") {
    projectID = input.projectID ? cleanRequired(input.projectID, 200, "Project identity") : undefined;
  } else if (input.projectID) {
    throw new Error("Only project-scoped memory may carry a project identity.");
  }
  const record: ManagedMemoryRecord = {
    id: randomUUID(),
    scope: input.scope,
    kind,
    statement,
    tags: (input.tags ?? []).map((tag) => cleanRequired(tag, 120, "Memory tag")).slice(0, 20),
    sourceArtifact,
    ...(projectID ? { projectID } : {}),
    ...(input.scope === "run" ? { sourceRunID: input.sourceRunID } : {}),
    confidence: 1,
    verification: "unverified",
    createdAt: swiftISODate(),
    promotionApprovedByUser: input.scope === "run",
  };
  mutateLedger(path, isMemoryRecord, "memory", (records) => [record, ...records]);
  return record;
}

export function approveManagedMemory(id: string, path = managedMemoryPath()): ManagedMemoryRecord {
  requireUUID(id, "Memory ID");
  let result: ManagedMemoryRecord | undefined;
  mutateLedger(path, isMemoryRecord, "memory", (records) => records.map((record) => {
    if (record.id !== id) return record;
    if (record.scope === "run") throw new Error("Run memory is already bound to its source run and cannot be promoted.");
    result = { ...record, promotionApprovedByUser: true, reviewedAt: swiftISODate() };
    return result;
  }));
  if (!result) throw new Error("Memory entry not found.");
  return result;
}

export function deleteManagedMemory(id: string, path = managedMemoryPath()): void {
  requireUUID(id, "Memory ID");
  let found = false;
  mutateLedger(path, isMemoryRecord, "memory", (records) => records.filter((record) => {
    if (record.id === id) found = true;
    return record.id !== id;
  }));
  if (!found) throw new Error("Memory entry not found.");
}

export function listManagedEvolutions(path = managedEvolutionPath()): ManagedEvolutionRecord[] {
  return readLedger(path, isEvolutionRecord, "evolution");
}

export function proposeManagedEvolution(
  input: { kind: ManagedEvolutionKind; name: string; source?: string; reason?: string; exactDiff: string },
  path = managedEvolutionPath(),
): ManagedEvolutionRecord {
  const record: ManagedEvolutionRecord = {
    id: randomUUID(),
    kind: input.kind,
    name: cleanRequired(input.name, 200, "Evolution name"),
    version: "0.1.0-draft",
    state: "draft",
    source: cleanRequired(input.source || "User-provided", 1_000, "Evolution source"),
    reason: cleanOptional(input.reason, 2_000, "Evolution reason"),
    exactDiff: cleanRequired(input.exactDiff, 8_000, "Evolution content"),
    permissions: [],
    evaluationSuite: "Not yet assigned",
    reviewerHasMaterialFinding: false,
    createdAt: swiftISODate(),
  };
  mutateLedger(path, isEvolutionRecord, "evolution", (records) => [record, ...records]);
  return record;
}

export function updateManagedEvolutionEvidence(
  id: string,
  input: {
    evaluationSuite: string;
    evaluationSummary?: string;
    rollbackTarget?: string;
    permissions?: readonly string[];
    reviewerHasMaterialFinding: boolean;
  },
  path = managedEvolutionPath(),
): ManagedEvolutionRecord {
  requireUUID(id, "Evolution ID");
  let result: ManagedEvolutionRecord | undefined;
  mutateLedger(path, isEvolutionRecord, "evolution", (records) => records.map((record) => {
    if (record.id !== id) return record;
    if (record.state === "active" || record.state === "superseded" || record.state === "rolled_back") {
      throw new Error("Evidence for a terminal or active evolution cannot be edited.");
    }
    const evaluationSummary = cleanOptional(input.evaluationSummary, 4_000, "Evaluation summary");
    const rollbackTarget = cleanOptional(input.rollbackTarget, 1_000, "Rollback target");
    const { evaluationSummary: _priorSummary, rollbackTarget: _priorRollback, ...base } = record;
    const updated: ManagedEvolutionRecord = {
      ...base,
      evaluationSuite: cleanRequired(input.evaluationSuite, 2_000, "Evaluation suite"),
      ...(evaluationSummary ? { evaluationSummary } : {}),
      ...(rollbackTarget ? { rollbackTarget } : {}),
      permissions: (input.permissions ?? []).map((permission) => cleanRequired(permission, 120, "Permission")).slice(0, 30),
      reviewerHasMaterialFinding: input.reviewerHasMaterialFinding,
    };
    result = updated;
    return updated;
  }));
  if (!result) throw new Error("Evolution proposal not found.");
  return result;
}

const NEXT: Readonly<Record<ManagedEvolutionState, ManagedEvolutionState | undefined>> = {
  draft: "source_reviewed",
  source_reviewed: "sandbox_tested",
  sandbox_tested: "adversarially_reviewed",
  adversarially_reviewed: "user_approved",
  user_approved: "active",
  active: "superseded",
  superseded: undefined,
  rolled_back: undefined,
};

export function advanceManagedEvolution(id: string, path = managedEvolutionPath()): ManagedEvolutionRecord {
  requireUUID(id, "Evolution ID");
  let result: ManagedEvolutionRecord | undefined;
  mutateLedger(path, isEvolutionRecord, "evolution", (records) => records.map((record) => {
    if (record.id !== id) return record;
    const next = NEXT[record.state];
    if (!next) throw new Error("This evolution has no next lifecycle state.");
    if (next === "sandbox_tested" && (record.evaluationSuite === "Not yet assigned" || !record.evaluationSummary)) {
      throw new Error("Sandbox-tested requires a named evaluation suite and passing evidence.");
    }
    if ((next === "adversarially_reviewed" || next === "user_approved" || next === "active") && record.reviewerHasMaterialFinding) {
      throw new Error("Resolve the material reviewer finding before advancing.");
    }
    if (next === "active" && (!record.evaluationSummary || !record.rollbackTarget)) {
      throw new Error("Activation requires evaluation evidence and a rollback target.");
    }
    result = { ...record, state: next, ...(next === "active" ? { activatedAt: swiftISODate() } : {}) };
    return result;
  }));
  if (!result) throw new Error("Evolution proposal not found.");
  return result;
}

export function rollbackManagedEvolution(id: string, path = managedEvolutionPath()): ManagedEvolutionRecord {
  requireUUID(id, "Evolution ID");
  let result: ManagedEvolutionRecord | undefined;
  mutateLedger(path, isEvolutionRecord, "evolution", (records) => records.map((record) => {
    if (record.id !== id) return record;
    if (record.state === "rolled_back") throw new Error("Evolution is already rolled back.");
    result = { ...record, state: "rolled_back" };
    return result;
  }));
  if (!result) throw new Error("Evolution proposal not found.");
  return result;
}

function mutateLedger<T>(
  path: string,
  guard: (value: unknown) => value is T,
  label: string,
  mutate: (records: T[]) => T[],
): void {
  ensureProtectedDirectory(dirname(path));
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    writeFileSync(lock, `${process.pid}\n`, { encoding: "utf8" });
    const startingFingerprint = ledgerFingerprint(path);
    const current = readLedger(path, guard, label);
    const next = mutate(current);
    if (next.length > MAX_RECORDS) throw new Error(`The ${label} ledger cannot exceed ${MAX_RECORDS} records.`);
    if (!next.every(guard)) throw new Error(`The ${label} mutation produced an invalid record.`);
    if (ledgerFingerprint(path) !== startingFingerprint) {
      throw new Error(`The ${label} ledger changed in another client. Nothing was overwritten; reload and retry.`);
    }
    atomicWrite(path, next);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) throw new Error(`The ${label} ledger is busy. Close another editor or retry.`);
    throw error;
  } finally {
    if (lock !== undefined) closeSync(lock);
    if (lock !== undefined && existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function ledgerFingerprint(path: string): string {
  if (!existsSync(path)) return "missing";
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

function readLedger<T>(path: string, guard: (value: unknown) => value is T, label: string): T[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`The ${label} ledger must be a regular, non-symlink file.`);
  if (stat.size > MAX_LEDGER_BYTES) throw new Error(`The ${label} ledger exceeds 1 MiB.`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`The LightningLoop ${label} ledger is malformed; management failed closed.`);
  }
  if (!Array.isArray(value) || value.length > MAX_RECORDS || !value.every(guard)) {
    throw new Error(`The LightningLoop ${label} ledger has an invalid schema; management failed closed.`);
  }
  return value;
}

function atomicWrite(path: string, value: unknown): void {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_LEDGER_BYTES) throw new Error("The protected ledger would exceed 1 MiB.");
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function ensureProtectedDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The LightningLoop data directory must be a regular directory, not a symlink.");
  chmodSync(path, 0o700);
}

function isMemoryRecord(value: unknown): value is ManagedMemoryRecord {
  if (!isObject(value)) return false;
  return isUUID(value.id)
    && (value.scope === "run" || value.scope === "project" || value.scope === "user")
    && (value.kind === undefined || value.kind === "note" || value.kind === "desire")
    && (value.projectID === undefined || (isBoundedString(value.projectID, 1, 200) && !SECRET_SHAPE.test(value.projectID)))
    && (value.scope === "project" || value.projectID === undefined)
    && isBoundedString(value.statement, 1, 10_000)
    && Array.isArray(value.tags) && value.tags.length <= 20 && value.tags.every((tag) => isBoundedString(tag, 1, 120))
    && isBoundedString(value.sourceArtifact, 1, 200)
    && (value.sourceRunID === undefined || isUUID(value.sourceRunID))
    && typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1
    && ["unverified", "source_backed", "verified", "contradicted"].includes(String(value.verification))
    && isISODate(value.createdAt)
    && (value.reviewedAt === undefined || isISODate(value.reviewedAt))
    && (value.expiresAt === undefined || isISODate(value.expiresAt))
    && (value.supersededBy === undefined || isUUID(value.supersededBy))
    && typeof value.promotionApprovedByUser === "boolean"
    && !SECRET_SHAPE.test(value.statement)
    && !SECRET_SHAPE.test(value.sourceArtifact);
}

function isEvolutionRecord(value: unknown): value is ManagedEvolutionRecord {
  if (!isObject(value)) return false;
  return isUUID(value.id)
    && ["system_prompt", "skill", "tool", "mcp", "memory_policy"].includes(String(value.kind))
    && isBoundedString(value.name, 1, 200)
    && isBoundedString(value.version, 1, 100)
    && Object.hasOwn(NEXT, String(value.state))
    && isBoundedString(value.source, 1, 1_000)
    && isBoundedString(value.reason, 0, 2_000)
    && isBoundedString(value.exactDiff, 1, 8_000)
    && Array.isArray(value.permissions) && value.permissions.length <= 30 && value.permissions.every((item) => isBoundedString(item, 1, 120))
    && isBoundedString(value.evaluationSuite, 1, 2_000)
    && (value.evaluationSummary === undefined || isBoundedString(value.evaluationSummary, 1, 4_000))
    && typeof value.reviewerHasMaterialFinding === "boolean"
    && (value.rollbackTarget === undefined || isBoundedString(value.rollbackTarget, 1, 1_000))
    && isISODate(value.createdAt)
    && (value.activatedAt === undefined || isISODate(value.activatedAt))
    && ![value.source, value.reason, value.exactDiff, value.evaluationSummary, value.rollbackTarget]
      .filter((item): item is string => typeof item === "string")
      .some((item) => SECRET_SHAPE.test(item));
}

function cleanRequired(value: string, max: number, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required.`);
  if (clean.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  if (SECRET_SHAPE.test(clean)) throw new Error(`${label} contains secret-like content, which is prohibited.`);
  return clean;
}

function cleanOptional(value: string | undefined, max: number, label: string): string {
  const clean = value?.trim() ?? "";
  if (!clean) return "";
  return cleanRequired(clean, max, label);
}

function requireUUID(value: string, label: string): void {
  if (!isUUID(value)) throw new Error(`${label} must be a UUID.`);
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isISODate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function swiftISODate(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
