import assert from "node:assert/strict";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeAgentImages, validateImagePaths } from "./image-input.js";

test("image loader trusts bounded file content rather than extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightningloop-images-"));
  const png = join(root, "evidence.bin");
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  const [image] = await validateImagePaths([png]);
  assert.equal(image?.mimeType, "image/png");
  assert.equal(image?.path, await realpath(png));
  assert.match(image?.expectedSHA256 ?? "", /^[a-f0-9]{64}$/u);
});

test("image encoding rejects bytes changed after validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightningloop-images-"));
  const png = join(root, "evidence.png");
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  const images = await validateImagePaths([png]);
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
  await assert.rejects(encodeAgentImages(images), /changed after validation/);
});

test("image loader rejects links, relative paths, and unsupported bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightningloop-images-"));
  const file = join(root, "text.png");
  const link = join(root, "linked.png");
  await writeFile(file, "not an image");
  await symlink(file, link);
  await assert.rejects(validateImagePaths(["relative.png"]), /absolute path/);
  await assert.rejects(validateImagePaths([link]), /regular files/);
  await assert.rejects(validateImagePaths([file]), /PNG, JPEG, WebP, or GIF/);
  await assert.rejects(validateImagePaths(Array(5).fill(file)), /at most 4/);
});
