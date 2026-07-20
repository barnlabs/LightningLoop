import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { scrubSensitiveEnvironment } from "../core/environment.js";

const MAX_EXECUTION_SECONDS = 120;
const PROCESS_SAMPLE_INTERVAL_MS = 20;
const QUIESCENCE_EMPTY_SAMPLES = 5;
const TERMINATION_GRACE_MS = 150;
const TERMINATION_DEADLINE_MS = 1_000;
const PROCESS_INSPECTION_TIMEOUT_MS = 30_000;
const ALLOW_PROCESS_FORK_RULE = "(allow process-fork)";
const DENY_PROCESS_FORK_RULE = "(deny process-fork)";

interface ProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
}

function processTable(): Promise<ProcessRecord[]> {
  if (process.platform === "win32") return Promise.resolve([]);
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,state="],
      {
        timeout: PROCESS_INSPECTION_TIMEOUT_MS,
        maxBuffer: 2 * 1_048_576,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(new Error(`Unable to inspect verifier descendants: ${error.message}`));
          return;
        }
        const records: ProcessRecord[] = [];
        for (const line of stdout.split(/\r?\n/u)) {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
          if (!match) continue;
          records.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            state: match[4] ?? "",
          });
        }
        resolvePromise(records);
      },
    );
  });
}

function workspaceProcessIDs(workspace: string): Promise<number[]> {
  if (process.platform !== "darwin" || !existsSync("/usr/sbin/lsof")) return Promise.resolve([]);
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "/usr/sbin/lsof",
      ["-a", "-d", "cwd", "-Fn", "--", workspace],
      {
        timeout: PROCESS_INSPECTION_TIMEOUT_MS,
        maxBuffer: 1_048_576,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
      (error, stdout) => {
        // lsof exits 1 when there are no matches. Any output is still parsed;
        // other failures make quiescence unprovable rather than silently safe.
        if (error && stdout.length === 0 && "code" in error && error.code !== 1) {
          rejectPromise(new Error(`Unable to inspect verifier working directories: ${error.message}`));
          return;
        }
        resolvePromise(stdout.split(/\r?\n/u)
          .map((line) => /^p(\d+)$/u.exec(line)?.[1])
          .filter((pid): pid is string => pid !== undefined)
          .map(Number));
      },
    );
  });
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1 || pid === process.pid) return;
  try { process.kill(pid, signal); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (pgid <= 1 || pgid === process.pid) return;
  try { process.kill(-pgid, signal); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * Tracks only the process tree and dedicated-workspace holders created by one
 * verifier. It deliberately never scans process command lines or environments,
 * which could disclose unrelated credentials, and it never signals an
 * unassociated system-wide name match.
 */
class VerificationProcessTracker {
  private readonly known = new Set<number>();
  private sampling: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private inspectionError?: Error;

  constructor(
    private readonly rootPID: number,
    private readonly workspace: string,
    private readonly inspectWorkspaceHolders: boolean,
  ) {
    this.known.add(rootPID);
  }

  start(): void {
    const schedule = (): void => {
      if (this.stopped) return;
      this.sampling = this.sample()
        .then(() => undefined)
        .catch((error) => { this.inspectionError = error instanceof Error ? error : new Error(String(error)); })
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(schedule, PROCESS_SAMPLE_INTERVAL_MS);
        });
    };
    schedule();
  }

  requestTermination(): void {
    signalProcessGroup(this.rootPID, "SIGKILL");
    for (const pid of this.known) signalProcess(pid, "SIGKILL");
  }

  private async sample(): Promise<ProcessRecord[]> {
    const records = await processTable();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const record of records) {
        if ((record.pgid === this.rootPID || this.known.has(record.ppid)) && !this.known.has(record.pid)) {
          this.known.add(record.pid);
          expanded = true;
        }
      }
    }
    return records;
  }

  private async liveTargets(): Promise<number[]> {
    const workspacePIDs = this.inspectWorkspaceHolders ? await workspaceProcessIDs(this.workspace) : [];
    for (const pid of workspacePIDs) this.known.add(pid);
    const records = await this.sample();
    return records
      .filter((record) => !record.state.startsWith("Z"))
      .filter((record) => record.pgid === this.rootPID || this.known.has(record.pid) || workspacePIDs.includes(record.pid))
      .map((record) => record.pid)
      .filter((pid) => pid > 1 && pid !== process.pid);
  }

  async quiesce(): Promise<boolean> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.sampling;
    if (this.inspectionError) throw this.inspectionError;

    let targets: number[] = [];
    let emptySamples = 0;
    while (emptySamples < QUIESCENCE_EMPTY_SAMPLES) {
      targets = await this.liveTargets();
      if (targets.length > 0) break;
      emptySamples += 1;
      if (emptySamples < QUIESCENCE_EMPTY_SAMPLES) await delay(10);
    }
    const hadResidualDescendants = targets.some((pid) => pid !== this.rootPID);
    if (targets.length === 0) return false;

    signalProcessGroup(this.rootPID, "SIGTERM");
    for (const pid of targets) signalProcess(pid, "SIGTERM");
    const graceDeadline = performance.now() + TERMINATION_GRACE_MS;
    while (targets.length > 0 && performance.now() < graceDeadline) {
      await delay(10);
      targets = await this.liveTargets();
    }

    if (targets.length > 0) {
      signalProcessGroup(this.rootPID, "SIGKILL");
      for (const pid of targets) signalProcess(pid, "SIGKILL");
    }
    const deadline = performance.now() + TERMINATION_DEADLINE_MS;
    while (targets.length > 0 && performance.now() < deadline) {
      await delay(10);
      targets = await this.liveTargets();
    }
    if (targets.length > 0) {
      throw new Error(`Verifier process quiescence could not be proven for ${targets.length} bounded descendant process${targets.length === 1 ? "" : "es"}.`);
    }
    return hadResidualDescendants;
  }
}

