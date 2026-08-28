/**
 * Installed LightningLoop runtime model catalog for Pi-managed presets.
 * Credential-free and network-disabled. Catalogued is exact installed-catalog
 * presence, not account entitlement or sign-in state.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderProfile } from "./provider-profile.js";

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

type RuntimeCredentialStore = NonNullable<NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"]>;

const inertRuntimeCredentialStore: RuntimeCredentialStore = {
  async read(_providerID) { return undefined; },
  async list() { return []; },
  async modify(_providerID, _modify) { return undefined; },
  async delete(_providerID) {},
};

function safeRuntimeString(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum && !/[\r\n\0]/u.test(trimmed) ? trimmed : fallback;
}

function safeRuntimeLimit(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return value >= minimum && value <= maximum ? value : fallback;
}

export async function loadInstalledRuntimeCatalog(profile: ProviderProfile): Promise<RuntimeModelCatalog> {
  if (!profile.piProviderID) {
    return { providerID: profile.id, models: [] };
  }
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

export function resolveRuntimeModel(catalog: RuntimeModelCatalog, modelID: string, displayName: string): RuntimeModelOption {
  const selected = catalog.models.find((model) => model.modelID === modelID);
  if (!selected) {
    throw new Error(
      `Model '${modelID}' is not catalogued by the installed LightningLoop runtime for ${displayName}. Run 'lightningloop provider models' and pick a listed ID.`,
    );
  }
  return selected;
}
