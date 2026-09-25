/** 音乐分析：调性检测（Krumhansl-Schmuckler）、逐小节和弦识别、统计信息。 */
import { Chord, ChordQuality, parseChord } from './chords';
import { pitchClass } from './notes';
import { MidiDocument, MidiNote, MidiTrack, DRUM_CHANNEL } from './types';
import { buildSigMap, collectSigs, collectTempos, buildTempoMap, ticksToSec, docDurationSec, docBarCount, barToTick, bpmOf, tickToBar } from './timing';

// Krumhansl-Kessler 音高类权重
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyEstimate {
  tonic: number; // 音高类 0-11
  tonicName: string;
  mode: 'major' | 'minor';
  confidence: number; // 0-1
}

/** 按时长×力度加权统计音高类分布并匹配 24 个大小调轮廓。 */
export function detectKey(doc: MidiDocument): KeyEstimate {
  const histogram = new Array(12).fill(0);
  for (const track of doc.tracks) {
    for (const note of track.notes) {
      if (isDrum(track, note)) continue;
      histogram[pitchClass(note.pitch)] += Math.max(1, note.endTick - note.startTick) * (note.velocity / 64);
    }
  }
  const total = histogram.reduce((a, b) => a + b, 0);
  if (total === 0) return { tonic: 0, tonicName: 'C', mode: 'major', confidence: 0 };

  let best = { score: -Infinity, tonic: 0, mode: 'major' as 'major' | 'minor' };
  let second = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? KS_MAJOR : KS_MINOR;
      const score = correlation(rotate(histogram, tonic), profile);
      if (score > best.score) {
        second = best.score;
        best = { score, tonic, mode };
      } else if (score > second) {
        second = score;
      }
    }
  }
  // 相关性差值映射到 0-1 置信度
  const confidence = Math.max(0, Math.min(1, (best.score - Math.max(second, 0)) * 2.5));
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return { tonic: best.tonic, tonicName: names[best.tonic], mode: best.mode, confidence };
}

function rotate(arr: number[], k: number): number[] {
  return arr.map((_, i) => arr[(i + k) % 12]);
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let dbv = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    dbv += (b[i] - mb) ** 2;
  }
  const den = Math.sqrt(da * dbv) || 1e-9;
  return num / den;
}

const CHORD_TEMPLATES: { quality: ChordQuality; intervals: number[]; suffix: string }[] = [
  { quality: 'maj', intervals: [0, 4, 7], suffix: '' },
  { quality: 'min', intervals: [0, 3, 7], suffix: 'm' },
  { quality: 'dom7', intervals: [0, 4, 7, 10], suffix: '7' },
  { quality: 'maj7', intervals: [0, 4, 7, 11], suffix: 'maj7' },
  { quality: 'min7', intervals: [0, 3, 7, 10], suffix: 'm7' },
  { quality: 'm7b5', intervals: [0, 3, 6, 10], suffix: 'm7b5' },
  { quality: 'dim', intervals: [0, 3, 6], suffix: 'dim' },
  { quality: 'aug', intervals: [0, 4, 8], suffix: 'aug' },
  { quality: 'sus4', intervals: [0, 5, 7], suffix: 'sus4' },
  { quality: 'sus2', intervals: [0, 2, 7], suffix: 'sus2' },
  { quality: 'maj6', intervals: [0, 4, 7, 9], suffix: '6' },
  { quality: 'maj9', intervals: [0, 4, 7, 11, 14], suffix: 'maj9' },
];

export interface BarChord {
  bar: number; // 1-based
  chord: string | null; // 如 "Cmaj7"；无足够音符为 null
}

