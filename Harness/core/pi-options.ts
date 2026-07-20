const VALUE_OPTIONS = new Set(["-p", "--print", "--thinking"]);
const FLAG_OPTIONS = new Set(["--no-session"]);
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export function validatePiPassthrough(args: readonly string[]): string[] {
  const accepted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) throw new Error("Empty Pi option is not allowed.");
    if (FLAG_OPTIONS.has(arg)) {
      accepted.push(arg);
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === "--thinking" && !THINKING_LEVELS.has(value)) throw new Error("Invalid Pi thinking level.");
      accepted.push(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`Pi option ${arg} is outside the LightningLoop safe passthrough allowlist.`);
  }
  return accepted;
}
