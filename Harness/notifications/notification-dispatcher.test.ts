import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchNotification } from "./notification-dispatcher.js";

test("notification hooks fail closed instead of invoking a shell", () => {
  const root = mkdtempSync(join(tmpdir(), "lightningloop-notify-"));
  const path = join(root, "hook.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, enabled: true, executable: "relative.sh", arguments: [] }));
  assert.throws(() => dispatchNotification("gold", "done", path), /absolute path/);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, enabled: false, executable: "/bin/false", arguments: [] }));
  assert.doesNotThrow(() => dispatchNotification("blocked", "paused", path));
});
