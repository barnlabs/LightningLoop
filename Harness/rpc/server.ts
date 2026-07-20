import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { LoopEngine } from "../core/loop-engine.js";
import type { AgentAdapter, Clarification, LoopEvent } from "../core/loop-types.js";
import { SecretRedactor } from "../core/redaction.js";
import { PROTOCOL_VERSION, type ProtocolEnvelope } from "../core/schema.js";
import { objectValue, stringValue } from "../core/structured-json.js";
import { PiProviderAdapter } from "../pi/model-adapter.js";
import { loadProviderProfile, providerCredentialService } from "../core/provider-profile.js";
import { validateImagePaths, type AgentImage } from "../core/image-input.js";
import { SearchClient, type SearchProvider } from "../search/search-client.js";
import { loadEligibleMemoryContext } from "../core/memory-store.js";
import { assertCredentialSafeInput, assertNoConfiguredCredential } from "../core/credential-safety.js";
import { WorkspaceArtifactExecutor } from "../artifacts/workspace-artifact-executor.js";
import { artifactSeedsForGoal } from "../artifacts/builtin-artifact-seeds.js";

const MAX_LINE_BYTES = 1_048_576;
const MAX_RUNS = 100;
const MAX_REQUEST_IDS = 10_000;
const MAX_GOAL_CHARACTERS = 50_000;
const MAX_ANSWERS = 20;
const MAX_ANSWER_CHARACTERS = 20_000;
const KEYCHAIN_SERVICES = {
  exa: "com.barnlabs.LightningLoop.search.exa",
  brave: "com.barnlabs.LightningLoop.search.brave",
  firecrawl: "com.barnlabs.LightningLoop.search.firecrawl",
} as const;

interface RequestPayloads {
  hello: Record<string, never>;
  createRun: { goal: string; imagePaths?: string[] };
  continueRun: {
    answers: Record<string, string>;
    maxReviewCycles?: number;
    goal?: string;
    clarification?: Clarification;
    imagePaths?: string[];
    researchProvider?: SearchProvider;
    artifactWorkspace?: string;
    approveArtifactWrites?: boolean;
    approveVerificationCommands?: boolean;
  };
  cancelRun: Record<string, never>;
  credentialStatus: Record<string, never>;
}

type RequestType = keyof RequestPayloads;
type RequestEnvelope = ProtocolEnvelope<RequestType, Record<string, unknown>> & { requestID: string };

interface RunState {
  goal: string;
  clarification?: Clarification;
  controller: AbortController;
  active: boolean;
  createdAt: number;
  images: AgentImage[];
}

export type RpcEmitter = (envelope: ProtocolEnvelope<string, unknown>) => void;
export type AgentFactory = () => Promise<AgentAdapter>;

class RpcRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function keychainConfigured(service: string): boolean {
  return spawnSync("/usr/bin/security", ["find-generic-password", "-s", service], {
    stdio: "ignore",
    timeout: 5_000,
  }).status === 0;
}

function searchConfigured(provider: keyof typeof KEYCHAIN_SERVICES): boolean {
  return keychainConfigured(KEYCHAIN_SERVICES[provider]);
}

function imagePathList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RpcRequestError("invalid_input", "imagePaths must be an array.");
  return value.map((path, index) => boundedString(path, `imagePaths[${index}]`, 4_096));
}

function searchProviderValue(value: unknown): SearchProvider | undefined {
  if (value === undefined) return undefined;
  if (value === "exa" || value === "brave" || value === "firecrawl") return value;
  throw new RpcRequestError("invalid_input", "researchProvider must be exa, brave, or firecrawl.");
}

