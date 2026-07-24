import { isIP } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { objectValue, stringValue } from "./structured-json.js";
import { lightningLoopDataPath } from "./platform-paths.js";

export const PROVIDER_CONFIG_VERSION = 1 as const;

/**
 * Cerebras lists this public-preview model in its catalog. It remains a
 * preferred starting point only; a LightningLoop run must still find the ID
 * in the installed runtime catalog before it can launch.
 */
export const CEREBRAS_GEMMA_4_31B_ID = "gemma-4-31b";
export const CEREBRAS_GEMMA_4_31B_NAME = "Gemma 4 31B";

export type ProviderPreset = "cerebras" | "groq" | "fireworks" | "xai" | "openai-codex" | "anthropic" | "custom" | "selection-required";

export interface ProviderProfile {
  schemaVersion: typeof PROVIDER_CONFIG_VERSION;
  id: string;
  preset: ProviderPreset;
  displayName: string;
  baseURL: string;
  modelID: string;
  modelName: string;
  supportsImages: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  /** Built-in Pi provider. Undefined only for a custom OpenAI-compatible endpoint. */
  piProviderID?: string;
}

const presets: Record<Exclude<ProviderPreset, "custom" | "selection-required">, Omit<ProviderProfile, "modelID" | "modelName" | "supportsImages" | "contextWindow" | "maxOutputTokens">> = {
  cerebras: {
    schemaVersion: PROVIDER_CONFIG_VERSION,
    id: "cerebras",
    preset: "cerebras",
    displayName: "Cerebras Inference",
    baseURL: "https://api.cerebras.ai/v1",
  },
  groq: {
    schemaVersion: PROVIDER_CONFIG_VERSION,
    id: "groq",
    preset: "groq",
    displayName: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
  },
  fireworks: {
    schemaVersion: PROVIDER_CONFIG_VERSION,
    id: "fireworks",
    preset: "fireworks",
    displayName: "Fireworks",
    baseURL: "https://api.fireworks.ai/inference/v1",
  },
  xai: {
    schemaVersion: PROVIDER_CONFIG_VERSION,
    id: "xai",
    preset: "xai",
    displayName: "xAI / Grok",
    baseURL: "https://api.x.ai/v1",
  },
  "openai-codex": {
    schemaVersion: PROVIDER_CONFIG_VERSION,
    id: "openai-codex",
    preset: "openai-codex",
    displayName: "OpenAI Codex",
    baseURL: "https://api.openai.com/v1",
  },
  anthropic: {
    schemaVersion: PROVIDER_CONFIG_VERSION,
    id: "anthropic",
    preset: "anthropic",
    displayName: "Anthropic Claude",
    baseURL: "https://api.anthropic.com/v1",
  },
};

export const selectableProviderPresets = ["cerebras", "groq", "fireworks", "xai", "openai-codex", "anthropic"] as const;
export type SelectableProviderPreset = typeof selectableProviderPresets[number];

export const defaultProviderProfile = (): ProviderProfile => profileForPreset("openai-codex");

/** Explicit first-run state. It is never valid persisted provider configuration. */
export const providerSelectionRequiredProfile = (): ProviderProfile => ({
  schemaVersion: PROVIDER_CONFIG_VERSION,
  id: "selection-required",
  preset: "selection-required",
  displayName: "Choose a provider",
  baseURL: "",
  modelID: "",
  modelName: "",
  supportsImages: false,
  contextWindow: 1_024,
  maxOutputTokens: 256,
});

export function isProviderSelectionRequired(profile: ProviderProfile): boolean {
  return profile.preset === "selection-required";
}

export const providerConfigPath = (): string => {
  const override = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  if (override) {
    if (!isAbsolute(override)) throw new Error("LIGHTNINGLOOP_PROVIDER_CONFIG_PATH must be absolute.");
    return override;
  }
  return lightningLoopDataPath("provider.json");
};

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function safeIdentifier(value: unknown): string {
  const id = stringValue(value, "provider.id");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("provider.id must contain only lowercase letters, numbers, and hyphens.");
  }
  return id;
}

export function validatedBaseURL(value: unknown, preset: ProviderPreset): string {
  const raw = stringValue(value, "provider.baseURL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Provider base URL is invalid.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider base URL must be credential-free HTTPS with no query or fragment.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host) !== 0) {
    throw new Error("Provider base URL must use a public DNS hostname, not localhost, a local name, or an IP literal.");
  }
  if (preset === "selection-required") throw new Error("Provider selection is required.");
  const known = preset === "custom" ? undefined : presets[preset];
  if (known && url.href.replace(/\/$/, "") !== known.baseURL) {
    throw new Error(`${known.displayName} must use its verified API base URL.`);
  }
  return url.href.replace(/\/$/, "");
}

