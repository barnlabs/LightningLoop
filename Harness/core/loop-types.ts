import type { Criterion, EvidenceRecord, ReviewRecord, RunStage } from "./schema.js";
import type { AgentImage } from "./image-input.js";
import type { OpenedSource, SearchProvider, SearchResult } from "../search/search-client.js";
import type { PromiseGraphTraceEntry } from "../graph/promise-graph.js";
import type { ObjectiveContract } from "./objective-oracle.js";

export interface AgentUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
}

export interface AgentRequest {
  role: "orchestrator" | "reviewer" | "implementer";
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  images?: AgentImage[];
}

export interface AgentReply {
  content: string;
  usage: AgentUsage;
}

export interface AgentAdapter {
  readonly supportsImages?: boolean;
  complete(request: AgentRequest, signal?: AbortSignal): Promise<AgentReply>;
}

export interface LoopContext {
  images?: AgentImage[];
  memories?: readonly string[];
  research?: {
    provider: SearchProvider;
    search(query: string): Promise<SearchResult[]>;
    documentationContext?(resultURL: string): Promise<{ url: string; text: string } | undefined>;
    openSource?(resultURL: string): Promise<OpenedSource | undefined>;
  };
  artifactExecutor?: ArtifactExecutor;
  /**
   * Optional owner-supplied completion oracle. When present and satisfied by
   * harness-observed evidence, it unblocks Gold; when absent or failing, the run
   * stays paused (fail-closed).
   */
  objective?: ObjectiveContract;
}

export interface ArtifactFileDraft {
  path: string;
  content: string;
}

export interface VerificationCommandDraft {
  executable: string;
  arguments: string[];
  purpose: string;
  mode?: "verify" | "generate";
  assertionID?: string;
  expectedOutput?: string;
}

export interface ArtifactFileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

export interface VerificationCommandEvidence {
  executable: string;
  arguments: string[];
  purpose: string;
  mode?: "verify" | "generate";
  assertionID?: string;
  expectedOutput?: string;
  exitCode: number | null;
  output: string;
  passed: boolean;
  origin: "implementer" | "harness";
  durationMs: number;
}

export interface ArtifactLoopbackEvidence {
  scheme: "http";
  host: "127.0.0.1";
  status: number;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface ArtifactPreviewEvidence {
  kind: "html" | "image";
  title: string;
  sourcePath: string;
  previewPath: string;
  mimeType: string;
  passed: boolean;
  message: string;
  width?: number;
  height?: number;
  loopback?: ArtifactLoopbackEvidence;
  reviewImage?: AgentImage;
}

export interface ArtifactExecutionReport {
  enabled: true;
  passed: boolean;
  summary: string;
  files: ArtifactFileEvidence[];
  commands: VerificationCommandEvidence[];
  previews: ArtifactPreviewEvidence[];
  workspaceAudit: {
    passed: boolean;
    files: number;
    bytes: number;
    message: string;
  };
}

export interface ArtifactExecutor {
  readonly allowVerificationCommands: boolean;
  describe(): string;
  apply(implementation: ImplementationDraft, signal?: AbortSignal, criteria?: readonly Criterion[]): Promise<ArtifactExecutionReport>;
  /**
   * Reopen the exact manifest recorded by the latest passing apply call.
   * Implementations that cannot provide this terminal check must omit it; the
   * engine then fails closed instead of awarding Gold for artifact work.
   */
  revalidateLastReport?(): Promise<{ passed: boolean; message: string }>;
}

export interface ClarifyingQuestion {
  id: string;
  question: string;
  whyItMatters: string;
}

export interface Clarification {
  summary: string;
  questions: ClarifyingQuestion[];
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  proof: string;
}

export interface PlanningDraft {
  criteria: Criterion[];
  plan: PlanStep[];
  risks: string[];
  acceptanceTest: string;
}

export interface ImplementationDraft {
  deliverable: string;
  notes: string[];
  files: ArtifactFileDraft[];
  verificationCommands: VerificationCommandDraft[];
}

export interface LoopEvent {
  stage: RunStage;
  message: string;
  round?: number;
  role?: AgentRequest["role"];
}

export interface LoopRunResult {
  completed: boolean;
  stage: "gold" | "paused";
  message: string;
  planning: PlanningDraft;
  implementation: ImplementationDraft;
  reviews: ReviewRecord[];
  evidence: EvidenceRecord[];
  artifactReport?: ArtifactExecutionReport;
  graphTrace?: PromiseGraphTraceEntry[];
  usage: AgentUsage;
}

export type LoopEventSink = (event: LoopEvent) => void | Promise<void>;
