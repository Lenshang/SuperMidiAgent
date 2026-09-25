/** 和弦符号解析与声位（voicing）生成。支持 C、Am、Cmaj7、F#m7b5、Gsus4、Bb7、Cadd9、C/E 等。 */
import { clampPitch, parseNoteName, pitchClass } from './notes';

export interface Chord {
  root: number; // 音高类 0-11
  bass?: number; // 转位低音（音高类），如 C/E 的 E
  quality: ChordQuality;
  intervals: number[]; // 相对根音的半音数
  symbol: string;
}

export type ChordQuality =
  | 'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4'
  | 'maj7' | 'min7' | 'dom7' | 'm7b5' | 'dim7'
  | 'maj6' | 'min6' | 'mMaj7'
  | 'add9' | 'madd9' | 'maj9' | 'min9' | 'dom9';

const QUALITY_TABLE: Record<string, { quality: ChordQuality; intervals: number[] }> = {
  '': { quality: 'maj', intervals: [0, 4, 7] },
  M: { quality: 'maj', intervals: [0, 4, 7] },
  maj: { quality: 'maj', intervals: [0, 4, 7] },
  m: { quality: 'min', intervals: [0, 3, 7] },
  min: { quality: 'min', intervals: [0, 3, 7] },
  '-': { quality: 'min', intervals: [0, 3, 7] },
  dim: { quality: 'dim', intervals: [0, 3, 6] },
  o: { quality: 'dim', intervals: [0, 3, 6] },
  aug: { quality: 'aug', intervals: [0, 4, 8] },
  '+': { quality: 'aug', intervals: [0, 4, 8] },
  sus2: { quality: 'sus2', intervals: [0, 2, 7] },
  sus4: { quality: 'sus4', intervals: [0, 5, 7] },
  sus: { quality: 'sus4', intervals: [0, 5, 7] },
  '6': { quality: 'maj6', intervals: [0, 4, 7, 9] },
  maj6: { quality: 'maj6', intervals: [0, 4, 7, 9] },
  m6: { quality: 'min6', intervals: [0, 3, 7, 9] },
  min6: { quality: 'min6', intervals: [0, 3, 7, 9] },
  '7': { quality: 'dom7', intervals: [0, 4, 7, 10] },
  dom7: { quality: 'dom7', intervals: [0, 4, 7, 10] },
  maj7: { quality: 'maj7', intervals: [0, 4, 7, 11] },
  M7: { quality: 'maj7', intervals: [0, 4, 7, 11] },
  Δ: { quality: 'maj7', intervals: [0, 4, 7, 11] },
  m7: { quality: 'min7', intervals: [0, 3, 7, 10] },
  min7: { quality: 'min7', intervals: [0, 3, 7, 10] },
  '-7': { quality: 'min7', intervals: [0, 3, 7, 10] },
  m7b5: { quality: 'm7b5', intervals: [0, 3, 6, 10] },
  ø: { quality: 'm7b5', intervals: [0, 3, 6, 10] },
  dim7: { quality: 'dim7', intervals: [0, 3, 6, 9] },
  o7: { quality: 'dim7', intervals: [0, 3, 6, 9] },
  mMaj7: { quality: 'mMaj7', intervals: [0, 3, 7, 11] },
  minMaj7: { quality: 'mMaj7', intervals: [0, 3, 7, 11] },
  add9: { quality: 'add9', intervals: [0, 4, 7, 14] },
  add2: { quality: 'add9', intervals: [0, 2, 4, 7] },
  madd9: { quality: 'madd9', intervals: [0, 3, 7, 14] },
  '9': { quality: 'dom9', intervals: [0, 4, 7, 10, 14] },
  dom9: { quality: 'dom9', intervals: [0, 4, 7, 10, 14] },
  maj9: { quality: 'maj9', intervals: [0, 4, 7, 11, 14] },
  M9: { quality: 'maj9', intervals: [0, 4, 7, 11, 14] },
  m9: { quality: 'min9', intervals: [0, 3, 7, 10, 14] },
  min9: { quality: 'min9', intervals: [0, 3, 7, 10, 14] },
};

