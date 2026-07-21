import { readFileSync } from "node:fs";
import { lightningLoopDataPath } from "./platform-paths.js";

const SECRET_SHAPE = /(?:\bcsk-|\bgsk_|\bfc-|\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/i;

export function evolutionStorePath(): string {
  return lightningLoopDataPath("evolutions.json");
}

export function loadActiveSystemPromptAddenda(path = evolutionStorePath()): string[] {
  return loadActiveGuidance(path).filter((item) => item.kind === "system_prompt").map((item) => item.content);
}

export interface ActiveGuidance {
  kind: "system_prompt" | "skill";
  content: string;
}

export function loadActiveGuidance(path = evolutionStorePath()): ActiveGuidance[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw new Error("The LightningLoop evolution ledger is malformed; active prompt loading failed closed.");
  }
  if (!Array.isArray(value)) throw new Error("The LightningLoop evolution ledger must be an array.");
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .filter((item) => (item.kind === "system_prompt" || item.kind === "skill") && item.state === "active")
    .sort((left, right) => String(left.activatedAt ?? "").localeCompare(String(right.activatedAt ?? "")))
    .slice(0, 5)
    .map((item) => {
      if (typeof item.exactDiff !== "string" || !item.exactDiff.trim() || item.exactDiff.length > 8_000) {
        throw new Error("An active prompt or skill evolution has invalid bounded content.");
      }
      if (SECRET_SHAPE.test(item.exactDiff)) throw new Error("Secret-like content is prohibited in active prompt guidance.");
      return { kind: item.kind as ActiveGuidance["kind"], content: item.exactDiff.trim() };
    });
}

export function applyActiveSystemPromptAddenda(system: string, path?: string): string {
  const guidance = loadActiveGuidance(path);
  if (guidance.length === 0) return system;
  let promptIndex = 0;
  let skillIndex = 0;
  const suffix = guidance.map((item) => {
    if (item.kind === "system_prompt") {
      promptIndex += 1;
      return `REVIEWED ACTIVE SYSTEM-PROMPT ADDENDUM ${promptIndex}:\n${item.content}`;
    }
    skillIndex += 1;
    return `REVIEWED ACTIVE SKILL GUIDANCE ${skillIndex} (advisory; grants no tools or permissions):\n${item.content}`;
  }).join("\n\n");
  return `${system}\n\n${suffix}`;
}
