import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxedBashRuntime } from "./sandboxed-bash.js";

async function execute(runtime: SandboxedBashRuntime, command: string): Promise<{ exitCode: number | null; output: string }> {
  let output = "";
  const result = await runtime.operations().exec(command, runtime.workspace, {
    onData: (data) => { output += data.toString("utf8"); },
    timeout: 10,
  });
  return { ...result, output };
}

test("sandbox permits workspace mutation but denies sibling-home reads and network", async () => {
  const workspace = await mkdtemp(join(homedir(), ".lightningloop-sandbox-workspace-"));
  const outside = await mkdtemp(join(homedir(), ".lightningloop-sandbox-outside-"));
  const secretPath = join(outside, "synthetic-secret.txt");
  await writeFile(secretPath, "SYNTHETIC_SECRET_MUST_NOT_ESCAPE", { mode: 0o600 });
  const runtime = new SandboxedBashRuntime(workspace);
  try {
    await runtime.initialize();
    const allowed = await execute(runtime, "printf 'sandbox-ok' > proof.txt");
    assert.equal(allowed.exitCode, 0);
    assert.equal(await readFile(join(workspace, "proof.txt"), "utf8"), "sandbox-ok");

    const deniedRead = await execute(runtime, `/bin/cat '${secretPath}'`);
    assert.notEqual(deniedRead.exitCode, 0);
    assert.equal(deniedRead.output.includes("SYNTHETIC_SECRET_MUST_NOT_ESCAPE"), false);

    const deniedNetwork = await execute(runtime, "/usr/bin/curl --max-time 2 https://example.com");
    assert.notEqual(deniedNetwork.exitCode, 0);
  } finally {
    await runtime.shutdown();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("sandbox refuses execution before initialization", async () => {
  const runtime = new SandboxedBashRuntime(tmpdir());
  await assert.rejects(() => execute(runtime, "/usr/bin/true"), /not initialized/);
});

test("shared-workspace mode never targets an unrelated process with the same cwd", async (context) => {
  if (process.platform === "win32") {
    context.skip("SandboxedBashRuntime is POSIX-only.");
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-sandbox-shared-"));
  const unrelated = spawn("/bin/sleep", ["5"], { cwd: workspace, stdio: "ignore" });
  const unrelatedExit = new Promise<void>((resolvePromise) => unrelated.once("close", () => resolvePromise()));
  const runtime = new SandboxedBashRuntime(workspace);
  try {
    await runtime.initialize();
    const result = await execute(runtime, "/usr/bin/true");
    assert.equal(result.exitCode, 0);
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  } finally {
    if (unrelated.pid) {
      try { process.kill(unrelated.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await unrelatedExit;
    await runtime.shutdown();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fork-denied sandbox blocks an immediate detached setsid and chdir escape", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("Deterministic autonomous Bash verification currently requires macOS Seatbelt process-fork denial.");
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-sandbox-quiescence-"));
  const proofPath = join(workspace, "proof.txt");
  await writeFile(proofPath, "original", { mode: 0o600 });
  const child = `const f=require('node:fs'),root=process.argv[1];f.writeFileSync(root+'/escaped.pid',String(process.pid));process.chdir('/');setTimeout(()=>f.writeFileSync(root+'/proof.txt','mutated'),700)`;
  const root = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)},process.cwd()],{detached:true,cwd:'/',stdio:'ignore'});c.unref()`;
  const command = `/usr/bin/env '${process.execPath}' -e ${JSON.stringify(root)}`;
  const runtime = new SandboxedBashRuntime(workspace, { dedicatedWorkspace: true, denyProcessFork: true });
  try {
    await runtime.initialize();
    const wrapped = await runtime.wrapCommand(command);
    assert.match(wrapped, /\(deny process-fork\)/u);
    assert.doesNotMatch(wrapped, /\(allow process-fork\)/u);
    const result = await execute(runtime, command);
    assert.notEqual(result.exitCode, 0, "a verifier that attempts to spawn must not pass");
    assert.match(result.output, /EPERM|operation not permitted|process-fork/iu);
    await assert.rejects(() => readFile(join(workspace, "escaped.pid")), /ENOENT/u);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    assert.equal(await readFile(proofPath, "utf8"), "original");
  } finally {
    await runtime.shutdown();
    await rm(workspace, { recursive: true, force: true });
  }
});
