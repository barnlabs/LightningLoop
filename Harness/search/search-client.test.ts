import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertNoConfiguredCredential } from "../core/credential-safety.js";
import { defaultProviderProfile, lightningLoopCredentialServices } from "../core/provider-profile.js";
import { SearchClient, captureSearchCredentials, isPublicAddress, parseDuckDuckGoHtml, type SourceTransport } from "./search-client.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
function source(body: string, contentType = "text/plain", status = 200): SourceTransport {
  return async () => ({ status, headers: { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) }, bytes: new TextEncoder().encode(body) });
}

test("Brave adapter uses the fixed endpoint and normalizes only web URLs", async () => {
  let requestedURL = "";
  let token = "";
  const fetcher: typeof fetch = async (input, init) => {
    requestedURL = String(input);
    token = new Headers(init?.headers).get("X-Subscription-Token") ?? "";
    return new Response(JSON.stringify({ web: { results: [
      { title: "Safe", url: "https://example.com/page", description: "Result" },
      { title: "Unsafe", url: "file:///etc/passwd", description: "Blocked" },
    ] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new SearchClient(fetcher, () => "test-credential");
  const response = await client.search("brave", "pi harness", 3);
  assert.equal(new URL(requestedURL).origin, "https://api.search.brave.com");
  assert.equal(token, "test-credential");
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.url, "https://example.com/page");
});

test("search input is bounded before credentials or network are touched", async () => {
  let credentialReads = 0;
  const client = new SearchClient(fetch, () => {
    credentialReads += 1;
    return "unused";
  });
  await assert.rejects(client.search("exa", "x".repeat(401)), /400-character/);
  assert.equal(credentialReads, 0);
});

test("captured environment research credentials are registered with durable-record safety", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-search-credential-"));
  const credential = "plain-captured-research-credential-86420";
  try {
    captureSearchCredentials({ EXA_API_KEY: credential });
    assert.throws(
      () => assertNoConfiguredCredential(
        [`Memory candidate ${credential}`],
        defaultProviderProfile(),
        () => undefined,
        join(directory, "missing-registry.json"),
      ),
      /Configured credential content/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("cross-provider runtime credentials are filtered from provider fields, opened evidence, and llms context", async () => {
  const selected = "exa-selected-runtime-credential-13579";
  const unselected = "brave-unselected-runtime-credential-24680";
  captureSearchCredentials({ BRAVE_SEARCH_API_KEY: unselected });
  let openedBody = `provider reflected ${unselected}`;
  let providerRequests = 0;
  const prior = process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
  const client = new SearchClient(
    async () => {
      providerRequests += 1;
      return new Response(JSON.stringify({ results: [{
        title: `unsafe ${unselected}`,
        url: "https://docs.example.com/evidence",
        highlights: [`unsafe ${unselected}`],
        publishedDate: unselected,
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    (service) => service.endsWith(".exa") ? selected : undefined,
    [],
    publicResolver,
    async (...args) => source(openedBody, "text/plain")(...args),
  );
  try {
    await assert.rejects(client.search("exa", `Do not send ${unselected}`, 1), /was not sent/);
    await assert.rejects(client.search("exa", `Do not send ${selected}`, 1), /was not sent/);
    assert.equal(providerRequests, 0);
    const response = await client.search("exa", "cross-provider runtime filtering", 1);
    assert.equal(response.results[0]?.title, "[REDACTED]");
    assert.equal(response.results[0]?.snippet, "[REDACTED]");
    assert.equal(response.results[0]?.publishedAt, "[REDACTED]");
    assert.equal(providerRequests, 1);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(unselected));
    assert.equal(await client.openSource("https://docs.example.com/evidence"), undefined);

    process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = "docs.example.com";
    openedBody = encodeURIComponent(encodeURIComponent(unselected));
    assert.equal(await client.documentationContext("https://docs.example.com/reference"), undefined);
  } finally {
    if (prior === undefined) delete process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
    else process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = prior;
  }
});

test("historical custom credentials are filtered and an unreadable catalog fails closed", async () => {
  const selectedService = "com.barnlabs.LightningLoop.search.firecrawl";
  const historicalService = "com.barnlabs.LightningLoop.provider.custom.old-lab.inference.example.com.apiKey";
  const selected = "selected-firecrawl-credential-11223";
  const historical = "historical-custom-credential-99887";
  const directory = mkdtempSync(join(tmpdir(), "lightningloop-historical-search-"));
  const registryPath = join(directory, "custom-credential-services.json");
  writeFileSync(registryPath, JSON.stringify([historicalService]), { mode: 0o600 });
  try {
    let networkRequests = 0;
    const client = new SearchClient(
      async () => {
        networkRequests += 1;
        return new Response(JSON.stringify({ id: historical, data: { web: [{
          title: historical,
          url: "https://docs.example.com/evidence",
          description: historical,
        }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      (service) => service === selectedService ? selected : service === historicalService ? historical : undefined,
      [],
      publicResolver,
      source(historical),
      {},
      () => lightningLoopCredentialServices(defaultProviderProfile(), registryPath),
    );
    await assert.rejects(client.search("firecrawl", `Never send ${historical}`, 1), /was not sent/);
    await assert.rejects(client.search("firecrawl", `Never send ${selected}`, 1), /was not sent/);
    assert.equal(networkRequests, 0);
    const response = await client.search("firecrawl", "historical filtering", 1);
    assert.equal(response.requestID, "[REDACTED]");
    assert.equal(response.results[0]?.title, "[REDACTED]");
    assert.equal(response.results[0]?.snippet, "[REDACTED]");
    assert.equal(await client.openSource("https://docs.example.com/evidence"), undefined);
    assert.equal(networkRequests, 1);

    writeFileSync(registryPath, "not-json", { mode: 0o600 });
    let failedClosedRequests = 0;
    const invalidCatalog = new SearchClient(
      async () => { failedClosedRequests += 1; return new Response("{}"); },
      () => selected,
      [],
      publicResolver,
      source("safe"),
      {},
      () => lightningLoopCredentialServices(defaultProviderProfile(), registryPath),
    );
    await assert.rejects(invalidCatalog.search("firecrawl", "must fail closed"), /registry is unreadable or malformed/);
    assert.equal(await invalidCatalog.openSource("https://docs.example.com/evidence"), undefined);
    assert.equal(failedClosedRequests, 0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("recognized secret-shaped research queries are rejected rather than rewritten or sent", async () => {
  let providerRequests = 0;
  const client = new SearchClient(
    async () => {
      providerRequests += 1;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    (service) => service.endsWith(".brave") ? "ordinary-selected-credential-445566" : undefined,
  );
  for (const query of [
    "api_key=abcdefghijklmnop",
    "Bearer abcdefghijklmnop",
    "csk-abcdefghijklmnop",
    "brave: abcdefghijklmnop",
  ]) {
    await assert.rejects(client.search("brave", query, 1), /was not sent/, query);
  }
  assert.equal(providerRequests, 0);
});

test("provider errors and results cannot reflect the configured credential", async () => {
  const reflected = "synthetic-credential-value-123456";
  const errorClient = new SearchClient(
    async () => new Response(JSON.stringify({ error: `bad key ${reflected}` }), { status: 401 }),
    () => reflected,
  );
  await assert.rejects(errorClient.search("exa", "test"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(reflected));
    return true;
  });

  const resultClient = new SearchClient(
    async () => new Response(JSON.stringify({ web: { results: [{ title: reflected, url: "https://example.com", description: reflected }] } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    () => reflected,
  );
  const response = await resultClient.search("brave", "test");
  assert.equal(response.results[0]?.title, "[REDACTED]");
  assert.equal(response.results[0]?.snippet, "[REDACTED]");
});

test("every provider rejects same-origin and cross-origin redirects without following them", async () => {
  const providerOrigins = {
    exa: "https://api.exa.ai",
    brave: "https://api.search.brave.com",
    firecrawl: "https://api.firecrawl.dev",
  } as const;
  for (const provider of ["exa", "brave", "firecrawl"] as const) {
    for (const location of [`${providerOrigins[provider]}/other`, "https://attacker.example/collect"] as const) {
      let redirectMode: RequestRedirect | undefined;
      const client = new SearchClient(async (_input, init) => {
        redirectMode = init?.redirect;
        return new Response(null, { status: 302, headers: { Location: location } });
      }, () => "synthetic-provider-credential");
      await assert.rejects(client.search(provider, "redirect test"), /rejected a redirect/);
      assert.equal(redirectMode, "error", `${provider} ${location}`);
    }
  }
});

test("provider JSON is strict-media-type, byte bounded, and subject to one absolute deadline", async () => {
  const wrongType = new SearchClient(
    async () => new Response("{}", { status: 200, headers: { "Content-Type": "text/plain; note=application/json" } }),
    () => "synthetic-provider-credential",
  );
  await assert.rejects(wrongType.search("brave", "wrong media"), /non-JSON/);

  const oversized = new SearchClient(
    async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "1048577" } }),
    () => "synthetic-provider-credential",
  );
  await assert.rejects(oversized.search("exa", "large"), /oversized/);

  const slowStream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
  });
  const slow = new SearchClient(
    async () => new Response(slowStream, { status: 200, headers: { "Content-Type": "application/json" } }),
    () => "synthetic-provider-credential",
    [],
    publicResolver,
    undefined,
    { providerDeadlineMS: 20 },
  );
  const startedAt = Date.now();
  await assert.rejects(slow.search("firecrawl", "slow drip"), /late JSON response/);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("all search adapters reject raw and repeatedly encoded credential URLs and sanitize provider fields before source opening", async () => {
  const credential = "synthetic-search-key/123456";
  const encoded = encodeURIComponent(encodeURIComponent(credential));
  const deeplyEncoded = Array.from({ length: 17 }).reduce<string>((value) => encodeURIComponent(value), credential);
  const responses: Record<"exa" | "brave" | "firecrawl", Record<string, unknown>> = {
    exa: {
      requestId: deeplyEncoded,
      results: [
        { title: credential, url: `https://example.com/path/${credential}`, highlights: [`evidence ${credential}`], publishedDate: credential },
        { title: credential, url: `https://example.com/search?key=${encoded}`, highlights: [encoded], publishedDate: encoded },
        { title: deeplyEncoded, url: `https://example.com/path/${deeplyEncoded}`, highlights: [deeplyEncoded], publishedDate: deeplyEncoded },
        { title: encoded, url: "https://example.com/safe?tracking=1#section", highlights: [encoded], publishedDate: encoded },
      ],
    },
    brave: {
      web: { results: [
        { title: credential, url: `https://example.com/search?token=${credential}`, description: encoded },
        { title: credential, url: `https://example.com/path/${encoded}`, description: credential },
        { title: encoded, url: "https://example.com/safe?tracking=1#section", description: credential },
      ] },
    },
    firecrawl: {
      id: encoded,
      data: { web: [
        { title: credential, url: `https://example.com/path/${credential}`, description: encoded },
        { title: credential, url: `https://example.com/search?key=${encoded}`, description: credential },
        { title: encoded, url: "https://example.com/safe?tracking=1#section", description: credential },
      ] },
    },
  };

  for (const provider of ["exa", "brave", "firecrawl"] as const) {
    let sourceOpens = 0;
    const client = new SearchClient(
      async () => new Response(JSON.stringify(responses[provider]), { status: 200, headers: { "Content-Type": "application/json" } }),
      () => credential,
      [],
      publicResolver,
      async (...args) => { sourceOpens += 1; return source("unexpected")(...args); },
    );
    const response = await client.search(provider, "safe query");
    // The reflected URL is dropped; the surviving URL has neither query nor
    // fragment, and every returned provider field is safe for model context.
    assert.equal(response.results.length, 1, provider);
    assert.equal(response.results[0]?.url, "https://example.com/safe", provider);
    assert.equal(response.results[0]?.title, "[REDACTED]", provider);
    assert.equal(response.results[0]?.snippet, "[REDACTED]", provider);
    if (provider === "exa") assert.equal(response.results[0]?.publishedAt, "[REDACTED]");
    if (provider === "exa" || provider === "firecrawl") assert.equal(response.requestID, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(response), new RegExp(credential), provider);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), provider);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(deeplyEncoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), provider);

    // A later automatic/open-source path sees the active credential too, so a
    // caller cannot reintroduce the provider's reflected URL after search.
    assert.equal(await client.openSource(`https://example.com/reopen/${credential}`), undefined, provider);
    assert.equal(await client.openSource(`https://example.com/reopen?key=${encoded}`), undefined, provider);
    assert.equal(sourceOpens, 0, provider);
  }
});

test("llms.txt retrieval is disabled by default and exact-host allowlisted", async () => {
  const prior = process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
  let requests = 0;
  const client = new SearchClient(fetch, () => "unused", ["docs.example.com"], publicResolver, async (...args) => {
    requests += 1;
    return source("# Documentation\nSafe bounded context", "text/plain")(...args);
  });
  try {
    delete process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
    assert.equal(await client.documentationContext("https://docs.example.com/reference"), undefined);
    assert.equal(requests, 0);
    process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = "docs.example.com";
    const context = await client.documentationContext("https://docs.example.com/reference");
    assert.equal(context?.url, "https://docs.example.com/llms.txt");
    assert.match(context?.text ?? "", /Documentation/);
    assert.equal(requests, 1);
    assert.equal(await client.documentationContext("https://attacker.example/"), undefined);
    assert.equal(requests, 1);
  } finally {
    if (prior === undefined) delete process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
    else process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = prior;
  }
});

test("opened sources are hash-preserved, classified, bounded, and use a pinned address", async () => {
  let pinnedAddress = "";
  const body = "# Official API\nCurrent bounded documentation.";
  const client = new SearchClient(fetch, () => "unused", ["docs.example.com"], publicResolver, async (_url, pinned, ...args) => {
    pinnedAddress = pinned.address;
    return source(body, "text/markdown; charset=utf-8")(_url, pinned, ...args);
  });
  const opened = await client.openSource("https://docs.example.com/reference");
  assert.equal(pinnedAddress, "93.184.216.34");
  assert.equal(opened?.url, "https://docs.example.com/reference");
  assert.equal(opened?.sourceClass, "official-or-primary-candidate");
  assert.match(opened?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.match(opened?.retrievedAt ?? "", /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(await client.openSource("http://docs.example.com/reference"), undefined);
  assert.equal(await client.openSource("https://127.0.0.1/reference"), undefined);

  const oversized = new SearchClient(fetch, () => "unused", [], publicResolver, async () => ({
    status: 200, headers: { "content-type": "text/plain", "content-length": "524289" }, bytes: new TextEncoder().encode("ignored"),
  }));
  assert.equal(await oversized.openSource("https://example.com/large"), undefined);
});

test("opened-source DNS resolution rejects loopback, RFC1918, link-local, special IPv6, mapped, and mixed answers before transport", async () => {
  const rejected = ["127.0.0.1", "10.0.0.1", "169.254.1.1", "240.0.0.1", "255.255.255.255", "::1", "fe80::1", "::ffff:127.0.0.1", "2001::1", "2002::1", "3fff::1"];
  for (const address of rejected) {
    let requests = 0;
    const resolver = async () => [{ address, family: address.includes(":") ? 6 as const : 4 as const }];
    const client = new SearchClient(fetch, () => "unused", [], resolver, async () => {
      requests += 1;
      return undefined;
    });
    assert.equal(await client.openSource("https://public.example.test/evidence"), undefined, address);
    assert.equal(requests, 0, address);
  }
  let requests = 0;
  const mixed = new SearchClient(fetch, () => "unused", [], async () => [
    { address: "93.184.216.34", family: 4 as const }, { address: "192.168.1.5", family: 4 as const },
  ], async () => { requests += 1; return undefined; });
  assert.equal(await mixed.openSource("https://public.example.test/evidence"), undefined);
  assert.equal(requests, 0);
});

test("special-use IPv6 ranges fail closed while globally-routable IPv6 is accepted", () => {
  for (const address of ["2001::1", "2001:2::1", "2002::1", "3fff::1", "::ffff:192.168.1.1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:4860::8888"), true);
  assert.equal(isPublicAddress("3fff:1000::1"), true);
});

test("opened-source DNS resolution permits public IPv4 plus ordinary global IPv6 and pins the selected address", async () => {
  let received = "";
  const client = new SearchClient(fetch, () => "unused", [], async () => [
    { address: "93.184.216.34", family: 4 as const }, { address: "2001:4860::8888", family: 6 as const },
  ], async (_url, pinned) => {
    received = pinned.address;
    return { status: 200, headers: { "content-type": "text/plain" }, bytes: new TextEncoder().encode("verified public evidence") };
  });
  assert.equal((await client.openSource("https://public.example.test/evidence"))?.text, "verified public evidence");
  assert.equal(received, "93.184.216.34");
});

test("opened evidence and llms context reject non-default HTTPS ports before resolution", async () => {
  let lookups = 0;
  const resolver = async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 as const }]; };
  const client = new SearchClient(fetch, () => "unused", [], resolver, source("safe"));
  assert.equal(await client.openSource("https://public.example.test:8443/evidence"), undefined);
  const prior = process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
  try {
    process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = "public.example.test";
    assert.equal(await client.documentationContext("https://public.example.test:8443/docs"), undefined);
  } finally {
    if (prior === undefined) delete process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
    else process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = prior;
  }
  assert.equal(lookups, 0);
});

test("opened evidence and llms.txt require an exact text media type", async () => {
  const prior = process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
  const client = new SearchClient(fetch, () => "unused", [], publicResolver, source("not text", "application/octet-stream; note=text/plain"));
  try {
    process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = "docs.example.com";
    assert.equal(await client.openSource("https://docs.example.com/evidence"), undefined);
    assert.equal(await client.documentationContext("https://docs.example.com/reference"), undefined);
  } finally {
    if (prior === undefined) delete process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
    else process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = prior;
  }
});

test("safe source URLs cannot return credential-bearing or malformed evidence bodies", async () => {
  const prior = process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
  const credential = "credential/without-a-recognizable-prefix-98765";
  const deeplyEncoded = Array.from({ length: 17 }).reduce<string>((value) => encodeURIComponent(value), credential);
  let openedBody = credential;
  const client = new SearchClient(
    async () => new Response(JSON.stringify({ web: { results: [{ title: "Safe", url: "https://docs.example.com/evidence", description: "Safe" }] } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }),
    () => credential,
    [],
    publicResolver,
    async (...args) => source(openedBody, "text/plain")(...args),
  );
  try {
    await client.search("brave", "activate credential filter");
    assert.equal(await client.openSource("https://docs.example.com/evidence"), undefined);
    openedBody = deeplyEncoded;
    assert.equal(await client.openSource("https://docs.example.com/evidence"), undefined);
    openedBody = "malformed percent escape %ZZ";
    assert.equal(await client.openSource("https://docs.example.com/evidence"), undefined);

    process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = "docs.example.com";
    openedBody = encodeURIComponent(encodeURIComponent(credential));
    assert.equal(await client.documentationContext("https://docs.example.com/reference"), undefined);
    openedBody = deeplyEncoded;
    assert.equal(await client.documentationContext("https://docs.example.com/reference"), undefined);
  } finally {
    if (prior === undefined) delete process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
    else process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = prior;
  }
});

test("opened source and llms.txt transports cannot exceed their absolute deadline", async () => {
  const prior = process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
  const neverReturns: SourceTransport = async () => new Promise(() => undefined);
  const client = new SearchClient(fetch, () => "unused", [], publicResolver, neverReturns, {
    sourceDeadlineMS: 20,
    documentationDeadlineMS: 20,
  });
  try {
    const sourceStarted = Date.now();
    assert.equal(await client.openSource("https://docs.example.com/evidence"), undefined);
    assert.ok(Date.now() - sourceStarted < 1_000);

    process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = "docs.example.com";
    const docsStarted = Date.now();
    assert.equal(await client.documentationContext("https://docs.example.com/reference"), undefined);
    assert.ok(Date.now() - docsStarted < 1_000);
  } finally {
    if (prior === undefined) delete process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST;
    else process.env.LIGHTNINGLOOP_LLMS_TXT_ALLOWLIST = prior;
  }
});

// A compact but representative DuckDuckGo HTML result page: a direct-URL result,
// a `/l/?uddg=` redirector result with an HTML entity in its title, a
// DuckDuckGo-internal ad link that must be dropped, and a result whose URL
// carries tracking query parameters.
const DUCKDUCKGO_FIXTURE = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main">
    <a rel="nofollow" class="result__a" href="https://rust-lang.org/">Rust Programming Language</a>
    <a class="result__snippet" href="https://rust-lang.org/"><b>Rust</b> is a fast, reliable <b>language</b>.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FRust&amp;rut=abc123">Rust &amp; Wikipedia</a>
    <a class="result__snippet" href="/l/?uddg=x">Encyclopedia entry about Rust.</a>
  </div>
</div>
<div class="result result--ad">
    <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Sponsored</a>
    <a class="result__snippet">Ad snippet</a>
</div>
<div class="result">
    <a rel="nofollow" class="result__a" href="https://example.com/page?utm=track&amp;ref=ddg">Example Domain</a>
    <a class="result__snippet">Example snippet without markup.</a>
</div>
`;

function htmlResponse(body: string, contentType = "text/html; charset=UTF-8", status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

test("parseDuckDuckGoHtml extracts direct + redirector URLs, decodes entities, and drops internal links", () => {
  const parsed = parseDuckDuckGoHtml(DUCKDUCKGO_FIXTURE);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { title: "Rust Programming Language", url: "https://rust-lang.org/", snippet: "Rust is a fast, reliable language." });
  assert.deepEqual(parsed[1], { title: "Rust & Wikipedia", url: "https://en.wikipedia.org/wiki/Rust", snippet: "Encyclopedia entry about Rust." });
  // Tracking query is preserved by the raw parser; the search gate strips it.
  assert.equal(parsed[2]?.url, "https://example.com/page?utm=track&ref=ddg");
  assert.equal(parseDuckDuckGoHtml("").length, 0);
});

test("free research needs no credential and normalizes every DuckDuckGo result", async () => {
  let method = "";
  let requestedURL = "";
  let body = "";
  let credentialReads = 0;
  const client = new SearchClient(
    async (input, init) => {
      requestedURL = String(input);
      method = init?.method ?? "GET";
      body = typeof init?.body === "string" ? init.body : "";
      return htmlResponse(DUCKDUCKGO_FIXTURE);
    },
    () => { credentialReads += 1; return undefined; },
  );
  const response = await client.search("free", "rust programming language", 5);
  assert.equal(method, "POST");
  assert.equal(new URL(requestedURL).origin, "https://html.duckduckgo.com");
  assert.match(body, /(?:^|&)q=rust\+programming\+language(?:&|$)/u);
  assert.equal(response.provider, "free");
  assert.equal(response.results.length, 3);
  assert.deepEqual(response.results.map((result) => result.url), [
    "https://rust-lang.org/",
    "https://en.wikipedia.org/wiki/Rust",
    "https://example.com/page", // query stripped by the URL safety gate
  ]);
  assert.equal(response.results[0]?.snippet, "Rust is a fast, reliable language.");
  assert.equal(response.results.every((result) => result.provider === "free"), true);
  // The credential filter still runs (defense in depth) but no key is required.
  assert.ok(credentialReads > 0);
});

test("free research redacts an ambient captured credential reflected in a result", async () => {
  const leaked = "free-ambient-research-credential-90210";
  captureSearchCredentials({ EXA_API_KEY: leaked });
  const client = new SearchClient(
    async () => htmlResponse(`
      <div class="result">
        <a rel="nofollow" class="result__a" href="https://example.org/leak">Leaky Result</a>
        <a class="result__snippet">Reflected ${leaked} inside the snippet.</a>
      </div>
    `),
    () => undefined,
  );
  const response = await client.search("free", "credential reflection", 3);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.snippet, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(response), new RegExp(leaked));
});

test("free research fails closed on non-HTML and on redirects", async () => {
  const jsonClient = new SearchClient(
    async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => undefined,
  );
  await assert.rejects(jsonClient.search("free", "non-html"), /non-HTML response/u);

  let redirectMode: RequestRedirect | undefined;
  const redirectClient = new SearchClient(async (_input, init) => {
    redirectMode = init?.redirect;
    return new Response(null, { status: 302, headers: { Location: "https://html.duckduckgo.com/elsewhere" } });
  }, () => undefined);
  await assert.rejects(redirectClient.search("free", "redirect"), /rejected a redirect/u);
  assert.equal(redirectMode, "error");
});

test("free research reaches DuckDuckGo live or skips cleanly without egress", async (t) => {
  const client = new SearchClient();
  let response;
  try {
    response = await client.search("free", "open source software foundation", 5);
  } catch (error) {
    t.skip(`DuckDuckGo egress unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  assert.equal(response.provider, "free");
  if (response.results.length === 0) {
    t.skip("DuckDuckGo returned no parseable results (anti-automation challenge)");
    return;
  }
  for (const result of response.results) {
    assert.match(result.url, /^https?:\/\/[^/]+\./u);
    assert.equal(result.provider, "free");
    assert.doesNotMatch(result.url, /duckduckgo\.com/u);
  }
});
