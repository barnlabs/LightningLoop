import type { EvolutionRecord, EvolutionState } from "./schema.js";

const NEXT: Readonly<Record<EvolutionState, readonly EvolutionState[]>> = {
  draft: ["source_reviewed", "rolled_back"],
  source_reviewed: ["sandbox_tested", "rolled_back"],
  sandbox_tested: ["adversarially_reviewed", "rolled_back"],
  adversarially_reviewed: ["user_approved", "rolled_back"],
  user_approved: ["active", "rolled_back"],
  active: ["superseded", "rolled_back"],
  superseded: ["rolled_back"],
  rolled_back: [],
};

export function transitionEvolution(
  record: EvolutionRecord,
  next: EvolutionState,
  now = new Date().toISOString(),
): EvolutionRecord {
  if (!NEXT[record.state].includes(next)) {
    throw new Error(`Invalid evolution transition: ${record.state} -> ${next}`);
  }
  if (next === "active") {
    if (!record.rollbackTarget) throw new Error("An active evolution requires a rollback target.");
    if (!record.evaluationSummary) throw new Error("An active evolution requires evaluation evidence.");
    if (record.reviewerFindings.some((finding) => finding.severity === "high" || finding.severity === "blocking")) {
      throw new Error("An evolution with a material finding cannot be activated.");
    }
  }
  return { ...record, state: next, ...(next === "active" ? { activatedAt: now } : {}) };
}
