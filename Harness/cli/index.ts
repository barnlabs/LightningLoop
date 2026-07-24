#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { main as runPi } from "@earendil-works/pi-coding-agent";
import { LoopEngine } from "../core/loop-engine.js";
import type { Clarification, LoopEvent } from "../core/loop-types.js";
import { scrubSensitiveEnvironment } from "../core/environment.js";
import { validatePiPassthrough } from "../core/pi-options.js";
import { terminalSafe } from "../core/terminal-output.js";
import { lightningLoopExtension } from "../pi/lightningloop-extension.js";
import { PiProviderAdapter } from "../pi/model-adapter.js";
import { captureSearchCredentials, SearchClient, type SearchProvider } from "../search/search-client.js";
import { runJsonlServer } from "../rpc/server.js";
import { callMcpServer, verifyMcpServer, type McpCallResult, type McpVerification } from "../mcp/client.js";
import { parseMcpManifest } from "../mcp/manifest.js";
import {
  isProviderSelectionRequired,
  loadProviderProfile,
  profileForPreset,
  providerCredentialService,
  saveProviderPreset,
  selectableProviderPresets,
  type SelectableProviderPreset,
} from "../core/provider-profile.js";
import { validateImagePaths } from "../core/image-input.js";
import { loadEligibleMemoryContext } from "../core/memory-store.js";
import { WorkspaceArtifactExecutor } from "../artifacts/workspace-artifact-executor.js";
import { startBrowserArtifactServer } from "../artifacts/browser-artifact-server.js";
import { artifactSeedsForGoal } from "../artifacts/builtin-artifact-seeds.js";
import { assertNoConfiguredCredential } from "../core/credential-safety.js";
import { lightningLoopDataPath } from "../core/platform-paths.js";
import { ManagedOverlay } from "../governance/managed-overlay.js";
import { DEFAULT_UPDATE_POLICY, updateChannelStatus } from "../update/update-policy.js";
import { dispatchNotification } from "../notifications/notification-dispatcher.js";

const SESSION_DIR = lightningLoopDataPath("harness-sessions");
const SHIPPED_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
const MANAGED_SKILLS_DIR = lightningLoopDataPath("managed", "current", "enabled-skills");

interface CliOptions {
  command: "tui" | "auth" | "provider" | "loop" | "search" | "mcp" | "harness" | "skills" | "update" | "artifact" | "serve" | "doctor" | "help";
  workspace: string;
  allowExecution: boolean;
  goal?: string;
  cycles: number;
  searchProvider?: SearchProvider;
  searchQuery?: string;
  searchLimit: number;
  researchProvider?: SearchProvider;
  imagePaths: string[];
  passthrough: string[];
  mcpAction?: "verify" | "call";
  mcpManifest?: string;
  mcpTool?: string;
  mcpInput?: string;
  approveManifest: boolean;
  approveArtifactWrites: boolean;
  approveVerificationCommands: boolean;
  harnessAction?: "status" | "backup" | "restore" | "reset";
  backupSlot: number;
  approveReset: boolean;
  approveRestore: boolean;
  artifactAction?: "serve";
  artifactSource?: string;
  artifactSHA256?: string;
  artifactManifestJSON?: string;
  skillAction?: "list" | "install" | "enable" | "disable";
  skillArgument?: string;
  approveSkillInstall: boolean;
  approveSkillEnableHash?: string;
  providerAction?: "list" | "select";
  providerArgument?: SelectableProviderPreset;
  doctorRuntimeOnly: boolean;
}

