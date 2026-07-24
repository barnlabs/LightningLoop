import { spawnSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { LoopEngine } from "../core/loop-engine.js";
import type { AgentAdapter, Clarification, LoopEvent } from "../core/loop-types.js";
import { SecretRedactor } from "../core/redaction.js";
import { PROTOCOL_VERSION, type ProtocolEnvelope } from "../core/schema.js";
import { objectValue, stringValue } from "../core/structured-json.js";
import { PiProviderAdapter } from "../pi/model-adapter.js";
import {
  loadProviderProfile,
  providerCredentialService,
  runtimeModelSelectionNotice,
  type ProviderProfile,
} from "../core/provider-profile.js";
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

interface ExpectedRuntimeModelSelection {
  expectedProviderID: string;
  expectedModelID: string;
  expectedSupportsImages: boolean;
  expectedContextWindow: number;
  expectedMaxOutputTokens: number;
}

interface RequestPayloads {
  hello: Record<string, never>;
  createRun: ExpectedRuntimeModelSelection & { goal: string; imagePaths?: string[] };
  continueRun: ExpectedRuntimeModelSelection & {
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
  providerModels: Record<string, never>;
}

type RequestType = keyof RequestPayloads;
type RequestEnvelope = ProtocolEnvelope<RequestType, Record<string, unknown>> & { requestID: string };

const REQUEST_ENVELOPE_FIELDS = new Set(["protocolVersion", "type", "runID", "requestID", "timestamp", "payload"]);
const REQUIRED_PAYLOAD_FIELDS: Record<RequestType, readonly string[]> = {
  hello: [],
  createRun: ["goal", "expectedProviderID", "expectedModelID", "expectedSupportsImages", "expectedContextWindow", "expectedMaxOutputTokens"],
  continueRun: ["answers", "expectedProviderID", "expectedModelID", "expectedSupportsImages", "expectedContextWindow", "expectedMaxOutputTokens"],
  cancelRun: [],
  credentialStatus: [],
  providerModels: [],
};
const OPTIONAL_PAYLOAD_FIELDS: Record<RequestType, readonly string[]> = {
  hello: [],
  createRun: ["imagePaths"],
  continueRun: ["maxReviewCycles", "goal", "clarification", "imagePaths", "researchProvider", "artifactWorkspace", "approveArtifactWrites", "approveVerificationCommands"],
  cancelRun: [],
  credentialStatus: [],
  providerModels: [],
};

function assertExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const fields = Object.keys(value);
  const unknown = fields.find((field) => !allowed.has(field));
  if (unknown) throw new RpcRequestError("invalid_input", `${label} contains unsupported field ${unknown}.`);
  const missing = required.find((field) => !Object.hasOwn(value, field));
  if (missing) throw new RpcRequestError("invalid_input", `${label} is missing required field ${missing}.`);
}

interface RunState {
  goal: string;
  clarification?: Clarification;
  controller: AbortController;
  active: boolean;
  createdAt: number;
  images: AgentImage[];
}

export type RpcEmitter = (envelope: ProtocolEnvelope<string, unknown>) => void;
export type AgentFactory = (profile: ProviderProfile) => Promise<AgentAdapter>;

export interface RuntimeModelOption {
  modelID: string;
  modelName: string;
  supportsImages: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface RuntimeModelCatalog {
  providerID: string;
  models: RuntimeModelOption[];
}

export type RuntimeModelCatalogFactory = (profile: ProviderProfile) => Promise<RuntimeModelCatalog>;

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
  assertExactFields(root, [...REQUEST_ENVELOPE_FIELDS], [], "request");
  if (root.protocolVersion !== PROTOCOL_VERSION) throw new RpcRequestError("unsupported_version", `Protocol version ${String(root.protocolVersion)} is unsupported.`);
  const type = stringValue(root.type, "type");
  if (!["hello", "createRun", "continueRun", "cancelRun", "credentialStatus", "providerModels"].includes(type)) {
    throw new RpcRequestError("unknown_request", `Unknown request type: ${type}`);
  }
  const requestType = type as RequestType;
  const runID = boundedSafeString(root.runID, "runID", 128);
  const requestID = boundedSafeString(root.requestID, "requestID", 128);
  const timestamp = boundedSafeString(root.timestamp, "timestamp", 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new RpcRequestError("invalid_timestamp", "timestamp must be a bounded UTC ISO 8601 instant.");
  }
  const payload = objectValue(root.payload, "payload");
  assertExactFields(payload, REQUIRED_PAYLOAD_FIELDS[requestType], OPTIONAL_PAYLOAD_FIELDS[requestType], "payload");
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: requestType,
    runID,
    requestID,
    timestamp,
    payload,
  };
}