/** 逐小节识别和弦：时长加权 + 低音加成 + 模板匹配。 */
export function detectChordsByBar(doc: MidiDocument, trackIndex?: number): BarChord[] {
  const tpq = doc.ticksPerQuarter;
  const sigMap = buildSigMap(collectSigs(doc));
  const bars = docBarCount(doc);
  const tracks = trackIndex !== undefined ? [doc.tracks[trackIndex]].filter(Boolean) : doc.tracks.filter((t) => t.notes.length > 0);
  const result: BarChord[] = [];
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  for (let bar = 1; bar <= bars; bar++) {
    const startTick = barToTick(bar, tpq, sigMap);
    const endTick = barToTick(bar + 1, tpq, sigMap);
    const weights = new Array(12).fill(0);
    const bassWeights = new Array(12).fill(0);
    for (const track of tracks) {
      if (isDrumTrack(track)) continue;
      for (const note of track.notes) {
        const s = Math.max(note.startTick, startTick);
        const e = Math.min(note.endTick, endTick);
        if (e - s <= 0) continue;
        const w = ((e - s) / tpq) * (0.5 + note.velocity / 127);
        weights[pitchClass(note.pitch)] += w;
        if (track.notes.some((n2) => n2.startTick === note.startTick)) {
          // 同 onset 最低音获得低音加成
          const lowestSameOnset = Math.min(...track.notes.filter((n2) => n2.startTick === note.startTick).map((n2) => n2.pitch));
          if (note.pitch === lowestSameOnset) bassWeights[pitchClass(note.pitch)] += w * 1.5;
        }
      }
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (total < 0.25) {
      result.push({ bar, chord: null });
      continue;
    }
    let best: { name: string; score: number } | null = null;
    for (let root = 0; root < 12; root++) {
      for (const tpl of CHORD_TEMPLATES) {
        let score = 0;
        const inChord = new Set(tpl.intervals.map((i) => (root + i) % 12));
        for (let pc = 0; pc < 12; pc++) {
          score += inChord.has(pc) ? weights[pc] : -weights[pc] * 0.7;
        }
        // 根音与低音加成
        score += weights[root] * 0.5 + (bassWeights[root] > 0 ? bassWeights[root] * 0.5 : 0);
        // 三音存在性检查（sus 除外）
        if (tpl.quality !== 'sus4' && tpl.quality !== 'sus2') {
          const third = (root + tpl.intervals[1]) % 12;
          if (weights[third] < total * 0.04) score -= total * 0.3;
        }
        const name = names[root] + tpl.suffix;
        if (!best || score > best.score) best = { name, score };
      }
    }
    result.push({ bar, chord: best && best.score > 0 ? best.name : null });
  }
  return result;
}

export interface TrackStats {
  index: number;
  name: string;
  program: number;
  channel: number;
  noteCount: number;
  pitchRange: [number, number] | null;
  avgVelocity: number;
  minVelocity: number;
  maxVelocity: number;
  controllers: Record<number, number>; // CC 号 → 事件数
  durationSec: number;
}

export interface MidiStats {
  durationSec: number;
  barCount: number;
  tempoBpm: number;
  tempoChanges: { tick: number; bpm: number }[];
  timeSignatures: { tick: number; numerator: number; denominator: number }[];
  ticksPerQuarter: number;
  format: number;
  key: KeyEstimate;
  totalNotes: number;
  tracks: TrackStats[];
  hasCC11: boolean;
  hasSustain: boolean;
  keyEstimateConfidence: number;
}

export function analyzeStats(doc: MidiDocument): MidiStats {
  const tpq = doc.ticksPerQuarter;
  const tempos = collectTempos(doc);
  const tempoMap = buildTempoMap(tempos, tpq);
  const durationSec = docDurationSec(doc);
  const tracks: TrackStats[] = doc.tracks.map((t, index) => {
    const controllers: Record<number, number> = {};
    for (const c of t.controls) controllers[c.controller] = (controllers[c.controller] ?? 0) + 1;
    const pitches = t.notes.map((n) => n.pitch);
    const vels = t.notes.map((n) => n.velocity);
    return {
      index,
      name: t.name || `Track ${index + 1}`,
      program: t.program,
      channel: t.channel,
      noteCount: t.notes.length,
      pitchRange: pitches.length ? [Math.min(...pitches), Math.max(...pitches)] : null,
      avgVelocity: vels.length ? Math.round(vels.reduce((a, b) => a + b, 0) / vels.length) : 0,
      minVelocity: vels.length ? Math.min(...vels) : 0,
      maxVelocity: vels.length ? Math.max(...vels) : 0,
      controllers,
      durationSec: t.notes.length ? Math.max(...t.notes.map((n) => ticksToSec(n.endTick, tpq, tempoMap))) : 0,
    };
  });
  const key = detectKey(doc);
  const allNotes = doc.tracks.flatMap((t) => t.notes);
  return {
    durationSec,
    barCount: docBarCount(doc),
    tempoBpm: Math.round(bpmOf(tempos[0]?.usPerQuarter ?? 500000) * 10) / 10,
    tempoChanges: tempos.map((t) => ({ tick: t.tick, bpm: Math.round(bpmOf(t.usPerQuarter) * 10) / 10 })),
    timeSignatures: collectSigs(doc).map((s) => ({ tick: s.tick, numerator: s.numerator, denominator: s.denominator })),
    ticksPerQuarter: tpq,
    format: doc.format,
    key,
    totalNotes: allNotes.length,
    tracks,
    hasCC11: doc.tracks.some((t) => t.controls.some((c) => c.controller === 11)),
    hasSustain: doc.tracks.some((t) => t.controls.some((c) => c.controller === 64)),
    keyEstimateConfidence: key.confidence,
  };
}

function isDrum(track: MidiTrack, note: MidiNote): boolean {
  const ch = note.channel ?? track.channel;
  return ch === DRUM_CHANNEL;
}

function isDrumTrack(track: MidiTrack): boolean {
  return track.channel === DRUM_CHANNEL || track.notes.every((n) => n.channel === DRUM_CHANNEL);
}

/** 把小节和弦序列解析成 progression 输入的规范化形式（供 modify 工具使用）。 */
export function parseProgression(entries: { bar: number; chord: string | null }[]): { bar: number; chord: Chord | null }[] {
  return entries.map((e) => ({ bar: e.bar, chord: e.chord ? parseChord(e.chord) : null }));
}
