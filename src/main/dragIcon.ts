/** 生成拖拽用的图标 PNG（纯 Node 实现，无 canvas 依赖）。 */
import { deflateSync } from 'zlib';

function crc32(buf: Uint8Array): number {
  let table = crcTable;
  if (!table) {
    table = crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

let crcTable: Uint32Array | null = null;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  const out = new Uint8Array(len.length + body.length + crc.length);
  out.set(len);
  out.set(body, 4);
  out.set(crc, 4 + body.length);
  return out;
}

/** 绘制 64x64 圆角方块 + 音符形状的 PNG。 */
export function createDragIconPng(): Uint8Array {
  const size = 64;
  const rgba = new Uint8Array(size * size * 4);

  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // alpha 混合
    const na = a / 255;
    rgba[i] = Math.round(rgba[i] * (1 - na) + r * na);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - na) + g * na);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - na) + b * na);
    rgba[i + 3] = Math.min(255, rgba[i + 3] + a);
  };

  // 圆角背景（紫色渐变）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const d = Math.min(dx, dy);
      if (d < 2) continue; // 透明角落
      const corner = 10;
      let inside = true;
      if (dx < corner && dy < corner) {
        const cdx = corner - dx;
        const cdy = corner - dy;
        inside = cdx * cdx + cdy * cdy <= corner * corner;
      }
      if (!inside) continue;
      const t = y / size;
      const r = Math.round(124 + 38 * t);
      const g = Math.round(58 + 20 * t);
      const b = Math.round(237 - 20 * t);
      setPixel(x, y, r, g, b, 255);
    }
  }

  // 音符：符头（椭圆）+ 符干 + 符尾
  const head = (cx: number, cy: number) => {
    for (let y = -6; y <= 6; y++) {
      for (let x = -8; x <= 8; x++) {
        if ((x * x) / 64 + (y * y) / 30 <= 1) setPixel(cx + x, cy + y, 255, 255, 255, 235);
      }
    }
  };
  head(26, 44);
  head(44, 40);
  // 符干
  for (let y = 18; y <= 44; y++) setPixel(32, y, 255, 255, 255, 235);
  for (let y = 14; y <= 40; y++) setPixel(50, y, 255, 255, 255, 235);
  // 顶部连接（符尾横梁）
  for (let x = 32; x <= 50; x++) {
    setPixel(x, 16, 255, 255, 255, 235);
    setPixel(x, 17, 255, 255, 255, 235);
  }

  // 组装 PNG
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
