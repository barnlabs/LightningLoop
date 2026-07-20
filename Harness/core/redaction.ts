const GENERIC_SECRET_PATTERNS = [
  /\bcsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bfc-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi,
  /\b(?:exa|brave|api[_ -]?key|token|secret|password)\s*[:=]\s*\S{12,}/gi,
];

const SECRET_FIELDS = new Set([
  "apikey",
  "authorization",
  "credential",
  "credentialvalue",
  "password",
  "secret",
  "secretvalue",
  "token",
]);

export class SecretRedactor {
  private readonly knownSecrets: string[];

  constructor(knownSecrets: readonly string[] = []) {
    this.knownSecrets = [...knownSecrets].filter((value) => value.length >= 8).sort((a, b) => b.length - a.length);
  }

  redact(input: string): string {
    let output = input;
    for (const secret of this.knownSecrets) output = output.split(secret).join("[REDACTED]");
    for (const pattern of GENERIC_SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
    return output;
  }

  assertSafe(value: unknown, path = "$"): void {
    if (typeof value === "string") {
      if (this.redact(value) !== value) throw new Error(`Secret-like value prohibited at ${path}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.assertSafe(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replaceAll("-", "").replaceAll("_", "");
        if (SECRET_FIELDS.has(normalizedKey) && nested !== undefined && nested !== null && nested !== "") {
          throw new Error(`Secret field prohibited at ${path}.${key}`);
        }
        this.assertSafe(nested, `${path}.${key}`);
      }
    }
  }
}