export function usage(): string {
  return `LightningLoop — Fast models. Ruthless review.

An independent BarnLabs open-source project.

Usage:
  llp | lloop | lightningloop [tui] [--workspace PATH] [--allow-execution] [-- RUNTIME_OPTIONS...]
  lightningloop auth
  lightningloop provider list
  lightningloop provider select <cerebras|groq|fireworks|xai|openai-codex|anthropic>
  lightningloop loop [GOAL] [--cycles 1-8] [--image PATH] [--research exa|brave|firecrawl]
    [--workspace EMPTY_DIR --approve-artifact-writes [--approve-verification-commands]]
  lightningloop search <exa|brave|firecrawl> QUERY [--limit 1-20]
  lightningloop mcp verify MANIFEST.json --workspace PATH --approve-manifest
  lightningloop mcp call MANIFEST.json TOOL --input PARAMS.json --workspace PATH --approve-manifest
  lightningloop harness status|backup|restore|reset [--slot 0-2] [--approve-restore|--approve-reset]
  lightningloop skills list|install|enable|disable [SOURCE_OR_ID] [--approve-skill-install|--approve-skill-enable HASH]
  lightningloop update check
  lightningloop artifact serve --workspace PATH --source RELATIVE.html --sha256 HASH [--manifest-json JSON]
  lightningloop serve
  lightningloop doctor [--runtime-only]
  lightningloop help

The TUI starts read-only. --allow-execution only makes mutation and shell requests eligible for an additional per-call confirmation.
Running llp or lloop with no arguments opens the interactive TUI.
The loop command is text-only by default. Artifact writes require an explicit empty directory and approval flag.
Verification commands additionally require --approve-verification-commands and run allowlisted programs in the network-denied OS sandbox.
MCP verification requires a versioned integrity manifest and an explicit approval flag for that exact invocation.
Provider sign-in uses the managed LightningLoop runtime. Run 'lightningloop auth', then use its /login command.
Choose a first-run provider with 'lightningloop provider list' and 'lightningloop provider select PRESET'.
LightningLoop never copies OAuth credentials into its own settings or managed overlay.`;
}

