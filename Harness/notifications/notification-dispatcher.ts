import { isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { lightningLoopDataPath } from "../core/platform-paths.js";
import { scrubSensitiveEnvironment } from "../core/environment.js";

export type NotificationEvent = "gold" | "blocked" | "needs_input";

interface NotificationHookConfig {
  schemaVersion: 1;
  enabled: boolean;
  executable: string;
  arguments: string[];
}

export function dispatchNotification(event: NotificationEvent, title: string, configPath = lightningLoopDataPath("managed", "current", "tools", "notification-hook.json")): void {
  // ANSI/Windows terminals normally interpret BEL without requiring a daemon.
  if (process.stderr.isTTY) process.stderr.write("\u0007");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown; }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return;
    throw new Error("The notification hook configuration is malformed; the hook was not run.");
  }
  const config = validateNotificationHook(raw);
  if (!config.enabled) return;
  const environment = { ...process.env };
  scrubSensitiveEnvironment(environment);
  const result = spawnSync(config.executable, config.arguments, {
    input: `${JSON.stringify({ schemaVersion: 1, event, title: title.replace(/[\r\n\0]/g, " ").slice(0, 160), timestamp: new Date().toISOString() })}\n`,
    encoding: "utf8",
    env: environment,
    shell: false,
    timeout: 5_000,
    maxBuffer: 32_768,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("The configured notification hook failed; loop state remains unchanged.");
}

function validateNotificationHook(value: unknown): NotificationHookConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Notification hook must be an object.");
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1 || typeof root.enabled !== "boolean" || typeof root.executable !== "string" || !Array.isArray(root.arguments)) throw new Error("Notification hook fields are invalid.");
  if (!isAbsolute(root.executable) || root.executable.length > 1_000) throw new Error("Notification hook executable must be an absolute path.");
  if (root.arguments.length > 16 || !root.arguments.every((arg) => typeof arg === "string" && arg.length <= 500 && !arg.includes("\0"))) throw new Error("Notification hook arguments are invalid.");
  return { schemaVersion: 1, enabled: root.enabled, executable: root.executable, arguments: root.arguments as string[] };
}
