import { createBashTool, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { renderBrandHeaderLines, renderStatusFooterLines } from "./lightningloop-theme.js";
import { basename } from "node:path";
import { resolve } from "node:path";
import { WorkspaceBoundary, evaluateToolRequest } from "../core/capability-policy.js";
import { LIGHTNINGLOOP_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { SandboxedBashRuntime } from "../sandbox/sandboxed-bash.js";
import { builtinWorkflowGuidance } from "../core/workflow-catalog.js";
import { terminalSafe } from "../core/terminal-output.js";
import { formatLiveUsageMeter } from "../core/usage-format.js";
import { validateImagePaths } from "../core/image-input.js";
import { isProviderSelectionRequired, loadProviderProfile, providerCredentialService, providerHeaders } from "../core/provider-profile.js";
import { LoopEngine } from "../core/loop-engine.js";
import { PiProviderAdapter } from "./model-adapter.js";
import { enforceFreeMode } from "../core/openrouter.js";
import { SearchClient, type SearchProvider } from "../search/search-client.js";
import { applyActiveSystemPromptAddenda, loadActiveGuidance } from "../core/evolution-store.js";
import { applyManagedMemoryContext, loadEligibleMemoryContext } from "../core/memory-store.js";
import { deriveProjectIdentity } from "../core/project-identity.js";
import { WorkspaceArtifactExecutor } from "../artifacts/workspace-artifact-executor.js";
import { artifactSeedsForGoal } from "../artifacts/builtin-artifact-seeds.js";
import {
  addManagedMemory,
  advanceManagedEvolution,
  approveManagedMemory,
  deleteManagedMemory,
  listManagedEvolutions,
  listManagedMemory,
  proposeManagedEvolution,
  rollbackManagedEvolution,
  updateManagedEvolutionEvidence,
  type ManagedEvolutionKind,
} from "../core/ledger-management.js";
import { assertCredentialSafeInput, assertNoConfiguredCredential } from "../core/credential-safety.js";
import { dispatchNotification } from "../notifications/notification-dispatcher.js";
import { encodePiApiKey } from "../core/pi-options.js";
import { RosterAdapter, buildRosterMembers, formatRosterLines, isLoopAgent, loadLoopRoster, saveLoopAgentModel } from "../core/loop-roster.js";
import { executeBrowseCommand } from "../core/terminal-browser.js";
import type { ProviderProfile } from "../core/provider-profile.js";
import type { AgentAdapter } from "../core/loop-types.js";

function keychainCommand(services: string[]): string {
  if (services.length < 1 || services.some((service) => !/^[A-Za-z0-9.-]+$/.test(service))) {
    throw new Error("Invalid Keychain service identifier.");
  }
  return `!/bin/sh -c '${services.map((service) => `/usr/bin/security find-generic-password -s ${service} -w`).join(" || ")}'`;
}

export interface LightningLoopExtensionOptions {
  /** Captured before TUI environment scrubbing; never read from ambient env here. */
  generalComputeApiKey?: string;
  /** OpenRouter API key captured before TUI environment scrubbing. */
  openRouterApiKey?: string;
  /**
   * Cerebras manual API key resolved by the CLI (env or OS secret store) before
   * TUI environment scrubbing. When present, Cerebras runs as an OpenAI-compatible
   * LightningLoop-managed provider instead of the Pi `/login` path.
   */
  cerebrasApiKey?: string;
}

type ManagedProviderRegistration = Parameters<ExtensionAPI["registerProvider"]>[1];

async function createRosterAdapter(profile: ProviderProfile): Promise<AgentAdapter> {
  const fallback = await PiProviderAdapter.create(profile);
  const members = await buildRosterMembers(profile, loadLoopRoster(), async (memberProfile) => (
    memberProfile.modelID === profile.modelID ? fallback : PiProviderAdapter.create(memberProfile)
  ));
  return new RosterAdapter(members, fallback);
}

/** OpenAI-compatible LightningLoop-managed provider registration for an API-key credential. */
function managedOpenAiProviderRegistration(
  profile: ReturnType<typeof loadProviderProfile>,
  apiKey: string,
): ManagedProviderRegistration {
  return {
    name: `LightningLoop / ${profile.displayName}`,
    baseUrl: profile.baseURL,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    headers: providerHeaders(profile),
    models: [
      {
        id: profile.modelID,
        name: profile.modelName,
        reasoning: true,
        input: profile.supportsImages ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: profile.contextWindow,
        maxTokens: profile.maxOutputTokens,
      },
    ],
  };
}

export function createLightningLoopExtension(options: LightningLoopExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const profile = loadProviderProfile();
  const providerID = `lightningloop-${profile.id}`;
  const workspace = process.cwd();
  const sandbox = new SandboxedBashRuntime(workspace);
  let sandboxReady = false;
  const sandboxedBash = createBashTool(workspace, { operations: sandbox.operations() });
  pi.registerTool({
    ...sandboxedBash,
    label: "bash (LightningLoop sandbox)",
    async execute(id, params, signal, onUpdate) {
      if (!sandboxReady) {
        return {
          content: [{ type: "text", text: "Execution blocked because the OS sandbox is unavailable." }],
          details: { blocked: true },
        };
      }
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerFlag("lightningloop-execution", {
    type: "boolean",
    default: false,
    description: "Allow individually confirmed workspace mutations and shell commands",
  });

  const cerebrasManualApiKey = profile.preset === "cerebras" ? options.cerebrasApiKey?.trim() : undefined;
  if (isProviderSelectionRequired(profile)) {
    // First-run TUI: register commands and the terminal browser without a provider.
  } else if (!profile.piProviderID) {
    const envApiKey = profile.preset === "generalcompute"
      ? options.generalComputeApiKey?.trim()
      : profile.preset === "openrouter"
        ? options.openRouterApiKey?.trim()
        : undefined;
    if (process.platform !== "darwin") {
      if (!envApiKey) {
        throw new Error(
          profile.preset === "generalcompute"
            ? "GeneralCompute on non-macOS requires GENERALCOMPUTE_API_KEY. It is not managed by runtime /login."
            : profile.preset === "openrouter"
              ? "OpenRouter on non-macOS requires OPENROUTER_API_KEY (or OPENROUTER_KEY). It is not managed by runtime /login."
              : "Custom provider Keychain profiles are macOS-only. Configure GeneralCompute or OpenRouter with an API key environment variable, or a runtime-managed built-in provider for cross-platform use.",
        );
      }
    }
    // An explicitly captured TUI env key is process-local; otherwise macOS uses Keychain.
    const apiKey = envApiKey
      ? encodePiApiKey(envApiKey)
      : (process.platform === "darwin" ? keychainCommand([providerCredentialService(profile)]) : envApiKey!);
    pi.registerProvider(providerID, managedOpenAiProviderRegistration(profile, apiKey));
  } else if (cerebrasManualApiKey) {
    // Cerebras manual-key override: run as a LightningLoop-managed OpenAI-compatible
    // provider instead of the Pi /login path. The CLI already resolved the key from
    // env or the OS secret store and registered it for redaction; it never touches
    // provider.json. Without a manual key, Cerebras keeps the Pi-managed path.
    pi.registerProvider(providerID, managedOpenAiProviderRegistration(profile, encodePiApiKey(cerebrasManualApiKey)));
  }

  let boundaryPromise: Promise<WorkspaceBoundary> | undefined;
  let pendingImagePaths: string[] = [];
  let activeResearchProvider: SearchProvider | undefined;
  let activeLoopController: AbortController | undefined;
  let activeArtifactWorkspace: string | undefined;
  let activeArtifactCommands = false;

  pi.on("session_start", async (_event, ctx) => {
    boundaryPromise = WorkspaceBoundary.create(ctx.cwd);
    const executionEnabled = pi.getFlag("lightningloop-execution") === true;
    const policyLabel = executionEnabled ? "CONFIRM EACH MUTATION" : "WORKSPACE READ ONLY";
    const workspaceLabel = terminalSafe(basename(ctx.cwd) || "workspace");
    ctx.ui.setTitle("LightningLoop — BarnLabs");
    ctx.ui.setStatus("lightningloop-policy", executionEnabled ? "confirmed execution" : "read-only");
    if (ctx.mode === "tui") {
      ctx.ui.setHeader((_tui, theme) => ({
        render(width: number): string[] {
          return renderBrandHeaderLines(theme, {
            displayName: profile.displayName,
            modelName: profile.modelName,
            runtimeManaged: Boolean(profile.piProviderID),
            preset: profile.preset,
          }, width);
        },
        invalidate() {},
      }));
      ctx.ui.setFooter((_tui, theme) => ({
        render(width: number): string[] {
          return renderStatusFooterLines(theme, {
            displayName: profile.displayName,
            executionEnabled,
            policyLabel,
            workspaceLabel,
            researchProvider: activeResearchProvider,
            artifactWorkspace: Boolean(activeArtifactWorkspace),
            artifactCommands: activeArtifactCommands,
          }, width);
        },
        invalidate() {},
      }));
      ctx.ui.setWorkingMessage(`${profile.modelName} is working…`);
      ctx.ui.setWorkingIndicator({
        frames: [
          ctx.ui.theme.fg("dim", "·"),
          ctx.ui.theme.fg("muted", "•"),
          ctx.ui.theme.fg("accent", "●"),
          ctx.ui.theme.fg("muted", "•"),
        ],
        intervalMs: 110,
      });
      ctx.ui.setHiddenThinkingLabel("Model reasoning");
    }
    if (executionEnabled) {
      try {
        await sandbox.initialize();
        sandboxReady = true;
        ctx.ui.setStatus("lightningloop-sandbox", "sandboxed · network denied");
      } catch {
        sandboxReady = false;
        ctx.ui.setStatus("lightningloop-sandbox", "execution blocked · sandbox failed");
        ctx.ui.notify("OS sandbox initialization failed. All shell execution remains blocked.", "error");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    sandboxReady = false;
    await sandbox.shutdown();
  });

  pi.on("before_agent_start", (event, ctx) => {
    const memories = loadEligibleMemoryContext(undefined, undefined, undefined, deriveProjectIdentity(process.cwd()).id);
    const current = applyManagedMemoryContext(
      applyActiveSystemPromptAddenda(ctx.getSystemPrompt()),
      memories,
    );
    assertCredentialSafeInput({ prompt: event.prompt, systemPrompt: current, memories }, profile);
    const workflow = builtinWorkflowGuidance(event.prompt);
    return {
      systemPrompt: current.includes(LIGHTNINGLOOP_SYSTEM_PROMPT)
        ? `${current}${workflow ? `\n\n${workflow}` : ""}`
        : `${current}\n\n${LIGHTNINGLOOP_SYSTEM_PROMPT}${workflow ? `\n\n${workflow}` : ""}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const boundary = await (boundaryPromise ?? WorkspaceBoundary.create(ctx.cwd));
    const executionEnabled = pi.getFlag("lightningloop-execution") === true;
    const decision = await evaluateToolRequest(
      { toolName: event.toolName, input: event.input as Record<string, unknown> },
      boundary,
      executionEnabled ? "confirm_mutations" : "read_only",
    );

    if (decision.action === "allow") return undefined;
    if (decision.action === "deny") return { block: true, reason: decision.reason };
    if (!ctx.hasUI) return { block: true, reason: "Interactive approval is unavailable." };

    const approved = await ctx.ui.confirm(
      "Approve one capability?",
      `${decision.reason}\n\n${decision.preview}\n\nThis approval applies only to this call.`,
    );
    return approved ? undefined : { block: true, reason: "User denied the capability request." };
  });

  pi.on("user_bash", async (event, ctx) => {
    if (pi.getFlag("lightningloop-execution") !== true || !ctx.hasUI) {
      return {
        result: {
          output: "LightningLoop blocked direct shell execution. Relaunch with --allow-execution and approve each call.",
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }
    if (!event.command.trim() || event.command.length > 2_000) {
      return {
        result: {
          output: "LightningLoop blocked a missing or overlong shell command.",
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }
    const approved = await ctx.ui.confirm(
      "Approve one shell command?",
      `${event.command}\n\nThis approval applies only to this command.`,
    );
    if (approved && sandboxReady) return { operations: sandbox.operations() };
    return {
      result: {
        output: sandboxReady
          ? "LightningLoop blocked the shell command because approval was denied."
          : "LightningLoop blocked the shell command because the OS sandbox is unavailable.",
        exitCode: 126,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.registerCommand("loop", {
    description: "Run the full deterministic LightningLoop state machine",
    handler: async (args, ctx) => {
      const goal = args.trim() || (await ctx.ui.editor("What outcome should LightningLoop produce?"))?.trim();
      if (!goal) {
        ctx.ui.notify("A goal is required.", "warning");
        return;
      }
      try {
        assertCredentialSafeInput(goal, profile);
      } catch {
        ctx.ui.notify("The goal was rejected by the credential-safety boundary.", "error");
        return;
      }
      if (isProviderSelectionRequired(profile)) {
        ctx.ui.notify("Select a provider first with `lightningloop provider select PRESET`.", "warning");
        return;
      }
      if (!ctx.isIdle() || activeLoopController) {
        ctx.ui.notify("A model turn or LightningLoop run is already active.", "warning");
        return;
      }
      pi.setSessionName(goal.slice(0, 72));
      const controller = new AbortController();
      activeLoopController = controller;
      try {
        const images = await validateImagePaths(pendingImagePaths);
        const search = activeResearchProvider ? new SearchClient() : undefined;
        if (activeArtifactCommands && pi.getFlag("lightningloop-execution") === true) {
          ctx.ui.notify("Artifact verification cannot share a session with the general confirmed-shell sandbox. Relaunch without --allow-execution or use artifact writes without --verify.", "error");
          return;
        }
        const artifactExecutor = activeArtifactWorkspace
          ? await WorkspaceArtifactExecutor.create(
              activeArtifactWorkspace,
              activeArtifactCommands,
              await artifactSeedsForGoal(goal, images),
            )
          : undefined;
        const memories = loadEligibleMemoryContext(undefined, undefined, undefined, deriveProjectIdentity(process.cwd()).id);
        assertNoConfiguredCredential(memories, profile);
        // Just-free-mode guarantee: refuse to run a model that is no longer free.
        await enforceFreeMode(profile);
        const engine = new LoopEngine(await createRosterAdapter(profile), {
          images,
          memories,
          approvedSkills: loadActiveGuidance().filter((item) => item.kind === "skill").map((item) => item.content),
          ...(artifactExecutor ? { artifactExecutor } : {}),
          ...(activeResearchProvider && search ? {
            research: {
              provider: activeResearchProvider,
              search: async (query: string) => (await search.search(activeResearchProvider!, query, 5)).results,
              documentationContext: async (url: string) => search.documentationContext(url),
              openSource: async (url: string) => search.openSource(url),
            },
          } : {}),
        });
        pendingImagePaths = [];
        ctx.ui.setStatus("lightningloop-run", "clarifying");
        const clarification = await engine.clarify(goal, controller.signal);
        assertCredentialSafeInput(clarification, profile);
        const answers: Record<string, string> = {};
        for (const question of clarification.questions) {
          const answer = (await ctx.ui.editor(`${question.question}\n\nWhy it matters: ${question.whyItMatters}`))?.trim();
          if (!answer) {
            ctx.ui.notify("The run stopped because every clarification requires an answer.", "warning");
            return;
          }
          assertCredentialSafeInput(answer, profile);
          answers[question.id] = answer;
        }
        assertCredentialSafeInput({ goal, clarification, answers }, profile);
        const result = await engine.execute(
          goal,
          clarification,
          answers,
          4,
          async (event) => {
            ctx.ui.setStatus("lightningloop-run", event.message);
            if (event.usage && event.usage.total > 0) {
              ctx.ui.setStatus("lightningloop-usage", formatLiveUsageMeter(event.usage));
            }
          },
          controller.signal,
        );
        assertCredentialSafeInput(result, profile);
        const heading = result.completed ? "GOLD" : "PAUSED";
        const reviewSummary = result.reviews.map((review) => `${review.target} round ${review.round}: ${review.score}/10 ${review.verdict}`).join("\n");
        const previewSummary = result.artifactReport?.previews.map((preview) => {
          const localhost = preview.loopback ? ` · HTTP ${preview.loopback.status} ${preview.loopback.host}` : "";
          return `- ${preview.passed ? "PASS" : "FAIL"} ${preview.kind} · ${preview.previewPath}${localhost}`;
        }).join("\n") ?? "";
        const artifactSummary = result.artifactReport
          ? `\n\n## Evidence Lab\n${result.artifactReport.passed ? "PASS" : "FAIL"} · ${result.artifactReport.summary}\n${previewSummary ? `\n### Previews\n${previewSummary}\n` : ""}\n### Files\n${result.artifactReport.files.map((file) => `- ${file.path} · ${file.bytes} bytes · sha256 ${file.sha256}`).join("\n")}\n\n### Script runner\n${result.artifactReport.commands.map((command) => `- ${command.passed ? "PASS" : "FAIL"} ${command.executable} · ${command.purpose} · ${command.origin} · ${command.durationMs} ms`).join("\n") || "No executable checks."}`
          : "";
        const content = `# LightningLoop ${heading}\n\n${result.message}\n\n${reviewSummary ? `## Reviews\n${reviewSummary}\n\n` : ""}${result.implementation.deliverable || "No deliverable was produced."}${artifactSummary}`;
        const resultMessage = { customType: "lightningloop-result", content, display: true, details: { completed: result.completed, usage: result.usage } };
        assertCredentialSafeInput(resultMessage, profile);
        pi.sendMessage(
          resultMessage,
          { triggerTurn: false },
        );
        const sessionEntry = {
          goal,
          completed: result.completed,
          reviews: result.reviews.length,
          usage: result.usage,
          timestamp: new Date().toISOString(),
        };
        assertCredentialSafeInput(sessionEntry, profile);
        pi.appendEntry("lightningloop-run", sessionEntry);
        ctx.ui.notify(result.completed ? "Gold reached. Every deterministic gate passed." : "Run paused with unresolved findings preserved.", result.completed ? "info" : "warning");
        try { dispatchNotification(result.completed ? "gold" : "blocked", result.completed ? "LightningLoop reached Gold" : "LightningLoop paused"); }
        catch (error) { ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Notification hook failed.", "warning"); }
      } catch (error) {
        if (controller.signal.aborted) ctx.ui.notify("LightningLoop run cancelled.", "warning");
        else ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "LightningLoop run failed.", "error");
      } finally {
        activeLoopController = undefined;
        ctx.ui.setStatus("lightningloop-run", undefined);
        ctx.ui.setStatus("lightningloop-usage", undefined);
      }
    },
  });

  pi.registerCommand("loop-cancel", {
    description: "Cancel the active LightningLoop run",
    handler: async (_args, ctx) => {
      if (!activeLoopController) {
        ctx.ui.notify("No LightningLoop run is active.", "info");
        return;
      }
      activeLoopController.abort(new DOMException("Run cancelled.", "AbortError"));
      ctx.ui.notify("Cancelling the active LightningLoop run…", "warning");
    },
  });

  pi.registerCommand("agents", {
    description: "List or pin models for Researcher, Engineer, and Verifier",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/u).filter(Boolean);
      try {
        if (tokens[0] === "select") {
          const role = tokens[1] ?? "";
          const model = tokens[2] ?? "";
          if (!isLoopAgent(role) || !model) {
            ctx.ui.notify("Usage: /agents select researcher|engineer|verifier MODEL_ID", "warning");
            return;
          }
          const roster = saveLoopAgentModel(role, model);
          ctx.ui.notify(`Pinned ${role} · ${model}\n${formatRosterLines(roster, profile.modelID).join("\n")}`, "info");
          return;
        }
        ctx.ui.notify(`LightningLoop agents\n${formatRosterLines(loadLoopRoster(), profile.modelID).join("\n")}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Agent roster failed closed.", "error");
      }
    },
  });

  pi.registerCommand("browse", {
    description: "Open one reputable HTTPS page as a terminal snapshot",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /browse https://reputable.example/path", "warning");
        return;
      }
      try {
        ctx.ui.notify(await executeBrowseCommand(url), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Browse failed closed.", "error");
      }
    },
  });

  pi.registerCommand("research", {
    description: "Choose free (keyless), Exa, Brave, Firecrawl, or off for the next runs",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "off" || value === "none") {
        activeResearchProvider = undefined;
        ctx.ui.notify("Automatic research is off.", "info");
        return;
      }
      if (value !== "exa" && value !== "brave" && value !== "firecrawl" && value !== "free") {
        ctx.ui.notify("Usage: /research free|exa|brave|firecrawl|off", "warning");
        return;
      }
      activeResearchProvider = value;
      const detail = value === "free" ? "No key required (DuckDuckGo HTML)." : "Its credential is checked only when /loop starts.";
      ctx.ui.notify(`Automatic research will use ${value}. ${detail}`, "info");
    },
  });

  pi.registerCommand("image", {
    description: "Attach a PNG, JPEG, WebP, or GIF to the next /loop run",
    handler: async (args, ctx) => {
      const path = args.trim();
      if (!path) {
        ctx.ui.notify("Usage: /image /absolute/path/to/image.png", "warning");
        return;
      }
      if (pendingImagePaths.length >= 4) {
        ctx.ui.notify("A run may contain at most four images. Use /image-clear to start over.", "warning");
        return;
      }
      try {
        const [image] = await validateImagePaths([resolve(path)]);
        if (!image) throw new Error("The image could not be loaded.");
        pendingImagePaths.push(image.path);
        ctx.ui.notify(`Attached ${basename(image.path)} (${pendingImagePaths.length}/4) to the next loop.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("image-clear", {
    description: "Remove images queued for the next /loop run",
    handler: async (_args, ctx) => {
      pendingImagePaths = [];
      ctx.ui.notify("Queued images cleared.", "info");
    },
  });

  pi.registerCommand("artifacts", {
    description: "Enable reviewed writes to an empty output directory for subsequent loops",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (raw === "off" || raw === "none") {
        activeArtifactWorkspace = undefined;
        activeArtifactCommands = false;
        ctx.ui.setStatus("lightningloop-artifacts", undefined);
        ctx.ui.notify("Artifact mode is off. Subsequent loops are text-only.", "info");
        return;
      }
      const verify = raw.endsWith(" --verify");
      const pathInput = verify ? raw.slice(0, -" --verify".length).trim() : raw;
      if (!pathInput) {
        ctx.ui.notify("Usage: /artifacts /absolute/empty/output/directory [--verify] or /artifacts off", "warning");
        return;
      }
      if (verify && pi.getFlag("lightningloop-execution") === true) {
        ctx.ui.notify("Artifact verification cannot be combined with the general --allow-execution sandbox in one TUI session.", "error");
        return;
      }
      const selected = resolve(pathInput);
      try {
        await WorkspaceArtifactExecutor.create(selected, verify);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Artifact workspace was rejected.", "error");
        return;
      }
      const approved = await ctx.ui.confirm(
        "Grant this run capability?",
        `Directory: ${selected}\n\nLightningLoop may create and revise only run-owned UTF-8 files in this currently empty directory.${verify ? " It may also run bounded checks, generated scripts, loopback HTML proof, and local static picture capture in the confined Evidence Lab. External network and ambient credentials remain denied." : " Code execution and HTML picture capture remain disabled."}\n\nThe grant remains active for subsequent /loop commands in this TUI session until /artifacts off.`,
      );
      if (!approved) {
        ctx.ui.notify("Artifact capability was not granted.", "warning");
        return;
      }
      activeArtifactWorkspace = selected;
      activeArtifactCommands = verify;
      ctx.ui.setStatus("lightningloop-artifacts", verify ? "Evidence Lab · tests + previews" : "artifact writes · no execution");
      ctx.ui.notify(`Artifact mode enabled for ${basename(selected)}. Existing content remains protected by the empty-directory gate.`, "info");
    },
  });

  pi.registerCommand("memory", {
    description: "List the protected user-managed memory ledger",
    handler: async (_args, ctx) => {
      try {
        const records = listManagedMemory();
        assertNoConfiguredCredential(records.flatMap((record) => [record.statement, record.sourceArtifact, ...record.tags]), profile);
        const content = records.length === 0
          ? "# LightningLoop memory\n\nNo entries. Durable memory is never inferred or promoted silently."
          : `# LightningLoop memory\n\n${records.map((record) => {
              const status = record.scope === "run"
                ? "run-bound"
                : record.promotionApprovedByUser ? "eligible" : "inactive — promotion required";
              return `- **${terminalSafe(record.scope)} · ${status}** · \`${record.id}\`\n  ${terminalSafe(record.statement)}\n  Source: ${terminalSafe(record.sourceArtifact)}`;
            }).join("\n")}`;
        pi.sendMessage({ customType: "lightningloop-memory", content, display: true }, { triggerTurn: false });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Memory loading failed closed.", "error");
      }
    },
  });

  pi.registerCommand("memory-add", {
    description: "Add inactive project or user memory without silently promoting it",
    handler: async (args, ctx) => {
      const scope = args.trim().toLowerCase();
      if (scope !== "project" && scope !== "user") {
        ctx.ui.notify("Usage: /memory-add project|user", "warning");
        return;
      }
      const statement = (await ctx.ui.editor("Memory statement (secrets are prohibited)"))?.trim();
      if (!statement) return;
      const source = (await ctx.ui.editor("Source or artifact"))?.trim() || "User-provided note";
      const tagText = (await ctx.ui.editor("Tags, comma separated (optional)"))?.trim() || "";
      try {
        assertNoConfiguredCredential([statement, source, tagText], profile);
        const record = addManagedMemory({
          scope,
          statement,
          sourceArtifact: source,
          tags: tagText.split(",").map((tag) => tag.trim()).filter(Boolean),
        });
        ctx.ui.notify(`Memory ${record.id} was added inactive. Use /memory-promote ${record.id} after reviewing it.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Memory was not saved.", "error");
      }
    },
  });

  pi.registerCommand("memory-promote", {
    description: "Explicitly approve one project or user memory for future runs",
    handler: async (args, ctx) => {
      const id = args.trim();
      let record;
      try {
        record = listManagedMemory().find((item) => item.id === id);
        if (record) assertNoConfiguredCredential([record.statement, record.sourceArtifact, ...record.tags], profile);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Memory loading failed closed.", "error");
        return;
      }
      if (!record) {
        ctx.ui.notify("Usage: /memory-promote MEMORY_UUID", "warning");
        return;
      }
      const approved = await ctx.ui.confirm(
        "Promote durable memory?",
        `${record.statement}\n\nScope: ${record.scope}\nSource: ${record.sourceArtifact}\n\nIf approved, this user-managed context may enter future runs. It remains untrusted context and cannot override system policy.`,
      );
      if (!approved) return;
      try {
        approveManagedMemory(id);
        ctx.ui.notify("Memory promotion approved. It is eligible for future runs.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Memory promotion failed.", "error");
      }
    },
  });

  pi.registerCommand("memory-delete", {
    description: "Delete one local memory entry after confirmation",
    handler: async (args, ctx) => {
      const id = args.trim();
      let record;
      try {
        record = listManagedMemory().find((item) => item.id === id);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Memory loading failed closed.", "error");
        return;
      }
      if (!record) {
        ctx.ui.notify("Usage: /memory-delete MEMORY_UUID", "warning");
        return;
      }
      const approved = await ctx.ui.confirm("Delete local memory?", `Entry: ${record.id}\n\nThis removes the entry from LightningLoop's local ledger without displaying its stored content.`);
      if (!approved) return;
      try {
        deleteManagedMemory(id);
        ctx.ui.notify("Memory deleted from the local ledger.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Memory deletion failed.", "error");
      }
    },
  });

  pi.registerCommand("desire", {
    description: "List global (user) and current-project desires/preferences",
    handler: async (_args, ctx) => {
      try {
        const projectID = deriveProjectIdentity(process.cwd()).id;
        const desires = listManagedMemory().filter((record) => record.kind === "desire");
        assertNoConfiguredCredential(desires.flatMap((record) => [record.statement, record.sourceArtifact, ...record.tags]), profile);
        const inScope = desires.filter((record) => record.scope === "user" || record.projectID === undefined || record.projectID === projectID);
        const content = inScope.length === 0
          ? `# LightningLoop desires\n\nNo global or project desires for this project (\`${projectID}\`). Nothing is promoted silently.`
          : `# LightningLoop desires · project \`${projectID}\`\n\n${inScope.map((record) => {
              const where = record.scope === "user" ? "global" : `project ${record.projectID ?? "(any)"}`;
              const status = record.promotionApprovedByUser ? "eligible" : "inactive — promotion required";
              return `- **${where} · ${status}** · \`${record.id}\`\n  ${terminalSafe(record.statement)}`;
            }).join("\n")}`;
        pi.sendMessage({ customType: "lightningloop-desire", content, display: true }, { triggerTurn: false });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Desire loading failed closed.", "error");
      }
    },
  });

  pi.registerCommand("desire-add", {
    description: "Capture a global (user) or current-project desire without silently promoting it",
    handler: async (args, ctx) => {
      const target = args.trim().toLowerCase();
      if (target !== "global" && target !== "project") {
        ctx.ui.notify("Usage: /desire-add global|project", "warning");
        return;
      }
      const statement = (await ctx.ui.editor("Desire / preference (secrets are prohibited)"))?.trim();
      if (!statement) return;
      try {
        assertNoConfiguredCredential([statement], profile);
        const scope = target === "global" ? "user" : "project";
        const projectID = target === "project" ? deriveProjectIdentity(process.cwd()).id : undefined;
        const record = addManagedMemory({
          scope,
          kind: "desire",
          statement,
          sourceArtifact: target === "global" ? "User desire (global)" : "User desire (project)",
          ...(projectID ? { projectID } : {}),
        });
        ctx.ui.notify(`Desire ${record.id} captured inactive${projectID ? ` for project ${projectID}` : " globally"}. Use /memory-promote ${record.id} to make it eligible.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Desire was not saved.", "error");
      }
    },
  });

  pi.registerCommand("evolution", {
    description: "List prompt, skill, tool, MCP, and memory-policy proposals",
    handler: async (_args, ctx) => {
      try {
        const records = listManagedEvolutions();
        assertNoConfiguredCredential(records.flatMap((record) => [record.name, record.source, record.reason, record.exactDiff, record.evaluationSummary ?? "", record.rollbackTarget ?? "", ...record.permissions]), profile);
        const content = records.length === 0
          ? "# LightningLoop evolution\n\nNo proposals. Changes begin inert and require the complete reviewed lifecycle before activation."
          : `# LightningLoop evolution\n\n${records.map((record) => `- **${terminalSafe(record.name)}** · ${record.kind} · ${record.state} · \`${record.id}\`\n  ${terminalSafe(record.reason || "No rationale recorded.")}`).join("\n")}`;
        pi.sendMessage({ customType: "lightningloop-evolution", content, display: true }, { triggerTurn: false });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Evolution loading failed closed.", "error");
      }
    },
  });

  pi.registerCommand("evolution-propose", {
    description: "Create an inert evolution draft for the strict review lifecycle",
    handler: async (args, ctx) => {
      const kind = args.trim().toLowerCase() as ManagedEvolutionKind;
      if (!["system_prompt", "skill", "tool", "mcp", "memory_policy"].includes(kind)) {
        ctx.ui.notify("Usage: /evolution-propose system_prompt|skill|tool|mcp|memory_policy", "warning");
        return;
      }
      const name = (await ctx.ui.editor("Proposal name"))?.trim();
      if (!name) return;
      const source = (await ctx.ui.editor("Source or research reference"))?.trim() || "User-provided";
      const reason = (await ctx.ui.editor("Why this change is needed"))?.trim() || "";
      const exactDiff = (await ctx.ui.editor("Exact prompt addendum, skill guidance, or capability proposal (secrets prohibited)"))?.trim();
      if (!exactDiff) return;
      try {
        assertNoConfiguredCredential([name, source, reason, exactDiff], profile);
        const record = proposeManagedEvolution({ kind, name, source, reason, exactDiff });
        ctx.ui.notify(`Draft ${record.id} created. It is inert until source review, testing, adversarial review, explicit approval, and activation.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Evolution draft was not saved.", "error");
      }
    },
  });

  pi.registerCommand("evolution-evidence", {
    description: "Record bounded evaluation, rollback, permission, and reviewer evidence",
    handler: async (args, ctx) => {
      const id = args.trim();
      const record = listManagedEvolutions().find((item) => item.id === id);
      if (!record) {
        ctx.ui.notify("Usage: /evolution-evidence EVOLUTION_UUID", "warning");
        return;
      }
      const evaluationSuite = (await ctx.ui.editor("Named evaluation suite"))?.trim();
      if (!evaluationSuite) return;
      const evaluationSummary = (await ctx.ui.editor("Observed evaluation result"))?.trim() || "";
      const rollbackTarget = (await ctx.ui.editor("Exact rollback target or procedure"))?.trim() || "";
      const permissionText = (await ctx.ui.editor("Requested permissions, comma separated (documentation only; grants nothing)"))?.trim() || "";
      const materialFinding = await ctx.ui.confirm(
        "Record a material finding?",
        "Choose Yes only if harsh review found an unresolved material issue. Such a finding blocks approval and activation.",
      );
      try {
        assertNoConfiguredCredential([evaluationSuite, evaluationSummary, rollbackTarget, permissionText], profile);
        updateManagedEvolutionEvidence(id, {
          evaluationSuite,
          evaluationSummary,
          rollbackTarget,
          permissions: permissionText.split(",").map((item) => item.trim()).filter(Boolean),
          reviewerHasMaterialFinding: materialFinding,
        });
        ctx.ui.notify(materialFinding ? "Evidence saved with a blocking material finding." : "Evolution evidence saved.", materialFinding ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Evolution evidence was not saved.", "error");
      }
    },
  });

  pi.registerCommand("evolution-advance", {
    description: "Advance exactly one reviewed lifecycle state after confirmation",
    handler: async (args, ctx) => {
      const id = args.trim();
      const record = listManagedEvolutions().find((item) => item.id === id);
      if (!record) {
        ctx.ui.notify("Usage: /evolution-advance EVOLUTION_UUID", "warning");
        return;
      }
      const nextLabels: Record<string, string> = {
        draft: "source reviewed",
        source_reviewed: "sandbox tested",
        sandbox_tested: "adversarially reviewed",
        adversarially_reviewed: "user approved",
        user_approved: "active",
        active: "superseded",
      };
      const next = nextLabels[record.state];
      if (!next) {
        ctx.ui.notify("This proposal has no next lifecycle state.", "warning");
        return;
      }
      const approved = await ctx.ui.confirm(
        `Advance to ${next}?`,
        `${record.name}\n\nCurrent state: ${record.state}\nNext state: ${next}\n\nThis command advances exactly one state. Tool and MCP entries remain separately integrity- and permission-gated even when active.`,
      );
      if (!approved) return;
      try {
        const updated = advanceManagedEvolution(id);
        ctx.ui.notify(`Evolution moved to ${updated.state}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Evolution transition failed.", "error");
      }
    },
  });

  pi.registerCommand("evolution-rollback", {
    description: "Fail closed by rolling back one evolution after confirmation",
    handler: async (args, ctx) => {
      const id = args.trim();
      const record = listManagedEvolutions().find((item) => item.id === id);
      if (!record) {
        ctx.ui.notify("Usage: /evolution-rollback EVOLUTION_UUID", "warning");
        return;
      }
      const approved = await ctx.ui.confirm("Roll back evolution?", `${record.name}\n\nThis makes the proposal ineligible for active use.`);
      if (!approved) return;
      try {
        rollbackManagedEvolution(id);
        ctx.ui.notify("Evolution rolled back and removed from active guidance.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? terminalSafe(error.message) : "Evolution rollback failed.", "error");
      }
    },
  });

  pi.registerCommand("loop-policy", {
    description: "Show the active LightningLoop capability policy",
    handler: async (_args, ctx) => {
      const mode = pi.getFlag("lightningloop-execution") === true ? "confirmed execution" : "read-only";
      const artifacts = activeArtifactWorkspace
        ? ` Artifact output: ${activeArtifactWorkspace}; ${activeArtifactCommands ? "structured verification enabled" : "commands disabled"}.`
        : " Artifact output: text-only.";
      ctx.ui.notify(`Policy: ${mode}. Workspace-confined. Credentials remain in Keychain.${artifacts}`, "info");
    },
  });

  pi.registerCommand("loop-help", {
    description: "Show the LightningLoop quick start",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Pin /agents select researcher|engineer|verifier MODEL. Browse a reputable page with /browse URL. Queue images with /image, choose /research free, and use /artifacts /empty/output [--verify] for run-owned files. Run /loop <goal>. Capture /desire. Govern /memory and /evolution. /loop-cancel stops the run.",
        "info",
      );
    },
  });

  pi.registerCommand("exit", {
    description: "Exit LightningLoop (alias for /quit)",
    handler: async (_args, ctx) => ctx.shutdown(),
  });
  };
}

export const lightningLoopExtension: ExtensionFactory = createLightningLoopExtension();

export default lightningLoopExtension;
