export const PROTOCOL_VERSION = 1 as const;

export type RunStage =
  | "draft"
  | "clarifying"
  | "awaiting_answers"
  | "planning"
  | "reviewing_plan"
  | "implementing"
  | "verifying"
  | "reviewing_implementation"
  | "gold"
  | "paused"
  | "failed"
  | "cancelled";

export type Severity = "info" | "low" | "medium" | "high" | "blocking";

export type CriterionEvidenceKind = "source" | "behavior" | "build" | "syntax" | "file" | "render" | "user_acceptance";

export interface Criterion {
  id: string;
  title: string;
  detail: string;
  evidence: string;
  /**
   * Required only for source criteria. This is a literal, case-sensitive
   * proposition, not a semantic summary: the exact bytes must occur in both
   * the opened source and the final output before source evidence can pass.
   */
  sourceClaim?: string;
  evidenceKind: CriterionEvidenceKind;
  evidenceTarget: string;
}

export interface EvidenceRecord {
  criterionID: string;
  kind: "command" | "test" | "build" | "render" | "inspection" | "source" | "user_acceptance";
  summary: string;
  artifact?: string;
  verifier: string;
  passed: boolean;
  capturedAt: string;
}

export interface ReviewFinding {
  id: string;
  severity: Severity;
  criterionID?: string;
  title: string;
  issue: string;
  requiredChange: string;
}

export interface ReviewRecord {
  target: "plan" | "implementation" | "evolution";
  round: number;
  score: number;
  verdict: "pass" | "revise";
  summary: string;
  findings: ReviewFinding[];
  requiredChanges: string[];
}

export interface GoldInput {
  criteria: Criterion[];
  evidence: EvidenceRecord[];
  review: ReviewRecord;
  verificationComplete: boolean;
  capabilityAmbiguities: string[];
}

export type CapabilityKind =
  | "workspace.read"
  | "workspace.write"
  | "process.execute"
  | "network.domain"
  | "search.provider"
  | "mcp.start"
  | "memory.read"
  | "evolution.propose"
  | "evolution.activate"
  | "publish.deploy"
  | "private_data.handle";

export interface CapabilityGrant {
  id: string;
  kind: CapabilityKind;
  scope: string;
  reason: string;
  runID: string;
  approvedBy: "user";
  approvedAt: string;
  expiresAt?: string;
  reusable: boolean;
}

export type MemoryScope = "run" | "project" | "user";
export type MemoryAuthor = "user" | "imported_source" | "agent_inference" | "verifier";
export type VerificationState = "unverified" | "source_backed" | "verified" | "contradicted";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  statement: string;
  tags: string[];
  sourceArtifact: string;
  sourceRunID: string;
  author: MemoryAuthor;
  confidence: number;
  verification: VerificationState;
  sensitivity: "public" | "private" | "secret_prohibited";
  createdAt: string;
  reviewedAt?: string;
  expiresAt?: string;
  supersedes?: string;
  supersededBy?: string;
  promotionApprovedByUser: boolean;
}

export type EvolutionKind = "system_prompt" | "skill" | "tool" | "mcp" | "memory_policy";
export type EvolutionState =
  | "draft"
  | "source_reviewed"
  | "sandbox_tested"
  | "adversarially_reviewed"
  | "user_approved"
  | "active"
  | "superseded"
  | "rolled_back";

export interface EvolutionRecord {
  id: string;
  kind: EvolutionKind;
  name: string;
  version: string;
  state: EvolutionState;
  source: string;
  reason: string;
  exactDiff: string;
  permissions: CapabilityKind[];
  dependencies: string[];
  evaluationSuite: string;
  evaluationSummary?: string;
  reviewerFindings: ReviewFinding[];
  rollbackTarget?: string;
  createdAt: string;
  activatedAt?: string;
}

export interface ProtocolEnvelope<TType extends string, TPayload> {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: TType;
  runID: string;
  timestamp: string;
  payload: TPayload;
  requestID?: string;
  eventID?: string;
}
