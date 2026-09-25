/** MIDI 操作调度：所有可被 AI 调用的修改操作在此定义并应用。 */
import { Chord, parseChord, voiceChord } from './chords';
import { clampVelocity, makeRng, gaussian } from './notes';
import {
  MidiDocument,
  MidiTrack,
  cloneDocument,
  createEmptyTrack,
  sortDocument,
  sortInPlace,
} from './types';
import { barToTick, buildSigMap, collectSigs, collectTempos, usPerQuarterOf, buildTempoMap, ticksToSec } from './timing';
import { humanizeTiming, humanizeVelocities, generateCC11, addSustainPedal } from './humanize';
import { docBarCount } from './timing';

export type MidiOperation =
  | { type: 'transpose'; semitones: number; trackIndex?: number }
  | { type: 'humanize_velocity'; trackIndex?: number; amount?: number; seed?: number }
  | { type: 'humanize_timing'; trackIndex?: number; amount?: number; seed?: number }
  | { type: 'add_cc11'; trackIndex?: number; intensity?: number; seed?: number }
  | { type: 'add_sustain'; trackIndex?: number; gapBeats?: number }
  | { type: 'quantize'; trackIndex?: number; grid?: number; strength?: number }
  | { type: 'scale_velocity'; factor: number; trackIndex?: number }
  | {
      type: 'change_chords';
      progression: { bar: number; chord: string | null }[];
      trackIndex?: number;
      createTrackIfMissing?: boolean;
      trackName?: string;
      program?: number;
      style?: 'block' | 'arpeggio' | 'broken';
      velocity?: number;
      overwrite?: boolean; // true=清空目标轨道已有音符
    }
  | { type: 'set_tempo'; bpm: number }
  | { type: 'add_tempo_change'; bar: number; bpm: number }
  | { type: 'set_program'; trackIndex?: number; program: number }
  | { type: 'set_track_name'; trackIndex: number; name: string }
  | { type: 'delete_track'; trackIndex: number };

export interface OperationResult {
  doc: MidiDocument;
  summary: string;
}

export function applyOperations(doc: MidiDocument, operations: MidiOperation[]): OperationResult {
  let current = doc;
  const summaries: string[] = [];
  for (const op of operations) {
    const r = applyOne(current, op);
    current = r.doc;
    summaries.push(r.summary);
  }
  sortDocument(current);
  return { doc: current, summary: summaries.join('；') || '无操作' };
}

