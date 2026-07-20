import type { McpManifest } from "./manifest.js";

export interface McpVerification {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  tools: string[];
}

export interface McpCallResult extends McpVerification {
  output: string;
  isError: boolean;
}

const disabled = (): never => {
  throw new Error("MCP execution is disabled until every executable input is pinned and descendant containment is deterministic.");
};

export async function verifyMcpServer(manifest: McpManifest, workspace: string): Promise<McpVerification> {
  void manifest;
  void workspace;
  return disabled();
}

export async function callMcpServer(
  manifest: McpManifest,
  workspace: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<McpCallResult> {
  void manifest;
  void workspace;
  void tool;
  void input;
  return disabled();
}
