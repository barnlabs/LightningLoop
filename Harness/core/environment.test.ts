import assert from "node:assert/strict";
import test from "node:test";
import { scrubSensitiveEnvironment } from "./environment.js";

test("tool environment keeps runtime basics and removes credential-shaped variables", () => {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    GH_TOKEN: "synthetic",
    SERVICE_API_KEY: "synthetic",
    PROXY: "https://user:password@example.com",
  };
  const removed = scrubSensitiveEnvironment(environment);
  assert.deepEqual(removed, ["GH_TOKEN", "PROXY", "SERVICE_API_KEY"]);
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, "/tmp/home");
});