export function parseProviderProfile(value: unknown): ProviderProfile {
  const root = objectValue(value, "provider profile");
  if (root.schemaVersion !== PROVIDER_CONFIG_VERSION) throw new Error("Provider profile version is unsupported.");
  const presetValue = stringValue(root.preset, "provider.preset");
  if (!["cerebras", "groq", "fireworks", "xai", "openai-codex", "anthropic", "custom"].includes(presetValue)) {
    throw new Error("Provider preset is unsupported.");
  }
  const preset = presetValue as Exclude<ProviderPreset, "selection-required">;
  const id = safeIdentifier(root.id);
  if (preset !== "custom" && id !== preset) throw new Error("Preset provider ID does not match its preset.");
  const displayName = stringValue(root.displayName, "provider.displayName").trim();
  const modelID = stringValue(root.modelID, "provider.modelID").trim();
  const modelName = stringValue(root.modelName, "provider.modelName").trim();
  if (!displayName || displayName.length > 80) throw new Error("Provider display name must contain 1-80 characters.");
  if (!modelID || modelID.length > 200 || /[\r\n\0]/.test(modelID)) throw new Error("Model ID must contain 1-200 safe characters.");
  if (!modelName || modelName.length > 120) throw new Error("Model name must contain 1-120 characters.");
  if (typeof root.supportsImages !== "boolean") throw new Error("supportsImages must be true or false.");
  return {
    schemaVersion: PROVIDER_CONFIG_VERSION,
    id,
    preset,
    displayName,
    baseURL: validatedBaseURL(root.baseURL, preset),
    modelID,
    modelName,
    supportsImages: root.supportsImages,
    contextWindow: boundedInteger(root.contextWindow, "contextWindow", 1_024, 2_000_000),
    maxOutputTokens: boundedInteger(root.maxOutputTokens, "maxOutputTokens", 256, 131_072),
    ...(preset === "custom" ? {} : { piProviderID: preset }),
  };
}

export function profileForPreset(preset: Exclude<ProviderPreset, "custom" | "selection-required">): ProviderProfile {
  const base = presets[preset];
  const defaults: Record<Exclude<ProviderPreset, "custom" | "selection-required">, Pick<ProviderProfile, "modelID" | "modelName" | "supportsImages" | "contextWindow" | "maxOutputTokens">> = {
    cerebras: { modelID: CEREBRAS_GEMMA_4_31B_ID, modelName: CEREBRAS_GEMMA_4_31B_NAME, supportsImages: true, contextWindow: 131_072, maxOutputTokens: 40_960 },
    groq: { modelID: "openai/gpt-oss-120b", modelName: "GPT-OSS 120B", supportsImages: false, contextWindow: 131_072, maxOutputTokens: 32_768 },
    fireworks: { modelID: "accounts/fireworks/models/kimi-k2p6", modelName: "Kimi K2.6", supportsImages: true, contextWindow: 262_000, maxOutputTokens: 32_768 },
    xai: { modelID: "grok-4.5", modelName: "Grok 4.5", supportsImages: true, contextWindow: 256_000, maxOutputTokens: 32_768 },
    "openai-codex": { modelID: "gpt-5.6-terra", modelName: "GPT-5.6 Terra", supportsImages: true, contextWindow: 400_000, maxOutputTokens: 131_072 },
    anthropic: { modelID: "claude-sonnet-4-6", modelName: "Claude Sonnet 4.6", supportsImages: true, contextWindow: 200_000, maxOutputTokens: 64_000 },
  };
  return { ...base, ...defaults[preset], piProviderID: preset };
}

export function runtimeModelSelectionNotice(profile: ProviderProfile): string | undefined {
  if (profile.preset === "cerebras" && profile.modelID === CEREBRAS_GEMMA_4_31B_ID) {
    return "Gemma 4 31B is a public-preview preference. It is not treated as catalogued until the installed LightningLoop runtime catalog lists it.";
  }
  return undefined;
}

