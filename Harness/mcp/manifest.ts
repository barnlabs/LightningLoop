import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { objectValue, stringValue } from "../core/structured-json.js";

const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_LAUNCHERS = new Set(["npx", "npm", "pnpm", "yarn", "bunx", "curl", "wget"]);

export interface McpIntegrityEntry {
  path: string;
  sha256: string;
}

export interface McpManifest {
  schemaVersion: 1;
  id: string;
  source: string;
  command: string;
  args: string[];
  integrity: McpIntegrityEntry[];
  allowedDomains: string[];
  workspaceWrite: boolean;
  timeoutSeconds: number;
}

function stringList(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array with at most ${maximum} entries.`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
}

export function parseMcpManifest(value: unknown): McpManifest {
  const root = objectValue(value, "MCP manifest");
  if (root.schemaVersion !== 1) throw new Error("MCP manifest schemaVersion must be 1.");
  const command = stringValue(root.command, "command");
  if (!isAbsolute(command)) throw new Error("MCP command must be an absolute path.");
  const launcher = command.split("/").at(-1)?.toLowerCase() ?? "";
  if (FORBIDDEN_LAUNCHERS.has(launcher)) throw new Error("Floating package and download launchers are prohibited.");
  const rawIntegrity = root.integrity;
  if (!Array.isArray(rawIntegrity) || rawIntegrity.length < 1 || rawIntegrity.length > 20) {
    throw new Error("integrity must contain 1 through 20 pinned artifacts.");
  }
  const integrity = rawIntegrity.map((entry, index) => {
    const object = objectValue(entry, `integrity[${index}]`);
    const path = stringValue(object.path, `integrity[${index}].path`);
    const sha256 = stringValue(object.sha256, `integrity[${index}].sha256`).toLowerCase();
    if (!isAbsolute(path) || !SHA256.test(sha256)) throw new Error(`integrity[${index}] must contain an absolute path and lowercase SHA-256.`);
    return { path, sha256 };
  });
  if (!integrity.some((entry) => entry.path === command)) throw new Error("integrity must pin the command executable.");
  const timeoutSeconds = root.timeoutSeconds === undefined ? 15 : root.timeoutSeconds;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
    throw new Error("timeoutSeconds must be an integer from 1 through 60.");
  }
  if (root.workspaceWrite !== undefined && typeof root.workspaceWrite !== "boolean") throw new Error("workspaceWrite must be boolean.");
  return {
    schemaVersion: 1,
    id: stringValue(root.id, "id").slice(0, 128),
    source: stringValue(root.source, "source").slice(0, 1_000),
    command,
    args: stringList(root.args ?? [], "args", 50),
    integrity,
    allowedDomains: stringList(root.allowedDomains ?? [], "allowedDomains", 20),
    workspaceWrite: root.workspaceWrite === true,
    timeoutSeconds,
  };
}

export async function verifyMcpIntegrity(manifest: McpManifest): Promise<void> {
  for (const entry of manifest.integrity) {
    const canonical = await realpath(entry.path);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new Error(`Pinned MCP artifact is not a file: ${entry.path}`);
    const digest = createHash("sha256").update(await readFile(canonical)).digest("hex");
    if (digest !== entry.sha256) throw new Error(`MCP integrity mismatch: ${entry.path}`);
  }
}