function safeRuntimeString(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum && !/[\r\n\0]/u.test(trimmed) ? trimmed : fallback;
}

function safeRuntimeLimit(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return value >= minimum && value <= maximum ? value : fallback;
}

type RuntimeCredentialStore = NonNullable<NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"]>;

const inertRuntimeCredentialStore: RuntimeCredentialStore = {
  async read(_providerID) { return undefined; },
  async list() { return []; },
  async modify(_providerID, _modify) { return undefined; },
  async delete(_providerID) {},
};

async function defaultRuntimeModelCatalog(profile: ProviderProfile): Promise<RuntimeModelCatalog> {
  if (!profile.piProviderID) {
    return { providerID: profile.id, models: [] };
  }
  // This runtime instance is credential-free and network-disabled. It uses the
  // installed model definitions only; it neither reads nor reports auth state.
  const runtime = await ModelRuntime.create({
    credentials: inertRuntimeCredentialStore,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const models = runtime.getModels(profile.piProviderID).flatMap((model): RuntimeModelOption[] => {
    const modelID = safeRuntimeString(model.id, "", 200);
    if (!modelID) return [];
    return [{
      modelID,
      modelName: safeRuntimeString(model.name, modelID, 120),
      supportsImages: model.input?.includes("image") ?? false,
      contextWindow: safeRuntimeLimit(model.contextWindow, 131_072, 1_024, 2_000_000),
      maxOutputTokens: safeRuntimeLimit(model.maxTokens, 32_768, 256, 131_072),
    }];
  });
  return { providerID: profile.id, models };
}

function boundedString(value: unknown, label: string, maximum: number): string {
  const result = stringValue(value, label);
  if (result.length > maximum) throw new RpcRequestError("invalid_input", `${label} exceeds ${maximum} characters.`);
  return result;
}

function boundedSafeString(value: unknown, label: string, maximum: number): string {
  const result = boundedString(value, label, maximum);
  if (!result || /[ -]/u.test(result)) {
    throw new RpcRequestError("invalid_input", `${label} must be a non-empty control-free string.`);
  }
  return result;
}

function expectedBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RpcRequestError("invalid_input", `${label} must be a boolean.`);
  return value;
}

function expectedLimit(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RpcRequestError("invalid_input", `${label} is outside the supported runtime bounds.`);
  }
  return value;
}

function expectedModelSelection(payload: Record<string, unknown>, profile: ProviderProfile): ExpectedRuntimeModelSelection {
  const selection = {
    expectedProviderID: boundedSafeString(payload.expectedProviderID, "payload.expectedProviderID", 64),
    expectedModelID: boundedSafeString(payload.expectedModelID, "payload.expectedModelID", 200),
    expectedSupportsImages: expectedBoolean(payload.expectedSupportsImages, "payload.expectedSupportsImages"),
    expectedContextWindow: expectedLimit(payload.expectedContextWindow, "payload.expectedContextWindow", 1_024, 2_000_000),
    expectedMaxOutputTokens: expectedLimit(payload.expectedMaxOutputTokens, "payload.expectedMaxOutputTokens", 256, 131_072),
  };
  if (selection.expectedProviderID !== profile.id || selection.expectedModelID !== profile.modelID) {
    throw new RpcRequestError(
      "model_selection_mismatch",
      "The selected provider or model changed before the LightningLoop runtime started the request. Refresh the runtime catalog and try again.",
    );
  }
  return selection;
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

function isCatalogText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= maximum
    && !/[\r\n\0]/u.test(value);
}

function isCatalogProviderID(value: unknown): value is string {
  return isCatalogText(value, 64) && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
}