export function parse(args: string[]): CliOptions {
  let command: CliOptions["command"] = "tui";
  let workspace = process.cwd();
  let allowExecution = false;
  let cycles = 4;
  const goalParts: string[] = [];
  let searchProvider: SearchProvider | undefined;
  const searchQueryParts: string[] = [];
  let searchLimit = 5;
  let researchProvider: SearchProvider | undefined;
  const imagePaths: string[] = [];
  const passthrough: string[] = [];
  let mcpAction: CliOptions["mcpAction"];
  let mcpManifest: string | undefined;
  let mcpTool: string | undefined;
  let mcpInput: string | undefined;
  let approveManifest = false;
  let approveArtifactWrites = false;
  let approveVerificationCommands = false;
  let harnessAction: CliOptions["harnessAction"];
  let backupSlot = 0;
  let approveReset = false;
  let approveRestore = false;
  let artifactAction: CliOptions["artifactAction"];
  let artifactSource: string | undefined;
  let artifactSHA256: string | undefined;
  let artifactManifestJSON: string | undefined;
  let skillAction: CliOptions["skillAction"];
  let skillArgument: string | undefined;
  let approveSkillInstall = false;
  let approveSkillEnableHash: string | undefined;
  let providerAction: CliOptions["providerAction"];
  let providerArgument: SelectableProviderPreset | undefined;
  let doctorRuntimeOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "tui") command = "tui";
    else if (arg === "auth") command = "auth";
    else if (arg === "provider") command = "provider";
    else if (arg === "loop") command = "loop";
    else if (arg === "search") command = "search";
    else if (arg === "mcp") command = "mcp";
    else if (arg === "harness") command = "harness";
    else if (arg === "skills") command = "skills";
    else if (arg === "update") command = "update";
    else if (arg === "artifact") command = "artifact";
    else if (arg === "serve") command = "serve";
    else if (arg === "doctor") command = "doctor";
    else if (arg === "help" || arg === "--help" || arg === "-h") command = "help";
    else if (arg === "--allow-execution") allowExecution = true;
    else if (arg === "--approve-manifest") approveManifest = true;
    else if (arg === "--approve-artifact-writes") approveArtifactWrites = true;
    else if (arg === "--approve-verification-commands") approveVerificationCommands = true;
    else if (arg === "--approve-reset") approveReset = true;
    else if (arg === "--approve-restore") approveRestore = true;
    else if (arg === "--approve-skill-install") approveSkillInstall = true;
    else if (arg === "--runtime-only") doctorRuntimeOnly = true;
    else if (arg === "--approve-skill-enable") {
      const value = args[index + 1];
      if (!value || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("--approve-skill-enable requires the exact 64-character reviewed SHA-256 from skills list.");
      approveSkillEnableHash = value;
      index += 1;
    }
    else if (arg === "--slot") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value < 0 || value > 2) throw new Error("--slot must be 0, 1, or 2.");
      backupSlot = value;
      index += 1;
    }
    else if (arg === "--image") {
      const value = args[index + 1];
      if (!value) throw new Error("--image requires a path.");
      imagePaths.push(resolve(value));
      index += 1;
    }
    else if (arg === "--research") {
      const value = args[index + 1];
      if (value !== "exa" && value !== "brave" && value !== "firecrawl") throw new Error("--research must be exa, brave, or firecrawl.");
      researchProvider = value;
      index += 1;
    }
    else if (arg === "--input") {
      const value = args[index + 1];
      if (!value) throw new Error("--input requires a JSON file path.");
      mcpInput = resolve(value);
      index += 1;
    }
    else if (arg === "--cycles") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error("--cycles must be an integer from 1 through 8.");
      cycles = value;
      index += 1;
    } else if (arg === "--limit") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error("--limit must be an integer from 1 through 20.");
      searchLimit = value;
      index += 1;
    }
    else if (arg === "--workspace") {
      const value = args[index + 1];
      if (!value) throw new Error("--workspace requires a path.");
      workspace = resolve(value);
      index += 1;
    } else if (arg === "--source") {
      const value = args[index + 1];
      if (!value) throw new Error("--source requires a relative HTML path.");
      artifactSource = value;
      index += 1;
    } else if (arg === "--sha256") {
      const value = args[index + 1];
      if (!value) throw new Error("--sha256 requires a reviewed artifact hash.");
      artifactSHA256 = value;
      index += 1;
    } else if (arg === "--manifest-json") {
      const value = args[index + 1];
      if (!value || value.length > 65_536) throw new Error("--manifest-json requires bounded reviewed file evidence.");
      artifactManifestJSON = value;
      index += 1;
    } else if (arg === "--") {
      passthrough.push(...validatePiPassthrough(args.slice(index + 1)));
      break;
    } else if (command === "loop" && !arg.startsWith("--")) {
      goalParts.push(arg);
    } else if (command === "search" && !arg.startsWith("--")) {
      if (!searchProvider) {
        if (arg !== "exa" && arg !== "brave" && arg !== "firecrawl") throw new Error("Search provider must be exa, brave, or firecrawl.");
        searchProvider = arg;
      } else {
        searchQueryParts.push(arg);
      }
    } else if (command === "mcp" && !arg.startsWith("--")) {
      if (!mcpAction) {
        if (arg !== "verify" && arg !== "call") throw new Error("The supported MCP actions are verify and call.");
        mcpAction = arg;
      } else if (!mcpManifest) {
        mcpManifest = resolve(arg);
      } else if (mcpAction === "call" && !mcpTool) {
        mcpTool = arg;
      } else {
        throw new Error("MCP command contains too many positional arguments.");
      }
    } else if (command === "harness" && !arg.startsWith("--")) {
      if (harnessAction || !["status", "backup", "restore", "reset"].includes(arg)) throw new Error("Harness action must be status, backup, restore, or reset.");
      harnessAction = arg as CliOptions["harnessAction"];
    } else if (command === "skills" && !arg.startsWith("--")) {
      if (!skillAction) {
        if (!["list", "install", "enable", "disable"].includes(arg)) throw new Error("Skill action must be list, install, enable, or disable.");
        skillAction = arg as CliOptions["skillAction"];
      } else if (!skillArgument) {
        skillArgument = arg;
      } else throw new Error("Skill command contains too many positional arguments.");
    } else if (command === "provider" && !arg.startsWith("--")) {
      if (!providerAction) {
        if (arg !== "list" && arg !== "select") throw new Error("Provider action must be list or select.");
        providerAction = arg;
      } else if (providerAction === "select" && !providerArgument) {
        if (!selectableProviderPresets.includes(arg as SelectableProviderPreset)) {
          throw new Error(`Provider preset must be one of: ${selectableProviderPresets.join(", ")}.`);
        }
        providerArgument = arg as SelectableProviderPreset;
      } else {
        throw new Error("Provider command contains too many positional arguments.");
      }
    } else if (command === "update" && !arg.startsWith("--")) {
      if (arg !== "check") throw new Error("The only enabled update action is check; installation remains disabled until a signed release channel exists.");
    } else if (command === "artifact" && !arg.startsWith("--")) {
      if (arg !== "serve" || artifactAction) throw new Error("Artifact action must be serve.");
      artifactAction = "serve";
    } else {
      throw new Error(`Unknown LightningLoop option: ${arg}. Put runtime options after --.`);
    }
  }
  const goal = goalParts.join(" ").trim();
  const searchQuery = searchQueryParts.join(" ").trim();
  if (doctorRuntimeOnly && command !== "doctor") throw new Error("--runtime-only is valid only with doctor.");
  return {
    command,
    workspace,
    allowExecution,
    ...(goal ? { goal } : {}),
    cycles,
    ...(searchProvider ? { searchProvider } : {}),
    ...(searchQuery ? { searchQuery } : {}),
    searchLimit,
    ...(researchProvider ? { researchProvider } : {}),
    imagePaths,
    passthrough,
    ...(mcpAction ? { mcpAction } : {}),
    ...(mcpManifest ? { mcpManifest } : {}),
    ...(mcpTool ? { mcpTool } : {}),
    ...(mcpInput ? { mcpInput } : {}),
    approveManifest,
    approveArtifactWrites,
    approveVerificationCommands,
    ...(harnessAction ? { harnessAction } : {}),
    backupSlot,
    approveReset,
    approveRestore,
    ...(artifactAction ? { artifactAction } : {}),
    ...(artifactSource ? { artifactSource } : {}),
    ...(artifactSHA256 ? { artifactSHA256 } : {}),
    ...(artifactManifestJSON ? { artifactManifestJSON } : {}),
    ...(skillAction ? { skillAction } : {}),
    ...(skillArgument ? { skillArgument } : {}),
    approveSkillInstall,
    ...(approveSkillEnableHash ? { approveSkillEnableHash } : {}),
    ...(providerAction ? { providerAction } : {}),
    ...(providerArgument ? { providerArgument } : {}),
    doctorRuntimeOnly,
  };
}

