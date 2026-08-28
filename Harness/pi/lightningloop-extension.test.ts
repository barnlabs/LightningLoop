import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertCredentialSafeInput, registerRuntimeCredential } from "../core/credential-safety.js";
import { createLightningLoopExtension, lightningLoopExtension } from "./lightningloop-extension.js";
import { encodePiApiKey } from "../core/pi-options.js";
import { loadProviderProfile, profileForPreset } from "../core/provider-profile.js";
import { prepareTuiRuntimeCredentials } from "../cli/index.js";
import { resolveConfigValueUncached } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const extensionModuleUrl = pathToFileURL(join(repositoryRoot, "dist/pi/lightningloop-extension.js")).href;

test("first-run TUI registers agents and browse without a selected provider", async () => {
  const previousConfig = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  const previousData = process.env.LIGHTNINGLOOP_DATA_DIR;
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-extension-firstrun-"));
  process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = join(directory, "missing-provider.json");
  process.env.LIGHTNINGLOOP_DATA_DIR = directory;
  const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> | void }>();
  const notifications: string[] = [];
  try {
    lightningLoopExtension({
      registerTool: () => undefined,
      registerFlag: () => undefined,
      registerProvider: () => {
        throw new Error("first-run TUI must not register a provider");
      },
      on: () => undefined,
      getFlag: () => false,
      registerCommand: (name: string, command: { handler: (args: string, context: unknown) => Promise<void> | void }) => commands.set(name, command),
      setSessionName: () => undefined,
      sendMessage: () => undefined,
      appendEntry: () => undefined,
    } as unknown as ExtensionAPI);
    assert.ok(commands.get("loop"));
    assert.ok(commands.get("help"));
    assert.ok(commands.get("provider"));
    assert.ok(commands.get("key"));
    assert.ok(commands.get("free"));
    assert.ok(commands.get("doctor"));
    assert.ok(commands.get("skills"));
    assert.ok(commands.get("agents"));
    assert.ok(commands.get("browse"));
    await commands.get("help")!.handler("", {
      ui: { notify: (message: string) => notifications.push(message) },
    });
    assert.equal(notifications.some((message) => /llp, lloop, and lightningloop/u.test(message)), true);
    assert.equal(notifications.some((message) => /never invents a dollar amount/u.test(message)), true);
    assert.equal(notifications.some((message) => /skills list\|enable\|disable/u.test(message)), true);
    assert.equal(notifications.some((message) => /\bPi\b/u.test(message)), false);
    await commands.get("agents")!.handler("", {
      ui: { notify: (message: string) => notifications.push(message) },
    });
    await commands.get("browse")!.handler("https://example.com/", {
      ui: { notify: (message: string) => notifications.push(message) },
    });
    assert.equal(notifications.some((message) => /researcher/u.test(message)), true);
    assert.equal(notifications.some((message) => /engineer/u.test(message)), true);
    assert.equal(notifications.some((message) => /verifier/u.test(message)), true);
    assert.equal(notifications.some((message) => /not a reputable primary source/u.test(message)), true);
  } finally {
    if (previousConfig === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = previousConfig;
    if (previousData === undefined) delete process.env.LIGHTNINGLOOP_DATA_DIR;
    else process.env.LIGHTNINGLOOP_DATA_DIR = previousData;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("extension rejects a credential-bearing goal before session naming, UI result, or persistence", async () => {
  const previousConfig = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  const previousData = process.env.LIGHTNINGLOOP_DATA_DIR;
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-extension-cred-"));
  process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = join(directory, "missing-provider.json");
  process.env.LIGHTNINGLOOP_DATA_DIR = directory;
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
  try {
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
  } finally {
    if (previousConfig === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = previousConfig;
    if (previousData === undefined) delete process.env.LIGHTNINGLOOP_DATA_DIR;
    else process.env.LIGHTNINGLOOP_DATA_DIR = previousData;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TUI preparation scrubs the OPENROUTER_KEY alias from the child tool environment", () => {
  // The shared scrubber matches *_API_KEY but not the bare OPENROUTER_KEY alias,
  // so prepareTuiRuntimeCredentials must delete it explicitly. This pins that guard.
  const env: NodeJS.ProcessEnv = {
    OPENROUTER_API_KEY: "or-api-secret-alpha-123456",
    OPENROUTER_KEY: "or-alias-secret-bravo-654321",
  };
  const options = prepareTuiRuntimeCredentials(profileForPreset("openrouter"), env);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.OPENROUTER_KEY, undefined);
  assert.equal(options.openRouterApiKey, "or-api-secret-alpha-123456");
});

test("TUI preparation passes GeneralCompute env credential across the scrub boundary", () => {
  const credential = "!gc_live_$NAME_synthetic_tui_boundary";
  const previous = process.env.GENERALCOMPUTE_API_KEY;
  const previousOther = process.env.OTHER_API_KEY;
  const previousName = process.env.NAME;
  const previousConfig = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-tui-boundary-"));
  const config = join(directory, "provider.json");
  writeFileSync(config, `${JSON.stringify({
    schemaVersion: 1,
    id: "generalcompute",
    preset: "generalcompute",
    displayName: "GeneralCompute",
    baseURL: "https://api.generalcompute.com/v1",
    modelID: "minimax-m2.7",
    modelName: "MiniMax M2.7",
    supportsImages: false,
    contextWindow: 192_000,
    maxOutputTokens: 131_072,
  })}\n`);
  process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = config;
  process.env.GENERALCOMPUTE_API_KEY = credential;
  try {
    process.env.OTHER_API_KEY = "other-synthetic-key";
    process.env.NAME = "ambient-value-must-not-be-read";
    const options = prepareTuiRuntimeCredentials(loadProviderProfile(), process.env);
    let registered: { apiKey?: string } | undefined;
    const fakePi = {
      registerTool: () => undefined,
      registerFlag: () => undefined,
      registerProvider: (_id: string, options: { apiKey?: string }) => { registered = options; },
      on: () => undefined,
      getFlag: () => false,
      registerCommand: () => undefined,
    };
    createLightningLoopExtension(options)(fakePi as unknown as ExtensionAPI);
    assert.equal(process.env.GENERALCOMPUTE_API_KEY, undefined);
    assert.equal(process.env.OTHER_API_KEY, undefined);
    assert.equal(registered?.apiKey, encodePiApiKey(credential));
    assert.match(registered?.apiKey ?? "", /^\$!/u);
    assert.doesNotMatch(registered?.apiKey ?? "", /(?<!\$)\$NAME/u);
    assert.equal(resolveConfigValueUncached(registered?.apiKey ?? "", { NAME: "different-ambient-value" }), credential);
    assert.throws(() => assertCredentialSafeInput({ user: credential }), /credential|secret|sensitive/iu);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.GENERALCOMPUTE_API_KEY)); process.stderr.write(String(process.env.OTHER_API_KEY));"], {
      env: process.env,
      encoding: "utf8",
    });
    assert.equal(child.status, 0);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /(?:gc_live_|other-synthetic-key|ambient-value)/u);
    assert.doesNotMatch(readFileSync(config, "utf8"), /gc_live_|\$NAME/u);
  } finally {
    if (previous === undefined) delete process.env.GENERALCOMPUTE_API_KEY;
    else process.env.GENERALCOMPUTE_API_KEY = previous;
    if (previousConfig === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = previousConfig;
    if (previousOther === undefined) delete process.env.OTHER_API_KEY;
    else process.env.OTHER_API_KEY = previousOther;
    if (previousName === undefined) delete process.env.NAME;
    else process.env.NAME = previousName;
    rmSync(directory, { force: true, recursive: true });
  }
});

