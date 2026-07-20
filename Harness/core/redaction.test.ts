import assert from "node:assert/strict";
import test from "node:test";
import { SecretRedactor } from "./redaction.js";

test("redactor removes known and provider-shaped secrets", () => {
  const known = "synthetic-search-secret-value";
  const redactor = new SecretRedactor([known]);
  const output = redactor.redact(`known=${known} provider=csk-synthetic123456789 firecrawl=fc-synthetic123456789`);
  assert.equal(output.includes(known), false);
  assert.equal(output.includes("csk-"), false);
  assert.equal(output.includes("fc-"), false);
});

test("protocol payloads reject secret-bearing fields", () => {
  const redactor = new SecretRedactor();
  assert.throws(() => redactor.assertSafe({ type: "hello", apiKey: "synthetic" }), /Secret field prohibited/);
  assert.doesNotThrow(() => redactor.assertSafe({ type: "credentialStatus", credentialID: "groq.default", configured: true }));
});