function runSkillGovernance(options: CliOptions): void {
  const overlay = new ManagedOverlay();
  const action = options.skillAction ?? "list";
  if (action === "install") {
    if (!options.skillArgument) throw new Error("Skill install requires a local source directory.");
    overlay.installSkill(resolve(options.skillArgument), options.approveSkillInstall ? "INSTALL-MANAGED-SKILL" : "");
  } else if (action === "enable" || action === "disable") {
    if (!options.skillArgument) throw new Error(`Skill ${action} requires an installed skill ID.`);
    overlay.setSkillEnabled(options.skillArgument, action === "enable", options.approveSkillEnableHash ?? "");
  }
  const skills = overlay.listSkills();
  process.stdout.write("LightningLoop managed skills\n");
  for (const skill of skills) process.stdout.write(`  ${skill.enabled ? "ENABLED" : "DISABLED"} ${terminalSafe(skill.id)} · sha256 ${skill.sha256}\n`);
  if (skills.length === 0) process.stdout.write("  No managed skills installed. Shipped project skills are unchanged.\n");
  process.stdout.write("  Provider runtime packages/settings changed: NO\n");
}

async function runArtifactHandoff(options: CliOptions): Promise<void> {
  if (options.artifactAction !== "serve" || !options.artifactSource || !options.artifactSHA256) {
    throw new Error("Usage: lightningloop artifact serve --workspace PATH --source RELATIVE.html --sha256 HASH");
  }
  let reviewedFiles: Array<{ path: string; sha256: string }> = [];
  if (options.artifactManifestJSON) {
    const parsed = JSON.parse(options.artifactManifestJSON) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 128 || parsed.some((item) => typeof item !== "object" || item === null || typeof (item as { path?: unknown }).path !== "string" || typeof (item as { sha256?: unknown }).sha256 !== "string")) {
      throw new Error("Artifact manifest must be an array of at most 128 path/SHA-256 records.");
    }
    reviewedFiles = parsed as Array<{ path: string; sha256: string }>;
  }
  const server = await startBrowserArtifactServer({
    workspace: options.workspace,
    sourcePath: options.artifactSource,
    expectedSHA256: options.artifactSHA256,
    reviewedFiles,
  });
  process.stdout.write(`${JSON.stringify({ url: server.url, expiresAt: server.expiresAt })}\n`);
  await new Promise<void>((resolvePromise) => {
    const expiryTimer = setTimeout(() => void server.close().finally(resolvePromise), 5 * 60_000);
    const finish = (): void => { clearTimeout(expiryTimer); void server.close().finally(resolvePromise); };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    process.stdin.once("end", finish);
  });
}

