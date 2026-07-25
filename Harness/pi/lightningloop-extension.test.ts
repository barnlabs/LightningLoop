import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRuntimeCredential } from "../core/credential-safety.js";
import { lightningLoopExtension } from "./lightningloop-extension.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const extensionModuleUrl = pathToFileURL(join(repositoryRoot, "dist/pi/lightningloop-extension.js")).href;

test("extension rejects a credential-bearing goal before session naming, UI result, or persistence", async () => {
  const credential = "csk-syntheticextension123456789";
  const encodedCredential = credential.replace("-", "%2D");
  registerRuntimeCredential(credential);
  const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> | void }>();
  const sessionNames: string[] = [];
  const messages: unknown[] = [];
  const entries: unknown[] = [];
  const notifications: string[] = [];
  const fakePi = {
    registerTool: () => undefined,
    registerFlag: () => undefined,
    registerProvider: () => undefined,
    on: () => undefined,
    getFlag: () => false,
    registerCommand: (name: string, command: { handler: (args: string, context: unknown) => Promise<void> | void }) => commands.set(name, command),
    setSessionName: (name: string) => sessionNames.push(name),
    sendMessage: (message: unknown) => messages.push(message),
    appendEntry: (_type: string, entry: unknown) => entries.push(entry),
  };
  lightningLoopExtension(fakePi as unknown as ExtensionAPI);
  const loop = commands.get("loop");
  assert.ok(loop);
  await loop.handler(`Explain ${encodedCredential}`, {
    isIdle: () => true,
    ui: {
      editor: async () => undefined,
      notify: (message: string) => notifications.push(message),
      setStatus: () => undefined,
    },
  });
  assert.deepEqual(sessionNames, []);
  assert.deepEqual(messages, []);
  assert.deepEqual(entries, []);
  assert.equal(notifications.some((message) => /credential-safety boundary/u.test(message)), true);
  assert.equal(notifications.some((message) => message.includes(credential)), false);
  assert.equal(notifications.some((message) => message.includes(encodedCredential)), false);
});

/**
 * Child process isolation: parent-suite tests also mutate
 * LIGHTNINGLOOP_PROVIDER_CONFIG_PATH under --test-concurrency=2.
 */
test("TUI identity presents runtime-managed provider ownership as LightningLoop", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-extension-"));
  const config = join(directory, "provider.json");
  const script = join(directory, "tui-identity.mjs");
  writeFileSync(config, `${JSON.stringify({
    schemaVersion: 1,
    id: "openai-codex",
    preset: "openai-codex",
    displayName: "OpenAI Codex",
    baseURL: "https://api.openai.com/v1",
    modelID: "gpt-5.6-terra",
    modelName: "GPT-5.6 Terra",
    supportsImages: true,
    contextWindow: 400_000,
    maxOutputTokens: 131_072,
  }, null, 2)}\n`);
  writeFileSync(script, `
import assert from "node:assert/strict";
const { lightningLoopExtension } = await import(${JSON.stringify(extensionModuleUrl)});
let sessionStart;
let headerFactory;
const fakePi = {
  registerTool: () => undefined,
  registerFlag: () => undefined,
  registerProvider: () => undefined,
  on: (event, handler) => { if (event === "session_start") sessionStart = handler; },
  getFlag: () => false,
  registerCommand: () => undefined,
};
lightningLoopExtension(fakePi);
assert.ok(sessionStart);
await sessionStart({}, {
  cwd: process.cwd(),
  mode: "tui",
  ui: {
    setTitle: () => undefined,
    setStatus: () => undefined,
    setHeader: (value) => { headerFactory = value; },
    setFooter: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    theme: { fg: (_n, v) => v, bold: (v) => v },
  },
});
assert.ok(headerFactory);
const rendered = headerFactory({}, { fg: (_n, v) => v, bold: (v) => v }).render(120).join("\\n");
assert.match(rendered, /authentication and model catalog managed by the LightningLoop runtime/u);
assert.doesNotMatch(rendered, /\\bPi\\b/u);
console.log("tui-identity-ok");
`);
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: repositoryRoot,
      env: {
        ...process.env,
        LIGHTNINGLOOP_PROVIDER_CONFIG_PATH: config,
      },
      timeout: 15_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /tui-identity-ok/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