const ROOT_NAMES = /^(C#|Db|D#|Eb|E|F#|Gb|G#|Ab|A#|Bb|C|D|E|F|G|A|B)/i;

/** 解析和弦符号，如 "Cmaj7"、"F#m7b5"、"Bb7"、"Gsus4"、"C/E"。 */
export function parseChord(symbol: string): Chord {
  const raw = symbol.trim().replace(/\s+/g, '');
  const rootMatch = ROOT_NAMES.exec(raw);
  if (!rootMatch) throw new Error(`无法识别和弦根音: "${symbol}"`);
  const root = parseNoteName(rootMatch[1] + '4') % 12;
  let rest = raw.slice(rootMatch[1].length);

  let bass: number | undefined;
  const slashIdx = rest.indexOf('/');
  if (slashIdx >= 0) {
    const bassPart = rest.slice(slashIdx + 1);
    rest = rest.slice(0, slashIdx);
    const bassMatch = ROOT_NAMES.exec(bassPart);
    if (!bassMatch) throw new Error(`无法识别和弦低音: "${symbol}"`);
    bass = parseNoteName(bassMatch[1] + '4') % 12;
  }

  const entry = QUALITY_TABLE[rest] ?? QUALITY_TABLE[normalizeQuality(rest)];
  if (!entry) throw new Error(`无法识别和弦属性: "${symbol}"`);
  return { root, bass, quality: entry.quality, intervals: entry.intervals, symbol: raw };
}

function normalizeQuality(q: string): string {
  let s = q.replace(/^[mM]aj(?=7|9)/, (m) => (m[0] === 'M' ? 'M7' : 'maj7'));
  // 常见简写容错：maj9 → maj9 已在表内；处理 mmaj7 等
  s = s.toLowerCase() === 'mmaj7' ? 'mMaj7' : s;
  return s;
}

export function chordPitches(chord: Chord, center = 60): number[] {
  // 三/四声部封闭排列，靠近 center
  const rootAbs = nearestPitchAbove(chord.root, center - 12);
  const voices: number[] = [];
  for (const iv of chord.intervals) {
    let p = rootAbs + iv;
    while (p - center > 9) p -= 12;
    voices.push(clampPitch(p));
  }
  return Array.from(new Set(voices)).sort((a, b) => a - b);
}

function nearestPitchAbove(pc: number, minPitch: number): number {
  let p = pc;
  while (p < minPitch) p += 12;
  return p;
}

export interface VoicingOptions {
  style: 'block' | 'arpeggio' | 'broken';
  barStartTick: number;
  barEndTick: number;
  tpq: number;
  velocity: number;
  centerPitch?: number;
  previousVoicing?: number[]; // 上一个和弦的音符，用于声部连接
}

/** 生成一个和弦在小节内的音符（含低音）。返回新音符数组。 */
export function voiceChord(chord: Chord, opts: VoicingOptions): { pitch: number; startTick: number; endTick: number; velocity: number }[] {
  const center = opts.centerPitch ?? 60;
  const bassPc = chord.bass ?? chord.root;
  const bassPitch = clampPitch(nearestPitchAbove(bassPc, center - 24));
  let upper = chordPitches(chord, center);
  if (opts.previousVoicing && opts.previousVoicing.length > 0) {
    upper = connectVoicing(chord, opts.previousVoicing, center);
  }

  const notes: { pitch: number; startTick: number; endTick: number; velocity: number }[] = [];
  const barLen = opts.barEndTick - opts.barStartTick;
  const q = opts.tpq / 4; // 1/16

  if (opts.style === 'block') {
    notes.push({ pitch: bassPitch, startTick: opts.barStartTick, endTick: opts.barEndTick, velocity: opts.velocity });
    for (const p of upper) {
      notes.push({ pitch: p, startTick: opts.barStartTick, endTick: opts.barEndTick, velocity: opts.velocity });
    }
  } else if (opts.style === 'broken') {
    // 低音 + 分解（根-五-三型），每拍两个音
    const pattern = [bassPitch, upper[upper.length - 1], upper[0], upper[Math.min(1, upper.length - 1)]];
    const step = barLen / Math.max(1, pattern.length);
    pattern.forEach((p, i) => {
      notes.push({
        pitch: p,
        startTick: Math.round(opts.barStartTick + i * step),
        endTick: Math.round(opts.barStartTick + (i + 1) * step),
        velocity: opts.velocity - (i === 0 ? 0 : 8),
      });
    });
  } else {
    // arpeggio：十六分音符上行琶音
    const sequence = [bassPitch, ...upper, ...[...upper].reverse().slice(1, -1)];
    const step = Math.max(q, barLen / sequence.length / 2);
    let t = opts.barStartTick;
    let i = 0;
    while (t < opts.barEndTick - q / 2) {
      const p = sequence[i % sequence.length];
      notes.push({ pitch: p, startTick: Math.round(t), endTick: Math.round(Math.min(t + step * 1.8, opts.barEndTick)), velocity: opts.velocity - 6 });
      t += step;
      i++;
    }
  }
  return notes.map((n) => ({ ...n, velocity: Math.max(20, Math.min(127, Math.round(n.velocity))) }));
}

/** 声部连接：在所有转位/开放位置中，选择与上一个声部平均移动最小的排列。 */
function connectVoicing(chord: Chord, previous: number[], center: number): number[] {
  const base = chordPitches(chord, center);
  const candidates: number[][] = [];
  // 生成若干转位候选：把最低音逐个上移八度
  let rotated = [...base];
  for (let r = 0; r < base.length; r++) {
    candidates.push([...rotated]);
    const lowest = rotated.shift()!;
    rotated = [...rotated, lowest + 12];
  }
  let best = base;
  let bestCost = Number.POSITIVE_INFINITY;
  const prevSorted = [...previous].sort((a, b) => a - b);
  for (const cand of candidates) {
    if (cand.some((p) => p < 40 || p > 84)) continue;
    const cost = cand.reduce((acc, p, i) => acc + Math.abs(p - (prevSorted[i % prevSorted.length] ?? p)), 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return best.sort((a, b) => a - b);
}
