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
import { createLightningLoopExtension } from "../pi/lightningloop-extension.js";
import { PiProviderAdapter } from "../pi/model-adapter.js";
import { FusionAdapter, buildOpenRouterFusionMembers, parseFusionModelIds, type FusionCallProvenance } from "../core/fusion-adapter.js";
import { parseObjectiveContract, type ObjectiveContract } from "../core/objective-oracle.js";
import type { AgentAdapter } from "../core/loop-types.js";
import { captureSearchCredentials, SearchClient, type SearchProvider } from "../search/search-client.js";
import { runJsonlServer } from "../rpc/server.js";
import { callMcpServer, verifyMcpServer, type McpCallResult, type McpVerification } from "../mcp/client.js";
import { parseMcpManifest } from "../mcp/manifest.js";
import {
  isProviderSelectionRequired,
  loadProviderProfile,
  profileForPreset,
  providerConfigPath,
  providerCredentialService,
  saveProviderPreset,
  selectableProviderPresets,
  type SelectableProviderPreset,
  type ProviderProfile,
} from "../core/provider-profile.js";
import { enforceFreeMode, fetchOpenRouterKeyCredits, fetchOpenRouterModels, pickFreeModeModel, resolveSelectableModel, selectFreeModels, type OpenRouterKeyCredits } from "../core/openrouter.js";
import { formatCreditLine, formatLiveUsageMeter, formatRunSummaryLine } from "../core/usage-format.js";
import { recordSelfImprovementProposals } from "../core/self-improvement.js";
import type { ProviderModelOverride } from "../core/provider-profile.js";
import { clearProviderCredential, defaultSecretBackend, readStoredProviderCredential, storeProviderCredential } from "../core/key-store.js";
import { validateImagePaths } from "../core/image-input.js";
import { loadEligibleMemoryContext } from "../core/memory-store.js";
import { deriveProjectIdentity } from "../core/project-identity.js";
import { WorkspaceArtifactExecutor } from "../artifacts/workspace-artifact-executor.js";
import { startBrowserArtifactServer } from "../artifacts/browser-artifact-server.js";
import { artifactSeedsForGoal } from "../artifacts/builtin-artifact-seeds.js";
import { assertNoConfiguredCredential, registerRuntimeCredential } from "../core/credential-safety.js";
import { lightningLoopDataPath } from "../core/platform-paths.js";
import { ManagedOverlay } from "../governance/managed-overlay.js";
import { DEFAULT_UPDATE_POLICY, updateChannelStatus } from "../update/update-policy.js";
import { dispatchNotification } from "../notifications/notification-dispatcher.js";
import {
  RosterAdapter,
  buildRosterMembers,
  formatRosterLines,
  isLoopAgent,
  loadLoopRoster,
  saveLoopAgentModel,
  type LoopAgent,
} from "../core/loop-roster.js";
import { SHIPPED_SKILLS } from "../core/skill-disclosure.js";
import { executeBrowseCommand } from "../core/terminal-browser.js";
import { loadActiveGuidance } from "../core/evolution-store.js";

const SESSION_DIR = lightningLoopDataPath("harness-sessions");
const SHIPPED_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
const MANAGED_SKILLS_DIR = lightningLoopDataPath("managed", "current", "enabled-skills");

interface CliOptions {
  command: "tui" | "auth" | "provider" | "free" | "key" | "loop" | "search" | "mcp" | "harness" | "skills" | "update" | "artifact" | "serve" | "doctor" | "help" | "agents" | "browse";
  workspace: string;
  allowExecution: boolean;
  goal?: string;
  cycles: number;
  searchProvider?: SearchProvider;
  searchQuery?: string;
  searchLimit: number;
  researchProvider?: SearchProvider;
  objectiveFile?: string;
  selfImprove: boolean;
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
  providerAction?: "list" | "select" | "models";
  providerArgument?: SelectableProviderPreset;
  providerModel?: string;
  providerFreeOnly: boolean;
  fusionModels?: string;
  keyAction?: "set" | "status" | "clear";
  keyProvider?: string;
  doctorRuntimeOnly: boolean;
  agentAction?: "list" | "select";
  agentRole?: LoopAgent;
  browseURL?: string;
}