function runHarnessGovernance(options: CliOptions): void {
  const overlay = new ManagedOverlay();
  const action = options.harnessAction ?? "status";
  if (action === "backup") overlay.backup();
  else if (action === "restore") {
    if (!options.approveRestore) throw new Error("Managed restore is blocked until --approve-restore is supplied for the selected backup slot.");
    overlay.restore(options.backupSlot);
  }
  else if (action === "reset") {
    if (!options.approveReset) throw new Error("Managed reset is blocked until --approve-reset is supplied. A rotating backup is created first.");
    overlay.reset("RESET-MANAGED-OVERLAY");
  }
  const status = overlay.status();
  process.stdout.write(`LightningLoop managed harness · ${action}\n`);
  process.stdout.write(`  Root: ${terminalSafe(status.root)}\n`);
  process.stdout.write(`  Current: ${status.current.files.length} files · ${status.current.totalBytes} bytes\n`);
  for (const backup of status.backups) process.stdout.write(`  Backup ${backup.slot}: ${backup.snapshot ? `${backup.snapshot.files.length} files · ${backup.snapshot.totalBytes} bytes` : "empty"}\n`);
  process.stdout.write("  Provider runtime auth/settings changed: NO\n");
}

async function runMcp(options: CliOptions): Promise<void> {
  if (!options.mcpAction || !options.mcpManifest) throw new Error("Usage: lightningloop mcp <verify|call> MANIFEST.json [TOOL --input PARAMS.json] --workspace PATH --approve-manifest");
  if (!options.approveManifest) throw new Error("MCP launch is blocked until --approve-manifest is supplied for this exact manifest invocation.");
  const encoded = await readFile(options.mcpManifest);
  if (encoded.length > 262_144) throw new Error("MCP manifest exceeds 256 KiB.");
  const manifest = parseMcpManifest(JSON.parse(encoded.toString("utf8")) as unknown);
  const workspace = realpathSync(options.workspace);
  let callResult: McpCallResult | undefined;
  const result: McpVerification = options.mcpAction === "call"
    ? (callResult = await callMcpServer(manifest, workspace, options.mcpTool ?? "", await readMcpInput(options.mcpInput)))
    : await verifyMcpServer(manifest, workspace);
  process.stdout.write(`MCP verified in the LightningLoop OS sandbox\n`);
  process.stdout.write(`  Server: ${terminalSafe(result.serverName)} ${terminalSafe(result.serverVersion)}\n`);
  process.stdout.write(`  Protocol: ${terminalSafe(result.protocolVersion)}\n`);
  process.stdout.write(`  Tools: ${result.tools.map(terminalSafe).join(", ") || "(none)"}\n`);
  process.stdout.write(`  Network domains: ${manifest.allowedDomains.length}\n`);
  process.stdout.write(`  Workspace write: ${manifest.workspaceWrite ? "ALLOWED BY THIS MANIFEST" : "DENIED"}\n`);
  if (callResult) {
    process.stdout.write(`  Call status: ${callResult.isError ? "ERROR" : "SUCCESS"}\n`);
    process.stdout.write(`\n${terminalSafe(callResult.output)}\n`);
    if (callResult.isError) process.exitCode = 2;
  }
}

async function readMcpInput(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) throw new Error("MCP call requires --input PARAMS.json.");
  const encoded = await readFile(path);
  if (encoded.length > 262_144) throw new Error("MCP input exceeds 256 KiB.");
  const value = JSON.parse(encoded.toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("MCP input must be a JSON object.");
  return value as Record<string, unknown>;
}

function keychainConfigured(service: string): boolean {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return result.status === 0;
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) return false;
  const major = Number.parseInt(match[1] ?? "0", 10);
  const minor = Number.parseInt(match[2] ?? "0", 10);
  return major > 22 || (major === 22 && minor >= 19);
}

