import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface AgentImage {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  expectedSHA256: string;
}

export interface EncodedAgentImage extends AgentImage {
  data: string;
}

function detectedMimeType(buffer: Buffer): AgentImage["mimeType"] | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
  return undefined;
}

export async function validateImagePaths(paths: readonly string[]): Promise<AgentImage[]> {
  if (paths.length > MAX_IMAGES) throw new Error(`A run may include at most ${MAX_IMAGES} images.`);
  const images: AgentImage[] = [];
  for (const path of paths) {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("Every image path must be an explicit absolute path.");
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Image attachments must be regular files, not links or directories.");
    if (metadata.size < 1 || metadata.size > MAX_IMAGE_BYTES) throw new Error(`Each image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
    const canonical = await realpath(path);
    const buffer = await readFile(canonical);
    const mimeType = detectedMimeType(buffer);
    if (!mimeType) throw new Error("Image content must be PNG, JPEG, WebP, or GIF; filename extensions are not trusted.");
    images.push({ path: canonical, mimeType, expectedSHA256: createHash("sha256").update(buffer).digest("hex") });
  }
  return images;
}

export async function encodeAgentImages(images: readonly AgentImage[]): Promise<EncodedAgentImage[]> {
  return Promise.all(images.map(async (image) => {
    if (!/^[a-f0-9]{64}$/u.test(image.expectedSHA256)) throw new Error("Image evidence requires a valid expected SHA-256 hash.");
    const metadata = await lstat(image.path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1 || metadata.size > MAX_IMAGE_BYTES) {
      throw new Error("Image evidence changed type or exceeded its byte bound before review.");
    }
    const buffer = await readFile(image.path);
    const detected = detectedMimeType(buffer);
    const actualSHA256 = createHash("sha256").update(buffer).digest("hex");
    if (detected !== image.mimeType || actualSHA256 !== image.expectedSHA256) {
      throw new Error("Image evidence changed after validation; review is blocked.");
    }
    return { ...image, data: buffer.toString("base64") };
  }));
}
