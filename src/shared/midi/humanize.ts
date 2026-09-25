/** 音乐化处理：乐句分割、力度人性化、CC11 表情曲线、延音踏板、微小时值偏移。 */
import { clampCC, clampVelocity, gaussian, makeRng } from './notes';
import { MidiDocument, MidiTrack, cloneDocument } from './types';

export interface Phrase {
  startTick: number;
  endTick: number;
  notes: number[]; // 索引到 track.notes
}

/**
 * 乐句分割：按 onset 间隙切分。相邻 onset 间隔超过 gapTicks 即视为新乐句。
 * gap 默认 3/4 拍。
 */
export function segmentPhrases(track: MidiTrack, tpq: number, gapBeats = 0.75): Phrase[] {
  if (track.notes.length === 0) return [];
  const gap = Math.round(gapBeats * tpq);
  const sorted = track.notes
    .map((n, i) => ({ i, start: n.startTick, end: n.endTick }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const phrases: Phrase[] = [];
  let current: { start: number; end: number; notes: number[] } = { start: sorted[0].start, end: sorted[0].end, notes: [sorted[0].i] };
  let lastOnset = sorted[0].start;
  for (let k = 1; k < sorted.length; k++) {
    const item = sorted[k];
    const onsetJump = item.start - lastOnset;
    const endGap = item.start - current.end;
    if (onsetJump >= gap * 4 || endGap >= gap) {
      phrases.push({ startTick: current.start, endTick: current.end, notes: current.notes });
      current = { start: item.start, end: item.end, notes: [item.i] };
    } else {
      current.end = Math.max(current.end, item.end);
      current.notes.push(item.i);
    }
    lastOnset = item.start;
  }
  phrases.push({ startTick: current.start, endTick: current.end, notes: current.notes });
  return phrases;
}

/** 小节内节拍位置的力度权重（4/4 近似，适配其他拍号）。 */
function metricAccent(tick: number, tpq: number, barLenTicks: number): number {
  const posInBar = ((tick % barLenTicks) + barLenTicks) % barLenTicks;
  const beat = posInBar / tpq;
  const barBeats = barLenTicks / tpq;
  if (beat === 0) return 10; // 小节头
  if (Math.abs(beat - barBeats / 2) < 0.01) return 6; // 半小节
  if (Number.isInteger(beat)) return beat % 2 === 0 ? 3 : 1;
  if (Math.abs(beat * 2 - Math.round(beat * 2)) < 0.01) return -4; // 八分反拍
  return -6; // 十六分等弱位
}

export interface HumanizeVelocityOptions {
  trackIndex?: number;
  amount?: number; // 0-1，默认 0.55
  seed?: number;
  barLenTicks: number;
}

/** 力度人性化：乐句弧线 + 节拍重音 + 长音强调 + 旋律高音突出 + 轻微抖动。 */
export function humanizeVelocities(doc: MidiDocument, opts: HumanizeVelocityOptions): MidiDocument {
  const amount = Math.max(0, Math.min(1, opts.amount ?? 0.55));
  const out = cloneDocument(doc);
  out.tracks.forEach((track, ti) => {
    if (opts.trackIndex !== undefined && ti !== opts.trackIndex) return;
    if (track.notes.length === 0) return;
    const rng = makeRng((opts.seed ?? 12345) + ti * 7919);
    const phrases = segmentPhrases(track, out.ticksPerQuarter);

    for (const phrase of phrases) {
      const pNotes = phrase.notes.map((i) => track.notes[i]);
      const pLen = Math.max(1, phrase.endTick - phrase.startTick);
      // 同 onset 最高音视作旋律
      const byOnset = new Map<number, number[]>();
      pNotes.forEach((n, k) => {
        const list = byOnset.get(n.startTick) ?? [];
        list.push(k);
        byOnset.set(n.startTick, list);
      });
      const melodyAt = new Map<number, number>();
      for (const [onset, ks] of byOnset) {
        const best = ks.reduce((a, b) => (pNotes[b].pitch > pNotes[a].pitch ? b : a), ks[0]);
        melodyAt.set(onset, pNotes[best].pitch);
      }
      const arcAmp = 13 * amount;

      for (const k of phrase.notes) {
        const note = track.notes[k];
        const progress = (note.startTick - phrase.startTick) / pLen;
        const arc = Math.sin(Math.PI * Math.min(1, Math.max(0, progress))) ** 0.8 * arcAmp;
        const accent = metricAccent(note.startTick, out.ticksPerQuarter, opts.barLenTicks) * amount;
        const durationBeats = (note.endTick - note.startTick) / out.ticksPerQuarter;
        const longNote = durationBeats >= 1 ? 4 * amount : 0;
        const melodyBonus = melodyAt.get(note.startTick) === note.pitch && byOnset.size > 0 ? 6 * amount : -3 * amount;
        const jitter = gaussian(rng) * 5 * amount;
        const delta = arc + accent + longNote + melodyBonus + jitter;
        note.velocity = clampVelocity(note.velocity + delta);
      }
    }
  });
  return out;
}

export interface CC11Options {
  trackIndex?: number;
  intensity?: number; // 0-1，默认 0.5
  seed?: number;
  gridTicks?: number; // 采样步长，默认 1/8 拍
  min?: number; // 曲线下限 0-127，默认 40
  max?: number; // 曲线上限 0-127，默认 122；曲线整体落在这个值域内
}

/**
 * 生成 CC11（表情）曲线：
 * - 每个乐句一条弧线：起步于值域中部偏下，45% 处达峰（接近 max），句尾回落（接近 min）；
 * - 长音（≥1 拍）内部有轻微 swell；
 * - 乐句边界轻微收束，制造呼吸感；
 * - 所有值严格落在 [min, max] 内（min 默认 40，max 默认 122，可指定 0-127 任意范围）；
 * - 采样后做滑动平均平滑。
 * 会替换轨道上已有的 CC11。
 */
export function generateCC11(doc: MidiDocument, opts: CC11Options): MidiDocument {
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.5));
  const grid = Math.max(15, Math.round(opts.gridTicks ?? doc.ticksPerQuarter / 8));
  const lo = Math.max(0, Math.min(127, Math.round(opts.min ?? 40)));
  const hi = Math.max(Math.min(127, Math.round(opts.max ?? 122)), lo + 6);
  const span = hi - lo;
  const out = cloneDocument(doc);
  out.tracks.forEach((track, ti) => {
    if (opts.trackIndex !== undefined && ti !== opts.trackIndex) return;
    if (track.notes.length === 0) return;
    const rng = makeRng((opts.seed ?? 24680) + ti * 104729);
    track.controls = track.controls.filter((c) => c.controller !== 11);

    const phrases = segmentPhrases(track, out.ticksPerQuarter);
    const samples: { tick: number; value: number }[] = [];

    phrases.forEach((phrase, pi) => {
      const pLen = Math.max(grid, phrase.endTick - phrase.startTick);
      const v0 = Math.round(lo + span * (0.42 + gaussian(rng) * 0.05));
      const peak = Math.round(hi - Math.abs(gaussian(rng)) * span * 0.04);
      const tail = Math.round(lo + span * (0.22 + gaussian(rng) * 0.05));
      const nextStart = phrases[pi + 1]?.startTick ?? phrase.endTick;
      // 起音保留：乐句开始的极短窗口内保持较高，避免吞掉音头
      const attackTicks = Math.min(Math.round(out.ticksPerQuarter / 2), Math.round(pLen * 0.12));

      for (let t = phrase.startTick; t <= Math.min(phrase.endTick, nextStart - 1); t += grid) {
        const progress = (t - phrase.startTick) / pLen;
        let value: number;
        if (t - phrase.startTick < attackTicks) {
          value = v0 + (peak - v0) * 0.35 * ((t - phrase.startTick) / Math.max(1, attackTicks));
        } else if (progress < 0.45) {
          const p = (progress - 0.12) / 0.33;
          value = v0 + (peak - v0) * Math.min(1, Math.max(0, p));
        } else if (t > phrase.endTick - pLen * 0.15 && phrase.endTick < nextStart) {
          // 乐句收尾回落
          const p = (t - (phrase.endTick - pLen * 0.15)) / (pLen * 0.15);
          value = peak + (tail - peak) * Math.min(1, Math.max(0, p));
        } else {
          const p = (progress - 0.45) / 0.55;
          value = peak + (tail - peak) * Math.min(1, Math.max(0, p)) * 0.55;
        }

        // 长音内部 swell
        const holding = track.notes.find(
          (n) => n.startTick <= t && n.endTick - n.startTick >= out.ticksPerQuarter && n.endTick > t,
        );
        if (holding) {
          const hProgress = (t - holding.startTick) / (holding.endTick - holding.startTick);
          value += Math.sin(Math.PI * Math.min(1, hProgress)) * 5 * intensity;
        }
        // 严格落在 [lo, hi] 值域内
        samples.push({ tick: t, value: Math.max(lo, Math.min(hi, Math.round(value))) });
      }
    });

    if (samples.length === 0) return;
    // 滑动平均平滑（窗口 3）
    const smoothed = samples.map((s, i) => {
      const window = [samples[i - 1]?.value ?? s.value, s.value, samples[i + 1]?.value ?? s.value];
      const avg = window.reduce((a, b) => a + b, 0) / window.length;
      return { tick: s.tick, value: Math.max(lo, Math.min(hi, clampCC(avg))) };
    });
    for (const s of smoothed) {
      track.controls.push({ tick: s.tick, controller: 11, value: s.value, channel: track.channel >= 0 ? track.channel : undefined });
    }
    track.controls.sort((a, b) => a.tick - b.tick || a.controller - b.controller);
  });
  return out;
}