export function usage(): string {
  return `LightningLoop — Fast models. Strict evidence.

An independent BarnLabs open-source project.
llp, lloop, and lightningloop are the same product.

First commands:
  llp help
  llp provider list
  llp provider select openrouter
  llp key set openrouter          (reads the key from stdin; never argv or a file)
  llp free
  llp doctor
  llp loop "your goal"

Usage:
  llp | lloop | lightningloop [tui] [--workspace PATH] [--allow-execution] [-- RUNTIME_OPTIONS...]
  lightningloop auth
  lightningloop provider list
  lightningloop provider select <cerebras|groq|fireworks|generalcompute|openrouter|xai|openai-codex|anthropic> [--model ID] [--free]
  lightningloop provider models [--free]
  lightningloop free [--model ID]
  lightningloop key set|status|clear <openrouter|generalcompute|cerebras>
  lightningloop loop [GOAL] [--cycles 1-8] [--image PATH] [--research exa|brave|firecrawl|free]
    [--fusion "openrouter/id1,openrouter/id2"] (openrouter, non-free; runs 2-4 models per turn, longest reply wins)
    [--objective-file contract.json] (owner completion oracle: harness-evidence checks required for Gold)
    [--self-improve] (records INERT draft evolution proposals from the run; activation still requires the full reviewed lifecycle)
    [--workspace EMPTY_DIR --approve-artifact-writes [--approve-verification-commands]]
  lightningloop search <exa|brave|firecrawl|free> QUERY [--limit 1-20]  (free = keyless DuckDuckGo HTML)
  lightningloop mcp verify MANIFEST.json --workspace PATH --approve-manifest
  lightningloop mcp call MANIFEST.json TOOL --input PARAMS.json --workspace PATH --approve-manifest
  lightningloop harness status|backup|restore|reset [--slot 0-2] [--approve-restore|--approve-reset]
  lightningloop skills list|install|enable|disable [SOURCE_OR_ID] [--approve-skill-install|--approve-skill-enable HASH]
  lightningloop agents list
  lightningloop agents select <researcher|engineer|verifier> --model ID
  lightningloop browse URL
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
  let objectiveFile: string | undefined;
  const imagePaths: string[] = [];
  const passthrough: string[] = [];
  let mcpAction: CliOptions["mcpAction"];
  let mcpManifest: string | undefined;
  let mcpTool: string | undefined;
  let mcpInput: string | undefined;
  let approveManifest = false;
  let approveArtifactWrites = false;
  let selfImprove = false;
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
  let providerModel: string | undefined;
  let providerFreeOnly = false;
  let fusionModels: string | undefined;
  let keyAction: CliOptions["keyAction"];
  let keyProvider: string | undefined;
  let doctorRuntimeOnly = false;
  let agentAction: CliOptions["agentAction"];
  let agentRole: LoopAgent | undefined;
  let browseURL: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "tui") command = "tui";
    else if (arg === "auth") command = "auth";
    else if (arg === "provider") command = "provider";
    // Only the leading token selects the `free` command; a later bare `free`
    // (e.g. the `search free` provider) must fall through to positional parsing.
    else if (arg === "free" && index === 0) command = "free";
    else if (arg === "key") command = "key";
    else if (arg === "loop") command = "loop";
    else if (arg === "search") command = "search";
    else if (arg === "mcp") command = "mcp";
    else if (arg === "harness") command = "harness";
    else if (arg === "skills") command = "skills";
    else if (arg === "agents" && index === 0) command = "agents";
    else if (arg === "browse" && index === 0) command = "browse";
    else if (arg === "update") command = "update";
    else if (arg === "artifact") command = "artifact";
    else if (arg === "serve") command = "serve";
    else if (arg === "doctor") command = "doctor";
    else if (arg === "help" || arg === "--help" || arg === "-h") command = "help";
    else if (arg === "--allow-execution") allowExecution = true;
    else if (arg === "--approve-manifest") approveManifest = true;
    else if (arg === "--approve-artifact-writes") approveArtifactWrites = true;
    else if (arg === "--self-improve") selfImprove = true;
    else if (arg === "--approve-verification-commands") approveVerificationCommands = true;
    else if (arg === "--approve-reset") approveReset = true;
    else if (arg === "--approve-restore") approveRestore = true;
    else if (arg === "--approve-skill-install") approveSkillInstall = true;
    else if (arg === "--runtime-only") doctorRuntimeOnly = true;
    else if (arg === "--free") providerFreeOnly = true;
    else if (arg === "--model") {
      const value = args[index + 1];
      if (!value || value.length > 200 || /[\r\n\0]/u.test(value)) throw new Error("--model requires a bounded model ID.");
      providerModel = value;
      index += 1;
    }
    else if (arg === "--fusion") {
      const value = args[index + 1];
      if (!value || value.length > 900 || /[\r\n\0]/u.test(value)) throw new Error("--fusion requires a bounded comma-separated model list.");
      fusionModels = value;
      index += 1;
    }
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
      if (value !== "exa" && value !== "brave" && value !== "firecrawl" && value !== "free") throw new Error("--research must be exa, brave, firecrawl, or free.");
      researchProvider = value;
      index += 1;
    }
    else if (arg === "--objective-file") {
      const value = args[index + 1];
      if (!value) throw new Error("--objective-file requires a JSON contract path.");
      objectiveFile = resolve(value);
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
        if (arg !== "exa" && arg !== "brave" && arg !== "firecrawl" && arg !== "free") throw new Error("Search provider must be exa, brave, firecrawl, or free.");
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
        if (arg !== "list" && arg !== "select" && arg !== "models") throw new Error("Provider action must be list, select, or models.");
        providerAction = arg;
      } else if (providerAction === "select" && !providerArgument) {
        if (!selectableProviderPresets.includes(arg as SelectableProviderPreset)) {
          throw new Error(`Provider preset must be one of: ${selectableProviderPresets.join(", ")}.`);
        }
        providerArgument = arg as SelectableProviderPreset;
      } else {
        throw new Error("Provider command contains too many positional arguments.");
      }
    } else if (command === "key" && !arg.startsWith("--")) {
      if (!keyAction) {
        if (arg !== "set" && arg !== "status" && arg !== "clear") throw new Error("Key action must be set, status, or clear.");
        keyAction = arg;
      } else if (!keyProvider) {
        keyProvider = arg;
      } else {
        throw new Error("Key command contains too many positional arguments.");
      }
    } else if (command === "agents" && !arg.startsWith("--")) {
      if (!agentAction) {
        if (arg !== "list" && arg !== "select") throw new Error("Agent action must be list or select.");
        agentAction = arg;
      } else if (agentAction === "select" && !agentRole) {
        if (!isLoopAgent(arg)) throw new Error("Agent must be researcher, engineer, or verifier.");
        agentRole = arg;
      } else {
        throw new Error("Agents command contains too many positional arguments.");
      }
    } else if (command === "browse" && !arg.startsWith("--")) {
      if (browseURL) throw new Error("Browse accepts one URL.");
      browseURL = arg;
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
    ...(objectiveFile ? { objectiveFile } : {}),
    selfImprove,
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
    ...(providerModel ? { providerModel } : {}),
    providerFreeOnly,
    ...(fusionModels ? { fusionModels } : {}),
    ...(keyAction ? { keyAction } : {}),
    ...(keyProvider ? { keyProvider } : {}),
    doctorRuntimeOnly,
    ...(agentAction ? { agentAction } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(browseURL ? { browseURL } : {}),
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

async function readObjectiveContract(path: string | undefined): Promise<ObjectiveContract | undefined> {
  if (!path) return undefined;
  const encoded = await readFile(path);
  if (encoded.length > 65_536) throw new Error("Objective contract exceeds 64 KiB.");
  return parseObjectiveContract(JSON.parse(encoded.toString("utf8")) as unknown);
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
  const managedEnvKey = !selectionRequired && !piManaged && (
    (profile.preset === "generalcompute" && Boolean(process.env.GENERALCOMPUTE_API_KEY?.trim()))
    || (profile.preset === "openrouter" && Boolean(process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_KEY?.trim()))
  );
  const managedApiKeyReady = keychainCredential || managedEnvKey;
  process.stdout.write("LightningLoop doctor\n");
  process.stdout.write(`  Node >=22.19: ${nodeOK ? "PASS" : "FAIL"} (${process.version})\n`);
  process.stdout.write(selectionRequired
    ? "  Active provider: SELECTION REQUIRED · run 'lightningloop provider list' then 'lightningloop provider select PRESET'\n"
    : `  Active provider: ${terminalSafe(profile.displayName)} · ${terminalSafe(profile.modelID)}\n`);
  if (!selectionRequired) process.stdout.write(`  Free mode: ${profile.freeOnly ? "ON · only zero-cost models" : "off"}\n`);
  const roster = loadLoopRoster();
  process.stdout.write("  Loop agents:\n");
  for (const line of formatRosterLines(roster, selectionRequired ? "" : profile.modelID)) {
    process.stdout.write(`    ${terminalSafe(line)}\n`);
  }
  process.stdout.write(`  Shipped skills: ${SHIPPED_SKILLS.length} (progressive disclosure)\n`);
  process.stdout.write("  Source policy: reputable primary hosts only\n");
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
  return runtimeOnly ? (nodeOK ? 0 : 1) : (nodeOK && !selectionRequired && (piManaged || managedApiKeyReady) ? 0 : 1);
}

async function runProviderCommand(options: CliOptions): Promise<void> {
  const action = options.providerAction ?? "list";
  if (action === "models") {
    await runProviderModels(options);
    return;
  }
  if (action === "select") {
    if (!options.providerArgument) throw new Error("Provider select requires a reviewed preset.");
    let override: ProviderModelOverride | undefined;
    if (options.providerArgument === "openrouter") {
      override = await buildOpenRouterOverride(options.providerModel, options.providerFreeOnly);
    } else if (options.providerModel) {
      override = { modelID: options.providerModel };
    }
    const selected = saveProviderPreset(options.providerArgument, providerConfigPath(), override);
    process.stdout.write(`Selected ${terminalSafe(selected.displayName)} · ${terminalSafe(selected.modelName)}${selected.freeOnly ? " · FREE MODE" : ""}\n`);
    if (selected.preset === "generalcompute") {
      process.stdout.write("Credential: LightningLoop-managed API key (Settings Keychain on macOS, or GENERALCOMPUTE_API_KEY). Not runtime /login.\n");
    } else if (selected.preset === "openrouter") {
      process.stdout.write("Credential: LightningLoop-managed API key. Store it easily with 'lightningloop key set openrouter', or set OPENROUTER_API_KEY / OPENROUTER_KEY. Not runtime /login.\n");
      process.stdout.write("Discover free models with: lightningloop provider models --free\n");
    } else {
      process.stdout.write("Credential stored by LightningLoop: NO. Use 'lightningloop auth' to start provider sign-in.\n");
    }
    return;
  }
  process.stdout.write("LightningLoop provider presets\n");
  for (const preset of selectableProviderPresets) {
    const profile = profileForPreset(preset);
    process.stdout.write(`  ${preset} · ${terminalSafe(profile.displayName)} · ${terminalSafe(profile.modelName)}\n`);
  }
  process.stdout.write("Select with: lightningloop provider select PRESET\n");
}

/**
 * Resolve an OpenRouter model override from the live catalog. With an explicit
 * model it is validated (and, under freeOnly, required to be free); with no model
 * but freeOnly it auto-picks the free router / first free model. Returns undefined
 * only when neither a model nor free mode is requested (use the preset default).
 */
async function buildOpenRouterOverride(model: string | undefined, freeOnly: boolean): Promise<ProviderModelOverride | undefined> {
  if (!model && !freeOnly) return undefined;
  const catalog = await fetchOpenRouterModels();
  const match = model ? resolveSelectableModel(catalog, model, freeOnly) : pickFreeModeModel(catalog);
  return {
    modelID: match.id,
    modelName: match.name,
    ...(match.contextWindow >= 1_024 && match.contextWindow <= 2_000_000 ? { contextWindow: match.contextWindow } : {}),
    ...(freeOnly ? { freeOnly: true } : {}),
  };
}

const KEY_STORE_PROVIDERS = ["openrouter", "generalcompute", "cerebras"] as const;

/** Easy, secure API-key storage in the OS secret store. Values are never echoed or filed. */
async function runKeyCommand(options: CliOptions): Promise<void> {
  const action = options.keyAction ?? "status";
  const providerName = options.keyProvider;
  if (!providerName || !(KEY_STORE_PROVIDERS as readonly string[]).includes(providerName)) {
    throw new Error(`Key command requires a provider: ${KEY_STORE_PROVIDERS.join(", ")}.`);
  }
  const profile = profileForPreset(providerName as SelectableProviderPreset);
  const backend = defaultSecretBackend();
  if (action === "status") {
    const present = readStoredProviderCredential(profile, backend) !== undefined;
    process.stdout.write(`LightningLoop key · ${providerName}\n`);
    process.stdout.write(`  Secure store: ${terminalSafe(backend.name)}\n`);
    process.stdout.write(`  Stored key: ${present ? "PRESENT" : "none"} · value never displayed\n`);
    return;
  }
  if (action === "clear") {
    clearProviderCredential(profile, backend);
    process.stdout.write(`Cleared any stored ${providerName} key from ${terminalSafe(backend.name)}.\n`);
    return;
  }
  // set: read the secret from stdin so it never appears in argv or shell history.
  if (process.stdin.isTTY) {
    throw new Error(`Pipe the key on stdin, e.g.: printf %s "$OPENROUTER_KEY" | lightningloop key set ${providerName}`);
  }
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const secret = input.trim();
  storeProviderCredential(profile, secret, backend);
  process.stdout.write(`Stored ${providerName} key in ${terminalSafe(backend.name)}. It is never written to provider.json or logs.\n`);
}

/** "Just free mode": pin OpenRouter to a zero-cost model (free router preferred). */
async function runFreeMode(options: CliOptions): Promise<void> {
  const override = await buildOpenRouterOverride(options.providerModel, true);
  const selected = saveProviderPreset("openrouter", providerConfigPath(), override);
  process.stdout.write(`Free mode ON · OpenRouter · ${terminalSafe(selected.modelName)} (${terminalSafe(selected.modelID)})\n`);
  process.stdout.write("Only zero-cost models will run; runs re-verify the model is still free.\n");
  process.stdout.write("Add your key with 'lightningloop key set openrouter' (or set OPENROUTER_API_KEY / OPENROUTER_KEY), then run llp.\n");
}

/** Credential-free live discovery of the OpenRouter catalog, optionally free models only. */
async function runProviderModels(options: CliOptions): Promise<void> {
  const models = await fetchOpenRouterModels();
  const shown = options.providerFreeOnly
    ? selectFreeModels(models)
    : models.slice().sort((a, b) => a.id.localeCompare(b.id));
  const scope = options.providerFreeOnly ? "free" : "all";
  process.stdout.write(`OpenRouter models · ${scope} · ${shown.length} of ${models.length}\n`);
  for (const model of shown) {
    const price = model.free ? "free" : `in ${model.promptPrice} · out ${model.completionPrice} (USD/token)`;
    process.stdout.write(`  ${terminalSafe(model.id)} · ${terminalSafe(model.name)} · ctx ${model.contextWindow} · ${price}\n`);
  }
  process.stdout.write("Select one with: lightningloop provider select openrouter --model <id>\n");
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
    process.stdout.write("  llp help\n");
    process.stdout.write("  llp provider list\n");
    process.stdout.write("  llp provider select PRESET\n");
    process.stdout.write("  llp key set openrouter|generalcompute|cerebras   (stdin only)\n");
    process.stdout.write("  llp free\n");
    process.stdout.write("  llp doctor\n");
    process.stdout.write("Without a provider you can still pin the three agents and browse a reputable source:\n");
    process.stdout.write("  lightningloop agents list\n");
    process.stdout.write("  lightningloop agents select researcher|engineer|verifier --model ID\n");
    process.stdout.write("  lightningloop browse URL\n");
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
  const { generalComputeApiKey, openRouterApiKey, cerebrasApiKey: cerebrasEnvApiKey } = prepareTuiRuntimeCredentials(profile, process.env);

  // Cerebras optionally runs via a manual key (env or OS secret store) instead of
  // Pi /login. The env key is captured above; fall back to the OS secret store.
  let cerebrasApiKey = cerebrasEnvApiKey;
  if (profile.preset === "cerebras" && !cerebrasApiKey) {
    const stored = readStoredProviderCredential(profile);
    if (stored) {
      registerRuntimeCredential(stored);
      cerebrasApiKey = stored;
    }
  }
  const usesManualCerebras = profile.preset === "cerebras" && cerebrasApiKey !== undefined;
  // A manual Cerebras key selects the LightningLoop-managed provider id; otherwise
  // Pi-managed presets keep their built-in provider id (/login path).
  const providerArg = profile.piProviderID && !usesManualCerebras
    ? profile.piProviderID
    : `lightningloop-${profile.id}`;

  // Mutations flow only through the OS-sandboxed bash override. Pi's in-process
  // write/edit tools are intentionally excluded because a confirmation dialog
  // alone is not an isolation boundary.
  const tools = options.allowExecution ? "read,grep,find,ls,bash" : "read,grep,find,ls";
  const args = [
    "--provider",
    providerArg,
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

  const extensionOptions = {
    ...(generalComputeApiKey ? { generalComputeApiKey } : {}),
    ...(openRouterApiKey ? { openRouterApiKey } : {}),
    ...(cerebrasApiKey ? { cerebrasApiKey } : {}),
  };
  await runPi(args, { extensionFactories: [{ name: "lightningloop", factory: createLightningLoopExtension(extensionOptions) }] });
}

/** Capture only bounded TUI credentials, register them for redaction, then scrub ambient env. */
export function prepareTuiRuntimeCredentials(
  profile: ProviderProfile,
  environment: NodeJS.ProcessEnv,
): { generalComputeApiKey?: string; openRouterApiKey?: string; cerebrasApiKey?: string } {
  const ambientGeneralComputeApiKey = environment.GENERALCOMPUTE_API_KEY?.trim();
  const ambientOpenRouterApiKey = environment.OPENROUTER_API_KEY?.trim() || environment.OPENROUTER_KEY?.trim();
  const ambientCerebrasApiKey = environment.CEREBRAS_API_KEY?.trim() || environment.CEREBRAS_KEY?.trim();
  if (ambientGeneralComputeApiKey) registerRuntimeCredential(ambientGeneralComputeApiKey);
  if (ambientOpenRouterApiKey) registerRuntimeCredential(ambientOpenRouterApiKey);
  if (ambientCerebrasApiKey) registerRuntimeCredential(ambientCerebrasApiKey);
  captureSearchCredentials(environment);
  scrubSensitiveEnvironment(environment);
  // The shared scrubber matches *_API_KEY, but the OPENROUTER_KEY and CEREBRAS_KEY
  // aliases do not match its pattern. Delete them explicitly so no credential
  // reaches the child tool environment.
  delete environment.OPENROUTER_KEY;
  delete environment.CEREBRAS_KEY;
  return {
    ...(profile.preset === "generalcompute" && ambientGeneralComputeApiKey ? { generalComputeApiKey: ambientGeneralComputeApiKey } : {}),
    ...(profile.preset === "openrouter" && ambientOpenRouterApiKey ? { openRouterApiKey: ambientOpenRouterApiKey } : {}),
    ...(profile.preset === "cerebras" && ambientCerebrasApiKey ? { cerebrasApiKey: ambientCerebrasApiKey } : {}),
  };
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
  const meter = event.usage && event.usage.total > 0 ? `  ${formatLiveUsageMeter(event.usage)}` : "";
  process.stdout.write(`\n[${event.stage}${round}] ${terminalSafe(event.message)}${meter}\n`);
}

/**
 * Read the OpenRouter credit balance when (and only when) an OpenRouter key is
 * present in the environment. Fail-closed: any error resolves to undefined so
 * the summary falls back to the always-present run-cost line. Keyless runs skip
 * the network entirely.
 */
async function readOptionalOpenRouterCredits(profile: ProviderProfile): Promise<OpenRouterKeyCredits | undefined> {
  if (profile.preset !== "openrouter") return undefined;
  const key = (process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY ?? "").trim();
  if (!key) return undefined;
  try {
    return await fetchOpenRouterKeyCredits(key);
  } catch {
    return undefined;
  }
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

/** Bounded, credential-free one-line summary of a fusion call for the operator. */
function renderFusionProvenance(provenance: FusionCallProvenance): string {
  const members = provenance.members
    .map((member) => {
      const detail = member.status === "ok" ? ` ${member.contentChars ?? 0}c/${member.usage?.total ?? 0}t` : "";
      return `${terminalSafe(member.model)} ${member.status}${detail}${member.selected ? "*" : ""}`;
    })
    .join(" · ");
  const selected = provenance.selectedModel ? terminalSafe(provenance.selectedModel) : "none";
  return `[fusion] ${provenance.role} · ${provenance.strategy} · selected=${selected} · ${members}`;
}

/**
 * Build the adapter the loop engine drives. With --fusion this wraps two or more
 * OpenRouter models in a {@link FusionAdapter}; the engine still sees one normal
 * adapter, so every deterministic gate is unchanged. Otherwise the single
 * configured provider adapter is returned.
 */
function runAgentsCommand(options: CliOptions): void {
  const action = options.agentAction ?? "list";
  const fallback = loadProviderProfile().modelID;
  if (action === "select") {
    if (!options.agentRole) throw new Error("Usage: lightningloop agents select researcher|engineer|verifier --model ID");
    if (!options.providerModel) throw new Error("agents select requires --model ID.");
    const roster = saveLoopAgentModel(options.agentRole, options.providerModel);
    process.stdout.write(`Pinned ${options.agentRole} · ${terminalSafe(options.providerModel)}\n`);
    for (const line of formatRosterLines(roster, fallback)) process.stdout.write(`  ${terminalSafe(line)}\n`);
    return;
  }
  process.stdout.write("LightningLoop agents\n");
  for (const line of formatRosterLines(loadLoopRoster(), fallback)) process.stdout.write(`  ${terminalSafe(line)}\n`);
  process.stdout.write("  Pin a model with: lightningloop agents select researcher|engineer|verifier --model ID\n");
}

async function runBrowseCommand(options: CliOptions): Promise<void> {
  if (!options.browseURL) throw new Error("Usage: lightningloop browse URL");
  const rendered = await executeBrowseCommand(options.browseURL);
  process.stdout.write(`${rendered.split("\n").map((line) => terminalSafe(line)).join("\n")}\n`);
}

async function buildLoopAdapter(profile: ProviderProfile, options: CliOptions): Promise<AgentAdapter> {
  if (!options.fusionModels) {
    const fallback = await PiProviderAdapter.create(profile);
    const members = await buildRosterMembers(profile, loadLoopRoster(), async (memberProfile) => (
      memberProfile.modelID === profile.modelID ? fallback : PiProviderAdapter.create(memberProfile)
    ));
    process.stdout.write("Agents:\n");
    for (const member of members) process.stdout.write(`  ${member.agent} · ${terminalSafe(member.modelID)}\n`);
    return new RosterAdapter(members, fallback);
  }
  if (profile.preset !== "openrouter") {
    throw new Error("Model fusion is currently supported only for the OpenRouter provider. Run 'provider select openrouter' first, then pass --fusion \"id1,id2\".");
  }
  if (profile.freeOnly) {
    throw new Error("Model fusion mixes free and paid models and cannot run while just-free-mode is pinned. Re-select openrouter without --free to use --fusion.");
  }
  const modelIDs = parseFusionModelIds(options.fusionModels);
  const members = await buildOpenRouterFusionMembers(profile, modelIDs, (memberProfile) => PiProviderAdapter.create(memberProfile));
  process.stdout.write(`Fusion: ${modelIDs.length} models · strategy longest · ${modelIDs.map((id) => terminalSafe(id)).join(", ")}\n`);
  return new FusionAdapter(members, {
    onProvenance: (provenance) => process.stdout.write(`${renderFusionProvenance(provenance)}\n`),
  });
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
    // Just-free-mode guarantee: refuse to run if the pinned model is no longer free.
    await enforceFreeMode(profile);
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
    process.stdout.write("\nϟ LightningLoop · Fast models. Strict evidence.\n");
    process.stdout.write(`BarnLabs · ${terminalSafe(profile.displayName)} / ${terminalSafe(profile.modelName)}\n`);
    process.stdout.write(artifactExecutor
      ? `Mode: reviewed workspace artifacts · ${artifactExecutor.allowVerificationCommands ? "sandboxed verification approved" : "commands disabled"}\nOutput: ${terminalSafe(realpathSync(options.workspace))}\n`
      : "Mode: complete text-deliverable loop · workspace writes and commands disabled\n");
    const search = options.researchProvider ? new SearchClient() : undefined;
    const { id: projectID } = deriveProjectIdentity(process.cwd());
    const memories = loadEligibleMemoryContext(undefined, undefined, undefined, projectID);
    assertNoConfiguredCredential(memories, profile);
    const objective = await readObjectiveContract(options.objectiveFile);
    if (objective) {
      process.stdout.write(`Objective oracle: ${objective.checks.length} harness-evidence check(s) required for Gold.\n`);
    }
    const approvedSkills = loadActiveGuidance().filter((item) => item.kind === "skill").map((item) => item.content);
    const engine = new LoopEngine(await buildLoopAdapter(profile, options), {
      images,
      memories,
      approvedSkills,
      ...(artifactExecutor ? { artifactExecutor } : {}),
      ...(objective ? { objective } : {}),
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
    process.stdout.write(`${formatRunSummaryLine({ reviews: result.reviews.length, usage: result.usage })}\n`);
    const credits = await readOptionalOpenRouterCredits(profile);
    if (credits) process.stdout.write(`${formatCreditLine(credits)}\n`);
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
    if (options.selfImprove) {
      const drafts = recordSelfImprovementProposals(result);
      process.stdout.write(`\nSelf-improvement: recorded ${drafts.length} INERT draft proposal(s). Each stays inactive until it passes the full source-review → sandbox → adversarial-review → user-approval lifecycle.\n`);
      for (const draft of drafts) process.stdout.write(`  draft ${draft.state} · ${draft.kind} · ${terminalSafe(draft.name)}\n`);
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
    await runProviderCommand(options);
    return;
  }
  if (options.command === "free") {
    await runFreeMode(options);
    return;
  }
  if (options.command === "key") {
    await runKeyCommand(options);
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
  if (options.command === "agents") {
    runAgentsCommand(options);
    return;
  }
  if (options.command === "browse") {
    await runBrowseCommand(options);
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