function isCatalogLimit(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validatedRuntimeModelCatalog(profile: ProviderProfile, value: unknown): RuntimeModelCatalog {
  const invalid = () => {
    throw new RpcRequestError("invalid_runtime_catalog", "The LightningLoop runtime returned an invalid model catalog.");
  };
  if (typeof value !== "object" || value === null) return invalid();
  const catalog = value as Partial<RuntimeModelCatalog>;
  if (!isCatalogProviderID(catalog.providerID) || catalog.providerID !== profile.id || !Array.isArray(catalog.models) || catalog.models.length > 500) {
    return invalid();
  }
  const modelIDs = new Set<string>();
  const models: RuntimeModelOption[] = [];
  for (const value of catalog.models) {
    if (typeof value !== "object" || value === null) return invalid();
    const model = value as Partial<RuntimeModelOption>;
    const { modelID, modelName, supportsImages, contextWindow, maxOutputTokens } = model;
    if (!isCatalogText(modelID, 200)
      || !isCatalogText(modelName, 120)
      || typeof supportsImages !== "boolean"
      || !isCatalogLimit(contextWindow, 1_024, 2_000_000)
      || !isCatalogLimit(maxOutputTokens, 256, 131_072)
      || modelIDs.has(modelID)) {
      return invalid();
    }
    modelIDs.add(modelID);
    models.push({
      modelID,
      modelName,
      supportsImages,
      contextWindow,
      maxOutputTokens,
    });
  }
  return { providerID: catalog.providerID, models };
}

class StageEventSequence {
  private readonly seen = new Set<string>();
  private terminal: "gold" | "paused" | undefined;

  accept(event: LoopEvent): void {
    const stage = event.stage;
    if (this.terminal) throw new RpcRequestError("invalid_stage_sequence", "A stage event followed the terminal stage.");
    if (this.seen.size === 0 && stage !== "planning") {
      throw new RpcRequestError("invalid_stage_sequence", "The first run stage must be planning.");
    }
    if (stage === "reviewing_plan" && !this.seen.has("planning")) {
      throw new RpcRequestError("invalid_stage_sequence", "Plan review occurred before planning.");
    }
    if (stage === "implementing" && !this.seen.has("reviewing_plan")) {
      throw new RpcRequestError("invalid_stage_sequence", "Implementation occurred before plan review.");
    }
    if ((stage === "verifying" || stage === "reviewing_implementation") && !this.seen.has("implementing")) {
      throw new RpcRequestError("invalid_stage_sequence", "Implementation review occurred before implementation.");
    }
    if (stage === "gold" && !this.seen.has("reviewing_implementation")) {
      throw new RpcRequestError("invalid_stage_sequence", "Gold occurred before implementation review.");
    }
    if (stage === "gold" || stage === "paused") this.terminal = stage;
    this.seen.add(stage);
  }

  finish(completed: boolean, message: string): LoopEvent | undefined {
    const expected = completed ? "gold" : "paused";
    if (this.terminal && this.terminal !== expected) {
      throw new RpcRequestError("invalid_stage_sequence", "The terminal stage disagreed with the run result.");
    }
    if (this.terminal) return undefined;
    const event = {
      stage: expected,
      role: completed ? "reviewer" : "orchestrator",
      message,
    } as LoopEvent;
    this.accept(event);
    return event;
  }
}

export class JsonlHarnessServer {
  private readonly runs = new Map<string, RunState>();
  private readonly runReservations = new Set<string>();
  private readonly requestIDs = new Set<string>();
  private readonly redactor = new SecretRedactor();

  constructor(
    private readonly emit: RpcEmitter,
    private readonly agentFactory: AgentFactory = (profile) => PiProviderAdapter.create(profile),
    private readonly runtimeModelCatalogFactory: RuntimeModelCatalogFactory = defaultRuntimeModelCatalog,
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

  private async runtimeModelCatalog(profile: ProviderProfile): Promise<RuntimeModelCatalog> {
    const catalog = await this.runtimeModelCatalogFactory(profile);
    return validatedRuntimeModelCatalog(profile, catalog);
  }

  private async selectedRuntimeProfile(payload: Record<string, unknown>, profile: ProviderProfile): Promise<ProviderProfile> {
    const expected = expectedModelSelection(payload, profile);
    if (!profile.piProviderID) {
      if (expected.expectedSupportsImages !== profile.supportsImages
          || expected.expectedContextWindow !== profile.contextWindow
          || expected.expectedMaxOutputTokens !== profile.maxOutputTokens) {
        throw new RpcRequestError("model_catalog_drift", "The custom model capabilities changed before the request started.");
      }
      return profile;
    }
    const catalog = await this.runtimeModelCatalog(profile);
    const selected = catalog.models.find((model) => model.modelID === profile.modelID);
    if (!selected) {
      const selectionNotice = runtimeModelSelectionNotice(profile);
      if (selectionNotice) throw new RpcRequestError("model_unavailable", selectionNotice);
      throw new RpcRequestError(
        "model_unavailable",
        `${profile.modelName} (${profile.modelID}) is not catalogued by the installed LightningLoop runtime. Choose a model shown by the runtime catalog.`,
      );
    }
    if (expected.expectedSupportsImages !== selected.supportsImages
        || expected.expectedContextWindow !== selected.contextWindow
        || expected.expectedMaxOutputTokens !== selected.maxOutputTokens) {
      throw new RpcRequestError(
        "model_catalog_drift",
        "The selected model capabilities or token limits changed. Refresh the exact runtime catalog snapshot and try again.",
      );
    }
    return {
      ...profile,
      modelName: selected.modelName,
      supportsImages: selected.supportsImages,
      contextWindow: selected.contextWindow,
      maxOutputTokens: selected.maxOutputTokens,
    };
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

  private reserveRun(runID: string): void {
    if (this.runReservations.has(runID) || this.runs.get(runID)?.active) {
      throw new RpcRequestError("run_conflict", "The run ID is already active.");
    }
    this.runReservations.add(runID);
  }

  private releaseRun(runID: string): void {
    this.runReservations.delete(runID);
  }

  async handleRawLine(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > MAX_LINE_BYTES) {
      this.send("error", { runID: "protocol", requestID: "unknown" }, {
        code: "message_too_large",
        message: "JSONL request exceeds 1 MiB.",
        retryable: false,
      });
      return;
    }
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      this.send("error", { runID: "protocol", requestID: "unknown" }, {
        code: "invalid_utf8",
        message: "JSONL requests must be strict UTF-8.",
        retryable: false,
      });
      return;
    }
    await this.handleLine(line);
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
            capabilities: ["promise_duty_graph", "deterministic_gold", "cancel", "credential_status", "runtime_model_catalog", "stateless_continue", "images", "iterative_bounded_research", "reviewed_workspace_artifacts", "evidence_lab", "loopback_html_proof", "rendered_previews", "sandboxed_script_runner", "managed_overlay_backups"],
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
              // Runtime credentials are intentionally opaque to LightningLoop.
              // A built-in provider's actual login state is never inferred by
              // the catalog path.
              inference: piManaged
                ? "runtime-managed/unknown"
                : (process.platform === "darwin" && keychainConfigured(providerCredentialService(activeProfile))),
              piManaged,
              ...Object.fromEntries((Object.keys(KEYCHAIN_SERVICES) as (keyof typeof KEYCHAIN_SERVICES)[]).map((name) => [name, searchConfigured(name)])),
            },
            valuesExposed: false,
          });
          return;
        case "providerModels": {
          const selectedProfile = loadProviderProfile();
          const catalog = await this.runtimeModelCatalog(selectedProfile);
          const selectedModelCatalogued = catalog.models.some((model) => model.modelID === selectedProfile.modelID);
          const catalogScope = selectedProfile.piProviderID
            ? "Pinned, credential-free LightningLoop runtime catalog. Provider account state and preview entitlement are not queried."
            : "Custom models are discovered only by the user-triggered native connection test.";
          this.send("response", request, {
            requestType: "providerModels",
            providerID: selectedProfile.id,
            models: catalog.models,
            selectedModelID: selectedProfile.modelID,
            selectedModelCatalogued,
            catalogScope,
            ...(runtimeModelSelectionNotice(selectedProfile) ? { selectionNotice: runtimeModelSelectionNotice(selectedProfile) } : {}),
          });
          return;
        }
        case "cancelRun": {
          const state = this.runs.get(request.runID);
          if (!state?.active) throw new RpcRequestError("run_not_active", "The run is not active.");
          state.controller.abort(new DOMException("Run cancelled by client.", "AbortError"));
          this.send("response", request, { requestType: "cancelRun", cancelled: true });
          return;
        }
        case "createRun": {
          this.reserveRun(request.runID);
          let state: RunState | undefined;
          try {
            const savedProfile = loadProviderProfile();
            const runProfile = await this.selectedRuntimeProfile(request.payload, savedProfile);
            assertCredentialSafeInput(request.payload, runProfile);
            const goal = boundedString(request.payload.goal, "payload.goal", MAX_GOAL_CHARACTERS);
            const images = await validateImagePaths(imagePathList(request.payload.imagePaths));
            state = this.makeRun(goal, undefined, images);
            state.active = true;
            this.runs.set(request.runID, state);
            const memories = loadEligibleMemoryContext(request.runID);
            assertNoConfiguredCredential(memories, runProfile);
            const clarification = await new LoopEngine(await this.agentFactory(runProfile), {
              images,
              memories,
            }).clarify(goal, state.controller.signal);
            assertCredentialSafeInput(clarification, runProfile);
            state.clarification = clarification;
            this.send("response", request, { requestType: "createRun", stage: "awaiting_answers", clarification });
          } finally {
            if (state) state.active = false;
            this.releaseRun(request.runID);
          }
          return;
        }
        case "continueRun": {
          this.reserveRun(request.runID);
          let state: RunState | undefined;
          try {
            const savedProfile = loadProviderProfile();
            const runProfile = await this.selectedRuntimeProfile(request.payload, savedProfile);
            assertCredentialSafeInput(request.payload, runProfile);
            state = this.runs.get(request.runID);
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
            const answers = answerMap(request.payload.answers);
            const cycles = request.payload.maxReviewCycles === undefined ? 4 : request.payload.maxReviewCycles;
            if (typeof cycles !== "number" || !Number.isInteger(cycles) || cycles < 1 || cycles > 8) {
              throw new RpcRequestError("invalid_cycles", "maxReviewCycles must be an integer from 1 through 8.");
            }
            state.controller = new AbortController();
            state.active = true;
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
            assertNoConfiguredCredential(memories, runProfile);
            const stageSequence = new StageEventSequence();
            const result = await new LoopEngine(await this.agentFactory(runProfile), {
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
              (event) => {
                stageSequence.accept(event);
                this.event(request as RequestEnvelope, event);
              },
              state.controller.signal,
            );
            const terminalEvent = stageSequence.finish(result.completed, result.message);
            if (terminalEvent) this.event(request, terminalEvent);
            assertCredentialSafeInput(result, runProfile);
            this.send(result.completed ? "runCompleted" : "runPaused", request, result);
            this.send("response", request, { requestType: "continueRun", result });
          } finally {
            if (state) state.active = false;
            this.releaseRun(request.runID);
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
  const pending = new Set<Promise<void>>();
  let line = Buffer.alloc(0);
  let overflowed = false;

  const submit = (bytes: Uint8Array) => {
    const request = server.handleRawLine(bytes);
    pending.add(request);
    void request.finally(() => pending.delete(request));
  };

  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const fragment = chunk.subarray(start, index);
      if (!overflowed) {
        if (line.length + fragment.length > MAX_LINE_BYTES) overflowed = true;
        else line = Buffer.concat([line, fragment], line.length + fragment.length);
      }
      if (overflowed) submit(new Uint8Array(MAX_LINE_BYTES + 1));
      else submit(line.at(-1) === 0x0d ? line.subarray(0, -1) : line);
      line = Buffer.alloc(0);
      overflowed = false;
      start = index + 1;
    }
    const remainder = chunk.subarray(start);
    if (!overflowed) {
      if (line.length + remainder.length > MAX_LINE_BYTES) {
        overflowed = true;
        line = Buffer.alloc(0);
      } else if (remainder.length > 0) {
        line = Buffer.concat([line, remainder], line.length + remainder.length);
      }
    }
  }
  if (overflowed) submit(new Uint8Array(MAX_LINE_BYTES + 1));
  else if (line.length > 0) submit(line);
  await Promise.allSettled([...pending]);
}