test("TUI preparation filters an inactive GeneralCompute credential without passing it to a built-in provider", () => {
  const credential = "inactive-generalcompute-credential-86420";
  const previous = process.env.GENERALCOMPUTE_API_KEY;
  const previousConfig = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-inactive-generalcompute-"));
  const config = join(directory, "provider.json");
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
  })}\n`);
  process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = config;
  process.env.GENERALCOMPUTE_API_KEY = credential;
  try {
    const options = prepareTuiRuntimeCredentials(loadProviderProfile(), process.env);
    assert.deepEqual(options, {});
    assert.equal(process.env.GENERALCOMPUTE_API_KEY, undefined);
    const fakePi = {
      registerTool: () => undefined,
      registerFlag: () => undefined,
      registerProvider: () => assert.fail("built-in provider must not receive an inactive GeneralCompute credential"),
      on: () => undefined,
      getFlag: () => false,
      registerCommand: () => undefined,
    };
    createLightningLoopExtension(options)(fakePi as unknown as ExtensionAPI);
    assert.throws(() => assertCredentialSafeInput({ user: credential }), /credential|secret|sensitive/iu);
    assert.doesNotMatch(readFileSync(config, "utf8"), new RegExp(credential, "u"));
  } finally {
    if (previous === undefined) delete process.env.GENERALCOMPUTE_API_KEY;
    else process.env.GENERALCOMPUTE_API_KEY = previous;
    if (previousConfig === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = previousConfig;
    rmSync(directory, { force: true, recursive: true });
  }
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
