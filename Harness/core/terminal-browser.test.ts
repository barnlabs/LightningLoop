import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSE_MAX_BYTES,
  browseReputablePage,
  describeBrowseRefusal,
  executeBrowseCommand,
  extractLinks,
  extractTitle,
  renderBrowsePage,
  type BrowseFetch,
} from "./terminal-browser.js";

const rfcHtml = `<html><head><title>RFC 9110</title></head><body>
<p>HTTP semantics.</p>
<a href="/rfc/rfc9111">Caching</a>
<a href="https://medium.com/nope">Blog</a>
</body></html>`;

test("title and link extraction keep only reputable hrefs", () => {
  assert.equal(extractTitle(rfcHtml), "RFC 9110");
  const links = extractLinks(rfcHtml, "https://www.rfc-editor.org/rfc/rfc9110");
  assert.deepEqual(links.map((link) => link.href), ["https://www.rfc-editor.org/rfc/rfc9111"]);
});

test("browseReputablePage fetches a reputable host and fails closed otherwise", async () => {
  const fetchImpl: BrowseFetch = async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(url.hostname, "www.rfc-editor.org");
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      bytes: new TextEncoder().encode(rfcHtml),
    };
  };
  const page = await browseReputablePage("https://www.rfc-editor.org/rfc/rfc9110", fetchImpl);
  assert.equal(page.title, "RFC 9110");
  assert.match(page.text, /HTTP semantics/);
  assert.equal(page.links.length, 1);
  assert.match(renderBrowsePage(page).join("\n"), /ϟ browse/);
  const rendered = await executeBrowseCommand("https://www.rfc-editor.org/rfc/rfc9110", fetchImpl);
  assert.match(rendered, /ϟ browse  https:\/\/www\.rfc-editor\.org\/rfc\/rfc9110/);
  assert.match(rendered, /RFC 9110/);
  await assert.rejects(() => executeBrowseCommand("https://example.com/x", fetchImpl), /not a reputable primary source/);
  await assert.rejects(() => browseReputablePage("https://example.com/x", fetchImpl), /not a reputable primary source/);
  assert.match(describeBrowseRefusal("https://example.com/x"), /not a reputable primary source/);
});

test("browse refuses redirects and non-text types, and snapshots oversize bodies", async () => {
  await assert.rejects(() => browseReputablePage("https://www.rfc-editor.org/rfc/rfc9110", async () => {
    throw new Error("redirect");
  }), /redirect/);
  await assert.rejects(() => browseReputablePage("https://www.rfc-editor.org/rfc/rfc9110", async () => ({
    status: 200,
    headers: { "content-type": "application/pdf" },
    bytes: new TextEncoder().encode("%PDF"),
  })), /HTML, Markdown, or plain text/);
  const huge = new Uint8Array(BROWSE_MAX_BYTES + 32);
  huge.fill(65);
  const page = await browseReputablePage("https://www.rfc-editor.org/rfc/rfc9110", async () => ({
    status: 200,
    headers: { "content-type": "text/plain" },
    bytes: huge,
  }));
  assert.equal(page.truncated, true);
  assert.equal(page.bytes, BROWSE_MAX_BYTES);
  assert.match(renderBrowsePage(page).join("\n"), /truncated/);
});
