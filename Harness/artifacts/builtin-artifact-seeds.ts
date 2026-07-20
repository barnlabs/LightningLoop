import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentImage } from "../core/image-input.js";
import { routeBuiltinWorkflows } from "../core/workflow-catalog.js";
import type { ArtifactSeed } from "./workspace-artifact-executor.js";

const execFileAsync = promisify(execFile);

async function normalizedPNG(source: AgentImage): Promise<Buffer> {
  if (source.mimeType === "image/png") return readFile(source.path);
  const directory = await mkdtemp(join(tmpdir(), "lightningloop-image-"));
  const output = join(directory, "source.png");
  try {
    await execFileAsync("/usr/bin/sips", ["-s", "format", "png", source.path, "--out", output], {
      timeout: 15_000,
      maxBuffer: 1_048_576,
    });
    const data = await readFile(output);
    if (!data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error("macOS image normalization did not produce a PNG.");
    }
    if (data.length < 1 || data.length > 10 * 1_048_576) throw new Error("Normalized image exceeds the 10 MiB input limit.");
    return data;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function artifactSeedsForGoal(goal: string, images: readonly AgentImage[]): Promise<ArtifactSeed[]> {
  if (!routeBuiltinWorkflows(goal).includes("photo_to_3d")) return [];
  const source = images[0];
  if (!source) throw new Error("Photo-to-3D artifact mode requires at least one validated image attachment.");
  const toolPath = fileURLToPath(new URL("../../Tools/photo_to_relief.mjs", import.meta.url));
  return [
    {
      path: "inputs/source.png",
      data: await normalizedPNG(source),
      description: "validated user image normalized to PNG by macOS ImageIO; integrity-pinned so any mutation fails the run",
    },
    {
      path: "tooling/photo_to_relief.mjs",
      data: await readFile(toolPath),
      description: "repository-reviewed dependency-free Node workflow, integrity-pinned so any mutation fails the run. When verification is granted, run node with arguments [\"tooling/photo_to_relief.mjs\",\"inputs/source.png\",\".\"]. Disclose that the result is a single-view 2.5D relief, not hidden-geometry reconstruction",
    },
  ];
}
