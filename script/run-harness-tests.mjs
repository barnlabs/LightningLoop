#!/usr/bin/env node
/**
 * Runs harness unit tests with a credential-free Pi-managed provider fixture so
 * clean CI runners (no provider.json) do not load selection-required and flake
 * under --test-concurrency=2 when some tests mutate LIGHTNINGLOOP_PROVIDER_CONFIG_PATH.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "lightningloop-harness-tests-"));
const configPath = join(directory, "provider.json");

writeFileSync(configPath, `${JSON.stringify({
  schemaVersion: 1,
  id: "openai-codex",
  preset: "openai-codex",
  displayName: "OpenAI Codex",
  baseURL: "https://api.openai.com/v1",
  modelID: "gpt-5.6-terra",
  modelName: "GPT-5.6 Terra",
  supportsImages: true,
  contextWindow: 400_000,
  maxOutputTokens: 131_072,
}, null, 2)}\n`);

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=2", "dist/**/*.test.js"],
  {
    cwd: root,
    env: {
      ...process.env,
      LIGHTNINGLOOP_PROVIDER_CONFIG_PATH: configPath,
    },
    stdio: "inherit",
  },
);

rmSync(directory, { force: true, recursive: true });
process.exit(result.status === null ? 1 : result.status);