export async function doctor(runtimeOnly = false): Promise<number> {
  const profile = loadProviderProfile();
  const nodeOK = isSupportedNodeVersion(process.version);
  const selectionRequired = isProviderSelectionRequired(profile);
  const piManaged = !selectionRequired && Boolean(profile.piProviderID);
  const keychainCredential = !selectionRequired && !piManaged && process.platform === "darwin" && keychainConfigured(providerCredentialService(profile));
  process.stdout.write("LightningLoop doctor\n");
  process.stdout.write(`  Node >=22.19: ${nodeOK ? "PASS" : "FAIL"} (${process.version})\n`);
  process.stdout.write(selectionRequired
    ? "  Active provider: SELECTION REQUIRED · run 'lightningloop provider list' then 'lightningloop provider select PRESET'\n"
    : `  Active provider: ${terminalSafe(profile.displayName)} · ${terminalSafe(profile.modelID)}\n`);
  process.stdout.write(`  Provider sign-in: ${piManaged ? "MANAGED BY RUNTIME/UNKNOWN" : "NOT APPLICABLE"}\n`);
  const researchStatus = (environmentName: string, service: string): string => process.env[environmentName]?.trim()
    || keychainConfigured(service) ? "CONFIGURED" : "MISSING";
  process.stdout.write(`  Exa research credential: ${researchStatus("EXA_API_KEY", "com.barnlabs.LightningLoop.search.exa")}\n`);
  process.stdout.write(`  Brave research credential: ${researchStatus("BRAVE_SEARCH_API_KEY", "com.barnlabs.LightningLoop.search.brave")}\n`);
  process.stdout.write(`  Firecrawl research credential: ${researchStatus("FIRECRAWL_API_KEY", "com.barnlabs.LightningLoop.search.firecrawl")}\n`);
  process.stdout.write("  Default workspace-tool policy: READ-ONLY\n");
  process.stdout.write("  Credential values displayed: NEVER\n");
  if (runtimeOnly) process.stdout.write("  Install/runtime-only health: provider onboarding is reported but does not fail installation\n");
  // `doctor` verifies local prerequisites. It never probes Pi credentials;
  // Pi owns their status and reports an auth failure only during its own run.
  return runtimeOnly ? (nodeOK ? 0 : 1) : (nodeOK && !selectionRequired && (piManaged || keychainCredential) ? 0 : 1);
}

function runProviderCommand(options: CliOptions): void {
  const action = options.providerAction ?? "list";
  if (action === "select") {
    if (!options.providerArgument) throw new Error("Provider select requires a reviewed preset.");
    const selected = saveProviderPreset(options.providerArgument);
    process.stdout.write(`Selected ${terminalSafe(selected.displayName)} · ${terminalSafe(selected.modelName)}\n`);
    process.stdout.write("Credential stored by LightningLoop: NO. Use 'lightningloop auth' to start provider sign-in.\n");
    return;
  }
  process.stdout.write("LightningLoop provider presets\n");
  for (const preset of selectableProviderPresets) {
    const profile = profileForPreset(preset);
    process.stdout.write(`  ${preset} · ${terminalSafe(profile.displayName)} · ${terminalSafe(profile.modelName)}\n`);
  }
  process.stdout.write("Select with: lightningloop provider select PRESET\n");
}

async function runSearch(options: CliOptions): Promise<void> {
  if (!options.searchProvider || !options.searchQuery) throw new Error("Search requires a provider and query.");
  const response = await new SearchClient().search(options.searchProvider, options.searchQuery, options.searchLimit);
  process.stdout.write(`LightningLoop search · ${response.provider} · ${response.results.length} result${response.results.length === 1 ? "" : "s"}\n`);
  for (const [index, result] of response.results.entries()) {
    process.stdout.write(`\n${index + 1}. ${terminalSafe(result.title)}\n   ${terminalSafe(result.url)}\n   ${terminalSafe(result.snippet)}\n`);
  }
  if (response.estimatedCost !== undefined) process.stdout.write(`\nProvider-reported estimated cost: $${response.estimatedCost.toFixed(4)}\n`);
  if (response.creditsUsed !== undefined) process.stdout.write(`\nProvider-reported credits used: ${response.creditsUsed}\n`);
}

async function runTUI(options: CliOptions): Promise<void> {
  const profile = loadProviderProfile();
  if (isProviderSelectionRequired(profile)) {
    process.stdout.write("LightningLoop first run: choose a provider before opening the TUI.\n");
    process.stdout.write("  lightningloop provider list\n");
    process.stdout.write("  lightningloop provider select PRESET\n");
    process.stdout.write("No credential has been read or stored. After selection, run llp again.\n");
    process.exitCode = 2;
    return;
  }
  const workspace = realpathSync(options.workspace);
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SESSION_DIR, 0o700);
  process.chdir(workspace);
  // Pi otherwise downloads the latest fd/rg release at startup without a
  // repository-pinned checksum. LightningLoop keeps runtime acquisition offline.
  process.env.PI_OFFLINE = "1";
  captureSearchCredentials(process.env);
  scrubSensitiveEnvironment(process.env);

  // Mutations flow only through the OS-sandboxed bash override. Pi's in-process
  // write/edit tools are intentionally excluded because a confirmation dialog
  // alone is not an isolation boundary.
  const tools = options.allowExecution ? "read,grep,find,ls,bash" : "read,grep,find,ls";
  const args = [
    "--provider",
    profile.piProviderID ?? `lightningloop-${profile.id}`,
    "--model",
    profile.modelID,
    "--session-dir",
    SESSION_DIR,
    "--tools",
    tools,
    "--no-extensions",
    "--no-skills",
    ...(existsSync(SHIPPED_SKILLS_DIR) ? ["--skill", SHIPPED_SKILLS_DIR] : []),
    ...(existsSync(MANAGED_SKILLS_DIR) ? ["--skill", MANAGED_SKILLS_DIR] : []),
    "--no-prompt-templates",
    ...(options.allowExecution ? ["--lightningloop-execution"] : []),
    ...options.passthrough,
  ];

  await runPi(args, { extensionFactories: [{ name: "lightningloop", factory: lightningLoopExtension }] });
}

