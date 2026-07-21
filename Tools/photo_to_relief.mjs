#!/usr/bin/env node

// Dependency-free, deterministic PNG -> textured 2.5D GLB/OBJ workflow.
// This intentionally does not claim to infer geometry hidden from a single view.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const diagonalDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) return left;
  if (aboveDistance <= diagonalDistance) return above;
  return upperLeft;
}

function decodePNG(data) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Input is not a PNG.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > data.length) throw new Error("PNG chunk exceeds the input boundary.");
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (length !== 13) throw new Error("PNG IHDR has an invalid length.");
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = end;
  }
  if (width < 2 || height < 2 || width > 16_384 || height > 16_384) throw new Error("PNG dimensions are outside the supported range.");
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error("Normalized PNG must be non-interlaced 8-bit RGB or RGBA.");
  }
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: (rowBytes + 1) * height });
  if (inflated.length !== (rowBytes + 1) * height) throw new Error("PNG pixel payload has an unexpected size.");
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const inputRow = y * (rowBytes + 1);
    const outputRow = y * rowBytes;
    const filter = inflated[inputRow];
    if (filter > 4) throw new Error("PNG uses an unsupported row filter.");
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[inputRow + 1 + x];
      const left = x >= channels ? pixels[outputRow + x - channels] : 0;
      const above = y > 0 ? pixels[outputRow - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[outputRow - rowBytes + x - channels] : 0;
      const value = filter === 0 ? raw
        : filter === 1 ? raw + left
          : filter === 2 ? raw + above
            : filter === 3 ? raw + Math.floor((left + above) / 2)
              : raw + paeth(left, above, upperLeft);
      pixels[outputRow + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function sample(image, u, v) {
  const x = Math.min(image.width - 1, Math.max(0, Math.round(u * (image.width - 1))));
  const y = Math.min(image.height - 1, Math.max(0, Math.round((1 - v) * (image.height - 1))));
  const offset = (y * image.width + x) * image.channels;
  const red = image.pixels[offset];
  const green = image.pixels[offset + 1];
  const blue = image.pixels[offset + 2];
  return { red, green, blue, luminance: (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 };
}

function align4(value) {
  return (value + 3) & ~3;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  name.copy(result, 4);
  payload.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, payload])), 8 + payload.length);
  return result;
}

