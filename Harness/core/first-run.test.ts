import assert from "node:assert/strict";
import test from "node:test";
import { doctorNextAction, firstRunMessage, FIRST_RUN_STEPS } from "./first-run.js";

test("first-run is four steps and names the next action", () => {
  assert.equal(FIRST_RUN_STEPS.length, 4);
  const message = firstRunMessage();
  assert.match(message, /first run: choose a provider/u);
  assert.match(message, /Next: llp provider select PRESET/u);
  assert.match(message, /llp key set NAME/u);
  assert.match(message, /llp auth then \/login/u);
  assert.match(message, /llp loop "your goal"/u);
  assert.doesNotMatch(message, /llp help/u);
  assert.doesNotMatch(message, /llp free/u);
  assert.doesNotMatch(message, /agents select/u);
  assert.doesNotMatch(message, /browse URL/u);
  assert.doesNotMatch(message, /\bPi\b/u);
});

test("doctor next action fail-closes to the one required step", () => {
  assert.equal(doctorNextAction({ selectionRequired: true, piManaged: false, managedKeyReady: false }), "Next: llp provider select PRESET");
  assert.match(doctorNextAction({ selectionRequired: false, piManaged: true, managedKeyReady: false }), /llp auth then \/login/u);
  assert.match(doctorNextAction({ selectionRequired: false, piManaged: false, managedKeyReady: false, managedKeyName: "openrouter" }), /key set openrouter/u);
  assert.equal(doctorNextAction({ selectionRequired: false, piManaged: false, managedKeyReady: true }), "Next: llp loop \"your goal\"");
});
