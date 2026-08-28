import { envCredentialForService } from "./key-catalog.js";
import { readSecret } from "./key-store.js";
import { lightningLoopCredentialServices, loadProviderProfile, type ProviderProfile } from "./provider-profile.js";
import { SecretRedactor } from "./redaction.js";

type CredentialReader = (service: string) => string | undefined;
const runtimeCredentials = new Set<string>();
const MAX_PERCENT_DECODE_ROUNDS = 16;

/** Registers a process-local credential for filtering without returning it. */
export function registerRuntimeCredential(value: string): void {
  const credential = value.trim();
  if (credential) runtimeCredentials.add(credential);
}

/**
 * Returns a copy of LightningLoop credentials captured by this process for the
 * sole purpose of output filtering. Callers must never persist or log these
 * values. Keeping the set process-local also avoids inspecting Pi state.
 */
export function runtimeCredentialValuesForFiltering(): readonly string[] {
  return [...runtimeCredentials];
}

function stringLeaves(value: unknown, output: string[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("Credential safety rejected a cyclic input object.");
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item) => stringLeaves(item, output, seen));
  else Object.entries(value).forEach(([key, item]) => {
    output.push(key);
    stringLeaves(item, output, seen);
  });
  seen.delete(value);
}

/**
 * Returns every bounded percent-decoded view without changing the accepted
 * semantic input. Malformed escapes or values that remain encoded after the
 * cap fail closed so a credential cannot hide behind parser disagreement.
 */
function canonicalInspectionForms(value: string): readonly string[] {
  const forms = [value];
  let current = value;
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    let decoded: string;
    try { decoded = decodeURIComponent(current); }
    catch { throw new Error("Credential safety rejected malformed percent encoding."); }
    if (decoded === current) return forms;
    forms.push(decoded);
    current = decoded;
  }
  try {
    if (decodeURIComponent(current) !== current) throw new Error("over-depth");
  } catch {
    throw new Error("Credential safety rejected over-depth or malformed percent encoding.");
  }
  return forms;
}

/**
 * Fresh, fail-closed trust boundary for any value about to enter UI, model,
 * provider, session naming, or persistence. It rejects both generic secret
 * shapes and exact current/runtime/historical LightningLoop-owned credentials,
 * and returns the original value unchanged only after all checks pass.
 */
export function assertCredentialSafeInput<T>(
  value: T,
  profile: ProviderProfile = loadProviderProfile(),
  readCredential: CredentialReader = processOwnedCredential,
  registryPath?: string,
): T {
  const values: string[] = [];
  stringLeaves(value, values, new WeakSet<object>());
  new SecretRedactor().assertSafe(value);
  const inspectionForms = values.flatMap((candidate) => canonicalInspectionForms(candidate));
  const shapeRedactor = new SecretRedactor();
  inspectionForms.forEach((candidate) => shapeRedactor.assertSafe(candidate));
  const services = lightningLoopCredentialServices(profile, registryPath);
  const credentials = [
    ...runtimeCredentials,
    ...services
      .map((service) => readCredential(service)?.trim())
      .filter((credential): credential is string => Boolean(credential)),
  ];
  for (const credential of credentials) {
    if (inspectionForms.some((candidate) => candidate.includes(credential))) {
      throw new Error("Credential-bearing input is prohibited at this trust boundary.");
    }
  }
  return value;
}

export function assertNoConfiguredCredential(
  values: readonly string[],
  profile: ProviderProfile = loadProviderProfile(),
  readCredential: CredentialReader = processOwnedCredential,
  registryPath?: string,
): void {
  try {
    assertCredentialSafeInput(values, profile, readCredential, registryPath);
  } catch (error) {
    if (error instanceof Error && error.message === "Credential-bearing input is prohibited at this trust boundary.") {
      throw new Error("Configured credential content is prohibited in memory and evolution records.");
    }
    throw error;
  }
}

/** Env or a key written in this process. Never `security find-generic-password`. */
function processOwnedCredential(service: string): string | undefined {
  return envCredentialForService(service) ?? readSecret(service);
}
