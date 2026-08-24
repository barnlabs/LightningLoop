/**
 * Pure, TTY-free builders for the LightningLoop TUI chrome (header band and
 * status footer). Keeping the string composition here — separate from the live
 * Pi extension wiring — lets the branding be snapshot-tested deterministically
 * (strip ANSI, no terminal) and keeps the theme coherent in one place.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ProviderPreset } from "../core/provider-profile.js";

/** The minimal theme surface the chrome needs: named foreground color + bold. */
export interface BrandTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface HeaderModel {
  displayName: string;
  modelName: string;
  /** True when the provider is LightningLoop-runtime managed (Pi `/login` path). */
  runtimeManaged: boolean;
  preset: ProviderPreset;
}

export interface FooterModel {
  displayName: string;
  executionEnabled: boolean;
  policyLabel: string;
  workspaceLabel: string;
  researchProvider?: string | undefined;
  artifactWorkspace: boolean;
  artifactCommands: boolean;
}

/** The wordmark shown on the header's brand line (single source of truth). */
export const BRAND_WORDMARK = "ϟ  LIGHTNINGLOOP";
export const BRAND_OWNER = "  /  BARNLABS";
/** The fixed pipeline shown next to the active model. */
export const PIPELINE_TAGLINE = "research → engineer → verify";
export const FOOTER_HELP = "Attach /image · set /research or /artifacts · run /loop <goal>";
/** Below this width the footer stacks its segments instead of justifying them. */
export const FOOTER_JUSTIFY_MIN_WIDTH = 68;

/** The one-line provider identity/credential-ownership statement. */
export function brandIdentityLine(model: Pick<HeaderModel, "runtimeManaged" | "preset">): string {
  if (model.runtimeManaged) {
    return "Provider-neutral · authentication and model catalog managed by the LightningLoop runtime";
  }
  if (model.preset === "generalcompute") {
    return "GeneralCompute · LightningLoop-managed fixed provider · Keychain or GENERALCOMPUTE_API_KEY";
  }
  if (model.preset === "openrouter") {
    return "OpenRouter · LightningLoop-managed · Keychain or OPENROUTER_API_KEY · free models via provider models --free";
  }
  if (model.preset === "selection-required") {
    return "Provider selection required · run lightningloop provider select";
  }
  return "Custom provider · credential stays in macOS Keychain";
}

/** Build the header band lines (accent rule, wordmark, model+pipeline, identity, spacer). */
export function renderBrandHeaderLines(theme: BrandTheme, model: HeaderModel, width: number): string[] {
  const rule = theme.fg("accent", "━".repeat(Math.max(1, width)));
  const brand = `${theme.bold(theme.fg("accent", BRAND_WORDMARK))}${theme.fg("dim", BRAND_OWNER)}`;
  const loop = `${theme.fg("muted", `${model.displayName} · ${model.modelName}`)}  ${theme.fg("dim", PIPELINE_TAGLINE)}`;
  const identity = theme.fg("dim", brandIdentityLine(model));
  return [
    truncateToWidth(rule, width),
    truncateToWidth(brand, width),
    truncateToWidth(loop, width),
    truncateToWidth(identity, width),
    "",
  ];
}

/** The research segment string for the footer (`research:free` / `research:off`). */
export function footerResearchSegment(provider: string | undefined): string {
  return provider ? `research:${provider}` : "research:off";
}

/** The artifact-mode segment string for the footer. */
export function footerArtifactSegment(workspace: boolean, commands: boolean): string {
  return workspace ? (commands ? "artifacts+verify" : "artifacts") : "text-only";
}

/** Build the status footer lines (policy + workspace on the left, run state on the right, help). */
export function renderStatusFooterLines(theme: BrandTheme, model: FooterModel, width: number): string[] {
  const left = `${theme.fg(model.executionEnabled ? "warning" : "success", `● ${model.policyLabel}`)}${theme.fg("dim", `  ·  ${model.workspaceLabel}`)}`;
  const research = footerResearchSegment(model.researchProvider);
  const artifacts = footerArtifactSegment(model.artifactWorkspace, model.artifactCommands);
  const right = theme.fg("muted", `${model.displayName}  ·  ${research}  ·  ${artifacts}  ·  /loop`);
  const help = theme.fg("dim", FOOTER_HELP);
  if (width >= FOOTER_JUSTIFY_MIN_WIDTH) {
    const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
    return [truncateToWidth(left + padding + right, width), truncateToWidth(help, width)];
  }
  return [truncateToWidth(left, width), truncateToWidth(right, width), truncateToWidth(help, width)];
}
