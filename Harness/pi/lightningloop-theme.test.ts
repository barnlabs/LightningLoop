import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  BRAND_OWNER,
  BRAND_TAGLINE,
  BRAND_WORDMARK,
  DISCOVERABLE_COMMANDS,
  FOOTER_HELP,
  PIPELINE_TAGLINE,
  brandIdentityLine,
  footerArtifactSegment,
  footerResearchSegment,
  invokedProductBin,
  renderBrandHeaderLines,
  renderDiscoverableHelp,
  renderStatusFooterLines,
  type BrandTheme,
  type FooterModel,
  type HeaderModel,
} from "./lightningloop-theme.js";

/** A plain-text theme so rendered snapshots are ANSI-free and deterministic. */
const plain: BrandTheme = { fg: (_name, text) => text, bold: (text) => text };

/** An ANSI-emitting theme used to prove the layout is color-independent. */
const ansi: BrandTheme = {
  fg: (_name, text) => `\u001b[36m${text}\u001b[0m`,
  bold: (text) => `\u001b[1m${text}\u001b[0m`,
};

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, "");

const headerModel: HeaderModel = {
  displayName: "OpenAI Codex",
  modelName: "GPT-5.6 Terra",
  runtimeManaged: true,
  preset: "openai-codex",
};

const footerModel: FooterModel = {
  displayName: "OpenAI Codex",
  executionEnabled: false,
  policyLabel: "WORKSPACE READ ONLY",
  workspaceLabel: "myproj",
  researchProvider: undefined,
  artifactWorkspace: false,
  artifactCommands: false,
};

test("header renders the coherent LightningLoop / BarnLabs brand band (plain-text snapshot)", () => {
  const lines = renderBrandHeaderLines(plain, headerModel, 120);
  assert.deepEqual(lines, [
    "━".repeat(120),
    "ϟ  LIGHTNINGLOOP  /  BARNLABS",
    BRAND_TAGLINE,
    "OpenAI Codex · GPT-5.6 Terra  research → engineer → verify",
    "Provider-neutral · authentication and model catalog managed by the LightningLoop runtime",
    "",
  ]);
  // Branding coherence: wordmark + owner present; never leaks the "Pi" runtime name.
  assert.ok(lines[1]?.includes(BRAND_WORDMARK) && lines[1]?.includes(BRAND_OWNER.trim()));
  assert.doesNotMatch(lines.join("\n"), /\bPi\b/u);
  assert.ok(lines[3]?.endsWith(PIPELINE_TAGLINE));
});

test("header names the invoked short bin without treating unknown argv as branding", () => {
  const lines = renderBrandHeaderLines(plain, { ...headerModel, invokedBin: "llp" }, 120);
  assert.match(lines[1]!, /LIGHTNINGLOOP  \/  BARNLABS  ·  llp$/u);
  assert.equal(invokedProductBin("/usr/local/bin/llp"), "llp");
  assert.equal(invokedProductBin("/opt/lloop"), "lloop");
  assert.equal(invokedProductBin("/tmp/dist/cli/index.js"), "lightningloop");
  assert.equal(invokedProductBin(undefined), "lightningloop");
});

test("discoverable help lists the first-run commands and refuses invented pricing", () => {
  const help = renderDiscoverableHelp();
  for (const command of DISCOVERABLE_COMMANDS) {
    assert.match(help, new RegExp(`^  ${command}\\b`, "mu"));
  }
  assert.match(help, /llp, lloop, and lightningloop/u);
  assert.match(help, /stdin, never argv/u);
  assert.match(help, /never invents a dollar amount/u);
  assert.match(help, /skills list\|enable\|disable/u);
  assert.doesNotMatch(help, /\bPi\b/u);
  assert.doesNotMatch(help, /\$\d/u);
});

test("header accent rule exactly fills the terminal width and truncates cleanly when narrow", () => {
  assert.equal(visibleWidth(renderBrandHeaderLines(plain, headerModel, 80)[0]!), 80);
  const narrow = renderBrandHeaderLines(plain, headerModel, 12);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 12, line);
});

test("header layout is color-independent (ANSI-stripped equals plain snapshot)", () => {
  const plainLines = renderBrandHeaderLines(plain, headerModel, 120);
  const ansiLines = renderBrandHeaderLines(ansi, headerModel, 120).map(stripAnsi);
  assert.deepEqual(ansiLines, plainLines);
});

