/**
 * Pure, TTY-free formatters for token usage, provider-reported cost, and (when a
 * key is present) OpenRouter credit balance. Keeping these here — separate from
 * the CLI and the live Pi extension — lets the "magic"/lightning usage surface
 * be snapshot-tested deterministically (ANSI-stripped, no terminal).
 *
 * Invariant: cost is provider-reported evidence, never invented. When the
 * provider reports no cost we say so ("unavailable" / an em dash) rather than
 * fabricating a number.
 */
import type { AgentUsage } from "./loop-types.js";
import type { OpenRouterKeyCredits } from "./openrouter.js";

/** Group an integer with commas, locale-independent for stable snapshots. */
export function formatTokenCount(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  return safe.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/** Format a USD amount at provider cost granularity (4 decimals). */
export function formatUSD(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return `$${safe.toFixed(4)}`;
}

/** Format a wallet-style USD balance at 2 decimals (for credit/account figures). */
export function formatUSDWallet(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return `$${safe.toFixed(2)}`;
}

/** True only when the provider reported a positive cost we can trust. */
export function hasReportedCost(usage: Pick<AgentUsage, "cost">): boolean {
  return Number.isFinite(usage.cost) && usage.cost > 0;
}

/** The cost fragment for the final summary; never invents cost. */
export function formatCostFragment(usage: Pick<AgentUsage, "cost">): string {
  return hasReportedCost(usage) ? `Provider-reported cost: ${formatUSD(usage.cost)}` : "Cost: unavailable";
}

/**
 * A compact, single-line live usage meter for the TUI status bar and CLI stage
 * lines. Shows accumulating total tokens, the input/output split, and cost (an
 * em dash when the provider has reported none so far).
 */
export function formatLiveUsageMeter(usage: AgentUsage): string {
  const cost = hasReportedCost(usage) ? formatUSD(usage.cost) : "—";
  return `ϟ ${formatTokenCount(usage.total)} tok · ↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)} · ${cost}`;
}

/** The final run summary line: review count, token split, and provider cost. */
export function formatRunSummaryLine(input: { reviews: number; usage: AgentUsage }): string {
  const { reviews, usage } = input;
  return `Reviews: ${reviews} · Tokens: in ${formatTokenCount(usage.input)} · out ${formatTokenCount(usage.output)} · total ${formatTokenCount(usage.total)} · ${formatCostFragment(usage)}`;
}

/**
 * The OpenRouter credit line, shown only when a key resolved a balance. Displays
 * remaining credit when the account has a cap, or "unlimited" for an uncapped
 * key; always includes lifetime usage. Callers fall back to the run cost line
 * (which is always present) when no credit info is available.
 */
export function formatCreditLine(credits: OpenRouterKeyCredits): string {
  if (credits.remaining !== null) {
    return `OpenRouter credit remaining: ${formatUSDWallet(credits.remaining)} · used ${formatUSDWallet(credits.usage)}`;
  }
  return `OpenRouter credit: unlimited · used ${formatUSDWallet(credits.usage)}`;
}
