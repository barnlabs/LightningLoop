/**
 * Completion oracle: an explicit, owner-supplied, typed objective contract that
 * the harness evaluates against its own observed evidence (files it hashed and
 * commands it executed) — never against model-claimed text. When the oracle
 * passes AND the reviewer gate passes AND every deterministic gate passes, the
 * run may reach Gold. With a failing oracle, or no oracle at all, the run stays
 * paused (fail-closed), exactly as before this oracle existed.
 */
import type { ArtifactExecutionReport } from "./loop-types.js";
import { objectValue, stringValue } from "./structured-json.js";

/**
 * The exact fail-closed reason used when no objective contract is supplied.
 * Preserved verbatim so a run with no oracle pauses with the same explanation
 * it always has.
 */
export const NO_OBJECTIVE_CONTRACT_REASON =
  "Automatic Gold is disabled until an immutable harness- or owner-supplied objective oracle exists. Source authority classification, retrieval, hashing, exact text, planner/reviewer agreement, and artifact checks are review context only; every result requires explicit owner acceptance.";

/** A required file whose harness-computed SHA-256 must match exactly. */
export interface FileSha256Check {
  type: "file_sha256";
  path: string;
  sha256: string;
}

/** A harness-executed, passing verification command whose captured output must contain a substring. */
export interface CommandOutputContainsCheck {
  type: "command_output_contains";
  substring: string;
  purpose?: string;
}

/** A harness-executed, passing verification command whose captured output must equal a value (trimmed). */
export interface CommandOutputEqualsCheck {
  type: "command_output_equals";
  value: string;
  purpose?: string;
}

export type ObjectiveCheck = FileSha256Check | CommandOutputContainsCheck | CommandOutputEqualsCheck;

export interface ObjectiveContract {
  version: 1;
  description?: string;
  checks: ObjectiveCheck[];
}

export interface ObjectiveEvaluation {
  passed: boolean;
  reason: string;
  /** Human-readable labels of the checks that passed, in order. */
  satisfied: string[];
}

const MAX_CHECKS = 16;
const MAX_STRING = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function boundedString(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (text.length === 0 || text.length > MAX_STRING || /[\u0000]/u.test(text)) {
    throw new Error(`${label} must be a bounded, non-empty, NUL-free string.`);
  }
  return text;
}

/**
 * Validate an untrusted parsed JSON value (e.g. from `--objective-file`) into a
 * typed {@link ObjectiveContract}. Fails closed on anything malformed.
 */
export function parseObjectiveContract(value: unknown): ObjectiveContract {
  const root = objectValue(value, "objective contract");
  if (root.version !== 1) throw new Error("Objective contract version must be 1.");
  if (!Array.isArray(root.checks) || root.checks.length === 0) {
    throw new Error("Objective contract must define at least one check.");
  }
  if (root.checks.length > MAX_CHECKS) throw new Error(`Objective contract supports at most ${MAX_CHECKS} checks.`);
  const description = root.description === undefined ? undefined : boundedString(root.description, "objective description");
  const checks: ObjectiveCheck[] = root.checks.map((raw, index) => {
    const check = objectValue(raw, `checks[${index}]`);
    const type = stringValue(check.type, `checks[${index}].type`);
    if (type === "file_sha256") {
      const path = boundedString(check.path, `checks[${index}].path`);
      const sha256 = boundedString(check.sha256, `checks[${index}].sha256`).toLowerCase();
      if (!SHA256_PATTERN.test(sha256)) throw new Error(`checks[${index}].sha256 must be 64 lowercase hex characters.`);
      return { type, path, sha256 };
    }
    if (type === "command_output_contains") {
      const substring = boundedString(check.substring, `checks[${index}].substring`);
      const purpose = check.purpose === undefined ? undefined : boundedString(check.purpose, `checks[${index}].purpose`);
      return { type, substring, ...(purpose ? { purpose } : {}) };
    }
    if (type === "command_output_equals") {
      const expected = boundedString(check.value, `checks[${index}].value`);
      const purpose = check.purpose === undefined ? undefined : boundedString(check.purpose, `checks[${index}].purpose`);
      return { type, value: expected, ...(purpose ? { purpose } : {}) };
    }
    throw new Error(`checks[${index}].type is unsupported.`);
  });
  return { version: 1, ...(description ? { description } : {}), checks };
}

interface CheckOutcome {
  passed: boolean;
  label: string;
  reason: string;
}

function evaluateCheck(check: ObjectiveCheck, report: ArtifactExecutionReport): CheckOutcome {
  if (check.type === "file_sha256") {
    const label = `file ${check.path} sha256 ${check.sha256.slice(0, 12)}…`;
    // The harness computed this SHA-256 over the bytes it wrote, so a match is
    // harness-observed evidence, not a model claim.
    const file = report.files.find((candidate) => candidate.path === check.path);
    if (!file) return { passed: false, label, reason: `no harness-recorded file at ${check.path}` };
    if (file.sha256.toLowerCase() !== check.sha256) {
      return { passed: false, label, reason: `${check.path} sha256 ${file.sha256} does not match the required digest` };
    }
    return { passed: true, label, reason: "" };
  }
  const wantPurpose = check.purpose;
  const purposeLabel = wantPurpose ? ` (purpose "${wantPurpose}")` : "";
  // Only a command the harness actually ran and recorded as passing is eligible.
  const candidates = report.commands.filter((command) => command.passed && (wantPurpose === undefined || command.purpose === wantPurpose));
  if (check.type === "command_output_contains") {
    const label = `command output contains "${check.substring.slice(0, 40)}"${purposeLabel}`;
    const match = candidates.some((command) => command.output.includes(check.substring));
    return { passed: match, label, reason: match ? "" : "no passing harness command output contained the required substring" };
  }
  const label = `command output equals "${check.value.slice(0, 40)}"${purposeLabel}`;
  const match = candidates.some((command) => command.output.trim() === check.value.trim());
  return { passed: match, label, reason: match ? "" : "no passing harness command output equalled the required value" };
}

/**
 * Evaluate the objective oracle against harness-observed artifact evidence. All
 * checks must pass (AND). Returns fail-closed when there is no contract or no
 * artifact report (a text-only run cannot present harness-executed evidence).
 */
export function evaluateObjectiveContract(
  contract: ObjectiveContract | undefined,
  report: ArtifactExecutionReport | undefined,
): ObjectiveEvaluation {
  if (!contract) return { passed: false, reason: NO_OBJECTIVE_CONTRACT_REASON, satisfied: [] };
  if (!report) {
    return { passed: false, reason: "The objective oracle requires harness-executed artifact evidence, but this run produced none.", satisfied: [] };
  }
  const satisfied: string[] = [];
  for (const check of contract.checks) {
    const outcome = evaluateCheck(check, report);
    if (!outcome.passed) {
      return { passed: false, reason: `Objective oracle failed: ${outcome.reason}.`, satisfied };
    }
    satisfied.push(outcome.label);
  }
  return {
    passed: true,
    reason: `Objective oracle satisfied ${satisfied.length} harness-evidence check(s): ${satisfied.join("; ")}`.slice(0, 300),
    satisfied,
  };
}