export class SandboxedBashRuntime {
  private initialized = false;
  private readonly activeExecutions = new Set<VerificationProcessTracker>();

  constructor(
    readonly workspace: string,
    readonly options: {
      allowedDomains?: string[];
      allowWorkspaceWrite?: boolean;
      tempDirectory?: string;
      allowedReadPaths?: string[];
      dedicatedWorkspace?: boolean;
      denyProcessFork?: boolean;
    } = {},
  ) {}

  private async wrap(command: string): Promise<string> {
    if (!this.options.tempDirectory) {
      return this.hardenProcessForkRule(await SandboxManager.wrapWithSandbox(command));
    }
    const previous = process.env.CLAUDE_CODE_TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = this.options.tempDirectory;
    try {
      return this.hardenProcessForkRule(await SandboxManager.wrapWithSandbox(command));
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = previous;
    }
  }

  private hardenProcessForkRule(wrappedCommand: string): string {
    if (this.options.denyProcessFork !== true) return wrappedCommand;
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
      throw new Error("Autonomous verification requires deterministic descendant containment, which is unavailable on this platform.");
    }
    const ruleIndex = wrappedCommand.indexOf(ALLOW_PROCESS_FORK_RULE);
    if (ruleIndex < 0) {
      throw new Error("Sandbox Runtime did not expose its expected process-fork rule; autonomous verification is blocked.");
    }
    // Seatbelt cannot apply a second profile from an already sandboxed
    // process. Compose the per-command restriction into Sandbox Runtime's
    // generated profile instead. Exact-rule replacement can only remove
    // authority and fails closed if the pinned runtime changes its contract.
    return `${wrappedCommand.slice(0, ruleIndex)}${DENY_PROCESS_FORK_RULE}${wrappedCommand.slice(ruleIndex + ALLOW_PROCESS_FORK_RULE.length)}`;
  }

  async initialize(): Promise<void> {
    const config: SandboxRuntimeConfig = {
      network: {
        allowedDomains: this.options.allowedDomains ?? [],
        deniedDomains: [],
        strictAllowlist: true,
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: [homedir(), "/Volumes"],
        allowRead: [this.workspace, ...(this.options.allowedReadPaths ?? [])],
        allowWrite: this.options.allowWorkspaceWrite === false ? [] : [this.workspace],
        denyWrite: [
          join(this.workspace, ".git"),
          join(this.workspace, ".env"),
          join(this.workspace, ".env.*"),
          join(this.workspace, "*.pem"),
          join(this.workspace, "*.key"),
        ],
        allowGitConfig: false,
      },
    };
    await SandboxManager.initialize(config);
    this.initialized = true;
  }

  operations(): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        if (!this.initialized) throw new Error("LightningLoop sandbox is not initialized; execution is blocked.");
        if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
        const wrapped = await this.wrap(command);
        const environment = { ...(options.env ?? {}) };
        scrubSensitiveEnvironment(environment);
        const seconds = Math.min(Math.max(options.timeout ?? MAX_EXECUTION_SECONDS, 1), MAX_EXECUTION_SECONDS);

        return new Promise((resolve, reject) => {
          const child = spawn("/bin/bash", ["-c", wrapped], {
            cwd,
            env: environment,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          if (!child.pid) {
            reject(new Error("Sandboxed verifier did not receive a process identifier; execution is blocked."));
            return;
          }
          const tracker = new VerificationProcessTracker(child.pid, this.workspace, this.options.dedicatedWorkspace === true);
          this.activeExecutions.add(tracker);
          tracker.start();
          let timedOut = false;
          let settled = false;
          const terminate = () => {
            tracker.requestTermination();
          };
          const timer = setTimeout(() => {
            timedOut = true;
            terminate();
          }, seconds * 1_000);
          const abort = () => terminate();
          options.signal?.addEventListener("abort", abort, { once: true });
          child.stdout?.on("data", options.onData);
          child.stderr?.on("data", options.onData);
          const finish = async (error: Error | undefined, code: number | null): Promise<void> => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            try {
              const leftDescendants = await tracker.quiesce();
              this.activeExecutions.delete(tracker);
              if (options.signal?.aborted) reject(new DOMException("Sandboxed command cancelled.", "AbortError"));
              else if (timedOut) reject(new Error(`Sandboxed command exceeded ${seconds} seconds.`));
              else if (error) reject(error);
              else if (leftDescendants) {
                options.onData(Buffer.from("Verifier left descendant processes running; they were terminated and proof is rejected for failed quiescence.\n", "utf8"));
                resolve({ exitCode: code === 0 ? 125 : code });
              } else resolve({ exitCode: code });
            } catch (quiescenceError) {
              this.activeExecutions.delete(tracker);
              reject(quiescenceError);
            }
          };
          child.once("error", (error) => {
            void finish(error, null);
          });
          child.once("close", (code) => {
            void finish(undefined, code);
          });
        });
      },
    };
  }

  async wrapCommand(command: string): Promise<string> {
    if (!this.initialized) throw new Error("LightningLoop sandbox is not initialized; execution is blocked.");
    return this.wrap(command);
  }

  restrictedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment = { ...source };
    scrubSensitiveEnvironment(environment);
    return environment;
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    const failures: Error[] = [];
    for (const execution of this.activeExecutions) {
      execution.requestTermination();
      try { await execution.quiesce(); }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      this.activeExecutions.delete(execution);
    }
    await SandboxManager.reset();
    if (failures.length > 0) throw new AggregateError(failures, "Sandbox shutdown could not prove verifier process quiescence.");
  }
}
