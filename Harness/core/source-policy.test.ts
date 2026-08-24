import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReputableSourceUrl,
  classifyHostname,
  classifySourceUrl,
  filterReputableSearchResults,
  isReputableSourceUrl,
} from "./source-policy.js";

test("public-authority TLDs and committed documentation hosts are reputable", () => {
  assert.equal(classifyHostname("cdc.gov"), "reputable");
  assert.equal(classifyHostname("www.cdc.gov"), "reputable");
  assert.equal(classifyHostname("mit.edu"), "reputable");
  assert.equal(classifyHostname("www.army.mil"), "reputable");
  assert.equal(classifyHostname("who.int"), "reputable");
  assert.equal(classifyHostname("developer.mozilla.org"), "reputable");
  assert.equal(classifyHostname("www.rfc-editor.org"), "reputable");
  assert.equal(classifyHostname("nodejs.org"), "reputable");
  assert.equal(isReputableSourceUrl("https://www.rfc-editor.org/rfc/rfc9110"), true);
});

test("blogs, aggregators, local names, and credentialed URLs are rejected", () => {
  assert.equal(classifyHostname("medium.com"), "rejected");
  assert.equal(classifyHostname("news.ycombinator.com"), "rejected");
  assert.equal(classifyHostname("example.com"), "rejected");
  assert.equal(classifyHostname("docs.example.com"), "rejected");
  assert.equal(classifyHostname("government.example"), "rejected");
  assert.equal(classifyHostname("localhost"), "rejected");
  assert.equal(classifySourceUrl("http://cdc.gov/x"), "rejected");
  assert.equal(classifySourceUrl("https://user:pass@cdc.gov/x"), "rejected");
  assert.equal(classifySourceUrl("https://cdc.gov:8443/x"), "rejected");
  assert.equal(isReputableSourceUrl("not a url"), false);
});

test("search results drop every non-reputable URL", () => {
  const kept = filterReputableSearchResults([
    { url: "https://agency.gov/fact" },
    { url: "https://example.com/blog" },
    { url: "https://developer.mozilla.org/en-US/docs/Web" },
    { url: "https://medium.com/p/1" },
  ]);
  assert.deepEqual(kept.map((item) => item.url), [
    "https://agency.gov/fact",
    "https://developer.mozilla.org/en-US/docs/Web",
  ]);
});

test("assertReputableSourceUrl fails closed with a clear message", () => {
  assert.throws(() => assertReputableSourceUrl("https://example.com/x"), /not a reputable primary source/);
  assert.doesNotThrow(() => assertReputableSourceUrl("https://agency.gov/x"));
});