function applyOne(doc: MidiDocument, op: MidiOperation): OperationResult {
  switch (op.type) {
    case 'transpose': {
      const out = cloneDocument(doc);
      let count = 0;
      out.tracks.forEach((t, i) => {
        if (op.trackIndex !== undefined && i !== op.trackIndex) return;
        for (const n of t.notes) {
          n.pitch = Math.max(0, Math.min(127, n.pitch + op.semitones));
          count++;
        }
      });
      return { doc: out, summary: `移调 ${op.semitones} 半音（${count} 个音符）` };
    }

    case 'humanize_velocity': {
      const out = humanizeVelocities(doc, {
        trackIndex: op.trackIndex,
        amount: op.amount,
        seed: op.seed,
        barLenTicks: defaultBarLenTicks(doc),
      });
      return { doc: out, summary: `力度人性化（强度 ${Math.round((op.amount ?? 0.55) * 100)}%）` };
    }

    case 'humanize_timing': {
      const out = humanizeTiming(doc, { trackIndex: op.trackIndex, amount: op.amount, seed: op.seed });
      return { doc: out, summary: `时值微偏移（强度 ${Math.round((op.amount ?? 0.3) * 100)}%）` };
    }

    case 'add_cc11': {
      const out = generateCC11(doc, { trackIndex: op.trackIndex, intensity: op.intensity, seed: op.seed });
      const ccCount = out.tracks.reduce((acc, t) => acc + t.controls.filter((c) => c.controller === 11).length, 0);
      return { doc: out, summary: `生成 CC11 表情曲线（${ccCount} 个事件）` };
    }

    case 'add_sustain': {
      const out = addSustainPedal(doc, { trackIndex: op.trackIndex, gapBeats: op.gapBeats });
      const count = out.tracks.reduce((acc, t) => acc + t.controls.filter((c) => c.controller === 64).length, 0);
      return { doc: out, summary: `添加延音踏板 CC64（${count} 个事件）` };
    }

    case 'quantize': {
      const grid = Math.max(1, op.grid ?? 0.25);
      const strength = Math.max(0, Math.min(1, op.strength ?? 1));
      const gridTicks = Math.round(grid * doc.ticksPerQuarter);
      const out = cloneDocument(doc);
      let count = 0;
      out.tracks.forEach((t, i) => {
        if (op.trackIndex !== undefined && i !== op.trackIndex) return;
        for (const n of t.notes) {
          const nearest = Math.round(n.startTick / gridTicks) * gridTicks;
          n.startTick = Math.max(0, Math.round(n.startTick + (nearest - n.startTick) * strength));
          count++;
        }
        sortInPlace(t);
      });
      return { doc: out, summary: `量化到 ${grid} 拍网格（${count} 个音符，强度 ${Math.round(strength * 100)}%）` };
    }

    case 'scale_velocity': {
      const out = cloneDocument(doc);
      let count = 0;
      out.tracks.forEach((t, i) => {
        if (op.trackIndex !== undefined && i !== op.trackIndex) return;
        for (const n of t.notes) {
          n.velocity = clampVelocity(n.velocity * op.factor);
          count++;
        }
      });
      return { doc: out, summary: `力度缩放 ×${op.factor}（${count} 个音符）` };
    }

    case 'change_chords':
      return applyChangeChords(doc, op);

    case 'set_tempo': {
      const out = cloneDocument(doc);
      const us = usPerQuarterOf(op.bpm);
      const tempos = collectTempos(doc);
      const first = tempos[0];
      if (first && first.tick === 0) {
        out.tracks.forEach((t) => {
          t.tempos = t.tempos.map((e) => (e.tick === 0 ? { ...e, usPerQuarter: us } : e));
        });
        if (!out.tracks.some((t) => t.tempos.some((e) => e.tick === 0))) {
          out.tracks[0].tempos.push({ tick: 0, usPerQuarter: us });
        }
      } else {
        out.tracks[0].tempos.push({ tick: 0, usPerQuarter: us });
      }
      return { doc: out, summary: `设置速度 ${op.bpm} BPM` };
    }

    case 'add_tempo_change': {
      const sigMap = buildSigMap(collectSigs(doc));
      const tick = barToTick(op.bar, doc.ticksPerQuarter, sigMap);
      const out = cloneDocument(doc);
      out.tracks[0].tempos.push({ tick, usPerQuarter: usPerQuarterOf(op.bpm) });
      out.tracks[0].tempos.sort((a, b) => a.tick - b.tick);
      return { doc: out, summary: `第 ${op.bar} 小节起速度变为 ${op.bpm} BPM` };
    }

    case 'set_program': {
      const idx = op.trackIndex ?? firstNoteTrackIndex(doc) ?? 0;
      const out = cloneDocument(doc);
      if (out.tracks[idx]) {
        out.tracks[idx].program = Math.max(0, Math.min(127, Math.round(op.program)));
        return { doc: out, summary: `轨道 ${idx + 1} 音色改为 GM ${op.program}` };
      }
      return { doc: out, summary: '轨道不存在，忽略 set_program' };
    }

    case 'set_track_name': {
      const out = cloneDocument(doc);
      if (out.tracks[op.trackIndex]) {
        out.tracks[op.trackIndex].name = op.name;
        return { doc: out, summary: `轨道 ${op.trackIndex + 1} 重命名为 "${op.name}"` };
      }
      return { doc: out, summary: '轨道不存在，忽略 set_track_name' };
    }

    case 'delete_track': {
      const out = cloneDocument(doc);
      if (out.tracks.length <= 1) return { doc: out, summary: '仅剩一条轨道，忽略删除' };
      if (out.tracks[op.trackIndex]) {
        const [removed] = out.tracks.splice(op.trackIndex, 1);
        return { doc: out, summary: `删除轨道 "${removed.name}"` };
      }
      return { doc: out, summary: '轨道不存在，忽略删除' };
    }

    default:
      return { doc, summary: '未知操作，已忽略' };
  }
}

function defaultBarLenTicks(doc: MidiDocument): number {
  const sig = collectSigs(doc)[0];
  const beats = ((sig?.numerator ?? 4) * 4) / (sig?.denominator ?? 4);
  return Math.round(beats * doc.ticksPerQuarter);
}