export function loadProviderProfile(path = providerConfigPath()): ProviderProfile {
  try {
    return parseProviderProfile(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return providerSelectionRequiredProfile();
    throw error;
  }
}

export function saveProviderPreset(preset: SelectableProviderPreset, path = providerConfigPath()): ProviderProfile {
  if (!selectableProviderPresets.includes(preset)) throw new Error("Provider preset is not selectable.");
  const profile = profileForPreset(preset);
  const encoded = `${JSON.stringify(profile, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > 16_384 || /(?:api.?key|authorization|bearer\s|(?:csk|sk)-[a-z0-9])/iu.test(encoded)) {
    throw new Error("Provider configuration must remain bounded and credential-free.");
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("Provider configuration directory is unsafe.");
  }
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 32_768) {
      throw new Error("Existing provider configuration is unsafe.");
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  const temporary = join(parent, `.provider.${process.pid}.${Date.now()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, encoded, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  return profile;
}

export function providerCredentialService(profile: ProviderProfile): string {
  if (profile.preset !== "custom") return `com.barnlabs.LightningLoop.provider.${profile.id}.apiKey`;
  const host = new URL(profile.baseURL).hostname.toLowerCase();
  return `com.barnlabs.LightningLoop.provider.custom.${profile.id}.${host}.apiKey`;
}

/**
 * Every fixed Keychain service LightningLoop has owned for provider or research
 * credentials. This deliberately excludes Pi-managed services: LightningLoop
 * must never probe Pi's credentials or ~/.pi state.
 *
 * The direct built-in services remain in the catalog so records cannot retain a
 * credential after the user switches providers. The unsuffixed custom service
 * is the macOS compatibility service used by earlier LightningLoop builds.
 */
export const historicalReadOnlyProviderCredentialServices = [
  "com.barnlabs.LightningLoop.provider.xai.apiKey",
  "com.barnlabs.LightningLoop.provider.openai-codex.apiKey",
  "com.barnlabs.LightningLoop.provider.anthropic.apiKey",
] as const;

export const fixedLightningLoopCredentialServices = [
  "com.barnlabs.LightningLoop.provider.cerebras.apiKey",
  "com.barnlabs.LightningLoop.provider.groq.apiKey",
  "com.barnlabs.LightningLoop.provider.fireworks.apiKey",
  ...historicalReadOnlyProviderCredentialServices,
  "com.barnlabs.LightningLoop.provider.custom.apiKey",
  "com.barnlabs.LightningLoop.search.exa",
  "com.barnlabs.LightningLoop.search.brave",
  "com.barnlabs.LightningLoop.search.firecrawl",
] as const;

export const customCredentialServiceRegistryPath = (): string => lightningLoopDataPath("custom-credential-services.json");

function isValidCustomCredentialService(service: string): boolean {
  return /^com\.barnlabs\.LightningLoop\.provider\.custom\.[a-z0-9-]{1,64}\.[a-z0-9.-]{3,253}\.apiKey$/u.test(service);
}

/**
 * Reads the native GUI's bounded registry of LightningLoop-owned custom service
 * identifiers. A missing registry is an empty history; every malformed or
 * unreadable existing registry fails closed so historical credentials cannot
 * silently disappear from memory/evolution filtering.
 */
export function loadHistoricalCustomCredentialServices(path = customCredentialServiceRegistryPath()): readonly string[] {
  let pathMetadata;
  try {
    pathMetadata = lstatSync(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw new Error("Custom credential service registry is unreadable; credential safety failed closed.");
  }
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.size > 32_768) {
    throw new Error("Custom credential service registry is unsafe; credential safety failed closed.");
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw new Error("Custom credential service registry is unreadable; credential safety failed closed.");
  }
  let parsed: unknown;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 32_768
        || (pathMetadata.ino !== 0 && metadata.ino !== pathMetadata.ino)
        || (pathMetadata.dev !== 0 && metadata.dev !== pathMetadata.dev)) {
      throw new Error("Custom credential service registry is unsafe; credential safety failed closed.");
    }
    parsed = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
  } catch {
    throw new Error("Custom credential service registry is unreadable or malformed; credential safety failed closed.");
  } finally {
    closeSync(descriptor);
  }
  if (!Array.isArray(parsed)
      || parsed.length > 128
      || parsed.some((item) => typeof item !== "string" || !isValidCustomCredentialService(item))
      || new Set(parsed).size !== parsed.length) {
    throw new Error("Custom credential service registry is malformed; credential safety failed closed.");
  }
  return parsed;
}

/**
 * Fixed LightningLoop-owned services plus the active per-host custom service.
 * No Pi-managed service is ever returned or read here.
 */
export function lightningLoopCredentialServices(profile: ProviderProfile, registryPath = customCredentialServiceRegistryPath()): readonly string[] {
  const activeCustomService = profile.preset === "custom" ? [providerCredentialService(profile)] : [];
  return [...new Set([...fixedLightningLoopCredentialServices, ...loadHistoricalCustomCredentialServices(registryPath), ...activeCustomService])];
}

export function providerHeaders(_profile: ProviderProfile): Record<string, string> {
  // Cerebras API v2 became the default on 2026-07-21, so the transition-only
  // X-Cerebras-Version-Patch header is intentionally no longer sent.
  return {};
}