function parseRequest(line: string, redactor: SecretRedactor): RequestEnvelope {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new RpcRequestError("message_too_large", "JSONL request exceeds 1 MiB.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(line) as unknown;
  } catch {
    throw new RpcRequestError("invalid_json", "Request must be one unfenced JSON object on one line.");
  }
  const root = objectValue(decoded, "request");
  redactor.assertSafe(root);
  if (root.protocolVersion !== PROTOCOL_VERSION) throw new RpcRequestError("unsupported_version", `Protocol version ${String(root.protocolVersion)} is unsupported.`);
  const type = stringValue(root.type, "type");
  if (!["hello", "createRun", "continueRun", "cancelRun", "credentialStatus"].includes(type)) {
    throw new RpcRequestError("unknown_request", `Unknown request type: ${type}`);
  }
  const runID = boundedString(root.runID, "runID", 128);
  const requestID = boundedString(root.requestID, "requestID", 128);
  const timestamp = stringValue(root.timestamp, "timestamp");
  if (!Number.isFinite(Date.parse(timestamp))) throw new RpcRequestError("invalid_timestamp", "timestamp must be ISO 8601.");
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: type as RequestType,
    runID,
    requestID,
    timestamp,
    payload: objectValue(root.payload, "payload"),
  };
}

function boundedString(value: unknown, label: string, maximum: number): string {
  const result = stringValue(value, label);
  if (result.length > maximum) throw new RpcRequestError("invalid_input", `${label} exceeds ${maximum} characters.`);
  return result;
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new RpcRequestError("invalid_input", `${label} must be a boolean.`);
  return value;
}

function answerMap(value: unknown): Record<string, string> {
  const raw = objectValue(value, "answers");
  if (Object.keys(raw).length > MAX_ANSWERS) throw new RpcRequestError("invalid_input", `answers may contain at most ${MAX_ANSWERS} entries.`);
  const answers: Record<string, string> = {};
  for (const [key, answer] of Object.entries(raw)) {
    answers[boundedString(key, "answer ID", 128)] = boundedString(answer, `answers.${key}`, MAX_ANSWER_CHARACTERS);
  }
  return answers;
}

function clarificationValue(value: unknown): Clarification {
  const root = objectValue(value, "clarification");
  if (!Array.isArray(root.questions) || root.questions.length < 1 || root.questions.length > 5) {
    throw new RpcRequestError("invalid_input", "clarification.questions must contain 1 through 5 questions.");
  }
  return {
    summary: boundedString(root.summary, "clarification.summary", 10_000),
    questions: root.questions.map((value, index) => {
      const question = objectValue(value, `clarification.questions[${index}]`);
      return {
        id: boundedString(question.id, `clarification.questions[${index}].id`, 128),
        question: boundedString(question.question, `clarification.questions[${index}].question`, 10_000),
        whyItMatters: boundedString(question.whyItMatters, `clarification.questions[${index}].whyItMatters`, 10_000),
      };
    }),
  };
}

export class JsonlHarnessServer {
  private readonly runs = new Map<string, RunState>();
  private readonly requestIDs = new Set<string>();
  private readonly redactor = new SecretRedactor();

  constructor(
    private readonly emit: RpcEmitter,
    private readonly agentFactory: AgentFactory = () => PiProviderAdapter.create(),
  ) {}

  private send(type: string, request: Pick<RequestEnvelope, "runID" | "requestID">, payload: unknown): void {
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      type,
      runID: request.runID,
      requestID: request.requestID,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.redactor.assertSafe(envelope);
    assertCredentialSafeInput(envelope, loadProviderProfile());
    this.emit(envelope);
  }

  private event(request: RequestEnvelope, event: LoopEvent): void {
    this.send("stageChanged", request, event);
  }

  private rememberRequest(request: RequestEnvelope): void {
    const key = `${request.runID}\u0000${request.requestID}`;
    if (this.requestIDs.has(key)) throw new RpcRequestError("duplicate_request", "That request ID was already processed for this run.");
    if (this.requestIDs.size >= MAX_REQUEST_IDS) {
      const oldest = this.requestIDs.values().next().value as string | undefined;
      if (oldest) this.requestIDs.delete(oldest);
    }
    this.requestIDs.add(key);
  }

