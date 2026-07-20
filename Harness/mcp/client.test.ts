import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callMcpServer, verifyMcpServer } from "./client.js";
import { parseMcpManifest } from "./manifest.js";

test("MCP execution stays disabled even for an integrity-pinned cooperative fixture", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-mcp-"));
  const server = join(workspace, "synthetic-mcp.py");
  const source = `#!/usr/bin/python3
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"synthetic-safe-mcp","version":"1.0.0"}}}), flush=True)
    elif message.get("method") == "tools/list":
        print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":{"tools":[{"name":"inspect_asset","description":"Synthetic","inputSchema":{"type":"object"}}]}}), flush=True)
    elif message.get("method") == "tools/call":
        print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":{"content":[{"type":"text","text":"asset-ok:" + message["params"]["arguments"]["asset"]}],"isError":False}}), flush=True)
`;
  await writeFile(server, source, { mode: 0o700 });
  await chmod(server, 0o700);
  const python = "/usr/bin/python3";
  const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  try {
    const manifest = parseMcpManifest({
      schemaVersion: 1,
      id: "synthetic-safe-mcp",
      source: "local test fixture",
      command: python,
      args: [server],
      integrity: [
        { path: python, sha256: await digest(python) },
        { path: server, sha256: await digest(server) },
      ],
      allowedDomains: [],
      workspaceWrite: false,
      timeoutSeconds: 10,
    });
    await assert.rejects(() => verifyMcpServer(manifest, workspace), /MCP execution is disabled/);
    await assert.rejects(() => callMcpServer(manifest, workspace, "inspect_asset", { asset: "cube.glb" }), /MCP execution is disabled/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MCP manifests reject floating launchers even while execution is disabled", async () => {
  assert.throws(() => parseMcpManifest({
    schemaVersion: 1,
    id: "unsafe",
    source: "test",
    command: "/usr/local/bin/npx",
    args: ["-y", "latest"],
    integrity: [{ path: "/usr/local/bin/npx", sha256: "a".repeat(64) }],
  }), /prohibited/);
});
