import { spawnSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentAdapter, AgentReply, AgentRequest } from "../core/loop-types.js";
import { encodeAgentImages } from "../core/image-input.js";
import {
  defaultProviderProfile,
  loadProviderProfile,
  isProviderSelectionRequired,
  providerCredentialService,
  providerHeaders,
  type ProviderProfile,
} from "../core/provider-profile.js";
import { SecretRedactor } from "../core/redaction.js";
import { applyActiveSystemPromptAddenda } from "../core/evolution-store.js";
import { assertCredentialSafeInput, registerRuntimeCredential } from "../core/credential-safety.js";

type PiRuntime = Pick<ModelRuntime, "completeSimple" | "getModel" | "registerProvider">;
type ProfileCredentialReader = (profile: ProviderProfile) => string | undefined;

function readMacCredential(profile: ProviderProfile): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", providerCredentialService(profile), "-w"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16_384,
  });
  const credential = result.status === 0 ? result.stdout.trim() : "";
  return credential || undefined;
}

/** LightningLoop-managed API-key credentials (never Pi /login). Env is checked for GeneralCompute. */
export function readLightningLoopManagedCredential(profile: ProviderProfile): string | undefined {
  if (profile.preset === "generalcompute") {
    const fromEnv = process.env.GENERALCOMPUTE_API_KEY?.trim();
    if (fromEnv) return fromEnv;
  }
  return readMacCredential(profile);
}

function missingManagedCredentialMessage(profile: ProviderProfile): string {
  if (profile.preset === "generalcompute") {
    return "GeneralCompute requires GENERALCOMPUTE_API_KEY or a LightningLoop Keychain credential (Settings on macOS). It is not managed by runtime /login.";
  }
  return "LightningLoop-managed API-key providers require a credential from the macOS Settings Keychain (Custom OpenAI-compatible). GeneralCompute also accepts GENERALCOMPUTE_API_KEY.";
}

function assertRuntimeModelSnapshot(
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
  profile: ProviderProfile,
): void {
  const supportsImages = Array.isArray(model.input) && model.input.includes("image");
  if (supportsImages !== profile.supportsImages
      || model.contextWindow !== profile.contextWindow
      || model.maxTokens !== profile.maxOutputTokens) {
    throw new Error(
      `The runtime catalog metadata for ${profile.modelID} changed after selection. Refresh the exact model snapshot before starting LightningLoop.`,
    );
  }
}

export class PiProviderAdapter implements AgentAdapter {
  readonly supportsImages: boolean;
  private constructor(
    private readonly runtime: PiRuntime,
    private readonly model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
    private readonly profile: ProviderProfile,
    private readonly redactor: SecretRedactor,
  ) { this.supportsImages = profile.supportsImages; }

  static async create(
    profile = loadProviderProfile(),
    createRuntime: () => Promise<PiRuntime> = () => ModelRuntime.create({ modelsPath: null, allowModelNetwork: false }),
    credentialReader: ProfileCredentialReader = readLightningLoopManagedCredential,
  ): Promise<PiProviderAdapter> {
    if (isProviderSelectionRequired(profile)) {
      throw new Error("Choose and save an inference provider before starting LightningLoop.");
    }
    const runtime = await createRuntime();
    const providerID = profile.piProviderID;
    let credential: string | undefined;
    if (!providerID) {
      credential = credentialReader(profile);
      if (!credential) throw new Error(missingManagedCredentialMessage(profile));
      registerRuntimeCredential(credential);
    }
    const resolvedProviderID = providerID ?? `lightningloop-${profile.id}`;
    if (credential) {
      runtime.registerProvider(resolvedProviderID, {
        name: `LightningLoop / ${profile.displayName}`,
        baseUrl: profile.baseURL,
        apiKey: credential,
        api: "openai-completions",
        authHeader: true,
        headers: providerHeaders(profile),
        models: [{
          id: profile.modelID,
          name: profile.modelName,
          reasoning: true,
          input: profile.supportsImages ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: profile.contextWindow,
          maxTokens: profile.maxOutputTokens,
        }],
      });
    }
    const model = runtime.getModel(resolvedProviderID, profile.modelID);
    if (!model) throw new Error(profile.piProviderID
      ? `The LightningLoop runtime does not currently catalog ${profile.modelID} for ${profile.displayName}. Choose a model shown by the runtime model picker, then complete provider sign-in with /login if requested.`
      : `The LightningLoop runtime does not currently catalog ${profile.modelID} for ${profile.displayName}. Choose a model shown by the runtime model picker.`);
    assertRuntimeModelSnapshot(model, profile);
    return new PiProviderAdapter(runtime, model, profile, new SecretRedactor(credential ? [credential] : []));
  }

  static defaultProfile(): ProviderProfile { return defaultProviderProfile(); }

  async complete(request: AgentRequest, signal?: AbortSignal): Promise<AgentReply> {
    assertCredentialSafeInput({ system: request.system, user: request.user }, this.profile);
    const images = request.images ?? [];
    if (images.length > 0 && !this.profile.supportsImages) {
      throw new Error(`${this.profile.modelName} is configured as text-only. Choose an image-capable model or remove the attachments.`);
    }
    const encoded = await encodeAgentImages(images);
    const content = images.length === 0
      ? request.user
      : [
          { type: "text" as const, text: request.user },
          ...encoded.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
        ];
    const evolvedSystem = applyActiveSystemPromptAddenda(request.system);
    assertCredentialSafeInput(evolvedSystem, this.profile);
    const response = await this.runtime.completeSimple(
      this.model,
      { systemPrompt: evolvedSystem, messages: [{ role: "user", content, timestamp: Date.now() }] },
      {
        temperature: request.temperature,
        maxTokens: Math.min(request.maxTokens, this.profile.maxOutputTokens),
        ...(signal ? { signal } : {}),
        timeoutMs: 180_000,
        maxRetries: 1,
      },
    );
    if (response.stopReason === "aborted" || signal?.aborted) {
      const reason = signal?.reason;
      throw reason instanceof Error ? reason : new DOMException("Provider request was cancelled.", "AbortError");
    }
    if (response.stopReason === "error") {
      throw new Error(this.redactor.redact(response.errorMessage || `${this.profile.displayName} request stopped: ${response.stopReason}`));
    }
    const text = response.content
      .filter((item): item is Extract<(typeof response.content)[number], { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("")
      .trim();
    if (!text) throw new Error(`${this.profile.modelName} returned no text content.`);
    const safeText = this.redactor.redact(text);
    assertCredentialSafeInput(safeText, this.profile);
    return {
      content: safeText,
      usage: {
        input: response.usage.input,
        output: response.usage.output,
        total: response.usage.totalTokens,
        cost: response.usage.cost.total,
      },
    };
  }
}
