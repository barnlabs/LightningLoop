import type { GoldInput, ReviewFinding } from "./schema.js";

export interface GoldDecision {
  passed: boolean;
  reasons: string[];
}

const material = (finding: ReviewFinding): boolean =>
  finding.severity === "medium" || finding.severity === "high" || finding.severity === "blocking";

export function decideGold(input: GoldInput): GoldDecision {
  const reasons: string[] = [];
  const criterionIDs = new Set(input.criteria.map((criterion) => criterion.id));
  const passedEvidence = new Set(
    input.evidence.filter((evidence) => evidence.passed).map((evidence) => evidence.criterionID),
  );

  if (input.criteria.length === 0) reasons.push("No acceptance criteria were defined.");
  for (const criterion of input.criteria) {
    if (!passedEvidence.has(criterion.id)) {
      reasons.push(`Criterion ${criterion.id} has no passing evidence.`);
    }
  }
  for (const evidence of input.evidence) {
    if (!criterionIDs.has(evidence.criterionID)) {
      reasons.push(`Evidence references unknown criterion ${evidence.criterionID}.`);
    }
  }
  if (!input.verificationComplete) reasons.push("Independent verification is incomplete.");
  if (input.review.verdict !== "pass") reasons.push("The reviewer verdict is not pass.");
  if (input.review.score < 9) reasons.push("The reviewer score is below 9/10.");
  if (input.review.findings.some(material)) reasons.push("A medium, high, or blocking finding remains.");
  if (input.review.requiredChanges.length > 0) reasons.push("Required changes remain.");
  if (input.capabilityAmbiguities.length > 0) reasons.push("A capability request remains ambiguous.");

  return { passed: reasons.length === 0, reasons };
}
