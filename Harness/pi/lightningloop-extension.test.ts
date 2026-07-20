import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRuntimeCredential } from "../core/credential-safety.js";
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
