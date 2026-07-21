import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_HTML_BYTES = 1_048_576;
const MAX_ASSET_BYTES = 16 * 1_048_576;
const DEFAULT_TTL_MS = 5 * 60_000;
const CSP = "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface BrowserArtifactServerOptions {
  workspace: string;
  sourcePath: string;
  expectedSHA256: string;
  ttlMs?: number;
  reviewedFiles?: readonly { path: string; sha256: string }[];
}

export interface BrowserArtifactServer {
  url: string;
  expiresAt: string;
  close(): Promise<void>;
}

function within(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").trim();
  const parts = normalized.split("/");
  if (!normalized || normalized.length > 240 || normalized.startsWith("/") || normalized.includes("\0")
      || parts.some((part) => !part || part.length > 120 || part === "." || part === ".." || /[\u0000-\u001f]/u.test(part))) {
    throw new Error("Browser artifact path must be a safe relative path.");
  }
  return parts.join("/");
}

async function rejectSymlinkComponents(root: string, path: string): Promise<void> {
  let current = root;
  for (const component of path.split("/")) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Browser artifact rejects symbolic-link path components: ${path}`);
  }
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": CSP,
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

export async function startBrowserArtifactServer(options: BrowserArtifactServerOptions): Promise<BrowserArtifactServer> {
  const requestedRoot = resolve(options.workspace);
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Browser artifact workspace must be a real directory.");
  const root = await realpath(requestedRoot);
  const sourcePath = safeRelativePath(options.sourcePath);
  if (extname(sourcePath).toLowerCase() !== ".html") throw new Error("Browser artifact serving is limited to HTML entry points.");
  if (!/^[a-f0-9]{64}$/u.test(options.expectedSHA256)) throw new Error("Browser artifact requires an exact SHA-256 hash.");
  const source = join(root, sourcePath);
  if (!within(root, source)) throw new Error("Browser artifact escaped the workspace.");
  await rejectSymlinkComponents(root, sourcePath);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.size < 1 || sourceInfo.size > MAX_HTML_BYTES) {
    throw new Error("Browser artifact HTML must be a bounded regular file.");
  }
  const canonicalSource = await realpath(source);
  if (!within(root, canonicalSource)) throw new Error("Browser artifact resolved outside the workspace.");
  const html = await readFile(canonicalSource);
  const actualHash = createHash("sha256").update(html).digest("hex");
  if (actualHash !== options.expectedSHA256) throw new Error("Browser artifact no longer matches the reviewed hash.");

  const token = randomBytes(24).toString("hex");
  const routeRoot = `/${token}/`;
  const assetRoot = dirname(canonicalSource);
  const assets = new Map<string, { body: Buffer; contentType: string }>();
  let totalAssetBytes = html.length;
  let assetCount = 0;
  for (const reviewed of options.reviewedFiles ?? []) {
    const reviewedPath = safeRelativePath(reviewed.path);
    if (!/^[a-f0-9]{64}$/u.test(reviewed.sha256)) throw new Error("Reviewed browser asset requires an exact SHA-256 hash.");
    const candidate = join(root, reviewedPath);
    if (candidate === canonicalSource || !within(assetRoot, candidate)) continue;
    await rejectSymlinkComponents(root, reviewedPath);
    const contentType = MIME[extname(candidate).toLowerCase()];
    if (!contentType || contentType.startsWith("text/html")) continue;
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > MAX_ASSET_BYTES) throw new Error(`Reviewed browser asset is not a bounded regular file: ${reviewedPath}`);
    const canonical = await realpath(candidate);
    if (!within(root, canonical) || !within(assetRoot, canonical)) throw new Error(`Reviewed browser asset escaped the reviewed directory: ${reviewedPath}`);
    const body = await readFile(canonical);
    if (createHash("sha256").update(body).digest("hex") !== reviewed.sha256) throw new Error(`Browser asset no longer matches its reviewed hash: ${reviewedPath}`);
    totalAssetBytes += body.length;
    assetCount += 1;
    if (assetCount > 128 || totalAssetBytes > 32 * 1_048_576) throw new Error("Browser artifact asset snapshot exceeds its bounded budget.");
    const key = relative(assetRoot, canonical).split(sep).join("/");
    assets.set(key, { body, contentType });
  }
  const ttlMs = Math.max(10_000, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, 15 * 60_000));
  const expiresAtMs = Date.now() + ttlMs;
  const server = createServer(async (request, response) => {
    try {
      if (Date.now() >= expiresAtMs) {
        response.writeHead(410, securityHeaders("text/plain; charset=utf-8"));
        response.end("Artifact link expired.");
        return;
      }
      const address = server.address();
      const expectedHost = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
      if (request.headers.host !== expectedHost || (request.method !== "GET" && request.method !== "HEAD") || !request.url?.startsWith(routeRoot)) {
        response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
        response.end("Not found.");
        return;
      }
      const rawAsset = request.url.slice(routeRoot.length).split("?", 1)[0] ?? "";
      const decoded = rawAsset ? decodeURIComponent(rawAsset) : "";
      const relativeAsset = decoded ? safeRelativePath(decoded) : "";
      const snapshot = decoded ? assets.get(relativeAsset) : { body: html, contentType: MIME[".html"]! };
      if (!snapshot) throw new Error("Asset is not in the immutable reviewed snapshot.");
      const { body, contentType } = snapshot;
      response.writeHead(200, { ...securityHeaders(contentType), "Content-Length": String(body.length) });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
      response.end("Not found.");
    }
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Browser artifact server did not receive an ephemeral port.");
  }
  const expiry = new Date(expiresAtMs).toISOString();
  const timer = setTimeout(() => void closeServer(server), ttlMs);
  timer.unref();
  return {
    url: `http://127.0.0.1:${address.port}${routeRoot}`,
    expiresAt: expiry,
    close: async () => { clearTimeout(timer); await closeServer(server); },
  };
}
