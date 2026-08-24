/**
 * Deterministic self-improvement proposal generator.
 *
 * From a completed or paused run result this derives structured, INERT draft
 * proposals (system_prompt and/or skill kind) and records them through the
 * existing reviewed evolution lifecycle via {@link proposeManagedEvolution},
 * which always creates records in the "draft" state.
 *
 * SECURITY INVARIANT — this module only ever *proposes*. Every proposal is born
 * in "draft" and is never surfaced to a run until it has traversed the full
 * source-reviewed → sandbox-tested → adversarially-reviewed → user-approved →
 * active lifecycle (enforced by `ledger-management`, and by `evolution-store`
 * which loads only `state === "active"` guidance). Nothing here activates,
 * advances, or bypasses that lifecycle. Run-derived text is additionally
 * secret-redacted before it reaches the ledger, on top of the ledger's own
 * fail-closed secret rejection.
 */
import type { LoopRunResult } from "./loop-types.js";
import type { ReviewFinding, ReviewRecord, Severity } from "./schema.js";
import { proposeManagedEvolution, type ManagedEvolutionRecord } from "./ledger-management.js";

const SECRET_SHAPE = /(?:\bcsk-|\bgsk_|\bfc-|\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}|\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{8,}/gi;

const SEVERITY_RANK: Record<Severity, number> = { blocking: 4, high: 3, medium: 2, low: 1, info: 0 };

export interface SelfImprovementProposal {
  kind: "system_prompt" | "skill";
  name: string;
  source: string;
  reason: string;
  exactDiff: string;
}

/** Replace any secret-shaped fragment so run-derived text can never carry a credential into the ledger. */
function redactSecrets(text: string): string {
  return text.replace(SECRET_SHAPE, "[redacted]");
}

/** Redact, trim, and hard-cap a block (newlines preserved). */
function redactAndCap(text: string, max: number): string {
  const clean = redactSecrets(text).trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Redact, collapse whitespace, and cap a single line. */
function line(text: string, max: number): string {
  return redactAndCap(text.replace(/\s+/gu, " "), max);
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Findings across all reviews, sorted deterministically (severity desc, then text). */
function collectFindings(reviews: readonly ReviewRecord[]): ReviewFinding[] {
  return reviews
    .flatMap((review) => review.findings)
    .slice()
    .sort((a, b) =>
      (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
      || a.title.localeCompare(b.title)
      || a.issue.localeCompare(b.issue));
}

function buildSystemPromptProposal(
  outcome: "gold" | "paused",
  themes: readonly string[],
  requiredChanges: readonly string[],
  reviewRounds: number,
): SelfImprovementProposal {
  const lines = [`Guidance distilled from the last ${outcome} LightningLoop run (${reviewRounds} reviewer round(s)).`];
  if (themes.length > 0) {
    lines.push("Pre-empt these recurring reviewer findings before claiming completion:");
    themes.forEach((theme, index) => lines.push(`${index + 1}. ${theme}`));
  } else {
    lines.push("The reviewer raised no material finding; preserve the evidence-first discipline that reached Gold.");
  }
  if (requiredChanges.length > 0) {
    lines.push("Apply these required-change patterns proactively:");
    requiredChanges.forEach((change) => lines.push(`- ${change}`));
  }
  return {
    kind: "system_prompt",
    name: `Self-improvement addendum from ${outcome} run`,
    source: "Automated self-improvement (deterministic)",
    reason: `Derived from a ${outcome} run with ${themes.length} material finding theme(s); proposes reviewer-aligned guidance so future runs pre-empt the same defects.`,
    exactDiff: redactAndCap(lines.join("\n"), 8_000),
  };
}

function buildSkillProposal(
  outcome: "gold" | "paused",
  material: readonly ReviewFinding[],
  requiredChanges: readonly string[],
): SelfImprovementProposal {
  const checks = dedupe([
    ...material.map((finding) => line(finding.requiredChange || finding.title, 160)),
    ...requiredChanges,
  ]).slice(0, 10);
  const lines = [
    `Reusable verification checklist derived from a ${outcome} run.`,
    "Advisory only — grants no tools or permissions.",
  ];
  if (checks.length > 0) {
    lines.push("Before declaring Gold, confirm each item:");
    checks.forEach((check) => lines.push(`- [ ] ${check}`));
  } else {
    lines.push("Before declaring Gold, confirm each item:");
    lines.push("- [ ] Reproduce the deliverable end-to-end and attach the exact command/output evidence.");
    lines.push("- [ ] Confirm every criterion has reviewer-traced evidence.");
  }
  return {
    kind: "skill",
    name: `Skill checklist from ${outcome} run`,
    source: "Automated self-improvement (deterministic)",
    reason: `Captured ${checks.length} reusable check(s) from the reviewer's required changes.`,
    exactDiff: redactAndCap(lines.join("\n"), 8_000),
  };
}

/**
 * Deterministically derive one system_prompt and one skill proposal from a run
 * result. Pure: identical input yields identical proposals (the only nondeterminism
 * — id and timestamp — is added later by the ledger when a proposal is recorded).
 */
export function deriveSelfImprovementProposals(result: LoopRunResult): SelfImprovementProposal[] {
  const outcome: "gold" | "paused" = result.completed ? "gold" : "paused";
  const findings = collectFindings(result.reviews);
  const material = findings.filter((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.medium);
  const themes = dedupe(material.map((finding) => line(finding.title, 120))).slice(0, 8);
  const requiredChanges = dedupe(result.reviews.flatMap((review) => review.requiredChanges).map((change) => line(change, 200))).slice(0, 8);
  return [
    buildSystemPromptProposal(outcome, themes, requiredChanges, result.reviews.length),
    buildSkillProposal(outcome, material, requiredChanges),
  ];
}

/**
 * Record the derived proposals as INERT drafts in the evolution ledger. Returns
 * the created records — each in the "draft" state. This performs no activation
 * and no lifecycle advancement; callers who want a proposal to take effect must
 * run it through the full reviewed lifecycle.
 */
export function recordSelfImprovementProposals(result: LoopRunResult, path?: string): ManagedEvolutionRecord[] {
  return deriveSelfImprovementProposals(result).map((proposal) =>
    proposeManagedEvolution(
      { kind: proposal.kind, name: proposal.name, source: proposal.source, reason: proposal.reason, exactDiff: proposal.exactDiff },
      path,
    ));
}
