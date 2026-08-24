import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "./loop-types.js";
import type { OpenRouterKeyCredits } from "./openrouter.js";
import {
  formatCostFragment,
  formatCreditLine,
  formatLiveUsageMeter,
  formatRunSummaryLine,
  formatTokenCount,
  formatUSD,
  hasReportedCost,
} from "./usage-format.js";

// These formatters emit no ANSI themselves, but we strip defensively so the
// snapshots stay valid if a caller ever wraps them in color — mirroring the O5
// theme snapshot approach.
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, "");
const snapshot = (text: string): string => stripAnsi(text);

const usage = (input: number, output: number, cost: number): AgentUsage => ({ input, output, total: input + output, cost });

test("formatTokenCount groups thousands and floors non-finite/negative to zero", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(1234), "1,234");
  assert.equal(formatTokenCount(1234567), "1,234,567");
  assert.equal(formatTokenCount(-5), "0");
  assert.equal(formatTokenCount(Number.NaN), "0");
  assert.equal(formatTokenCount(2048.9), "2,048");
});

test("formatUSD renders four-decimal USD and clamps invalid amounts to $0.0000", () => {
  assert.equal(formatUSD(0.0123), "$0.0123");
  assert.equal(formatUSD(0), "$0.0000");
  assert.equal(formatUSD(-1), "$0.0000");
  assert.equal(formatUSD(Number.NaN), "$0.0000");
});

test("cost fragment never invents cost: reports it only when positive, else 'unavailable'", () => {
  assert.equal(hasReportedCost({ cost: 0 }), false);
  assert.equal(hasReportedCost({ cost: 0.0001 }), true);
  assert.equal(snapshot(formatCostFragment({ cost: 0 })), "Cost: unavailable");
  assert.equal(snapshot(formatCostFragment({ cost: 0.25 })), "Provider-reported cost: $0.2500");
});

test("live usage meter snapshots the accumulating tokens/cost with an em dash when cost is unreported", () => {
  assert.equal(
    snapshot(formatLiveUsageMeter(usage(1024, 512, 0.0123))),
    "ϟ 1,536 tok · ↑1,024 ↓512 · $0.0123",
  );
  assert.equal(
    snapshot(formatLiveUsageMeter(usage(2500, 1500, 0))),
    "ϟ 4,000 tok · ↑2,500 ↓1,500 · —",
  );
});

test("final run-summary formatter snapshots the token split and provider cost (CLI summary)", () => {
  assert.equal(
    snapshot(formatRunSummaryLine({ reviews: 3, usage: usage(12000, 3400, 0.4210) })),
    "Reviews: 3 · Tokens: in 12,000 · out 3,400 · total 15,400 · Provider-reported cost: $0.4210",
  );
  assert.equal(
    snapshot(formatRunSummaryLine({ reviews: 0, usage: usage(0, 0, 0) })),
    "Reviews: 0 · Tokens: in 0 · out 0 · total 0 · Cost: unavailable",
  );
});

test("credit line snapshots remaining/uncapped balances from a resolved key", () => {
  const capped: OpenRouterKeyCredits = { usage: 3.5, limit: 10, remaining: 6.5, isFreeTier: false };
  const uncapped: OpenRouterKeyCredits = { usage: 2.25, limit: null, remaining: null, isFreeTier: true };
  assert.equal(snapshot(formatCreditLine(capped)), "OpenRouter credit remaining: $6.50 · used $3.50");
  assert.equal(snapshot(formatCreditLine(uncapped)), "OpenRouter credit: unlimited · used $2.25");
});
