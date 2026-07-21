import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type ToolName = "read" | "grep" | "find" | "ls" | "write" | "edit" | "bash" | string;
export type ExecutionMode = "read_only" | "confirm_mutations";

export interface ToolRequest {
  toolName: ToolName;
  input: Record<string, unknown>;
}

export type PolicyDecision =
  | { action: "allow"; reason: string }
  | { action: "confirm"; reason: string; preview: string }
  | { action: "deny"; reason: string };

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

async function nearestExisting(path: string): Promise<{ existing: string; suffix: string[] }> {
  const suffix: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      await lstat(cursor);
      return { existing: cursor, suffix };
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`No existing ancestor for ${path}`);
      suffix.unshift(cursor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
      cursor = parent;
    }
  }
}

export class WorkspaceBoundary {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<WorkspaceBoundary> {
    return new WorkspaceBoundary(await realpath(root));
  }

  async canonicalize(candidate: string): Promise<string> {
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(this.root, candidate);
    try {
      return await realpath(absolute);
    } catch {
      const { existing, suffix } = await nearestExisting(absolute);
      return join(await realpath(existing), ...suffix);
    }
  }

  async contains(candidate: string): Promise<boolean> {
    const canonical = await this.canonicalize(candidate);
    const pathFromRoot = relative(this.root, canonical);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  }
}

function pathInput(request: ToolRequest): string | undefined {
  const value = request.input.path;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function preview(request: ToolRequest): string {
  if (request.toolName === "bash") {
    const command = request.input.command;
    return typeof command === "string" ? command : "shell command";
  }
  return `${request.toolName} ${pathInput(request) ?? "(workspace)"}`;
}

function isSensitiveWorkspacePath(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (/\.(?:pem|key|p12|pfx)$/.test(name)) return true;
  if (segments.includes(".ssh") || segments.includes(".aws") || segments.includes(".gnupg")) return true;
  return normalized.endsWith("/.git/config") || normalized.endsWith("/.git/credentials");
}

function shellNamesSensitivePath(command: string): boolean {
  return /(?:^|[\s'"/])(?:\.env(?:\.[a-z0-9_-]+)?|[^\s'"/]+\.(?:pem|key|p12|pfx)|\.git\/(?:config|credentials))(?:$|[\s'";|&])/i.test(command);
}

export async function evaluateToolRequest(
  request: ToolRequest,
  boundary: WorkspaceBoundary,
  mode: ExecutionMode,
): Promise<PolicyDecision> {
  if (request.toolName === "bash") {
    const command = request.input.command;
    if (typeof command !== "string" || !command.trim()) {
      return { action: "deny", reason: "Shell execution requires a non-empty command." };
    }
    if (command.length > 2_000) {
      return { action: "deny", reason: "Shell command exceeds the 2,000-character review limit." };
    }
    if (shellNamesSensitivePath(command)) {
      return { action: "deny", reason: "Shell command names a credential-bearing workspace path." };
    }
    return mode === "confirm_mutations"
      ? { action: "confirm", reason: "Shell execution requires per-call approval.", preview: preview(request) }
      : { action: "deny", reason: "Shell execution is disabled in read-only mode." };
  }

  if (!READ_TOOLS.has(request.toolName) && !WRITE_TOOLS.has(request.toolName)) {
    return { action: "deny", reason: `Tool ${request.toolName} is not in the reviewed capability set.` };
  }

  const candidate = pathInput(request) ?? boundary.root;
  if (!(await boundary.contains(candidate))) {
    return { action: "deny", reason: `Path is outside the approved workspace: ${candidate}` };
  }
  const canonical = await boundary.canonicalize(candidate);
  if (isSensitiveWorkspacePath(canonical)) {
    return { action: "deny", reason: "Credential-bearing workspace paths are not readable by model tools." };
  }

  if (READ_TOOLS.has(request.toolName)) {
    return { action: "allow", reason: "Read-only request is confined to the approved workspace." };
  }

  return mode === "confirm_mutations"
    ? { action: "confirm", reason: "Workspace mutation requires per-call approval.", preview: preview(request) }
    : { action: "deny", reason: "Workspace mutation is disabled in read-only mode." };
}