  private makeRun(goal: string, clarification?: Clarification, images: AgentImage[] = []): RunState {
    if (this.runs.size >= MAX_RUNS) {
      const inactive = [...this.runs.entries()]
        .filter(([, state]) => !state.active)
        .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
      if (!inactive) throw new RpcRequestError("server_busy", "The harness has reached its active-run limit.");
      this.runs.delete(inactive[0]);
    }
    return {
      goal,
      ...(clarification ? { clarification } : {}),
      controller: new AbortController(),
      active: false,
      createdAt: Date.now(),
      images,
    };
  }

  async handleLine(line: string): Promise<void> {
    let request: RequestEnvelope | undefined;
    try {
      const parsedRequest = parseRequest(line, this.redactor);
      assertCredentialSafeInput(parsedRequest, loadProviderProfile());
      request = parsedRequest;
      this.rememberRequest(request);
      switch (request.type) {
        case "hello":
          const profile = loadProviderProfile();
          this.send("response", request, {
            requestType: "hello",
            product: "LightningLoop",
            protocolVersion: PROTOCOL_VERSION,
            provider: profile.displayName,
            model: profile.modelID,
            capabilities: ["promise_duty_graph", "deterministic_gold", "cancel", "credential_status", "stateless_continue", "images", "iterative_bounded_research", "reviewed_workspace_artifacts", "evidence_lab", "loopback_html_proof", "rendered_previews", "sandboxed_script_runner", "managed_overlay_backups"],
            identity: "A BarnLabs open-source project. Providers are user-selected third-party services.",
          });
          return;
        case "credentialStatus":
          const activeProfile = loadProviderProfile();
          const piManaged = Boolean(activeProfile.piProviderID);
          this.send("response", request, {
            requestType: "credentialStatus",
            activeProvider: activeProfile.id,
            providers: {
              // Pi credentials are intentionally opaque to LightningLoop. A
              // built-in provider's actual login state is learned only when Pi
              // runs the model and reports its own authentication failure.
              inference: piManaged
                ? "Pi-managed/unknown"
                : (process.platform === "darwin" && keychainConfigured(providerCredentialService(activeProfile))),
              piManaged,
              ...Object.fromEntries((Object.keys(KEYCHAIN_SERVICES) as (keyof typeof KEYCHAIN_SERVICES)[]).map((name) => [name, searchConfigured(name)])),
            },
            valuesExposed: false,
          });
          return;
        case "cancelRun": {
          const state = this.runs.get(request.runID);
          if (!state?.active) throw new RpcRequestError("run_not_active", "The run is not active.");
          state.controller.abort(new DOMException("Run cancelled by client.", "AbortError"));
          this.send("response", request, { requestType: "cancelRun", cancelled: true });
          return;
        }
        case "createRun": {
          if (this.runs.get(request.runID)?.active) throw new RpcRequestError("run_conflict", "The run ID is already active.");
          assertCredentialSafeInput(request.payload, loadProviderProfile());
          const goal = boundedString(request.payload.goal, "payload.goal", MAX_GOAL_CHARACTERS);
          const images = await validateImagePaths(imagePathList(request.payload.imagePaths));
          const state = this.makeRun(goal, undefined, images);
          state.active = true;
          this.runs.set(request.runID, state);
          try {
            const memories = loadEligibleMemoryContext(request.runID);
            assertNoConfiguredCredential(memories, loadProviderProfile());
            const clarification = await new LoopEngine(await this.agentFactory(), {
              images,
              memories,
            }).clarify(goal, state.controller.signal);
            assertCredentialSafeInput(clarification, loadProviderProfile());
            state.clarification = clarification;
            state.active = false;
            this.send("response", request, { requestType: "createRun", stage: "awaiting_answers", clarification });
          } catch (error) {
            state.active = false;
            throw error;
          }
          return;
        }
        case "continueRun": {
          assertCredentialSafeInput(request.payload, loadProviderProfile());
          let state = this.runs.get(request.runID);
          if (!state && request.payload.goal !== undefined && request.payload.clarification !== undefined) {
            const images = await validateImagePaths(imagePathList(request.payload.imagePaths));
            state = this.makeRun(
              boundedString(request.payload.goal, "payload.goal", MAX_GOAL_CHARACTERS),
              clarificationValue(request.payload.clarification),
              images,
            );
            this.runs.set(request.runID, state);
          }
          if (!state?.clarification) throw new RpcRequestError("run_not_ready", "Create and clarify the run before continuing.");
          if (state.active) throw new RpcRequestError("run_conflict", "The run is already active.");
          const answers = answerMap(request.payload.answers);
          const cycles = request.payload.maxReviewCycles === undefined ? 4 : request.payload.maxReviewCycles;
          if (typeof cycles !== "number" || !Number.isInteger(cycles) || cycles < 1 || cycles > 8) {
            throw new RpcRequestError("invalid_cycles", "maxReviewCycles must be an integer from 1 through 8.");
          }
          state.controller = new AbortController();
          state.active = true;
          try {
            const researchProvider = searchProviderValue(request.payload.researchProvider);
            const search = researchProvider ? new SearchClient() : undefined;
            const approveArtifactWrites = optionalBoolean(request.payload.approveArtifactWrites, "approveArtifactWrites");
            const approveVerificationCommands = optionalBoolean(request.payload.approveVerificationCommands, "approveVerificationCommands");
            if (approveVerificationCommands && !approveArtifactWrites) {
              throw new RpcRequestError("capability_denied", "Verification commands require an explicit artifact-write grant.");
            }
            if (approveArtifactWrites && request.payload.artifactWorkspace === undefined) {
              throw new RpcRequestError("invalid_input", "artifactWorkspace is required when artifact writes are approved.");
            }
            if (!approveArtifactWrites && request.payload.artifactWorkspace !== undefined) {
              throw new RpcRequestError("capability_denied", "artifactWorkspace was supplied without an explicit artifact-write grant.");
            }
            const artifactExecutor = approveArtifactWrites
              ? await WorkspaceArtifactExecutor.create(
                  boundedString(request.payload.artifactWorkspace, "artifactWorkspace", 4_096),
                  approveVerificationCommands,
                  await artifactSeedsForGoal(state.goal, state.images),
                )
              : undefined;
            const memories = loadEligibleMemoryContext(request.runID);
            assertNoConfiguredCredential(memories, loadProviderProfile());
            const result = await new LoopEngine(await this.agentFactory(), {
              images: state.images,
              memories,
              ...(artifactExecutor ? { artifactExecutor } : {}),
              ...(researchProvider && search ? {
                research: {
                  provider: researchProvider,
                  search: async (query: string) => (await search.search(researchProvider, query, 5)).results,
                  documentationContext: async (url: string) => search.documentationContext(url),
                  openSource: async (url: string) => search.openSource(url),
                },
              } : {}),
            }).execute(
              state.goal,
              state.clarification,
              answers,
              cycles,
              (event) => this.event(request as RequestEnvelope, event),
              state.controller.signal,
            );
            assertCredentialSafeInput(result, loadProviderProfile());
            state.active = false;
            this.send(result.completed ? "runCompleted" : "runPaused", request, result);
            this.send("response", request, { requestType: "continueRun", result });
          } catch (error) {
            state.active = false;
            throw error;
          }
          return;
        }
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const code = error instanceof RpcRequestError ? error.code : aborted ? "cancelled" : "request_failed";
      const rawMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = this.redactor.redact(rawMessage).slice(0, 1_000);
      this.send("error", request ?? { runID: "protocol", requestID: "unknown" }, {
        code,
        message: safeMessage,
        retryable: false,
      });
    }
  }
}

export async function runJsonlServer(): Promise<void> {
  const server = new JsonlHarnessServer((envelope) => process.stdout.write(`${JSON.stringify(envelope)}\n`));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  lines.on("line", (line) => {
    const request = server.handleLine(line);
    pending.add(request);
    void request.finally(() => pending.delete(request));
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  await Promise.allSettled([...pending]);
}
