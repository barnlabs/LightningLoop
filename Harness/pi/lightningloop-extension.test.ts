import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRuntimeCredential } from "../core/credential-safety.js";
import { saveProviderPreset } from "../core/provider-profile.js";
import { lightningLoopExtension } from "./lightningloop-extension.js";

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

test("TUI identity presents runtime-managed provider ownership as LightningLoop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-extension-"));
  const config = join(directory, "provider.json");
  const previous = process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
  saveProviderPreset("openai-codex", config);
  process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = config;
  try {
    let sessionStart: ((event: unknown, context: unknown) => Promise<void> | void) | undefined;
    let headerFactory: ((tui: unknown, theme: { fg(name: string, value: string): string; bold(value: string): string }) => { render(width: number): string[] }) | undefined;
    const fakePi = {
      registerTool: () => undefined,
      registerFlag: () => undefined,
      registerProvider: () => undefined,
      on: (event: string, handler: (event: unknown, context: unknown) => Promise<void> | void) => {
        if (event === "session_start") sessionStart = handler;
      },
      getFlag: () => false,
      registerCommand: () => undefined,
    };
    lightningLoopExtension(fakePi as unknown as ExtensionAPI);
    assert.ok(sessionStart);
    await sessionStart({}, {
      cwd: process.cwd(),
      mode: "tui",
      ui: {
        setTitle: () => undefined,
        setStatus: () => undefined,
        setHeader: (value: (tui: unknown, theme: { fg(name: string, value: string): string; bold(value: string): string }) => { render(width: number): string[] }) => { headerFactory = value; },
        setFooter: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        theme: {
          fg: (_name: string, value: string) => value,
          bold: (value: string) => value,
        },
      },
    });
    assert.ok(headerFactory);
    const theme = {
      fg: (_name: string, value: string) => value,
      bold: (value: string) => value,
    };
    const rendered = headerFactory({}, theme).render(120).join("\n");
    assert.match(rendered, /authentication and model catalog managed by the LightningLoop runtime/u);
    assert.doesNotMatch(rendered, /\bPi\b/u);
  } finally {
    if (previous === undefined) delete process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH;
    else process.env.LIGHTNINGLOOP_PROVIDER_CONFIG_PATH = previous;
    rmSync(directory, { force: true, recursive: true });
  }
});
