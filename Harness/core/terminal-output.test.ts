import assert from "node:assert/strict";
import test from "node:test";
import { terminalSafe } from "./terminal-output.js";

test("terminal output removes control and ANSI escape sequences but preserves text layout", () => {
  assert.equal(terminalSafe("safe\u001b[2J\nnext\tcolumn"), "safe[2J\nnext\tcolumn");
});
