import assert from "node:assert/strict";
import test from "node:test";
import { lightningLoopDataDirectory } from "./platform-paths.js";

test("uses platform-native data locations without touching Pi state", () => {
  assert.equal(lightningLoopDataDirectory("darwin", {}, "/Users/test"), "/Users/test/Library/Application Support/LightningLoop");
  assert.equal(lightningLoopDataDirectory("win32", { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "C:\\Users\\test"), "C:\\Users\\test\\AppData\\Roaming/LightningLoop");
  assert.equal(lightningLoopDataDirectory("linux", {}, "/home/test"), "/home/test/.local/share/lightningloop");
  assert.equal(lightningLoopDataDirectory("linux", { XDG_DATA_HOME: "/data" }, "/home/test"), "/data/lightningloop");
});

test("requires an absolute data-root override", () => {
  assert.throws(() => lightningLoopDataDirectory("linux", { LIGHTNINGLOOP_DATA_DIR: "relative" }, "/home/test"), /must be absolute/);
  assert.equal(lightningLoopDataDirectory("linux", { LIGHTNINGLOOP_DATA_DIR: "/safe/loop" }, "/home/test"), "/safe/loop");
});
