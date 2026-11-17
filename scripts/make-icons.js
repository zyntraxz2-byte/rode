'use strict';
// Generates the PWA icons (pink tile with a white "R") as PNGs without any image library.
// Run: node scripts/make-icons.js   (output: public/icons/*.png)
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [0xee, 0x11, 0x82];
const FG = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const rect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** `scale` shrinks the glyph (maskable icons keep it inside the central safe zone). */
function png(size, { scale = 1, rounded = false } = {}) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = rounded ? size * 0.22 : 0;
  for (let j = 0; j < size; j++) {
    raw[j * (size * 4 + 1)] = 0;
    for (let i = 0; i < size; i++) {
      // map pixel to a 10x10 design grid, centred and scaled
      const x = ((i + 0.5) / size - 0.5) / scale * 10 + 5;
      const y = ((j + 0.5) / size - 0.5) / scale * 10 + 5;
      const glyph =
        rect(x, y, 3.2, 2.2, 4.6, 7.8) || rect(x, y, 3.2, 2.2, 7.0, 3.5) || rect(x, y, 3.2, 4.5, 7.0, 5.8) ||
        rect(x, y, 5.7, 2.2, 7.0, 5.8) || segDist(x, y, 4.9, 5.6, 7.6, 7.8) < 0.7;
      let inside = true;
      if (rounded) {
        const cx = Math.min(Math.max(i + 0.5, radius), size - radius), cy = Math.min(Math.max(j + 0.5, radius), size - radius);
        inside = Math.hypot(i + 0.5 - cx, j + 0.5 - cy) <= radius;
      }
      const o = j * (size * 4 + 1) + 1 + i * 4;
      const c = glyph ? FG : BG;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
const files = {
  'icon-192.png': png(192, { rounded: true }),
  'icon-512.png': png(512, { rounded: true }),
  'maskable-512.png': png(512, { scale: 0.7 }), // full-bleed; glyph inside the 80% safe zone
  'apple-touch-icon.png': png(180, { scale: 0.85 }), // iOS applies its own rounding and dislikes transparency
};
for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(out, name), buf);
process.stdout.write(`wrote ${Object.keys(files).length} icons to ${out}\n`);
