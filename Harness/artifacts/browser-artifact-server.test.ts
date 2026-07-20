import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startBrowserArtifactServer } from "./browser-artifact-server.js";

async function rawRequest(url: URL, method = "GET", host = url.host): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = request(url, { method, headers: { Host: host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.once("error", rejectPromise);
    outgoing.end();
  });
}

test("browser artifact server is tokenized, loopback-only, hash-bound, and CSP-confined", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-browser-artifact-"));
  const html = Buffer.from("<!doctype html><html><body><h1>Gold</h1></body></html>");
  await writeFile(join(workspace, "index.html"), html);
  const server = await startBrowserArtifactServer({
    workspace,
    sourcePath: "index.html",
    expectedSHA256: createHash("sha256").update(html).digest("hex"),
    ttlMs: 10_000,
  });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/u);
    assert.doesNotMatch(server.url, /index|html/u);
    const response = await fetch(server.url, { redirect: "error" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), html.toString("utf8"));
    assert.match(response.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/u);
    assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'none'/u);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  } finally {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("browser artifact server rejects stale hashes, links, traversal, and non-HTML entries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-browser-artifact-"));
  await writeFile(join(workspace, "index.html"), "<h1>Gold</h1>");
  await writeFile(join(workspace, "model.stl"), "solid model\nendsolid model\n");
  await symlink(join(workspace, "index.html"), join(workspace, "linked.html"));
  try {
    await assert.rejects(() => startBrowserArtifactServer({ workspace, sourcePath: "index.html", expectedSHA256: "0".repeat(64) }), /reviewed hash/u);
    await assert.rejects(() => startBrowserArtifactServer({ workspace, sourcePath: "../index.html", expectedSHA256: "0".repeat(64) }), /safe relative/u);
    await assert.rejects(() => startBrowserArtifactServer({ workspace, sourcePath: `${"a".repeat(121)}.html`, expectedSHA256: "0".repeat(64) }), /safe relative/u);
    await assert.rejects(() => startBrowserArtifactServer({ workspace, sourcePath: "bad\nname.html", expectedSHA256: "0".repeat(64) }), /safe relative/u);
    await assert.rejects(() => startBrowserArtifactServer({ workspace, sourcePath: "model.stl", expectedSHA256: "0".repeat(64) }), /limited to HTML/u);
    await assert.rejects(() => startBrowserArtifactServer({ workspace, sourcePath: "linked.html", expectedSHA256: "0".repeat(64) }), /symbolic-link/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("browser artifact server rejects hostile requests, unreviewed assets, expiry, and a closed link", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-browser-artifact-"));
  const html = Buffer.from("<!doctype html><html><body>Reviewed</body></html>");
  const allowedCSS = Buffer.from("body{color:green}");
  await writeFile(join(workspace, "index.html"), html);
  await writeFile(join(workspace, "allowed.css"), allowedCSS);
  await writeFile(join(workspace, "unreviewed.css"), "body{color:red}");
  const originalNow = Date.now;
  try {
    const server = await startBrowserArtifactServer({
      workspace,
      sourcePath: "index.html",
      expectedSHA256: createHash("sha256").update(html).digest("hex"),
      ttlMs: 10_000,
      reviewedFiles: [{ path: "allowed.css", sha256: createHash("sha256").update(allowedCSS).digest("hex") }],
    });
    const url = new URL(server.url);
    try {
      assert.equal((await rawRequest(url, "GET", "evil.invalid")).status, 404, "raw Host mismatches are rejected");
      assert.equal((await rawRequest(url, "POST")).status, 404, "POST is rejected");
      assert.equal((await rawRequest(new URL(`/${"0".repeat(48)}/`, url))).status, 404, "wrong capability token is rejected");
      assert.equal((await rawRequest(new URL("%2e%2e/index.html", url))).status, 404, "encoded traversal is rejected");
      assert.equal((await rawRequest(new URL("unreviewed.css", url))).status, 404, "unreviewed asset is rejected");
      const allowed = await rawRequest(new URL("allowed.css", url));
      assert.equal(allowed.status, 200, "reviewed allowlisted asset is served");
      assert.equal(allowed.body, allowedCSS.toString("utf8"));

      const now = originalNow();
      Date.now = () => now + 10_001;
      assert.equal((await rawRequest(url)).status, 410, "expired capability link is gone");
    } finally {
      Date.now = originalNow;
      await server.close();
    }
    await assert.rejects(() => rawRequest(url), /ECONNREFUSED|ECONNRESET|socket hang up/u, "closed server is not reachable");
  } finally {
    Date.now = originalNow;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("browser artifact responses are immutable after the reviewed snapshot is created", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-browser-artifact-"));
  const original = Buffer.from("<!doctype html><link rel=\"stylesheet\" href=\"style.css\"><h1>Reviewed</h1>");
  await writeFile(join(workspace, "index.html"), original);
  await writeFile(join(workspace, "style.css"), "h1{color:green}");
  const cssHash = createHash("sha256").update("h1{color:green}").digest("hex");
  const server = await startBrowserArtifactServer({
    workspace,
    sourcePath: "index.html",
    expectedSHA256: createHash("sha256").update(original).digest("hex"),
    ttlMs: 10_000,
    reviewedFiles: [{ path: "style.css", sha256: cssHash }],
  });
  try {
    await writeFile(join(workspace, "index.html"), "<h1>Changed</h1>");
    await writeFile(join(workspace, "style.css"), "h1{color:red}");
    assert.equal(await (await fetch(server.url)).text(), original.toString("utf8"));
    assert.equal(await (await fetch(new URL("style.css", server.url))).text(), "h1{color:green}");
  } finally {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
