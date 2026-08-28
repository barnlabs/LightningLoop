/**
 * Easy, secure API-key storage backed by the operating system's secret store.
 *
 * Design principles:
 * - **Never** write a credential to a plaintext file. If no OS secret store is
 *   available, operations fail closed with guidance to use an environment
 *   variable instead. LightningLoop's `provider.json` stays credential-free.
 * - macOS uses the Keychain via `security` for **write/clear only**; Linux uses
 *   libsecret via `secret-tool` the same way (the secret is passed on stdin,
 *   never argv). Windows is not yet supported here and fails closed.
 * - `get` never runs `security find-generic-password` or `secret-tool lookup`.
 *   Those lookups prompt the login keychain / keyring. Status and doctor treat
 *   a key the user did not just write in this process as env-or-missing.
 * - Backends are injectable so the storage logic is unit-tested without touching
 *   a real keyring.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { providerCredentialService, type ProviderProfile } from "./provider-profile.js";

const SECRET_MAX_BYTES = 8_192;
const KEYCHAIN_ACCOUNT = "lightningloop";

export interface SecretBackend {
  readonly name: string;
  isAvailable(): boolean;
  set(service: string, secret: string): void;
  /** Read is env or same-process write. OS backends must not probe the store. */
  get(service: string): string | undefined;
  clear(service: string): void;
}

/** Secrets written by `storeSecret` in this process. Never a live Keychain dump. */
const sessionSecrets = new Map<string, string>();

function isWriteOnlyOsBackend(backend: SecretBackend): boolean {
  return backend === macOSKeychainBackend || backend === linuxSecretToolBackend;
}

export function assertSafeService(service: string): void {
  if (!/^[A-Za-z0-9.@_-]{1,255}$/u.test(service)) {
    throw new Error("Invalid credential service identifier.");
  }
}

export function assertSafeSecret(secret: string): void {
  if (!secret || secret.length > SECRET_MAX_BYTES || /[\r\n\0]/u.test(secret)) {
    throw new Error("The secret is empty, too long, or contains control characters.");
  }
}

/** macOS Keychain via the `security` CLI. */
export const macOSKeychainBackend: SecretBackend = {
  name: "macOS Keychain",
  isAvailable: () => process.platform === "darwin" && existsSync("/usr/bin/security"),
  set(service, secret) {
    assertSafeService(service);
    assertSafeSecret(secret);
    // -U updates an existing item in place.
    const result = spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT, "-s", service, "-w", secret], {
      timeout: 5_000,
      stdio: "ignore",
    });
    if (result.status !== 0) throw new Error("Failed to store the credential in the macOS Keychain.");
  },
  get(service) {
    assertSafeService(service);
    // Do not call `security find-generic-password`. Attribute or password
    // lookup prompts the login keychain when the item exists and this binary
    // is not on the ACL (installer, doctor, tests, `key status`).
    return undefined;
  },
  clear(service) {
    assertSafeService(service);
    spawnSync("/usr/bin/security", ["delete-generic-password", "-s", service], { timeout: 5_000, stdio: "ignore" });
  },
};

function secretToolPath(): string | undefined {
  for (const candidate of ["/usr/bin/secret-tool", "/bin/secret-tool"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Linux libsecret via `secret-tool`. The secret is delivered on stdin, not argv. */
export const linuxSecretToolBackend: SecretBackend = {
  name: "Linux libsecret (secret-tool)",
  isAvailable: () => process.platform === "linux" && secretToolPath() !== undefined,
  set(service, secret) {
    assertSafeService(service);
    assertSafeSecret(secret);
    const tool = secretToolPath();
    if (!tool) throw new Error("secret-tool is not installed.");
    const result = spawnSync(tool, ["store", "--label", `LightningLoop ${service}`, "service", service], {
      input: secret,
      timeout: 5_000,
      stdio: ["pipe", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`Failed to store the credential via libsecret. Ensure a secret service (keyring) is running. ${result.stderr?.trim() ?? ""}`.trim());
    }
  },
  get(service) {
    assertSafeService(service);
    // `secret-tool lookup` can prompt the session keyring. Status is env-or-missing.
    return undefined;
  },
  clear(service) {
    assertSafeService(service);
    const tool = secretToolPath();
    if (!tool) return;
    spawnSync(tool, ["clear", "service", service], { timeout: 5_000, stdio: "ignore" });
  },
};

/** The unavailable backend fails every mutation closed with actionable guidance. */
export const unavailableBackend: SecretBackend = {
  name: "none",
  isAvailable: () => false,
  set() {
    throw new Error("No OS secret store is available on this platform. Set the provider's API key as an environment variable instead (for example OPENROUTER_API_KEY).");
  },
  get: () => undefined,
  clear: () => undefined,
};

export function defaultSecretBackend(): SecretBackend {
  if (macOSKeychainBackend.isAvailable()) return macOSKeychainBackend;
  if (linuxSecretToolBackend.isAvailable()) return linuxSecretToolBackend;
  return unavailableBackend;
}

export function storeSecret(service: string, secret: string, backend: SecretBackend = defaultSecretBackend()): void {
  assertSafeService(service);
  assertSafeSecret(secret);
  if (!backend.isAvailable()) {
    throw new Error(`Secure key storage is unavailable (${backend.name}). Set the key as an environment variable instead, or install a system keyring.`);
  }
  backend.set(service, secret);
  if (isWriteOnlyOsBackend(backend)) sessionSecrets.set(service, secret);
}

export function readSecret(service: string, backend: SecretBackend = defaultSecretBackend()): string | undefined {
  assertSafeService(service);
  if (isWriteOnlyOsBackend(backend)) return sessionSecrets.get(service);
  if (!backend.isAvailable()) return undefined;
  return backend.get(service);
}

export function clearSecret(service: string, backend: SecretBackend = defaultSecretBackend()): void {
  assertSafeService(service);
  if (isWriteOnlyOsBackend(backend)) sessionSecrets.delete(service);
  if (!backend.isAvailable()) return;
  backend.clear(service);
}

export function secretPresent(service: string, backend: SecretBackend = defaultSecretBackend()): boolean {
  return readSecret(service, backend) !== undefined;
}

export function storeProviderCredential(profile: ProviderProfile, secret: string, backend: SecretBackend = defaultSecretBackend()): void {
  storeSecret(providerCredentialService(profile), secret, backend);
}

export function readStoredProviderCredential(profile: ProviderProfile, backend: SecretBackend = defaultSecretBackend()): string | undefined {
  return readSecret(providerCredentialService(profile), backend);
}

export function clearProviderCredential(profile: ProviderProfile, backend: SecretBackend = defaultSecretBackend()): void {
  clearSecret(providerCredentialService(profile), backend);
}
