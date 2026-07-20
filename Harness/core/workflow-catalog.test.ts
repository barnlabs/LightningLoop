import assert from "node:assert/strict";
import test from "node:test";
import { builtinWorkflowGuidance, routeBuiltinWorkflows } from "./workflow-catalog.js";

test("workflow router selects narrow built-ins and leaves unrelated prompts alone", () => {
  assert.deepEqual(routeBuiltinWorkflows("Turn this photo into a 3D GLB"), ["photo_to_3d"]);
  assert.deepEqual(routeBuiltinWorkflows("Build a beautiful responsive website"), ["website"]);
  assert.deepEqual(routeBuiltinWorkflows("Write an advanced Swift CLI application"), ["software"]);
  assert.deepEqual(routeBuiltinWorkflows("Summarize this paragraph"), []);
  assert.match(builtinWorkflowGuidance("Create a site"), /375 and 1280/);
});
