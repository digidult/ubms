#!/usr/bin/env node
/**
 * Renders the app icon (same drawing as apps/web/public/icon.svg) into the PNG and ICO files the
 * Tauri build needs, without any image tooling: signed distance functions, 4x4 supersampling,
 * PNG via zlib, ICO with BMP entries (16, 24, 32, 48, 64) and a PNG entry (256).
 *
 * Usage: node scripts/make-icons.mjs [outDir]   (default apps/desktop/src-tauri/icons)
 */
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, process.argv[2] ?? 'apps/desktop/src-tauri/icons');

/** Signed distance to a rounded rectangle (x, y, w, h, r) in icon units (0..512). */
function roundedRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Color at a point: [r, g, b, a] with straight alpha, components 0..1. */
function shade(px, py) {
  const blue = [0x1f / 255, 0x6f / 255, 0xeb / 255];
  if (roundedRect(px, py, 0, 0, 512, 512, 112) > 0) return [0, 0, 0, 0];
  let c = blue;
  const over = (/** @type {number} */ alpha) => {
    c = c.map((v) => v * (1 - alpha) + alpha);
  };
  if (Math.abs(roundedRect(px, py, 104, 160, 268, 192, 32)) <= 16) over(1);
  if (roundedRect(px, py, 384, 220, 32, 72, 10) <= 0) over(1);
  if (roundedRect(px, py, 146, 202, 70, 108, 12) <= 0) over(1);
  if (roundedRect(px, py, 236, 202, 70, 108, 12) <= 0) over(0.55);
  return [...c, 1];
}

/** RGBA pixels of a size x size icon (top-down rows). */
function render(size) {
  const ss = 4;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = shade(((x + (sx + 0.5) / ss) / size) * 512, ((y + (sy + 0.5) / ss) / size) * 512);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      px[i + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        px[i] = Math.round((r / a) * 255);
        px[i + 1] = Math.round((g / a) * 255);
        px[i + 2] = Math.round((b / a) * 255);
      }
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const px = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 32-bit BMP (DIB) entry for an ICO file: bottom-up BGRA plus an empty AND mask. */
function bmpEntry(size) {
  const px = render(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      pixels[dst] = px[src + 2];
      pixels[dst + 1] = px[src + 1];
      pixels[dst + 2] = px[src];
      pixels[dst + 3] = px[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico() {
  const images = [16, 24, 32, 48, 64].map((s) => ({ size: s, data: bmpEntry(s) }));
  images.push({ size: 256, data: png(256) });
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    head[e] = img.size >= 256 ? 0 : img.size;
    head[e + 1] = img.size >= 256 ? 0 : img.size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(img.data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

mkdirSync(outDir, { recursive: true });
const files = {
  '32x32.png': png(32),
  '64x64.png': png(64),
  '128x128.png': png(128),
  '128x128@2x.png': png(256),
  'icon.png': png(512),
  'icon.ico': ico(),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(outDir, name), data);
  console.log(`${name.padEnd(16)} ${data.length} bytes`);
}
