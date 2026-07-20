import assert from "node:assert/strict";
import test from "node:test";
import { validatePiPassthrough } from "./pi-options.js";

test("safe print options are allowed without exposing provider or tool policy", () => {
  assert.deepEqual(validatePiPassthrough(["--no-session", "-p", "Say hello", "--thinking", "low"]), [
    "--no-session", "-p", "Say hello", "--thinking", "low",
  ]);
});

test("Pi tool, extension, provider, and session overrides are denied", () => {
  for (const option of ["--tools", "--extension", "--provider", "--model", "--session-dir"]) {
    assert.throws(() => validatePiPassthrough([option, "unsafe"]), /safe passthrough/);
  }
});