test("brandIdentityLine covers every provider ownership branch", () => {
  assert.match(brandIdentityLine({ runtimeManaged: true, preset: "cerebras" }), /managed by the LightningLoop runtime/u);
  assert.match(brandIdentityLine({ runtimeManaged: false, preset: "generalcompute" }), /^GeneralCompute · LightningLoop-managed fixed provider/u);
  assert.match(brandIdentityLine({ runtimeManaged: false, preset: "openrouter" }), /free models via provider models --free$/u);
  assert.match(brandIdentityLine({ runtimeManaged: false, preset: "selection-required" }), /^Provider selection required/u);
  assert.match(brandIdentityLine({ runtimeManaged: false, preset: "custom" }), /credential stays in macOS Keychain$/u);
});

test("footer justifies policy + run state on a wide terminal and appends the help line", () => {
  const lines = renderStatusFooterLines(plain, footerModel, 100);
  assert.equal(lines.length, 2);
  const left = "● WORKSPACE READ ONLY  ·  myproj";
  const right = "OpenAI Codex  ·  research:off  ·  text-only  ·  /loop";
  assert.ok(lines[0]!.startsWith(left), lines[0]);
  assert.ok(lines[0]!.endsWith(right), lines[0]);
  assert.equal(visibleWidth(lines[0]!), 100);
  assert.equal(lines[1], FOOTER_HELP);
});

test("footer stacks its segments on a narrow terminal", () => {
  const lines = renderStatusFooterLines(plain, footerModel, 40);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "● WORKSPACE READ ONLY  ·  myproj");
  assert.equal(lines[1], truncateToWidth("OpenAI Codex  ·  research:off  ·  text-only  ·  /loop", 40));
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, line);
});

test("footer reflects execution, research, and artifact state", () => {
  const active: FooterModel = {
    displayName: "OpenAI Codex",
    executionEnabled: true,
    policyLabel: "CONFIRM EACH MUTATION",
    workspaceLabel: "myproj",
    researchProvider: "free",
    artifactWorkspace: true,
    artifactCommands: true,
  };
  const lines = renderStatusFooterLines(plain, active, 120);
  assert.match(lines[0]!, /● CONFIRM EACH MUTATION/u);
  assert.match(lines[0]!, /research:free/u);
  assert.match(lines[0]!, /artifacts\+verify/u);
});

test("footer segment helpers are exhaustive and stable", () => {
  assert.equal(footerResearchSegment(undefined), "research:off");
  assert.equal(footerResearchSegment("free"), "research:free");
  assert.equal(footerResearchSegment("exa"), "research:exa");
  assert.equal(footerArtifactSegment(false, false), "text-only");
  assert.equal(footerArtifactSegment(true, false), "artifacts");
  assert.equal(footerArtifactSegment(true, true), "artifacts+verify");
});

test("footer layout is color-independent (ANSI-stripped equals plain snapshot)", () => {
  const plainLines = renderStatusFooterLines(plain, footerModel, 100);
  const ansiLines = renderStatusFooterLines(ansi, footerModel, 100).map(stripAnsi);
  assert.deepEqual(ansiLines, plainLines);
});

test("footer help names the discoverable first commands", () => {
  assert.equal(FOOTER_HELP, "llp help · provider · key · skills · /loop <goal>");
  const lines = renderStatusFooterLines(plain, footerModel, 100);
  assert.equal(lines[1], FOOTER_HELP);
});

test("footer appends provider-reported usage and credit lines only when supplied", () => {
  const withUsage = renderStatusFooterLines(plain, {
    ...footerModel,
    usageLine: "ϟ 1,536 tok · ↑1,024 ↓512 · —",
    creditLine: "OpenRouter credit remaining: $6.50 · used $3.50",
  }, 100);
  assert.equal(withUsage.at(-2), "ϟ 1,536 tok · ↑1,024 ↓512 · —");
  assert.equal(withUsage.at(-1), "OpenRouter credit remaining: $6.50 · used $3.50");
  const without = renderStatusFooterLines(plain, footerModel, 100);
  assert.equal(without.some((line) => line.includes("$") || line.includes("tok")), false);
});