async function runAuth(options: CliOptions): Promise<void> {
  const workspace = realpathSync(options.workspace);
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  process.chdir(workspace);
  process.env.PI_OFFLINE = "1";
  scrubSensitiveEnvironment(process.env);
  process.stdout.write("LightningLoop starts the provider sign-in flow. Use /login, choose OpenAI Codex, Anthropic, or xAI, and complete the provider's browser/device flow. Use /logout to revoke a provider credential.\n");
  await runPi(["--session-dir", SESSION_DIR, "--tools", "read", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]);
}

function renderEvent(event: LoopEvent): void {
  const round = event.round ? ` · round ${event.round}` : "";
  process.stdout.write(`\n[${event.stage}${round}] ${terminalSafe(event.message)}\n`);
}

type Questioner = (prompt: string) => Promise<string>;

async function collectAnswers(clarification: Clarification, ask: Questioner): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  process.stdout.write(`\nOrchestrator interpretation: ${terminalSafe(clarification.summary)}\n`);
  for (const question of clarification.questions) {
    process.stdout.write(`\n${terminalSafe(question.id)}. ${terminalSafe(question.question)}\n   Why: ${terminalSafe(question.whyItMatters)}\n`);
    const answer = (await ask("   Answer: ")).trim();
    if (!answer) throw new Error(`An answer is required for ${question.id}.`);
    answers[question.id] = answer;
  }
  return answers;
}

