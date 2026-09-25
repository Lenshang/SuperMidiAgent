/** 生成应用图标 build/icon.ico（纯 Node：绘制 PNG 并封装 ICO 容器）。 */
import { deflateSync } from 'zlib';
import fs from 'fs';

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  const out = new Uint8Array(4 + body.length + 4);
  out.set(len);
  out.set(body, 4);
  out.set(crc, 4 + body.length);
  return out;
}

/** 绘制 size x size 的音符图标 RGBA。 */
function draw(size) {
  const s = size / 64;
  const rgba = new Uint8Array(size * size * 4);
  const set = (x, y, r, g, b, a) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const na = a / 255;
    rgba[i] = Math.round(rgba[i] * (1 - na) + r * na);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - na) + g * na);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - na) + b * na);
    rgba[i + 3] = Math.min(255, rgba[i + 3] + a);
  };

  // 圆角渐变背景
  const corner = 10 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      if (Math.min(dx, dy) < 1.4 * s) continue;
      let inside = true;
      if (dx < corner && dy < corner) {
        const cdx = corner - dx;
        const cdy = corner - dy;
        inside = cdx * cdx + cdy * cdy <= corner * corner;
      }
      if (!inside) continue;
      const t = y / size;
      set(x, y, Math.round(124 + 38 * t), Math.round(58 + 20 * t), Math.round(237 - 20 * t), 255);
    }
  }

  const disc = (cx, cy, rx, ry, a = 250) => {
    for (let y = -ry - 1; y <= ry + 1; y++) {
      for (let x = -rx - 1; x <= rx + 1; x++) {
        if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) set(cx + x, cy + y, 255, 255, 255, a);
      }
    }
  };
  const rect = (x0, y0, x1, y1, a = 250) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, 255, 255, 255, a);
  };

  // 双音符
  disc(26 * s, 44 * s, 8 * s, 6 * s);
  disc(44 * s, 40 * s, 8 * s, 6 * s);
  rect(31 * s, 18 * s, 33 * s, 44 * s);
  rect(49 * s, 14 * s, 51 * s, 40 * s);
  rect(32 * s, 16 * s, 50 * s, 18.6 * s);
  // 高光弧
  for (let x = 12 * s; x <= 52 * s; x++) {
    const y = 9 * s + Math.sin((x / size) * Math.PI) * 2.2 * s;
    set(x, y, 255, 255, 255, 70);
  }
  return rgba;
}

function png(rgba, size) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ICO：256 与 64 两个 PNG 条目
const sizes = [256, 64];
const pngs = sizes.map((sz) => png(draw(sz), sz));
const count = sizes.length;
const header = new Uint8Array(6);
header[0] = 0;
header[1] = 0;
header[2] = 1;
header[3] = 0;
header[4] = count;
header[5] = 0;

const dir = new Uint8Array(16 * count);
const dv = new DataView(dir.buffer);
let offset = 6 + 16 * count;
sizes.forEach((sz, i) => {
  const base = i * 16;
  dir[base] = sz === 256 ? 0 : sz;
  dir[base + 1] = sz === 256 ? 0 : sz;
  dir[base + 2] = 0;
  dir[base + 3] = 0;
  dv.setUint16(base + 4, 1, true);
  dv.setUint16(base + 6, 32, true);
  dv.setUint32(base + 8, pngs[i].length, true);
  dv.setUint32(base + 12, offset, true);
  offset += pngs[i].length;
});

const ico = new Uint8Array(offset);
ico.set(header, 0);
ico.set(dir, 6);
let o = 6 + 16 * count;
for (const p of pngs) {
  ico.set(p, o);
  o += p.length;
}

fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.ico', ico);
console.log(`build/icon.ico written: ${ico.length} bytes (sizes: ${sizes.join(', ')})`);

// macOS / Linux 使用的 512x512 PNG
fs.writeFileSync('build/icon.png', png(draw(512), 512));
console.log(`build/icon.png written: 512x512`);
