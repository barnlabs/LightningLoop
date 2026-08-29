/**
 * One catalog load + pick path for CLI and TUI.
 * Unknown IDs fail closed as model_unavailable. Never invent a model.
 */
import { fetchHostModels } from "./host-catalog.js";
import { missingKeyNextAction } from "./key-catalog.js";
import { fetchOpenRouterModels, selectFreeModels } from "./openrouter.js";
import {
  applyCataloguedModel,
  isPiManagedPreset,
  isProviderSelectionRequired,
  loadProviderProfile,
  saveProviderProfile,
  selectableProviderPresets,
  type ProviderProfile,
  type SelectableProviderPreset,
} from "./provider-profile.js";
import { loadInstalledRuntimeCatalog } from "./runtime-catalog.js";

export const MODEL_UNAVAILABLE = "model_unavailable";

export interface CataloguedModel {
  id: string;
  name: string;
  supportsImages?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  free?: boolean;
}

export interface DiscoveredCatalog {
  source: "runtime" | "openrouter" | "host";
  label: string;
  providerDisplayName: string;
  preset: string;
  models: CataloguedModel[];
}

export interface ProviderPickTokens {
  preset?: SelectableProviderPreset;
  pick?: string;
}

export function modelUnavailable(detail: string): Error {
  return new Error(`${MODEL_UNAVAILABLE}: ${detail}`);
}

export function splitProviderPickTokens(tokens: readonly string[]): ProviderPickTokens {
  const first = tokens[0];
  const second = tokens[1];
  if (!first) return {};
  if (selectableProviderPresets.includes(first as SelectableProviderPreset)) {
    return second
      ? { preset: first as SelectableProviderPreset, pick: second }
      : { preset: first as SelectableProviderPreset };
  }
  return { pick: first };
}

export function formatCatalogList(catalog: DiscoveredCatalog): string {
  const header = `${catalog.providerDisplayName} models · ${catalog.label} · ${catalog.models.length}`;
  const lines = catalog.models.map((model, index) => {
    const n = String(index + 1).padStart(2, " ");
    const ctx = model.contextWindow ? ` · ctx ${model.contextWindow}` : "";
    const extra = model.free === true ? " · free" : model.supportsImages === true ? " · image+text" : "";
    return `  ${n}. ${model.id} · ${model.name}${ctx}${extra}`;
  });
  return [header, ...lines].join("\n");
}

export function catalogPickHint(catalog: DiscoveredCatalog): string {
  if (catalog.preset === "custom") {
    return "Pick one with: llp provider pick <n|id>   (custom hosts stay on the saved profile)";
  }
  if (catalog.source === "openrouter") {
    return "Pick one with: llp provider pick <n|id>";
  }
  return `Pick one with: llp provider pick <n|id>`;
}

export function resolveCatalogPick(catalog: DiscoveredCatalog, token: string): CataloguedModel {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 200 || /[\r\n\0]/u.test(trimmed)) {
    throw modelUnavailable("Pick requires a catalog index or a catalogued model ID.");
  }
  if (/^\d+$/u.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    const selected = catalog.models[index - 1];
    if (!selected) {
      throw modelUnavailable(`No catalog entry ${index}. Load models, then pick a listed number or ID.`);
    }
    return selected;
  }
  const selected = catalog.models.find((model) => model.id === trimmed);
  if (!selected) {
    throw modelUnavailable(`Model '${trimmed}' is not in the current ${catalog.providerDisplayName} catalog. Load models and pick a listed ID.`);
  }
  return selected;
}

export async function applyProviderPick(
  profile: ProviderProfile,
  token: string,
  options: DiscoverCatalogOptions = {},
): Promise<{ catalog: DiscoveredCatalog; model: CataloguedModel; saved: ProviderProfile }> {
  const catalog = await discoverActiveCatalog(profile, options);
  const model = resolveCatalogPick(catalog, token);
  const saved = persistCataloguedPick(
    loadProviderProfile(),
    model,
    Boolean(options.freeOnly || profile.freeOnly),
  );
  return { catalog, model, saved };
}

export function persistCataloguedPick(
  profile: ProviderProfile,
  model: CataloguedModel,
  freeOnly = false,
): ProviderProfile {
  return saveProviderProfile(applyCataloguedModel(profile, {
    modelID: model.id,
    modelName: model.name,
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(freeOnly ? { freeOnly: true } : {}),
  }));
}

export interface DiscoverCatalogOptions {
  freeOnly?: boolean;
  credential?: string | undefined;
}

export async function discoverActiveCatalog(
  profile: ProviderProfile,
  options: DiscoverCatalogOptions = {},
): Promise<DiscoveredCatalog> {
  if (options.freeOnly && (isProviderSelectionRequired(profile) || profile.preset === "openrouter" || !profile.preset)) {
    return loadOpenRouterCatalog(true);
  }
  if (isProviderSelectionRequired(profile)) {
    throw new Error("Provider selection is required. Run 'lightningloop provider select PRESET' first.");
  }
  if (profile.preset === "openrouter") {
    return loadOpenRouterCatalog(Boolean(options.freeOnly || profile.freeOnly));
  }
  if (profile.piProviderID && isPiManagedPreset(profile.preset)) {
    const catalog = await loadInstalledRuntimeCatalog(profile);
    return {
      source: "runtime",
      label: "installed runtime catalog",
      providerDisplayName: profile.displayName,
      preset: profile.preset,
      models: catalog.models.map((model) => ({
        id: model.modelID,
        name: model.modelName,
        supportsImages: model.supportsImages,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
      })),
    };
  }
  const credential = options.credential?.trim() ?? "";
  if (!credential) {
    throw new Error(missingKeyNextAction(profile.preset === "generalcompute" ? "generalcompute" : "custom"));
  }
  const models = await fetchHostModels(profile, credential);
  return {
    source: "host",
    label: "live host catalog",
    providerDisplayName: profile.displayName,
    preset: profile.preset,
    models: models.map((model) => ({ id: model.id, name: model.name })),
  };
}

async function loadOpenRouterCatalog(freeOnly: boolean): Promise<DiscoveredCatalog> {
  const models = await fetchOpenRouterModels();
  const shown = freeOnly ? selectFreeModels(models) : models.slice().sort((left, right) => left.id.localeCompare(right.id));
  return {
    source: "openrouter",
    label: freeOnly ? "public OpenRouter catalog · free" : "public OpenRouter catalog",
    providerDisplayName: "OpenRouter",
    preset: "openrouter",
    models: shown.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      free: model.free,
    })),
  };
}
