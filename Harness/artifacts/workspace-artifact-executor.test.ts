import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, lstat, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateImagePaths } from "../core/image-input.js";
import type { ImplementationDraft } from "../core/loop-types.js";
import { artifactSeedsForGoal } from "./builtin-artifact-seeds.js";
import { WorkspaceArtifactExecutor } from "./workspace-artifact-executor.js";

const implementation = (overrides: Partial<ImplementationDraft> = {}): ImplementationDraft => ({
  deliverable: "Created a tested program.",
  notes: [],
  files: [{ path: "src/app.js", content: "export const answer = 42;\n" }],
  verificationCommands: [],
  ...overrides,
});

function immediateDetachedEscape(mutation: string): NonNullable<ImplementationDraft["verificationCommands"]>[number] {
  const child = `const f=require('node:fs'),root=process.argv[1];f.writeFileSync(root+'/.lightningloop-tmp/escaped.pid',String(process.pid));process.chdir('/');setTimeout(()=>{${mutation}},700)`;
  const root = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)},process.cwd()],{detached:true,cwd:'/',stdio:'ignore'});c.unref()`;
  return {
    executable: "node",
    arguments: ["-e", root],
    purpose: "Attempt an immediate detached setsid and chdir escape",
  };
}

test("artifact executor atomically writes owned files and records real hashes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace);
    const first = await executor.apply(implementation({ files: [{ path: "src/note.txt", content: "answer = 42\n" }] }));
    assert.equal(first.passed, true);
    assert.equal(first.files.length, 1);
    assert.match(first.files[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(await readFile(join(workspace, "src/note.txt"), "utf8"), "answer = 42\n");

    const revised = await executor.apply(implementation({ files: [{ path: "src/note.txt", content: "answer = 43\n" }] }));
    assert.equal(revised.passed, true);
    assert.equal(await readFile(join(workspace, "src/note.txt"), "utf8"), "answer = 43\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("terminal revalidation rejects bytes changed after a passing report returns", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-terminal-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace);
    assert.equal((await executor.revalidateLastReport()).passed, false);
    const report = await executor.apply(implementation({
      files: [{ path: "answer.txt", content: "The answer is 42.\n" }],
    }));
    assert.equal(report.passed, true);
    assert.equal((await executor.revalidateLastReport()).passed, true);

    await writeFile(join(workspace, "answer.txt"), "The answer is 43.\n", { mode: 0o600 });
    const revalidation = await executor.revalidateLastReport();
    assert.equal(revalidation.passed, false);
    assert.match(revalidation.message, /changed after its passing report/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("terminal revalidation rejects oversized growth of an expected file before hashing it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-terminal-growth-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace);
    const report = await executor.apply(implementation({ files: [{ path: "answer.txt", content: "42\n" }] }));
    assert.equal(report.passed, true);
    const handle = await open(join(workspace, "answer.txt"), "r+");
    try {
      await handle.truncate(10 * 1_048_576 + 1);
    } finally {
      await handle.close();
    }

    const revalidation = await executor.revalidateLastReport();
    assert.equal(revalidation.passed, false);
    assert.match(revalidation.message, /changed type, mode, or size|byte budget/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("terminal revalidation rejects an unexpected oversized sparse addition without reading it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-terminal-addition-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace);
    const report = await executor.apply(implementation({ files: [{ path: "answer.txt", content: "42\n" }] }));
    assert.equal(report.passed, true);
    const handle = await open(join(workspace, "unexpected.bin"), "w");
    try {
      await handle.truncate(134_217_728 + 1);
    } finally {
      await handle.close();
    }

    const revalidation = await executor.revalidateLastReport();
    assert.equal(revalidation.passed, false);
    assert.match(revalidation.message, /unexpected addition/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("terminal revalidation rejects an addition flood at the expected-entry boundary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-terminal-flood-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace);
    const report = await executor.apply(implementation({ files: [{ path: "answer.txt", content: "42\n" }] }));
    assert.equal(report.passed, true);
    for (let offset = 0; offset < 2_049; offset += 128) {
      const end = Math.min(offset + 128, 2_049);
      await Promise.all(Array.from({ length: end - offset }, (_, index) =>
        writeFile(join(workspace, `unexpected-${String(offset + index).padStart(4, "0")}.txt`), "", { mode: 0o600 })));
    }

    const revalidation = await executor.revalidateLastReport();
    assert.equal(revalidation.passed, false);
    assert.match(revalidation.message, /unexpected addition/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("terminal bounded hashing rejects a file that grows while it is being read", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-terminal-race-"));
  const seed = Buffer.alloc(10 * 1_048_576, 0x41);
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, false, [{
      path: "inputs/large.bin",
      data: seed,
      description: "Bounded terminal hash race fixture",
    }]);
    const report = await executor.apply(implementation({ files: [{ path: "answer.txt", content: "42\n" }] }));
    assert.equal(report.passed, true);

    let stopGrowing = false;
    const grower = (async () => {
      while (!stopGrowing) {
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        if (!stopGrowing) await appendFile(join(workspace, "inputs/large.bin"), Buffer.from([0x42]));
      }
    })();
    const revalidation = await executor.revalidateLastReport();
    stopGrowing = true;
    await grower;
    assert.equal(revalidation.passed, false);
    assert.match(revalidation.message, /changed|grew|hash/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("each artifact round removes prior run-owned files omitted from the new manifest", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace);
    const first = await executor.apply(implementation({
      files: [
        { path: "answer.txt", content: "The answer is 42.\n" },
        { path: "contradiction.txt", content: "The answer is not 42.\n" },
      ],
    }));
    assert.equal(first.passed, true);
    assert.ok(first.files.some((file) => file.path === "contradiction.txt"));

    const second = await executor.apply(implementation({
      files: [{ path: "answer.txt", content: "The answer is 42.\n" }],
    }));
    assert.equal(second.passed, true);
    assert.deepEqual(second.files.map((file) => file.path), ["answer.txt"]);
    await assert.rejects(() => readFile(join(workspace, "contradiction.txt")), /ENOENT/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verification rejects chmod mutation and the final workspace audit records the unsafe mode", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode mutation is not available on Windows.");
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const report = await executor.apply(implementation({
      files: [{ path: "answer.txt", content: "The answer is 42.\n" }],
      verificationCommands: [{
        executable: "node",
        arguments: ["-e", "require('node:fs').chmodSync('answer.txt', 0o777)"],
        purpose: "Exercise the immutable workspace mode boundary",
      }],
    }));
    assert.equal(report.passed, false);
    assert.equal(report.commands[0]?.passed, false);
    assert.match(report.commands[0]?.output ?? "", /mutated the tested workspace/u);
    assert.equal(report.workspaceAudit.passed, false);
    assert.match(report.workspaceAudit.message, /mode|writable/u);
    await chmod(join(workspace, "answer.txt"), 0o600);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verification rejects a run-owned file changed into a directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const report = await executor.apply(implementation({
      files: [{ path: "answer.txt", content: "The answer is 42.\n" }],
      verificationCommands: [{
        executable: "node",
        arguments: ["-e", "const f=require('node:fs');f.unlinkSync('answer.txt');f.mkdirSync('answer.txt')"],
        purpose: "Exercise the immutable workspace file-type boundary",
      }],
    }));
    assert.equal(report.passed, false);
    assert.equal(report.commands[0]?.passed, false);
    assert.match(report.commands[0]?.output ?? "", /mutated the tested workspace/u);
    assert.equal(report.workspaceAudit.passed, false);
    assert.match(report.workspaceAudit.message, /changed from a file into a directory/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fork-denied verification rejects immediate setsid/chdir rewrite, chmod, and type replacement", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("Deterministic autonomous Bash verification currently requires macOS Seatbelt process-fork denial.");
    return;
  }
  const cases = [
    {
      name: "rewrite",
      mutation: "require('node:fs').writeFileSync('answer.txt','MUTATED')",
      assertUnchanged: async (workspace: string) => {
        assert.equal(await readFile(join(workspace, "answer.txt"), "utf8"), "The answer is 42.\n");
      },
    },
    {
      name: "chmod",
      mutation: "require('node:fs').chmodSync('answer.txt',0o777)",
      assertUnchanged: async (workspace: string) => {
        assert.equal((await lstat(join(workspace, "answer.txt"))).mode & 0o7777, 0o600);
      },
    },
    {
      name: "type replacement",
      mutation: "const f=require('node:fs');f.unlinkSync('answer.txt');f.mkdirSync('answer.txt')",
      assertUnchanged: async (workspace: string) => {
        assert.equal((await lstat(join(workspace, "answer.txt"))).isFile(), true);
        assert.equal(await readFile(join(workspace, "answer.txt"), "utf8"), "The answer is 42.\n");
      },
    },
  ] as const;

  for (const attempt of cases) {
    await context.test(attempt.name, async () => {
      const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-quiescence-"));
      try {
        const executor = await WorkspaceArtifactExecutor.create(workspace, true);
        const report = await executor.apply(implementation({
          files: [{ path: "answer.txt", content: "The answer is 42.\n" }],
          verificationCommands: [immediateDetachedEscape(attempt.mutation)],
        }));
        assert.equal(report.passed, false);
        assert.equal(report.commands[0]?.passed, false);
        assert.match(report.commands[0]?.output ?? "", /EPERM|operation not permitted|process-fork/iu);
        await assert.rejects(() => readFile(join(workspace, ".lightningloop-tmp/escaped.pid")), /ENOENT/u);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
        await attempt.assertUnchanged(workspace);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
});

test("artifact executor runs only explicitly enabled structured verification commands in the sandbox", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const denied = await WorkspaceArtifactExecutor.create(workspace, false);
    await assert.rejects(
      () => denied.apply(implementation({
        verificationCommands: [{ executable: "node", arguments: ["--check", "src/app.js"], purpose: "Parse the program" }],
      })),
      /without an explicit command capability grant/,
    );

    const secondWorkspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
    try {
      const allowed = await WorkspaceArtifactExecutor.create(secondWorkspace, true);
      const report = await allowed.apply(implementation({
        verificationCommands: [{ executable: "node", arguments: ["--check", "src/app.js"], purpose: "Parse the program" }],
      }));
      assert.equal(report.passed, true);
      assert.equal(report.commands[0]?.exitCode, 0);
      assert.equal(report.commands[0]?.passed, true);
      assert.equal(report.workspaceAudit.passed, true);
    } finally {
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("artifact executor proactively compiles Python and labels harness-selected evidence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const report = await executor.apply(implementation({
      files: [{ path: "main.py", content: "def answer() -> int:\n    return 42\n" }],
      verificationCommands: [],
    }));
    assert.equal(report.passed, true, report.commands[0]?.output);
    assert.equal(report.commands.length, 1);
    assert.equal(report.commands[0]?.executable, "python3");
    assert.equal(report.commands[0]?.origin, "harness");
    assert.ok((report.commands[0]?.durationMs ?? -1) >= 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an approved TypeScript runtime command does not substitute for typechecking", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const report = await executor.apply(implementation({
      files: [{
        path: "main.ts",
        content: "const answer: number = 42;\nif (answer !== 42) throw new Error('wrong answer');\nconsole.log(`answer=${answer}`);\n",
      }],
      verificationCommands: [{
        executable: "node",
        arguments: ["main.ts"],
        purpose: "Execute the generated TypeScript proof program",
      }],
    }));
    assert.equal(report.passed, false);
    assert.equal(report.commands[0]?.origin, "implementer");
    assert.match(report.commands[0]?.output ?? "", /answer=42/u);
    assert.ok((report.commands[0]?.durationMs ?? -1) >= 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an unrelated passing command cannot prove invalid TypeScript", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const report = await executor.apply(implementation({
      files: [{ path: "main.ts", content: "const value: string = 42;\n" }],
      verificationCommands: [{ executable: "node", arguments: ["-e", "console.log('unrelated pass')"], purpose: "Unrelated passing command" }],
    }));
    assert.equal(report.commands[0]?.passed, true);
    assert.equal(report.passed, false);
    assert.match(report.summary, /TypeScript|typecheck|verification/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TypeScript artifacts fail closed when no typecheck, build, or test runs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const report = await executor.apply(implementation({
      files: [{ path: "main.ts", content: "const value: string = 42;\n" }],
      verificationCommands: [],
    }));
    assert.equal(report.passed, false);
    assert.match(report.summary, /TypeScript|typecheck|verification/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("offline Rust verification fails closed because cargo requires child processes", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("Deterministic autonomous Bash verification currently requires macOS Seatbelt process-fork denial.");
    return;
  }
  const cargoAvailable = spawnSync("/usr/bin/env", ["cargo", "--version"], { encoding: "utf8" }).status === 0;
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const report = await executor.apply(implementation({
      files: [
        {
          path: "Cargo.toml",
          content: "[package]\nname = \"lightningloop-proof\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        },
        {
          path: "Cargo.lock",
          content: "# This file is automatically @generated by Cargo.\nversion = 3\n\n[[package]]\nname = \"lightningloop-proof\"\nversion = \"0.1.0\"\n",
        },
        {
          path: "src/lib.rs",
          content: "pub fn answer() -> u8 { 42 }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn proves_answer() { assert_eq!(answer(), 42); }\n}\n",
        },
      ],
      verificationCommands: [],
    }));
    assert.equal(report.passed, false);
    assert.equal(report.commands[0]?.executable, "cargo");
    assert.equal(report.commands[0]?.origin, "harness");
    assert.equal(report.commands[0]?.passed, false);
    if (cargoAvailable) {
      assert.match(report.commands[0]?.output ?? "", /operation not permitted|EPERM/iu);
    } else {
      assert.match(report.commands[0]?.output ?? "", /cargo: No such file or directory/iu);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("artifact executor serves HTML over loopback and captures static picture evidence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    const report = await executor.apply(implementation({
      files: [{
        path: "index.html",
        content: "<!doctype html><html><head><title>Proof</title></head><body><main><h1>Rendered proof</h1></main></body></html>",
      }],
      verificationCommands: [],
    }));
    assert.equal(report.passed, true, report.previews[0]?.message);
    const preview = report.previews.find((item) => item.kind === "html");
    assert.equal(preview?.loopback?.host, "127.0.0.1");
    assert.equal(preview?.loopback?.status, 200);
    assert.equal(preview?.mimeType, "image/png");
    assert.ok((preview?.width ?? 0) > 0);
    assert.ok((preview?.height ?? 0) > 0);
    assert.match(preview?.previewPath ?? "", /^_lightningloop\/previews\/.*\.png$/u);
    const screenshot = await readFile(join(workspace, preview?.previewPath ?? "missing"));
    assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(report.files.some((file) => file.path === preview?.previewPath));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("artifact executor rejects collisions, traversal, links, and secret-shaped output", async () => {
  const occupied = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  await writeFile(join(occupied, "keep.txt"), "owned by user");
  await assert.rejects(() => WorkspaceArtifactExecutor.create(occupied), /must be empty/);
  await rm(occupied, { recursive: true, force: true });

  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace);
    await assert.rejects(
      () => executor.apply(implementation({ files: [{ path: "../escape.txt", content: "no" }] })),
      /unsafe component|relative/,
    );
    await assert.rejects(
      () => executor.apply(implementation({ files: [{ path: ".env", content: "not-a-real-value" }] })),
      /Credential-like artifact path/,
    );
    await assert.rejects(
      () => executor.apply(implementation({ files: [{ path: "note.txt", content: "api_key=synthetic_secret_value_12345" }] })),
      /Secret-like value prohibited/,
    );

    await symlink("/etc/hosts", join(workspace, "linked"));
    const fresh = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
    try {
      const linkedExecutor = await WorkspaceArtifactExecutor.create(fresh);
      await symlink("/etc/hosts", join(fresh, "linked"));
      const report = await linkedExecutor.apply(implementation());
      assert.equal(report.passed, false);
      assert.match(report.workspaceAudit.message, /symbolic link/);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("autonomous lint commands cannot use fix or write-in-place flags", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const executor = await WorkspaceArtifactExecutor.create(workspace, true);
    await assert.rejects(() => executor.apply(implementation({
      files: [{ path: "index.js", content: "export const value = 1;\n" }],
      verificationCommands: [{ executable: "node", arguments: ["--write", "index.js"], purpose: "Pretend to lint" }],
    })), /non-mutating/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("photo-to-3D seeds are validated, immutable, and included in evidence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const imagePath = resolve("LightningLoop/Resources/Assets.xcassets/AppIcon.appiconset/icon_64.png");
    const images = await validateImagePaths([imagePath]);
    const seeds = await artifactSeedsForGoal("Turn this photo into a 3D model", images);
    const executor = await WorkspaceArtifactExecutor.create(workspace, true, seeds);
    assert.match(executor.describe(), /Protected harness inputs/);
    const report = await executor.apply(implementation({ files: [{ path: "README.md", content: "# Generated relief\n" }] }));
    assert.equal(report.passed, true);
    assert.ok(report.files.some((file) => file.path === "inputs/source.png"));
    assert.ok(report.files.some((file) => file.path === "tooling/photo_to_relief.mjs"));
    await assert.rejects(
      () => executor.apply(implementation({ files: [{ path: "inputs/source.png", content: "replacement" }] })),
      /Protected harness input cannot be replaced/,
    );
    const integrityFailure = await executor.apply(implementation({
      files: [{ path: "README.md", content: "# Attempted replacement\n" }],
      verificationCommands: [{
        executable: "node",
        arguments: ["-e", "require('node:fs').writeFileSync('inputs/source.png', 'replacement')"],
        purpose: "Exercise the protected-input integrity gate",
      }],
    }));
    assert.equal(integrityFailure.passed, false);
    assert.match(integrityFailure.workspaceAudit.message, /failed its integrity check/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("photo-to-3D artifact path generates and reopens a real GLB", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lightningloop-artifacts-"));
  try {
    const imagePath = resolve("LightningLoop/Resources/Assets.xcassets/AppIcon.appiconset/icon_64.png");
    const images = await validateImagePaths([imagePath]);
    const seeds = await artifactSeedsForGoal("Create a 3D GLB from this image", images);
    const executor = await WorkspaceArtifactExecutor.create(workspace, true, seeds);
    const report = await executor.apply(implementation({
      files: [{ path: "README.md", content: "# LightningLoop generated 2.5D relief\n" }],
      verificationCommands: [{
        executable: "node",
        arguments: ["tooling/photo_to_relief.mjs", "inputs/source.png", "."],
        purpose: "Generate and reopen-validate the 2.5D relief",
        mode: "generate",
      }],
    }));
    assert.equal(report.passed, true, report.commands[0]?.output);
    assert.equal(report.commands[0]?.exitCode, 0);
    for (const output of ["relief.glb", "relief.obj", "preview.png", "report.json"]) {
      const evidence = report.files.find((file) => file.path === output);
      assert.ok(evidence, `missing evidence for ${output}`);
      assert.ok(evidence.bytes > 0, `${output} must be nonempty`);
    }
    const validation = JSON.parse(await readFile(join(workspace, "report.json"), "utf8")) as {
      reopen_validation?: { passed?: boolean; vertices?: number; material_slots?: number };
      limitation?: string;
    };
    assert.equal(validation.reopen_validation?.passed, true);
    assert.ok((validation.reopen_validation?.vertices ?? 0) > 0);
    assert.ok((validation.reopen_validation?.material_slots ?? 0) > 0);
    assert.match(validation.limitation ?? "", /single photograph/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