function encodePreview(image, heightAt) {
  const width = Math.min(640, image.width);
  const height = Math.max(2, Math.round(width * image.height / image.width));
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const v = 1 - y / (height - 1);
      const color = sample(image, u, v);
      const left = heightAt(Math.max(0, u - 1 / width), v);
      const right = heightAt(Math.min(1, u + 1 / width), v);
      const down = heightAt(u, Math.max(0, v - 1 / height));
      const up = heightAt(u, Math.min(1, v + 1 / height));
      const shade = Math.max(0.42, Math.min(1.25, 0.88 + (left - right) * 2.8 + (down - up) * 1.8));
      const target = 1 + x * 4;
      row[target] = Math.min(255, Math.round(color.red * shade));
      row[target + 1] = Math.min(255, Math.round(color.green * shade));
      row[target + 2] = Math.min(255, Math.round(color.blue * shade));
      row[target + 3] = 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createGeometry(image) {
  const maximum = 64;
  const gridX = image.width >= image.height ? maximum : Math.max(12, Math.round(maximum * image.width / image.height));
  const gridY = image.height >= image.width ? maximum : Math.max(12, Math.round(maximum * image.height / image.width));
  const aspect = image.width / image.height;
  const width = aspect >= 1 ? 3.2 : 3.2 * aspect;
  const height = aspect >= 1 ? 3.2 / aspect : 3.2;
  const depth = Math.min(width, height) * 0.16;
  const heightAt = (u, v) => sample(image, u, v).luminance * depth;
  const positions = new Float32Array(gridX * gridY * 3);
  const normals = new Float32Array(gridX * gridY * 3);
  const uvs = new Float32Array(gridX * gridY * 2);
  let positionCursor = 0;
  let uvCursor = 0;
  for (let y = 0; y < gridY; y += 1) {
    const v = y / (gridY - 1);
    for (let x = 0; x < gridX; x += 1) {
      const u = x / (gridX - 1);
      positions[positionCursor] = (u - 0.5) * width;
      positions[positionCursor + 1] = (v - 0.5) * height;
      positions[positionCursor + 2] = heightAt(u, v);
      const dx = heightAt(Math.min(1, u + 1 / (gridX - 1)), v) - heightAt(Math.max(0, u - 1 / (gridX - 1)), v);
      const dy = heightAt(u, Math.min(1, v + 1 / (gridY - 1))) - heightAt(u, Math.max(0, v - 1 / (gridY - 1)));
      const nx = -dx * gridX / width;
      const ny = -dy * gridY / height;
      const length = Math.hypot(nx, ny, 1);
      normals[positionCursor] = nx / length;
      normals[positionCursor + 1] = ny / length;
      normals[positionCursor + 2] = 1 / length;
      uvs[uvCursor] = u;
      uvs[uvCursor + 1] = v;
      positionCursor += 3;
      uvCursor += 2;
    }
  }
  const indices = new Uint16Array((gridX - 1) * (gridY - 1) * 6);
  let indexCursor = 0;
  for (let y = 0; y < gridY - 1; y += 1) {
    for (let x = 0; x < gridX - 1; x += 1) {
      const lower = y * gridX + x;
      indices.set([lower, lower + 1, lower + gridX + 1, lower, lower + gridX + 1, lower + gridX], indexCursor);
      indexCursor += 6;
    }
  }
  return { gridX, gridY, width, height, depth, positions, normals, uvs, indices, heightAt };
}

function typedBuffer(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function createGLB(geometry, texturePNG) {
  const segments = [];
  const views = [];
  let cursor = 0;
  const append = (buffer, target) => {
    const padding = align4(cursor) - cursor;
    if (padding) segments.push(Buffer.alloc(padding));
    cursor += padding;
    const view = { buffer: 0, byteOffset: cursor, byteLength: buffer.length, ...(target ? { target } : {}) };
    views.push(view);
    segments.push(buffer);
    cursor += buffer.length;
    return views.length - 1;
  };
  const positionView = append(typedBuffer(geometry.positions), 34962);
  const normalView = append(typedBuffer(geometry.normals), 34962);
  const uvView = append(typedBuffer(geometry.uvs), 34962);
  const indexView = append(typedBuffer(geometry.indices), 34963);
  const imageView = append(texturePNG);
  const binary = Buffer.concat([...segments, Buffer.alloc(align4(cursor) - cursor)]);
  const vertexCount = geometry.positions.length / 3;
  const gltf = {
    asset: { version: "2.0", generator: "BarnLabs LightningLoop photo relief" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "PhotoRelief" }],
    meshes: [{ name: "PhotoReliefMesh", primitives: [{
      attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
      indices: 3,
      material: 0,
    }] }],
    materials: [{ name: "SourceImageMaterial", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.7 }, doubleSided: true }],
    textures: [{ sampler: 0, source: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: imageView, mimeType: "image/png", name: "SourceImage" }],
    accessors: [
      { bufferView: positionView, componentType: 5126, count: vertexCount, type: "VEC3", min: [-geometry.width / 2, -geometry.height / 2, 0], max: [geometry.width / 2, geometry.height / 2, geometry.depth] },
      { bufferView: normalView, componentType: 5126, count: vertexCount, type: "VEC3" },
      { bufferView: uvView, componentType: 5126, count: vertexCount, type: "VEC2", min: [0, 0], max: [1, 1] },
      { bufferView: indexView, componentType: 5123, count: geometry.indices.length, type: "SCALAR", min: [0], max: [vertexCount - 1] },
    ],
    bufferViews: views,
    buffers: [{ byteLength: binary.length }],
  };
  const json = Buffer.from(JSON.stringify(gltf), "utf8");
  const paddedJSON = Buffer.concat([json, Buffer.alloc(align4(json.length) - json.length, 0x20)]);
  const glb = Buffer.alloc(12 + 8 + paddedJSON.length + 8 + binary.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(paddedJSON.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  paddedJSON.copy(glb, 20);
  const binaryHeader = 20 + paddedJSON.length;
  glb.writeUInt32LE(binary.length, binaryHeader);
  glb.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(glb, binaryHeader + 8);
  return glb;
}

function createOBJ(geometry) {
  const lines = ["# LightningLoop single-view 2.5D relief"];
  for (let index = 0; index < geometry.positions.length; index += 3) {
    lines.push(`v ${geometry.positions[index].toFixed(6)} ${geometry.positions[index + 1].toFixed(6)} ${geometry.positions[index + 2].toFixed(6)}`);
  }
  for (let index = 0; index < geometry.uvs.length; index += 2) lines.push(`vt ${geometry.uvs[index].toFixed(6)} ${geometry.uvs[index + 1].toFixed(6)}`);
  for (let index = 0; index < geometry.indices.length; index += 3) {
    const a = geometry.indices[index] + 1;
    const b = geometry.indices[index + 1] + 1;
    const c = geometry.indices[index + 2] + 1;
    lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
  }
  return `${lines.join("\n")}\n`;
}

function reopenGLB(glb) {
  if (glb.readUInt32LE(0) !== 0x46546c67 || glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length) throw new Error("GLB header validation failed.");
  const jsonLength = glb.readUInt32LE(12);
  if (glb.readUInt32LE(16) !== 0x4e4f534a) throw new Error("GLB JSON chunk is missing.");
  const parsed = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength).trim());
  const binaryHeader = 20 + jsonLength;
  if (glb.readUInt32LE(binaryHeader + 4) !== 0x004e4942) throw new Error("GLB binary chunk is missing.");
  const binaryLength = glb.readUInt32LE(binaryHeader);
  if (binaryHeader + 8 + binaryLength !== glb.length) throw new Error("GLB binary chunk length is invalid.");
  const vertexCount = parsed.accessors?.[0]?.count ?? 0;
  const materialSlots = parsed.meshes?.[0]?.primitives?.[0]?.material === 0 ? 1 : 0;
  if (vertexCount < 4 || materialSlots < 1 || parsed.images?.[0]?.mimeType !== "image/png") throw new Error("GLB semantic reopen validation failed.");
  return { passed: true, mesh_objects: parsed.meshes.length, vertices: vertexCount, material_slots: materialSlots };
}

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) fail("usage: node photo_to_relief.mjs INPUT_PNG OUTPUT_DIRECTORY");
const sourcePath = resolve(sourceArgument);
const outputDirectory = resolve(outputArgument);
try {
  const sourcePNG = await readFile(sourcePath);
  const image = decodePNG(sourcePNG);
  const geometry = createGeometry(image);
  const glb = createGLB(geometry, sourcePNG);
  const preview = encodePreview(image, geometry.heightAt);
  const reopenValidation = reopenGLB(glb);
  await Promise.all([
    writeFile(join(outputDirectory, "relief.glb"), glb, { mode: 0o600 }),
    writeFile(join(outputDirectory, "relief.obj"), createOBJ(geometry), { mode: 0o600 }),
    writeFile(join(outputDirectory, "preview.png"), preview, { mode: 0o600 }),
  ]);
  const report = {
    workflow: "LightningLoop photo-to-3D relief",
    source: basename(sourcePath),
    source_sha256: createHash("sha256").update(sourcePNG).digest("hex"),
    source_pixels: [image.width, image.height],
    grid: [geometry.gridX, geometry.gridY],
    vertices: geometry.positions.length / 3,
    triangles: geometry.indices.length / 3,
    dimensions_model_units: [geometry.width, geometry.height, geometry.depth],
    reopen_validation: reopenValidation,
    outputs: ["relief.glb", "relief.obj", "preview.png", "report.json"],
    limitation: "A single photograph cannot reveal hidden geometry. This output is a textured 2.5D luminance relief, not full photogrammetry.",
  };
  await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
