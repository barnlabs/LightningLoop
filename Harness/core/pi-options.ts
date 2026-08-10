const VALUE_OPTIONS = new Set(["-p", "--print", "--thinking"]);
const FLAG_OPTIONS = new Set(["--no-session"]);
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** Encode a captured credential for Pi's config-value grammar without changing its bytes at resolution. */
export function encodePiApiKey(apiKey: string): string {
  const escapedDollars = apiKey.replaceAll("$", () => "$$");
  return escapedDollars.startsWith("!") ? `$!${escapedDollars.slice(1)}` : escapedDollars;
}

export function validatePiPassthrough(args: readonly string[]): string[] {
  const accepted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) throw new Error("Empty runtime option is not allowed.");
    if (FLAG_OPTIONS.has(arg)) {
      accepted.push(arg);
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === "--thinking" && !THINKING_LEVELS.has(value)) throw new Error("Invalid runtime thinking level.");
      accepted.push(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`Runtime option ${arg} is outside the LightningLoop safe passthrough allowlist.`);
  }
  return accepted;
}
