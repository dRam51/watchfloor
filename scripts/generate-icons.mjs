#!/usr/bin/env node
/**
 * Generates the PWA icons (M6).
 *
 * PNG is written by hand -- zlib is in Node's standard library and a PNG is a
 * CRC-checked container around a deflate stream, so this needs no dependency.
 * That matters more than it sounds: every image toolchain (sharp, canvas,
 * jimp) is either native, large, or both, and this project has rejected the
 * MCP and Anthropic SDKs on exactly that measurement. Forty lines of zlib is a
 * better trade than a native module for four static files.
 *
 * SVG alone would not do. Android and desktop Chrome accept it, but an iOS
 * home-screen icon must be PNG, and a phone is the whole point of the PWA --
 * §7's deliverable is "legible on a phone browser".
 *
 *   node scripts/generate-icons.mjs
 *
 * Deterministic: same input, byte-identical output, so re-running it does not
 * churn git. Committed rather than generated at build time because they change
 * roughly never and a build step that produces binaries is a build step that
 * eventually breaks quietly.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'web', 'public');

// Pulled from web/src/styles/tokens.css so the icon and the app agree. Stated
// as literals here because this script must not import the app's CSS, and
// noted so a palette retune knows to come back.
const BG = [11, 14, 18]; // --color-bg
const INK = [122, 162, 247]; // --color-accent
const DIM = [91, 102, 114]; // --color-text-dim

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixels -> a PNG file. */
function png(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10,11,12 = compression, filter, interlace: all 0.

  // Each scanline is prefixed with a filter byte; 0 = None. Filtering would
  // shrink the file, and at this size it is not worth the code to get wrong.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The mark: three stacked bars of decreasing length on a dark ground — a lane
 * of ranked rows, which is what the thing actually is. Deliberately not a
 * letterform: at 48px on a home screen a "W" is indistinguishable from every
 * other "W", and this reads as a list at any size.
 *
 * `safe` insets the artwork for maskable icons, where the platform may crop to
 * a circle and anything in the outer ~10% can be cut.
 */
function draw(size, { maskable }) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };

  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) set(x, y, BG);

  const safe = maskable ? Math.round(size * 0.18) : Math.round(size * 0.16);
  const inner = size - safe * 2;
  const barH = Math.max(2, Math.round(inner * 0.16));
  const gap = Math.max(2, Math.round(inner * 0.13));
  const widths = [1, 0.72, 0.46];
  const colours = [INK, INK, DIM];

  let y = safe + Math.round((inner - (barH * 3 + gap * 2)) / 2);
  for (let b = 0; b < 3; b += 1) {
    const w = Math.round(inner * widths[b]);
    for (let dy = 0; dy < barH; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) set(safe + dx, y + dy, colours[b]);
    }
    y += barH + gap;
  }
  return png(size, size, px);
}

mkdirSync(outDir, { recursive: true });
const written = [];
for (const [name, size, opts] of [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: false }], // iOS ignores the manifest and reads this
]) {
  const file = join(outDir, name);
  writeFileSync(file, draw(size, opts));
  written.push(name);
}
console.log(`wrote ${written.length} icon(s) to web/public: ${written.join(', ')}`);