async function runLoop(options: CliOptions): Promise<void> {
  const pipedLines: string[] = [];
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    pipedLines.push(...input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask: Questioner = async (prompt) => {
    if (terminal) return terminal.question(prompt);
    const answer = pipedLines.shift();
    if (answer === undefined) throw new Error("Not enough piped answers were supplied for the clarifying questions.");
    process.stdout.write(`${prompt}${answer}\n`);
    return answer;
  };
  try {
    const goal = options.goal || (await ask("What outcome should LightningLoop produce? ")).trim();
    if (!goal) throw new Error("A goal is required.");

    const profile = loadProviderProfile();
    if (isProviderSelectionRequired(profile)) {
      throw new Error("Provider selection is required. Run 'lightningloop provider list' then 'lightningloop provider select PRESET'.");
    }
    if (options.approveVerificationCommands && !options.approveArtifactWrites) {
      throw new Error("--approve-verification-commands requires --approve-artifact-writes.");
    }
    const images = await validateImagePaths(options.imagePaths);
    const artifactExecutor = options.approveArtifactWrites
      ? await WorkspaceArtifactExecutor.create(
          realpathSync(options.workspace),
          options.approveVerificationCommands,
          await artifactSeedsForGoal(goal, images),
        )
      : undefined;
    process.stdout.write("\nϟ LightningLoop · Fast models. Ruthless review.\n");
    process.stdout.write(`BarnLabs · ${terminalSafe(profile.displayName)} / ${terminalSafe(profile.modelName)}\n`);
    process.stdout.write(artifactExecutor
      ? `Mode: reviewed workspace artifacts · ${artifactExecutor.allowVerificationCommands ? "sandboxed verification approved" : "commands disabled"}\nOutput: ${terminalSafe(realpathSync(options.workspace))}\n`
      : "Mode: complete text-deliverable loop · workspace writes and commands disabled\n");
    const search = options.researchProvider ? new SearchClient() : undefined;
    const memories = loadEligibleMemoryContext();
    assertNoConfiguredCredential(memories, profile);
    const engine = new LoopEngine(await PiProviderAdapter.create(profile), {
      images,
      memories,
      ...(artifactExecutor ? { artifactExecutor } : {}),
      ...(options.researchProvider && search ? {
        research: {
          provider: options.researchProvider,
          search: async (query: string) => (await search.search(options.researchProvider!, query, 5)).results,
          documentationContext: async (url: string) => search.documentationContext(url),
          openSource: async (url: string) => search.openSource(url),
        },
      } : {}),
    });
    process.stdout.write("\n[clarifying] Orchestrator is defining the decision boundary.\n");
    const clarification = await engine.clarify(goal);
    const answers = await collectAnswers(clarification, ask);
    const result = await engine.execute(goal, clarification, answers, options.cycles, renderEvent);

    process.stdout.write(`\n=== ${result.stage.toUpperCase()} ===\n${result.message}\n`);
    const cost = result.usage.cost > 0 ? ` · Provider-reported cost: $${result.usage.cost.toFixed(4)}` : " · Cost: unavailable";
    process.stdout.write(`Reviews: ${result.reviews.length} · Tokens: ${result.usage.total}${cost}\n`);
    if (result.implementation.deliverable) process.stdout.write(`\n${terminalSafe(result.implementation.deliverable)}\n`);
    if (result.artifactReport) {
      process.stdout.write(`\nEvidence Lab: ${result.artifactReport.passed ? "PASS" : "FAIL"}\n`);
      for (const preview of result.artifactReport.previews) {
        const localhost = preview.loopback ? ` · HTTP ${preview.loopback.status} ${preview.loopback.host}` : "";
        process.stdout.write(`  ${preview.passed ? "PASS" : "FAIL"} ${preview.kind} preview ${terminalSafe(preview.previewPath)}${localhost}\n`);
      }
      for (const file of result.artifactReport.files) {
        process.stdout.write(`  file ${terminalSafe(file.path)} · ${file.bytes} bytes · sha256 ${file.sha256}\n`);
      }
      for (const command of result.artifactReport.commands) {
        process.stdout.write(`  ${command.passed ? "PASS" : "FAIL"} ${terminalSafe(command.executable)} · ${terminalSafe(command.purpose)} · ${command.origin} · ${command.durationMs} ms\n`);
      }
      process.stdout.write(`  workspace audit: ${result.artifactReport.workspaceAudit.passed ? "PASS" : "FAIL"} · ${terminalSafe(result.artifactReport.workspaceAudit.message)}\n`);
    }
    if (!result.completed) process.exitCode = 2;
    try { dispatchNotification(result.completed ? "gold" : "blocked", result.completed ? "LightningLoop reached Gold" : "LightningLoop paused"); }
    catch (error) { process.stderr.write(`Notification warning: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`); }
  } finally {
    terminal?.close();
  }
}

async function entry(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.command === "doctor") {
    process.exitCode = await doctor(options.doctorRuntimeOnly);
    return;
  }
  if (options.command === "provider") {
    runProviderCommand(options);
    return;
  }
  if (options.command === "auth") {
    await runAuth(options);
    return;
  }
  if (options.command === "harness") {
    runHarnessGovernance(options);
    return;
  }
  if (options.command === "skills") {
    runSkillGovernance(options);
    return;
  }
  if (options.command === "update") {
    const status = updateChannelStatus(DEFAULT_UPDATE_POLICY);
    process.stdout.write(`LightningLoop update · ${status.state}\n  ${status.message}\n  LightningLoop runtime package pin: ${DEFAULT_UPDATE_POLICY.piPackageVersion}\n  Managed overlay changed: NO\n`);
    return;
  }
  if (options.command === "artifact") {
    await runArtifactHandoff(options);
    return;
  }
  if (options.command === "loop") {
    await runLoop(options);
    return;
  }
  if (options.command === "search") {
    await runSearch(options);
    return;
  }
  if (options.command === "mcp") {
    await runMcp(options);
    return;
  }
  if (options.command === "serve") {
    await runJsonlServer();
    return;
  }
  await runTUI(options);
}

// Keeping entry-point dispatch explicit lets the CLI parser be exercised without
// starting Pi's interactive terminal UI. This is particularly important for the
// no-argument aliases, whose documented behaviour is to select the TUI.
const invokedPath = process.argv[1];
const isEntrypoint = invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  entry().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`LightningLoop failed: ${message}\n`);
    process.exitCode = 1;
  });
}
