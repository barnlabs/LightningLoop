import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  realpath,
  readlink,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ArtifactExecutionReport,
  ArtifactExecutor,
  ArtifactFileDraft,
  ArtifactPreviewEvidence,
  ImplementationDraft,
  VerificationCommandDraft,
  VerificationCommandEvidence,
} from "../core/loop-types.js";
import { SecretRedactor } from "../core/redaction.js";
import type { AgentImage } from "../core/image-input.js";
import type { Criterion } from "../core/schema.js";
import { SandboxedBashRuntime } from "../sandbox/sandboxed-bash.js";

const MAX_FILES_PER_ROUND = 32;
const MAX_FILE_BYTES = 131_072;
const MAX_MANIFEST_BYTES = 524_288;
const MAX_COMMANDS_PER_ROUND = 4;
const MAX_COMMANDS_PER_RUN = 16;
const MAX_COMMAND_OUTPUT_BYTES = 65_536;
const MAX_WORKSPACE_FILES = 2_048;
const MAX_WORKSPACE_BYTES = 134_217_728;
const MAX_WORKSPACE_ENTRIES = MAX_WORKSPACE_FILES * 2;
const MAX_COMMAND_SECONDS = 60;
const MAX_AUTOMATIC_COMMANDS_PER_ROUND = 4;
const MAX_PREVIEWS_PER_ROUND = 6;
const MAX_PREVIEW_BYTES = 10 * 1_048_576;

const PREVIEW_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const ALLOWED_EXECUTABLES = new Set([
  "node",
  "npm",
  "swift",
  "xcodebuild",
  "python3",
  "pytest",
  "cargo",
  "go",
  "ruby",
  "bundle",
  "make",
  "cmake",
]);

interface RustToolchain {
  binDirectory: string;
  rootDirectory: string;
}

interface WorkspaceManifestRecord {
  path: string;
  type: "directory" | "file" | "symbolic-link" | "special";
  mode: number;
  bytes: number;
  sha256?: string;
}

interface WorkspaceManifestSnapshot {
  root: {
    path: string;
    device: string;
    inode: string;
    mode: number;
  };
  entries: WorkspaceManifestRecord[];
}

async function execFileText(file: string, arguments_: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(file, arguments_, { timeout: 5_000, maxBuffer: 16_384, env: environment }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout.trim());
    });
  });
}

async function discoverRustToolchain(): Promise<RustToolchain | undefined> {
  const environment = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  try {
    const candidate = await execFileText("/usr/bin/which", ["cargo"], environment);
    if (!candidate) return undefined;
    const resolvedCandidate = await realpath(candidate);
    if (!within(homedir(), resolvedCandidate)) return undefined;
    const rustup = basename(resolvedCandidate) === "rustup" ? resolvedCandidate : join(dirname(candidate), "rustup");
    const cargo = await execFileText(rustup, ["which", "cargo"], environment);
    const resolvedCargo = await realpath(cargo);
    if (!within(homedir(), resolvedCargo)) return undefined;
    const binDirectory = dirname(resolvedCargo);
    return { binDirectory, rootDirectory: dirname(binDirectory) };
  } catch {
    return undefined;
  }
}

export interface ArtifactSeed {
  path: string;
  data: Buffer;
  description: string;
}

export interface ArtifactTerminalRevalidation {
  passed: boolean;
  message: string;
}

function secretPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  return parts.some((part) =>
    part === ".git"
    || part === ".ssh"
    || part === ".aws"
    || part === ".gnupg"
    || part === ".env"
    || part.startsWith(".env.")
    || part.endsWith(".pem")
    || part.endsWith(".key")
    || part.includes("credential")
    || part.includes("secret"),
  );
}

function safeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").trim();
  if (!normalized || normalized.length > 240) throw new Error("Artifact paths must contain 1-240 characters.");
  if (isAbsolute(normalized) || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`Artifact path must be relative: ${input}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f]/u.test(part))) {
    throw new Error(`Artifact path contains an unsafe component: ${input}`);
  }
  if (secretPath(normalized)) throw new Error(`Credential-like artifact path is prohibited: ${input}`);
  return parts.join("/");
}

function within(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function directoryNotEmpty(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOTEMPTY" || error.code === "EEXIST");
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateCommand(command: VerificationCommandDraft): void {
  if (!ALLOWED_EXECUTABLES.has(command.executable)) {
    throw new Error(`Verification executable is not allowlisted: ${command.executable}`);
  }
  if (command.arguments.length > 32) throw new Error("A verification command may contain at most 32 arguments.");
  for (const argument of command.arguments) {
    if (argument.length > 500 || /[\u0000\r\n]/u.test(argument)) throw new Error("Verification command arguments must be bounded single-line values.");
    if (["--fix", "--write", "--write-mode", "--in-place", "-w"].includes(argument.toLowerCase())) {
      throw new Error("Autonomous verification must be non-mutating; fix/write-in-place flags are prohibited.");
    }
  }
  if (!command.purpose.trim() || command.purpose.length > 500) throw new Error("Verification commands require a bounded purpose.");
  if (command.mode !== undefined && command.mode !== "verify" && command.mode !== "generate") throw new Error("Command mode must be verify or generate.");
  if (command.assertionID !== undefined && (!command.assertionID.trim() || command.assertionID.length > 240 || /[\u0000\r\n]/u.test(command.assertionID))) {
    throw new Error("Verification assertion IDs must be bounded single-line values.");
  }
  if (command.expectedOutput !== undefined) {
    if (!command.assertionID) throw new Error("Expected output requires an explicit assertion ID.");
    if (!command.expectedOutput || command.expectedOutput.length > 500 || /[\u0000\r\n]/u.test(command.expectedOutput)) {
      throw new Error("Expected verification output must be a bounded nonempty single line.");
    }
  }
}

function injectPreviewCSP(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (head?.index !== undefined) {
    const insertion = head.index + head[0].length;
    return `${html.slice(0, insertion)}${meta}${html.slice(insertion)}`;
  }
  const root = /<html(?:\s[^>]*)?>/iu.exec(html);
  if (root?.index !== undefined) {
    const insertion = root.index + root[0].length;
    return `${html.slice(0, insertion)}<head>${meta}</head>${html.slice(insertion)}`;
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

function pngDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return undefined;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function imageMimeType(path: string, data: Buffer): AgentImage["mimeType"] | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png") && pngDimensions(data)) return "image/png";
  if ((lower.endsWith(".jpg") || lower.endsWith(".jpeg")) && data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (lower.endsWith(".gif") && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (lower.endsWith(".webp") && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export class WorkspaceArtifactExecutor implements ArtifactExecutor {
  readonly allowVerificationCommands: boolean;
  private readonly ownedPaths = new Set<string>();
  private readonly ownedDirectories = new Set<string>();
  private readonly protectedPaths = new Set<string>();
  private readonly protectedHashes = new Map<string, string>();
  private readonly redactor = new SecretRedactor();
  private commandCount = 0;
  private lastPassingReportManifest: WorkspaceManifestSnapshot | undefined;

  private constructor(
    private readonly root: string,
    allowVerificationCommands: boolean,
    private readonly seedDescriptions: readonly string[],
  ) {
    this.allowVerificationCommands = allowVerificationCommands;
  }

  static async create(
    workspace: string,
    allowVerificationCommands = false,
    seeds: readonly ArtifactSeed[] = [],
  ): Promise<WorkspaceArtifactExecutor> {
    const requested = resolve(workspace);
    if (requested === resolve("/") || requested === resolve(homedir())) {
      throw new Error("Artifact workspace cannot be the filesystem root or the user home directory.");
    }
    const info = await lstat(requested).catch(() => undefined);
    if (!info) throw new Error("Artifact workspace must already exist as an empty directory.");
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Artifact workspace must be a real directory, not a link or file.");
    const root = await realpath(requested);
    const entries = await readdir(root);
    if (entries.length > 0) throw new Error("Artifact workspace must be empty so the run cannot overwrite existing work.");
    await chmod(root, 0o700);
    const executor = new WorkspaceArtifactExecutor(root, allowVerificationCommands, seeds.map((seed) => `${seed.path}: ${seed.description}`));
    for (const seed of seeds) {
      const path = safeRelativePath(seed.path);
      if (seed.data.length < 1 || seed.data.length > 10 * 1_048_576) throw new Error(`Protected input has an invalid size: ${path}`);
      await executor.writeOwnedFile(path, seed.data);
      executor.protectedPaths.add(path);
      executor.protectedHashes.set(path, createHash("sha256").update(seed.data).digest("hex"));
    }
    return executor;
  }

  describe(): string {
    const base = this.allowVerificationCommands
      ? "dedicated empty workspace; atomic UTF-8 artifact writes; structured allowlisted verification commands in the network-denied OS sandbox"
      : "dedicated empty workspace; atomic UTF-8 artifact writes; command execution disabled";
    return this.seedDescriptions.length === 0 ? base : `${base}. Protected harness inputs: ${this.seedDescriptions.join("; ")}`;
  }

  async apply(implementation: ImplementationDraft, signal?: AbortSignal, criteria: readonly Criterion[] = []): Promise<ArtifactExecutionReport> {
    // A new round invalidates the prior run-bound terminal proof immediately,
    // including when validation below throws or the new report fails.
    this.lastPassingReportManifest = undefined;
    signal?.throwIfAborted();
    const rootInfo = await lstat(this.root).catch(() => undefined);
    if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(this.root) !== this.root) {
      throw new Error("Artifact workspace changed identity after approval; execution is blocked.");
    }
    const files = implementation.files;
    const commands = implementation.verificationCommands;
    if (files.length < 1) throw new Error("Artifact mode requires at least one declared file.");
    if (files.length > MAX_FILES_PER_ROUND) throw new Error(`A round may write at most ${MAX_FILES_PER_ROUND} files.`);
    if (commands.length > MAX_COMMANDS_PER_ROUND) throw new Error(`A round may run at most ${MAX_COMMANDS_PER_ROUND} verification commands.`);
    if (commands.length > 0 && !this.allowVerificationCommands) throw new Error("Verification commands were requested without an explicit command capability grant.");
    if (this.commandCount + commands.length > MAX_COMMANDS_PER_RUN) throw new Error(`A run may execute at most ${MAX_COMMANDS_PER_RUN} verification commands.`);
    this.redactor.assertSafe({ files, commands });

    const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
    if (totalBytes > MAX_MANIFEST_BYTES) throw new Error(`Artifact manifest exceeds ${MAX_MANIFEST_BYTES} UTF-8 bytes.`);
    const seen = new Set<string>();
    const manifest: Array<{ path: string; encoded: Buffer }> = [];
    const declaredFileEvidence: ArtifactExecutionReport["files"] = [];
    for (const file of files) {
      signal?.throwIfAborted();
      const path = safeRelativePath(file.path);
      if (path.startsWith("_lightningloop/")) throw new Error("The _lightningloop directory is reserved for harness-generated evidence.");
      if (seen.has(path)) throw new Error(`Artifact manifest repeats path: ${path}`);
      seen.add(path);
      const encoded = Buffer.from(file.content, "utf8");
      if (encoded.length > MAX_FILE_BYTES) throw new Error(`Artifact file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
      manifest.push({ path, encoded });
      declaredFileEvidence.push({ path, bytes: encoded.length, sha256: createHash("sha256").update(encoded).digest("hex") });
    }
    await this.reconcileManifest(seen);
    for (const file of manifest) {
      signal?.throwIfAborted();
      await this.writeOwnedFile(file.path, file.encoded);
    }

    const automaticCommands = this.allowVerificationCommands
      ? await this.automaticVerificationCommands(commands, criteria)
      : [];
    if (automaticCommands.length > MAX_AUTOMATIC_COMMANDS_PER_ROUND) {
      throw new Error(`The harness selected more than ${MAX_AUTOMATIC_COMMANDS_PER_ROUND} automatic verification commands.`);
    }
    if (this.commandCount + commands.length + automaticCommands.length > MAX_COMMANDS_PER_RUN) {
      throw new Error(`A run may execute at most ${MAX_COMMANDS_PER_RUN} verification commands.`);
    }

    const commandEvidence: VerificationCommandEvidence[] = [];
    if (commands.length > 0 || automaticCommands.length > 0) {
      await mkdir(join(this.root, ".lightningloop-tmp"), { recursive: true, mode: 0o700 });
      const needsRust = [...commands, ...automaticCommands].some((command) => command.executable === "cargo");
      const rustToolchain = needsRust ? await discoverRustToolchain() : undefined;
      const runtime = new SandboxedBashRuntime(this.root, {
        tempDirectory: join(this.root, ".lightningloop-tmp"),
        allowedReadPaths: rustToolchain ? [rustToolchain.rootDirectory] : [],
        dedicatedWorkspace: true,
        denyProcessFork: true,
      });
      try {
        await runtime.initialize();
        for (const command of commands) {
          signal?.throwIfAborted();
          await this.assertProtectedInputs();
          validateCommand(command);
          if (command.mode === "generate" && !this.isTrustedGeneratorCommand(command)) throw new Error("Generate mode is limited to a pinned harness-owned artifact generator.");
          this.commandCount += 1;
          commandEvidence.push(await this.runImmutableCommand(runtime, command, "implementer", rustToolchain, signal));
        }
        for (const command of automaticCommands) {
          signal?.throwIfAborted();
          try { await this.assertProtectedInputs(); }
          catch { break; }
          validateCommand(command);
          this.commandCount += 1;
          commandEvidence.push(await this.runImmutableCommand(runtime, command, "harness", rustToolchain, signal));
        }
      } finally {
        await runtime.shutdown();
      }
    }

    const previews = await this.collectPreviewEvidence(signal);
    let audit = await this.auditWorkspace();
    const auditedManifest = audit.passed ? await this.workspaceManifestSnapshot() : undefined;
    const workspacePaths = await this.workspacePaths();
    if (audit.passed) await this.adoptAuditedWorkspace();
    const executableProofComplete = this.executableProofComplete(workspacePaths, commandEvidence);
    let fileEvidence = audit.passed ? await this.collectWorkspaceEvidence() : declaredFileEvidence;
    let terminalManifest: WorkspaceManifestSnapshot | undefined;
    if (audit.passed && auditedManifest) {
      terminalManifest = await this.workspaceManifestSnapshot();
      if (JSON.stringify(auditedManifest) !== JSON.stringify(terminalManifest)) {
        audit = {
          passed: false,
          files: audit.files,
          bytes: audit.bytes,
          message: "Workspace changed after its audit; terminal artifact proof is rejected.",
        };
        fileEvidence = declaredFileEvidence;
      }
    }
    const passed = audit.passed
      && commandEvidence.every((command) => command.passed)
      && previews.every((preview) => preview.passed)
      && executableProofComplete;
    if (passed && terminalManifest) this.lastPassingReportManifest = terminalManifest;
    return {
      enabled: true,
      passed,
      summary: passed
        ? `Verified ${fileEvidence.length} workspace file${fileEvidence.length === 1 ? "" : "s"}; ${commandEvidence.length} verification command${commandEvidence.length === 1 ? "" : "s"} and ${previews.length} preview${previews.length === 1 ? "" : "s"} passed.`
        : !executableProofComplete
          ? "Artifact verification failed: executable or TypeScript source requires a passing build, typecheck, test, lint, or bounded runtime proof."
          : "Artifact verification failed; inspect the command and workspace evidence.",
      files: fileEvidence,
      commands: commandEvidence,
      previews,
      workspaceAudit: audit,
    };
  }

  /**
   * Reopens the exact manifest captured by the most recent passing apply().
   * The graph runtime calls this after model-review latency and immediately
   * before any terminal award. A missing, failed, superseded, or changed run
   * always fails closed.
   */
  async revalidateLastReport(): Promise<ArtifactTerminalRevalidation> {
    const expected = this.lastPassingReportManifest;
    if (!expected) {
      return { passed: false, message: "No passing artifact report is available for terminal revalidation." };
    }
    try {
      const actual = await this.workspaceManifestSnapshot(expected);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        return { passed: false, message: "Artifact workspace changed after its passing report; terminal proof is rejected." };
      }
      return { passed: true, message: "Artifact root identity and exact entry manifest still match the last passing report." };
    } catch (error) {
      return {
        passed: false,
        message: this.redactor.redact(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      };
    }
  }

  private async workspacePaths(): Promise<string[]> {
    const paths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const relativePath = relative(this.root, absolute).split(sep).join("/");
        if (relativePath === ".lightningloop-tmp" || relativePath.startsWith(".lightningloop-tmp/")) continue;
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) paths.push(relativePath);
      }
    };
    await visit(this.root);
    return paths.sort();
  }

  private async adoptAuditedWorkspace(): Promise<void> {
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const path = relative(this.root, absolute).split(sep).join("/");
        if (path === ".lightningloop-tmp" || path.startsWith(".lightningloop-tmp/")) continue;
        if (entry.isDirectory()) {
          this.ownedDirectories.add(path);
          await visit(absolute);
        } else if (entry.isFile()) {
          this.ownedPaths.add(path);
        }
      }
    };
    await visit(this.root);
  }

  private async automaticVerificationCommands(
    _declared: readonly VerificationCommandDraft[],
    criteria: readonly Criterion[],
  ): Promise<VerificationCommandDraft[]> {
    const paths = await this.workspacePaths();
    const commands: VerificationCommandDraft[] = [];
    for (const python of paths.filter((path) => path.endsWith(".py"))) {
      commands.push({
        executable: "python3",
        arguments: ["-c", "import pathlib,sys; path=sys.argv[1]; compile(pathlib.Path(path).read_text(encoding='utf-8'), path, 'exec')", python],
        purpose: `Harness-selected Python syntax check for ${python}`,
        assertionID: `syntax:${python}`,
      });
    }
    for (const javascript of paths.filter((path) => /\.(?:cjs|mjs|js)$/u.test(path))) {
      commands.push({
        executable: "node",
        arguments: ["--check", javascript],
        purpose: `Harness-selected JavaScript syntax check for ${javascript}`,
        assertionID: `syntax:${javascript}`,
      });
    }
    if (paths.includes("Cargo.toml") && paths.includes("Cargo.lock")) {
      commands.push({
        executable: "cargo",
        arguments: ["test", "--offline", "--locked"],
        purpose: "Harness-selected offline Rust build and test",
        assertionID: "build:cargo",
      });
    }
    for (const criterion of criteria) {
      if (criterion.evidenceKind !== "behavior") continue;
      const match = /^js-export:([^#]+)#([A-Za-z_$][A-Za-z0-9_$]{0,63})=(.+)$/u.exec(criterion.evidenceTarget);
      if (!match) continue;
      const path = safeRelativePath(match[1]!);
      if (!/\.(?:mjs|js)$/u.test(path) || !paths.includes(path)) continue;
      let expected: unknown;
      try { expected = JSON.parse(match[3]!); } catch { continue; }
      if (expected !== null && !["string", "number", "boolean"].includes(typeof expected)) continue;
      const expectedOutput = `LIGHTNINGLOOP_ASSERT:${JSON.stringify(expected)}`;
      if (expectedOutput.length > 500) continue;
      commands.push({
        executable: "node",
        arguments: [
          "--no-warnings",
          "--experimental-vm-modules",
          "--input-type=module",
          "-e",
          "const{readFileSync:r,writeSync:w}=await import('node:fs'),v=await import('node:vm'),[p,n]=process.argv.slice(1),c=v.createContext({},{codeGeneration:{strings:false,wasm:false}}),m=new v.SourceTextModule(r(p,'utf8'),{context:c});await m.link(()=>{throw 0});await m.evaluate({timeout:3000});let x=m.namespace[n];x=typeof x=='function'?await x():x;if(x!==null&&!['string','number','boolean'].includes(typeof x))throw 0;w(1,'LIGHTNINGLOOP_ASSERT:'+JSON.stringify(x)+'\\n')",
          path,
          match[2]!,
        ],
        purpose: `Harness-owned assertion of ${match[2]} from ${path}`,
        assertionID: criterion.evidenceTarget,
        expectedOutput,
      });
    }
    return commands.slice(0, MAX_AUTOMATIC_COMMANDS_PER_ROUND);
  }

  private executableProofComplete(paths: readonly string[], commands: readonly VerificationCommandEvidence[]): boolean {
    const passedHarness = commands.filter((command) => command.passed && command.origin === "harness");
    return paths.every((path) => {
      if (/\.(?:cjs|mjs|js)$/u.test(path)) {
        return passedHarness.some((command) => command.executable === "node" && command.arguments[0] === "--check" && command.arguments[1] === path);
      }
      if (/\.py$/u.test(path)) {
        return passedHarness.some((command) => command.assertionID === `syntax:${path}`);
      }
      if (/\.rs$/u.test(path)) return paths.includes("Cargo.toml") && paths.includes("Cargo.lock") && passedHarness.some((command) => command.executable === "cargo" && command.arguments[0] === "test");
      // TypeScript and the remaining compiled languages require a real applicable
      // harness-selected compiler/build integration. An arbitrary passing user
      // command is deliberately insufficient.
      if (/\.(?:tsx?|go|rb|swift)$/u.test(path)) return false;
      return true;
    });
  }

  private async collectPreviewEvidence(signal?: AbortSignal): Promise<ArtifactPreviewEvidence[]> {
    signal?.throwIfAborted();
    const paths = await this.workspacePaths();
    const previews: ArtifactPreviewEvidence[] = [];
    const htmlPath = paths.find((path) => path === "index.html")
      ?? paths.find((path) => path.endsWith("/index.html"))
      ?? paths.find((path) => path.toLowerCase().endsWith(".html"));
    if (htmlPath && this.allowVerificationCommands) {
      previews.push(await this.captureHTMLPreview(htmlPath, signal));
    }
    for (const path of paths) {
      if (previews.length >= MAX_PREVIEWS_PER_ROUND) break;
      if (path.startsWith("_lightningloop/")) continue;
      const lower = path.toLowerCase();
      if (!/\.(?:png|jpe?g|gif|webp)$/u.test(lower)) continue;
      const data = await readFile(join(this.root, path));
      if (data.length < 1 || data.length > MAX_PREVIEW_BYTES) {
        previews.push({
          kind: "image",
          title: basename(path),
          sourcePath: path,
          previewPath: path,
          mimeType: "application/octet-stream",
          passed: false,
          message: "Image preview exceeded the 10 MiB evidence limit.",
        });
        continue;
      }
      const mimeType = imageMimeType(path, data);
      const dimensions = mimeType === "image/png" ? pngDimensions(data) : undefined;
      previews.push({
        kind: "image",
        title: basename(path),
        sourcePath: path,
        previewPath: path,
        mimeType: mimeType ?? "application/octet-stream",
        passed: mimeType !== undefined,
        message: mimeType ? "Image signature verified for static picture evidence." : "Image extension did not match supported image bytes.",
        ...(mimeType ? { reviewImage: { path: join(this.root, path), mimeType, expectedSHA256: createHash("sha256").update(data).digest("hex") } } : {}),
        ...(dimensions ?? {}),
      });
    }
    return previews;
  }

  private async captureHTMLPreview(path: string, signal?: AbortSignal): Promise<ArtifactPreviewEvidence> {
    const sourceURL = join(this.root, path);
    const encoded = await readFile(sourceURL);
    if (encoded.length < 1 || encoded.length > 1_048_576 || encoded.includes(0)) {
      return {
        kind: "html",
        title: basename(path),
        sourcePath: path,
        previewPath: path,
        mimeType: "text/html",
        passed: false,
        message: "HTML preview must be nonempty UTF-8 text no larger than 1 MiB.",
      };
    }
    const sanitized = Buffer.from(injectPreviewCSP(encoded.toString("utf8")), "utf8");
    const loopback = await this.verifyLoopbackHTML(sanitized, signal);
    const token = randomUUID();
    const temporaryHTML = join(dirname(sourceURL), `.${basename(path)}.lightningloop-preview-${token}.html`);
    const outputDirectory = join(this.root, ".lightningloop-tmp", `quicklook-${token}`);
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const handle = await open(temporaryHTML, "wx", 0o600);
    try {
      await handle.writeFile(sanitized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      signal?.throwIfAborted();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(
          "/usr/bin/qlmanage",
          ["-t", "-s", "1280", "-o", outputDirectory, temporaryHTML],
          {
            timeout: 20_000,
            maxBuffer: 65_536,
            env: {
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              HOME: join(this.root, ".lightningloop-tmp"),
              CFFIXED_USER_HOME: join(this.root, ".lightningloop-tmp"),
            },
          },
          (error) => error ? rejectPromise(error) : resolvePromise(),
        );
      });
      signal?.throwIfAborted();
      const outputName = (await readdir(outputDirectory)).find((name) => name.toLowerCase().endsWith(".png"));
      if (!outputName) throw new Error("Quick Look did not produce a PNG preview.");
      const image = await readFile(join(outputDirectory, outputName));
      const dimensions = pngDimensions(image);
      if (!dimensions || image.length < 1 || image.length > MAX_PREVIEW_BYTES) {
        throw new Error("Quick Look produced invalid or oversized PNG evidence.");
      }
      const stem = basename(path, ".html").replaceAll(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 80) || "index";
      const previewPath = `_lightningloop/previews/${stem}-desktop.png`;
      await this.writeOwnedFile(previewPath, image);
      return {
        kind: "html",
        title: `${basename(path)} static picture evidence`,
        sourcePath: path,
        previewPath,
        mimeType: "image/png",
        passed: loopback.status === 200,
        message: "Rendered from a CSP-confined copy and independently served over an ephemeral loopback endpoint.",
        width: dimensions.width,
        height: dimensions.height,
        loopback,
        reviewImage: { path: join(this.root, previewPath), mimeType: "image/png", expectedSHA256: createHash("sha256").update(image).digest("hex") },
      };
    } catch (error) {
      return {
        kind: "html",
        title: `${basename(path)} static picture evidence`,
        sourcePath: path,
        previewPath: path,
        mimeType: "text/html",
        passed: false,
        message: this.redactor.redact(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        loopback,
      };
    } finally {
      await unlink(temporaryHTML).catch(() => undefined);
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }

  private async verifyLoopbackHTML(
    html: Buffer,
    signal?: AbortSignal,
  ): Promise<NonNullable<ArtifactPreviewEvidence["loopback"]>> {
    signal?.throwIfAborted();
    const server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/preview") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(html.length),
        "Content-Security-Policy": PREVIEW_CSP,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(html);
    });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(0, "127.0.0.1", () => resolvePromise());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Loopback preview did not receive an ephemeral port.");
      const response = await fetch(`http://127.0.0.1:${address.port}/preview`, {
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > 1_048_576) throw new Error("Loopback preview response exceeded 1 MiB.");
      return {
        scheme: "http",
        host: "127.0.0.1",
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    } finally {
      if (server.listening) {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      }
    }
  }

  private async ensureDirectories(relativeFile: string): Promise<void> {
    let cursor = this.root;
    for (const component of relativeFile.split("/").slice(0, -1)) {
      cursor = join(cursor, component);
      if (!within(this.root, cursor)) throw new Error("Artifact directory escaped the workspace.");
      const info = await lstat(cursor).catch(() => undefined);
      if (info) {
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Artifact parent is not a real directory: ${component}`);
      } else {
        await mkdir(cursor, { mode: 0o700 });
        this.ownedDirectories.add(relative(this.root, cursor).split(sep).join("/"));
      }
    }
  }

  private async reconcileManifest(declaredPaths: ReadonlySet<string>): Promise<void> {
    const stalePaths = [...this.ownedPaths]
      .filter((path) => !this.protectedPaths.has(path) && !declaredPaths.has(path))
      .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
    for (const path of stalePaths) {
      const target = join(this.root, path);
      if (!within(this.root, target)) throw new Error(`Run-owned artifact path escaped the workspace: ${path}`);
      const info = await lstat(target).catch(() => undefined);
      if (info) {
        if (info.isDirectory()) {
          throw new Error(`Run-owned artifact changed into a directory and cannot be reconciled safely: ${path}`);
        }
        // unlink removes a link itself and never follows its target.
        await unlink(target);
      }
      this.ownedPaths.delete(path);
      await this.pruneOwnedParents(dirname(target));
    }
    await this.pruneAllEmptyOwnedDirectories();
  }

  private async pruneOwnedParents(start: string): Promise<void> {
    let cursor = start;
    while (cursor !== this.root && within(this.root, cursor)) {
      const path = relative(this.root, cursor).split(sep).join("/");
      if (!this.ownedDirectories.has(path)) return;
      const info = await lstat(cursor).catch(() => undefined);
      if (!info) {
        this.ownedDirectories.delete(path);
      } else {
        if (info.isSymbolicLink() || !info.isDirectory()) return;
        try {
          await rmdir(cursor);
          this.ownedDirectories.delete(path);
        } catch (error) {
          if (!directoryNotEmpty(error)) throw error;
          return;
        }
      }
      cursor = dirname(cursor);
    }
  }

  private async pruneAllEmptyOwnedDirectories(): Promise<void> {
    const paths = [...this.ownedDirectories]
      .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
    for (const path of paths) {
      const directory = join(this.root, path);
      if (!within(this.root, directory)) throw new Error(`Run-owned artifact directory escaped the workspace: ${path}`);
      const info = await lstat(directory).catch(() => undefined);
      if (!info) {
        this.ownedDirectories.delete(path);
        continue;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Run-owned artifact directory changed type and cannot be reconciled safely: ${path}`);
      }
      try {
        await rmdir(directory);
        this.ownedDirectories.delete(path);
      } catch (error) {
        if (!directoryNotEmpty(error)) throw error;
      }
    }
  }

  private async writeOwnedFile(relativeFile: string, encoded: Buffer): Promise<void> {
    if (this.protectedPaths.has(relativeFile)) throw new Error(`Protected harness input cannot be replaced: ${relativeFile}`);
    await this.ensureDirectories(relativeFile);
    const target = join(this.root, relativeFile);
    if (!within(this.root, target)) throw new Error("Artifact path escaped the workspace.");
    const existing = await lstat(target).catch(() => undefined);
    if (existing && (!this.ownedPaths.has(relativeFile) || existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error(`Artifact path is not owned by this run: ${relativeFile}`);
    }
    const temporary = join(dirname(target), `.${basename(target)}.lightningloop-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const resolved = await realpath(target);
    if (!within(this.root, resolved)) throw new Error(`Written artifact resolved outside the workspace: ${relativeFile}`);
    this.ownedPaths.add(relativeFile);
  }

  private async runCommand(
    runtime: SandboxedBashRuntime,
    command: VerificationCommandDraft,
    origin: VerificationCommandEvidence["origin"],
    rustToolchain?: RustToolchain,
    signal?: AbortSignal,
  ): Promise<VerificationCommandEvidence> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let output = "";
    let overflow = false;
    const encodedCommand = ["/usr/bin/env", command.executable, ...command.arguments]
      .map(quoteShellArgument)
      .join(" ");
    try {
      const result = await runtime.operations().exec(encodedCommand, this.root, {
        timeout: MAX_COMMAND_SECONDS,
        signal: controller.signal,
        env: runtime.restrictedEnvironment({
          ...process.env,
          PATH: rustToolchain ? `${rustToolchain.binDirectory}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}` : process.env.PATH,
          CARGO_HOME: join(this.root, ".lightningloop-tmp", "cargo-home"),
          CARGO_TARGET_DIR: join(this.root, ".lightningloop-tmp", "cargo-target"),
          TMPDIR: join(this.root, ".lightningloop-tmp"),
          TMP: join(this.root, ".lightningloop-tmp"),
          TEMP: join(this.root, ".lightningloop-tmp"),
        }),
        onData: (data) => {
          if (overflow) return;
          output += data.toString("utf8");
          if (Buffer.byteLength(output, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
            overflow = true;
            output = output.slice(0, MAX_COMMAND_OUTPUT_BYTES);
            controller.abort(new Error("Verification output exceeded the limit."));
          }
        },
      });
      const redactedOutput = this.redactor.redact(output);
      const lastOutputLine = redactedOutput.split(/\r?\n/u).filter((line) => line.length > 0).at(-1);
      const outputMatched = command.expectedOutput === undefined || lastOutputLine === command.expectedOutput;
      return {
        ...command,
        exitCode: result.exitCode,
        output: redactedOutput,
        passed: result.exitCode === 0 && !overflow && outputMatched,
        origin,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      const suffix = overflow ? "Verification output exceeded 64 KiB." : message;
      return {
        ...command,
        exitCode: null,
        output: this.redactor.redact(`${output}\n${suffix}`).trim().slice(0, MAX_COMMAND_OUTPUT_BYTES),
        passed: false,
        origin,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async runImmutableCommand(
    runtime: SandboxedBashRuntime,
    command: VerificationCommandDraft,
    origin: VerificationCommandEvidence["origin"],
    rustToolchain?: RustToolchain,
    signal?: AbortSignal,
  ): Promise<VerificationCommandEvidence> {
    const before = await this.workspaceManifestSnapshot();
    const evidence = await this.runCommand(runtime, command, origin, rustToolchain, signal);
    const after = await this.workspaceManifestSnapshot();
    if (JSON.stringify(before) === JSON.stringify(after) || (command.mode === "generate" && this.isTrustedGeneratorCommand(command))) return evidence;
    return {
      ...evidence,
      passed: false,
      output: `${evidence.output}\nVerification command mutated the tested workspace; proof is rejected.`.trim().slice(0, MAX_COMMAND_OUTPUT_BYTES),
    };
  }

  private async workspaceManifestSnapshot(expected?: WorkspaceManifestSnapshot): Promise<WorkspaceManifestSnapshot> {
    const rootInfo = await lstat(this.root, { bigint: true });
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(this.root) !== this.root) {
      throw new Error("Artifact workspace changed type or identity while its manifest was reopened.");
    }
    const expectedByPath = expected ? new Map(expected.entries.map((record) => [record.path, record])) : undefined;
    if (expected) {
      if (expected.entries.length > MAX_WORKSPACE_ENTRIES) throw new Error("Expected artifact manifest exceeds the entry budget.");
      const expectedFiles = expected.entries.filter((record) => record.type === "file");
      if (expectedFiles.length > MAX_WORKSPACE_FILES) throw new Error("Expected artifact manifest exceeds the file budget.");
      let expectedBytes = 0;
      for (const record of expectedFiles) {
        if (record.bytes < 0 || record.bytes > MAX_PREVIEW_BYTES || record.bytes > MAX_WORKSPACE_BYTES - expectedBytes) {
          throw new Error("Expected artifact manifest exceeds its per-file or aggregate byte budget.");
        }
        expectedBytes += record.bytes;
      }
    }
    const records: WorkspaceManifestRecord[] = [];
    let fileCount = 0;
    let aggregateBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      const directoryHandle = await opendir(directory);
      try {
        for await (const entry of directoryHandle) {
          const absolute = join(directory, entry.name);
          const path = relative(this.root, absolute).split(sep).join("/");
          if (path === ".lightningloop-tmp" || path.startsWith(".lightningloop-tmp/")) continue;
          if (records.length >= MAX_WORKSPACE_ENTRIES) {
            throw new Error("Artifact manifest exceeds the bounded entry budget.");
          }
          if (expected && records.length >= expected.entries.length) {
            throw new Error("Artifact workspace contains unexpected additions after its passing report.");
          }
          const expectedRecord = expectedByPath?.get(path);
          if (expectedByPath && !expectedRecord) {
            throw new Error(`Artifact workspace contains an unexpected addition after its passing report: ${path}`);
          }
          const info = await lstat(absolute);
          const mode = info.mode & 0o7777;
          const type: WorkspaceManifestRecord["type"] = info.isDirectory()
            ? "directory"
            : info.isFile()
              ? "file"
              : info.isSymbolicLink()
                ? "symbolic-link"
                : "special";
          if (expectedRecord && (expectedRecord.type !== type || expectedRecord.mode !== mode || expectedRecord.bytes !== info.size)) {
            throw new Error(`Artifact workspace entry changed type, mode, or size after its passing report: ${path}`);
          }
          if (type === "directory") {
            records.push({ path, type, mode, bytes: info.size });
            await visit(absolute);
          } else if (type === "file") {
            fileCount += 1;
            if (fileCount > MAX_WORKSPACE_FILES || info.size < 0 || info.size > MAX_PREVIEW_BYTES || info.size > MAX_WORKSPACE_BYTES - aggregateBytes) {
              throw new Error("Artifact manifest exceeds its file, per-file, or aggregate byte budget.");
            }
            aggregateBytes += info.size;
            const sha256 = await this.boundedFileHash(absolute, info.size, info);
            if (expectedRecord?.sha256 && expectedRecord.sha256 !== sha256) {
              throw new Error(`Artifact workspace file hash changed after its passing report: ${path}`);
            }
            records.push({ path, type, mode, bytes: info.size, sha256 });
          } else if (type === "symbolic-link") {
            if (expectedRecord) throw new Error(`Artifact workspace entry became a symbolic link after its passing report: ${path}`);
            const target = await readlink(absolute);
            records.push({
              path,
              type,
              mode,
              bytes: Buffer.byteLength(target, "utf8"),
              sha256: createHash("sha256").update(target).digest("hex"),
            });
          } else {
            if (expectedRecord) throw new Error(`Artifact workspace entry became a special file after its passing report: ${path}`);
            records.push({ path, type, mode, bytes: info.size });
          }
        }
      } finally {
        await directoryHandle.close().catch(() => undefined);
      }
    };
    await visit(this.root);
    if (expected && records.length !== expected.entries.length) {
      throw new Error("Artifact workspace is missing entries from its passing report.");
    }
    records.sort((left, right) => left.path.localeCompare(right.path));
    return {
      root: {
        path: this.root,
        device: rootInfo.dev.toString(10),
        inode: rootInfo.ino.toString(10),
        mode: Number(rootInfo.mode & 0o7777n),
      },
      entries: records,
    };
  }

  private async boundedFileHash(
    absolute: string,
    expectedBytes: number,
    initialInfo: Awaited<ReturnType<typeof lstat>>,
  ): Promise<string> {
    if (expectedBytes < 0 || expectedBytes > MAX_PREVIEW_BYTES) {
      throw new Error("Artifact file exceeds the terminal hash byte budget.");
    }
    const handle = await open(absolute, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== expectedBytes || opened.dev !== initialInfo.dev || opened.ino !== initialInfo.ino) {
        throw new Error("Artifact file changed identity or size before bounded hashing.");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1_024, expectedBytes)));
      let bytesReadTotal = 0;
      while (bytesReadTotal < expectedBytes) {
        const requested = Math.min(buffer.length, expectedBytes - bytesReadTotal);
        const { bytesRead } = await handle.read(buffer, 0, requested, bytesReadTotal);
        if (bytesRead <= 0) throw new Error("Artifact file shrank during bounded hashing.");
        hash.update(buffer.subarray(0, bytesRead));
        bytesReadTotal += bytesRead;
      }
      const overflow = Buffer.allocUnsafe(1);
      const extra = await handle.read(overflow, 0, 1, bytesReadTotal);
      if (extra.bytesRead !== 0) throw new Error("Artifact file grew during bounded hashing.");
      const [closedInfo, pathInfo] = await Promise.all([handle.stat(), lstat(absolute)]);
      if (!closedInfo.isFile()
        || !pathInfo.isFile()
        || pathInfo.isSymbolicLink()
        || closedInfo.size !== expectedBytes
        || pathInfo.size !== expectedBytes
        || closedInfo.dev !== initialInfo.dev
        || closedInfo.ino !== initialInfo.ino
        || pathInfo.dev !== initialInfo.dev
        || pathInfo.ino !== initialInfo.ino
        || pathInfo.mode !== initialInfo.mode
        || pathInfo.mtimeMs !== initialInfo.mtimeMs
        || pathInfo.ctimeMs !== initialInfo.ctimeMs) {
        throw new Error("Artifact file changed while its bounded hash was computed.");
      }
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  }

  private isTrustedGeneratorCommand(command: VerificationCommandDraft): boolean {
    return command.executable === "node"
      && JSON.stringify(command.arguments) === JSON.stringify(["tooling/photo_to_relief.mjs", "inputs/source.png", "."])
      && this.protectedHashes.has("tooling/photo_to_relief.mjs")
      && this.protectedHashes.has("inputs/source.png");
  }

  private async auditWorkspace(): Promise<ArtifactExecutionReport["workspaceAudit"]> {
    let files = 0;
    let bytes = 0;
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = join(directory, entry.name);
        const relativePath = relative(this.root, absolute).split(sep).join("/");
        if (secretPath(relativePath)) throw new Error(`Workspace audit rejected credential-like path: ${relativePath}`);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error(`Workspace audit rejected symbolic link: ${relativePath}`);
        const mode = info.mode & 0o7777;
        if (process.platform !== "win32" && (mode & 0o022) !== 0) {
          throw new Error(`Workspace audit rejected group/world-writable mode ${mode.toString(8)}: ${relativePath}`);
        }
        if (info.isDirectory()) {
          if (this.ownedPaths.has(relativePath)) {
            throw new Error(`Run-owned artifact changed from a file into a directory: ${relativePath}`);
          }
          await visit(absolute);
        } else if (info.isFile()) {
          if (process.platform !== "win32" && this.ownedPaths.has(relativePath) && mode !== 0o600) {
            throw new Error(`Run-owned artifact mode changed from 600 to ${mode.toString(8)}: ${relativePath}`);
          }
          files += 1;
          bytes += info.size;
          if (files > MAX_WORKSPACE_FILES || bytes > MAX_WORKSPACE_BYTES) throw new Error("Workspace output exceeded the file or byte budget.");
          if (info.size <= 1_048_576) {
            const content = await readFile(absolute);
            if (!content.includes(0)) this.redactor.assertSafe(content.toString("utf8"), relativePath);
          }
        } else {
          throw new Error(`Workspace audit rejected non-file output: ${relativePath}`);
        }
      }
    };
    try {
      await visit(this.root);
      await this.assertProtectedInputs();
      const rootInfo = await lstat(this.root);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(this.root) !== this.root) {
        throw new Error("Artifact workspace changed type or identity during execution.");
      }
      if (process.platform !== "win32" && (rootInfo.mode & 0o7777) !== 0o700) {
        throw new Error(`Artifact workspace mode changed from 700 to ${(rootInfo.mode & 0o7777).toString(8)}.`);
      }
      return { passed: true, files, bytes, message: "Workspace remained confined, link-free, mode-safe, secret-shape-free, and within budget." };
    } catch (error) {
      return {
        passed: false,
        files,
        bytes,
        message: this.redactor.redact(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      };
    }
  }

  private async assertProtectedInputs(): Promise<void> {
    for (const [path, expectedHash] of this.protectedHashes) {
      const absolute = join(this.root, path);
      const info = await lstat(absolute).catch(() => undefined);
      if (!info || info.isSymbolicLink() || !info.isFile()) throw new Error(`Protected harness input changed type or disappeared: ${path}`);
      const actualHash = createHash("sha256").update(await readFile(absolute)).digest("hex");
      if (actualHash !== expectedHash) throw new Error(`Protected harness input failed its integrity check: ${path}`);
    }
  }

  private async collectWorkspaceEvidence(): Promise<ArtifactExecutionReport["files"]> {
    const paths = await this.workspacePaths();
    if (paths.length > 128) throw new Error("Workspace contains too many files for bounded artifact evidence.");
    const evidence: ArtifactExecutionReport["files"] = [];
    for (const path of paths) {
      const data = await readFile(join(this.root, path));
      evidence.push({ path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
    return evidence;
  }
}