export interface SustainOptions {
  trackIndex?: number;
  /** 分组间隔（拍）：前一个音结束与下一个音开始间隔小于该值视为同一踏板组 */
  gapBeats?: number;
}

/** 添加延音踏板（CC64）：按音符间隙分组，踏板在组首踩下、组尾（稍延后）抬起。 */
export function addSustainPedal(doc: MidiDocument, opts: SustainOptions): MidiDocument {
  const gapTicks = Math.round((opts.gapBeats ?? 0.25) * doc.ticksPerQuarter);
  const out = cloneDocument(doc);
  out.tracks.forEach((track, ti) => {
    if (opts.trackIndex !== undefined && ti !== opts.trackIndex) return;
    if (track.notes.length === 0) return;
    track.controls = track.controls.filter((c) => c.controller !== 64);

    const sorted = [...track.notes].sort((a, b) => a.startTick - b.startTick);
    const groups: { start: number; end: number }[] = [];
    let current = { start: sorted[0].startTick, end: sorted[0].endTick };
    for (let i = 1; i < sorted.length; i++) {
      const n = sorted[i];
      if (n.startTick - current.end <= gapTicks) {
        current.end = Math.max(current.end, n.endTick);
      } else {
        groups.push(current);
        current = { start: n.startTick, end: n.endTick };
      }
    }
    groups.push(current);

    groups.forEach((g, i) => {
      const press = Math.max(0, g.start - 1);
      const nextStart = groups[i + 1]?.start ?? Number.MAX_SAFE_INTEGER;
      const release = Math.min(g.end + Math.round(doc.ticksPerQuarter * 0.1), nextStart - 1);
      track.controls.push({ tick: press, controller: 64, value: 127, channel: track.channel >= 0 ? track.channel : undefined });
      if (release > press) {
        track.controls.push({ tick: release, controller: 64, value: 0, channel: track.channel >= 0 ? track.channel : undefined });
      }
    });
    track.controls.sort((a, b) => a.tick - b.tick || a.controller - b.controller);
  });
  return out;
}

export interface HumanizeTimingOptions {
  trackIndex?: number;
  amount?: number; // 0-1，默认 0.3；最大偏移约 ±0.06 拍 × amount×10
  seed?: number;
}

/** 微小时值人性化：起始位置轻微偏移（保持音符时值），让演奏更自然。 */
export function humanizeTiming(doc: MidiDocument, opts: HumanizeTimingOptions): MidiDocument {
  const amount = Math.max(0, Math.min(1, opts.amount ?? 0.3));
  const maxShift = Math.round(doc.ticksPerQuarter * 0.06 * (0.5 + amount));
  const out = cloneDocument(doc);
  out.tracks.forEach((track, ti) => {
    if (opts.trackIndex !== undefined && ti !== opts.trackIndex) return;
    const rng = makeRng((opts.seed ?? 13579) + ti * 31);
    const shifted = new Map<number, number>();
    for (const note of track.notes) {
      const shift = Math.round(gaussian(rng) * maxShift * 0.5);
      const newStart = Math.max(0, note.startTick + shift);
      shifted.set(note.startTick, newStart);
      const duration = note.endTick - note.startTick;
      note.startTick = newStart;
      note.endTick = newStart + duration;
    }
    void shifted;
    track.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  });
  return out;
}