function firstNoteTrackIndex(doc: MidiDocument): number | undefined {
  const idx = doc.tracks.findIndex((t) => t.notes.length > 0);
  return idx >= 0 ? idx : undefined;
}

/** 换和弦：解析 progression，按小节生成带声部连接的伴奏和声。 */
function applyChangeChords(
  doc: MidiDocument,
  op: Extract<MidiOperation, { type: 'change_chords' }>,
): OperationResult {
  const sigMap = buildSigMap(collectSigs(doc));
  const bars = docBarCount(doc);
  const out = cloneDocument(doc);

  // 确定目标轨道
  let trackIndex = op.trackIndex;
  let created = false;
  if (trackIndex === undefined || !out.tracks[trackIndex]) {
    if (op.createTrackIfMissing !== false) {
      const track = createEmptyTrack(op.trackName ?? 'Chords', op.program ?? 0);
      out.tracks.push(track);
      trackIndex = out.tracks.length - 1;
      created = true;
    } else {
      return { doc: out, summary: '指定的和弦轨道不存在，忽略 change_chords' };
    }
  }
  const track: MidiTrack = out.tracks[trackIndex];
  if (op.overwrite !== false) track.notes = [];

  // 解析 progression
  const parsed: { bar: number; chord: Chord | null }[] = [];
  for (const entry of op.progression) {
    if (entry.bar < 1 || entry.bar > bars + 64) continue;
    parsed.push({ bar: Math.floor(entry.bar), chord: entry.chord ? parseChord(entry.chord) : null });
  }
  parsed.sort((a, b) => a.bar - b.bar);
  if (parsed.length === 0) return { doc: out, summary: 'progression 为空，忽略 change_chords' };

  const style = op.style ?? 'block';
  const baseVelocity = op.velocity ?? 68;
  const rng = makeRng(424242);
  const byBar = new Map<number, Chord | null>();
  for (const p of parsed) byBar.set(p.bar, p.chord);

  // 逐小节：向前继承最近的和弦定义
  let carrying: Chord | null = null;
  let previousVoicing: number[] | undefined;
  let noteCount = 0;
  const chordSummary: string[] = [];
  for (let bar = 1; bar <= bars; bar++) {
    if (byBar.has(bar)) carrying = byBar.get(bar) ?? null;
    if (!carrying) continue;
    const startTick = barToTick(bar, doc.ticksPerQuarter, sigMap);
    const endTick = barToTick(bar + 1, doc.ticksPerQuarter, sigMap);
    const notes = voiceChord(carrying, {
      style,
      barStartTick: startTick,
      barEndTick: endTick,
      tpq: doc.ticksPerQuarter,
      velocity: baseVelocity,
      previousVoicing,
    });
    for (const n of notes) {
      track.notes.push({
        pitch: n.pitch,
        velocity: clampVelocity(n.velocity + gaussian(rng) * 2),
        startTick: n.startTick,
        endTick: n.endTick,
      });
      noteCount++;
    }
    previousVoicing = notes.map((n) => n.pitch);
    chordSummary.push(`${bar}:${carrying.symbol}`);
  }
  sortInPlace(track);
  return {
    doc: out,
    summary: `${created ? '新建和弦轨道并' : ''}写入和弦进行 ${chordSummary.map((s) => s.split(':')[1]).join(' ')}（风格 ${style}，${noteCount} 个音符）`,
  };
}

/** 统计信息：给 MCP 工具返回文本摘要用。 */
export function docQuickSummary(doc: MidiDocument): string {
  const tempoMap = buildTempoMap(collectTempos(doc), doc.ticksPerQuarter);
  const totalNotes = doc.tracks.reduce((a, t) => a + t.notes.length, 0);
  const dur = doc.tracks.reduce((max, t) => {
    const end = t.notes.reduce((m, n) => Math.max(m, ticksToSec(n.endTick, doc.ticksPerQuarter, tempoMap)), 0);
    return Math.max(max, end);
  }, 0);
  const barCount = docBarCount(doc);
  return `${doc.tracks.length} 轨 / ${totalNotes} 音符 / ${barCount} 小节 / ${dur.toFixed(1)}s`;
}
