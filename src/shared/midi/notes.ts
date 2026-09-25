/** 音名（如 "C4"、"F#3"、"Bb2"）与 MIDI 音高互转。科学音高记谱：C4 = 60。 */

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function parseNoteName(name: string): number {
  const m = /^\s*([A-Ga-g])\s*([#b♯♭x]?)(-?\d+)\s*$/.exec(name);
  if (!m) throw new Error(`无法识别的音名: "${name}"`);
  let pc = LETTER_PC[m[1].toUpperCase()];
  const acc = m[2];
  if (acc === '#' || acc === '♯') pc += 1;
  else if (acc === 'b' || acc === '♭') pc -= 1;
  else if (acc === 'x') pc += 2;
  const octave = parseInt(m[3], 10);
  const pitch = (octave + 1) * 12 + pc;
  if (pitch < 0 || pitch > 127) throw new Error(`音名 ${name} 超出 MIDI 范围`);
  return pitch;
}

export function formatPitch(pitch: number, preferFlats = false): string {
  const p = ((pitch % 12) + 12) % 12;
  const name = preferFlats ? FLAT_NAMES[p] : SHARP_NAMES[p];
  const octave = Math.floor(pitch / 12) - 1;
  return `${name}${octave}`;
}

export function pitchClass(pitch: number): number {
  return ((pitch % 12) + 12) % 12;
}

export const PITCH_CLASS_SHARP = SHARP_NAMES;
export const PITCH_CLASS_FLAT = FLAT_NAMES;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampPitch(p: number): number {
  return clamp(Math.round(p), 0, 127);
}

export function clampVelocity(v: number): number {
  return clamp(Math.round(v), 1, 127);
}

export function clampCC(v: number): number {
  return clamp(Math.round(v), 0, 127);
}

/** 确定性伪随机数（mulberry32），保证人性化处理可复现。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 近似标准正态（Box-Muller），基于给定 rng。 */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
