/**
 * Terminal browser for `llp browse` and the TUI `/browse` command.
 * Fetches one reputable HTTPS page with the same fail-closed gates as
 * opened research sources, then renders a bounded text snapshot.
 */
import { createHash } from "node:crypto";
import { assertReputableSourceUrl, classifySourceUrl, isReputableSourceUrl } from "./source-policy.js";

export const BROWSE_MAX_BYTES = 256_000;
export const BROWSE_DEADLINE_MS = 8_000;
export const BROWSE_TEXT_CHARS = 4_000;
export const BROWSE_MAX_LINKS = 12;

export interface BrowseFetchResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export type BrowseFetch = (
  url: URL,
  init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
) => Promise<BrowseFetchResponse>;

export interface BrowseLink {
  href: string;
  text: string;
}

export interface BrowsePage {
  url: string;
  title: string;
  text: string;
  contentType: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
  links: BrowseLink[];
}

function header(headers: Record<string, string>, name: string): string {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] ?? "") : "";
}

function mediaType(value: string): string | undefined {
  const type = value.split(";")[0]?.trim().toLowerCase();
  return type || undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'");
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const title = match ? stripTags(decodeHtml(match[1] ?? "")).slice(0, 160) : "";
  return title || "Untitled";
}

export function extractLinks(html: string, base: string): BrowseLink[] {
  const links: BrowseLink[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && links.length < BROWSE_MAX_LINKS) {
    let href: string;
    try { href = new URL(decodeHtml(match[1] ?? ""), base).href; }
    catch { continue; }
    if (!isReputableSourceUrl(href) || seen.has(href)) continue;
    seen.add(href);
    const text = stripTags(decodeHtml(match[2] ?? "")).slice(0, 80) || href;
    links.push({ href, text });
  }
  return links;
}

export function renderBrowsePage(page: BrowsePage): string[] {
  const lines = [
    `ϟ browse  ${page.url}`,
    `title     ${page.title}`,
    `type      ${page.contentType} · ${page.bytes} bytes${page.truncated ? " · truncated" : ""} · sha256 ${page.sha256}`,
    "",
    page.text,
  ];
  if (page.links.length > 0) {
    lines.push("", "reputable links");
    for (const link of page.links) lines.push(`  ${link.text} · ${link.href}`);
  }
  return lines;
}

const defaultFetch: BrowseFetch = async (url, init) => {
  const response = await fetch(url, { headers: init.headers, redirect: init.redirect, signal: init.signal });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return { status: response.status, headers, bytes };
};

export async function browseReputablePage(rawUrl: string, fetchImpl: BrowseFetch = defaultFetch): Promise<BrowsePage> {
  assertReputableSourceUrl(rawUrl, "Browse URL");
  const url = new URL(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROWSE_DEADLINE_MS);
  let response: BrowseFetchResponse;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "text/html, text/plain;q=0.9, text/markdown;q=0.8" },
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Browse failed closed: HTTP ${response.status}.`);
  }
  if (response.bytes.length < 1) throw new Error("Browse page was empty.");
  const truncated = response.bytes.length > BROWSE_MAX_BYTES;
  const bytes = truncated ? response.bytes.slice(0, BROWSE_MAX_BYTES) : response.bytes;
  const contentType = mediaType(header(response.headers, "content-type")) ?? "";
  if (!["text/html", "text/plain", "text/markdown"].includes(contentType)) {
    throw new Error("Browse accepts only HTML, Markdown, or plain text.");
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  if (!decoded) throw new Error("Browse page was empty.");
  const title = contentType === "text/html" ? extractTitle(decoded) : url.pathname.split("/").filter(Boolean).at(-1) || url.hostname;
  const text = (contentType === "text/html" ? stripTags(decoded) : decoded).slice(0, BROWSE_TEXT_CHARS);
  const links = contentType === "text/html" ? extractLinks(decoded, url.href) : [];
  return {
    url: url.href,
    title,
    text,
    contentType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    truncated,
    links,
  };
}

export function describeBrowseRefusal(rawUrl: string): string {
  return classifySourceUrl(rawUrl) === "rejected"
    ? "Refused: not a reputable primary source."
    : "Refused: browse failed closed.";
}
