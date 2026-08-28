/**
 * LightningLoop-managed key names for `llp key set|status|clear`.
 *
 * Pi-managed presets (xAI, Codex, Anthropic, Groq, Fireworks) stay on
 * `lightningloop auth` + runtime `/login`. This catalog is only the keys
 * LightningLoop itself stores in the OS secret store.
 */
import { isProviderSelectionRequired, providerCredentialService, type ProviderProfile } from "./provider-profile.js";

export const managedKeyNames = [
  "openrouter",
  "generalcompute",
  "custom",
  "cerebras",
  "firecrawl",
  "exa",
  "brave",
] as const;

export type ManagedKeyName = typeof managedKeyNames[number];

export type ManagedKeyKind = "inference" | "research";

export interface ManagedKeySlot {
  name: ManagedKeyName;
  kind: ManagedKeyKind;
  /** Fixed service, or empty when the active custom profile supplies it. */
  service: string;
  envNames: readonly string[];
  label: string;
}

const slots: Record<ManagedKeyName, ManagedKeySlot> = {
  openrouter: {
    name: "openrouter",
    kind: "inference",
    service: "com.barnlabs.LightningLoop.provider.openrouter.apiKey",
    envNames: ["OPENROUTER_API_KEY", "OPENROUTER_KEY"],
    label: "OpenRouter",
  },
  generalcompute: {
    name: "generalcompute",
    kind: "inference",
    service: "com.barnlabs.LightningLoop.provider.generalcompute.apiKey",
    envNames: ["GENERALCOMPUTE_API_KEY"],
    label: "GeneralCompute",
  },
  custom: {
    name: "custom",
    kind: "inference",
    service: "",
    envNames: [],
    label: "Custom OpenAI-compatible",
  },
  cerebras: {
    name: "cerebras",
    kind: "inference",
    service: "com.barnlabs.LightningLoop.provider.cerebras.apiKey",
    envNames: ["CEREBRAS_API_KEY", "CEREBRAS_KEY"],
    label: "Cerebras (manual key)",
  },
  firecrawl: {
    name: "firecrawl",
    kind: "research",
    service: "com.barnlabs.LightningLoop.search.firecrawl",
    envNames: ["FIRECRAWL_API_KEY"],
    label: "Firecrawl",
  },
  exa: {
    name: "exa",
    kind: "research",
    service: "com.barnlabs.LightningLoop.search.exa",
    envNames: ["EXA_API_KEY"],
    label: "Exa",
  },
  brave: {
    name: "brave",
    kind: "research",
    service: "com.barnlabs.LightningLoop.search.brave",
    envNames: ["BRAVE_SEARCH_API_KEY"],
    label: "Brave Search",
  },
};

export function isManagedKeyName(value: string): value is ManagedKeyName {
  return (managedKeyNames as readonly string[]).includes(value);
}

export function parseManagedKeyName(value: string | undefined): ManagedKeyName {
  if (!value || !isManagedKeyName(value)) {
    throw new Error(`Key command requires a name: ${managedKeyNames.join(", ")}.`);
  }
  return value;
}

export function managedKeySlot(name: ManagedKeyName): ManagedKeySlot {
  return slots[name];
}

export function managedKeyService(name: ManagedKeyName, profile?: ProviderProfile): string {
  if (name === "custom") {
    if (!profile || isProviderSelectionRequired(profile) || profile.preset !== "custom") {
      throw new Error("key set custom requires a saved Custom provider profile. Save the HTTPS host in Settings first.");
    }
    return providerCredentialService(profile);
  }
  return slots[name].service;
}

export function envCredential(name: ManagedKeyName, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const envName of slots[name].envNames) {
    const value = environment[envName]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function missingKeyNextAction(name: ManagedKeyName): string {
  const slot = slots[name];
  const envHint = slot.envNames[0] ? ` or set ${slot.envNames[0]}` : "";
  return `${slot.label} is not configured. Pipe the key on stdin: printf %s "$KEY" | lightningloop key set ${name}${envHint}. The value is never written to provider.json or logs.`;
}
