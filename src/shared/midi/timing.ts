/** 时间轴换算：tick ↔ 拍 ↔ 秒，小节/拍位置。 */
import { MidiDocument, TimeSigEvent, TempoEvent, documentEndTick } from './types';

export interface TempoSpan {
  tick: number;
  usPerQuarter: number;
  startSec: number; // 该速度段起点的绝对秒
}

export interface SigSpan {
  tick: number;
  numerator: number;
  denominator: number;
  barLenBeats: number;
}

export function buildTempoMap(tempos: TempoEvent[], tpq: number): TempoSpan[] {
  const sorted = [...tempos].sort((a, b) => a.tick - b.tick);
  const map: TempoSpan[] = [];
  let sec = 0;
  let lastTick = 0;
  let us = sorted[0]?.usPerQuarter ?? 500000;
  if (sorted.length === 0 || sorted[0].tick > 0) {
    map.push({ tick: 0, usPerQuarter: us, startSec: 0 });
  }
  for (const t of sorted) {
    sec += ((t.tick - lastTick) * us) / (tpq * 1e6);
    us = t.usPerQuarter;
    map.push({ tick: t.tick, usPerQuarter: us, startSec: sec });
    lastTick = t.tick;
  }
  return map;
}

export function buildSigMap(sigs: TimeSigEvent[]): SigSpan[] {
  const sorted = [...sigs].sort((a, b) => a.tick - b.tick);
  const map: SigSpan[] = [];
  if (sorted.length === 0 || sorted[0].tick > 0) {
    map.push({ tick: 0, numerator: 4, denominator: 4, barLenBeats: 4 });
  }
  for (const s of sorted) {
    map.push({ tick: s.tick, numerator: s.numerator, denominator: s.denominator, barLenBeats: (s.numerator * 4) / s.denominator });
  }
  return map;
}

/** 采集文档全部速度/拍号事件（任何轨道的都算，通常在轨道 0）。 */
export function collectTempos(doc: MidiDocument): TempoEvent[] {
  const all: TempoEvent[] = [];
  for (const t of doc.tracks) all.push(...t.tempos);
  if (all.length === 0) all.push({ tick: 0, usPerQuarter: 500000 });
  return all.sort((a, b) => a.tick - b.tick);
}

export function collectSigs(doc: MidiDocument): TimeSigEvent[] {
  const all: TimeSigEvent[] = [];
  for (const t of doc.tracks) all.push(...t.timeSignatures);
  if (all.length === 0) all.push({ tick: 0, numerator: 4, denominator: 4 });
  return all.sort((a, b) => a.tick - b.tick);
}

export function ticksToSec(tick: number, tpq: number, tempoMap: TempoSpan[]): number {
  const t = Math.max(0, tick);
  let span = tempoMap[0];
  for (const s of tempoMap) {
    if (s.tick <= t) span = s;
    else break;
  }
  if (!span) return 0;
  return span.startSec + ((t - span.tick) * span.usPerQuarter) / (tpq * 1e6);
}

export function secToTicks(sec: number, tpq: number, tempoMap: TempoSpan[]): number {
  const s = Math.max(0, sec);
  let span = tempoMap[0];
  for (const sp of tempoMap) {
    if (sp.startSec <= s) span = sp;
    else break;
  }
  if (!span) return 0;
  const beats = (s - span.startSec) * 1e6 / span.usPerQuarter;
  return Math.round(span.tick + beats * tpq);
}

export function docDurationSec(doc: MidiDocument): number {
  const tpq = doc.ticksPerQuarter;
  const tempoMap = buildTempoMap(collectTempos(doc), tpq);
  const endTick = Math.max(documentEndTick(doc), 1);
  return ticksToSec(endTick, tpq, tempoMap);
}

/** 文档的小节数（内容实际跨越的小节数；结尾恰在小节线时不算新小节）。 */
export function docBarCount(doc: MidiDocument): number {
  const tpq = doc.ticksPerQuarter;
  const sigMap = buildSigMap(collectSigs(doc));
  const endTick = documentEndTick(doc);
  if (endTick <= 0) return 1;
  return tickToBar(endTick - 1, tpq, sigMap);
}

export function tickToBar(tick: number, tpq: number, sigMap: SigSpan[]): number {
  const t = Math.max(0, tick);
  let span = sigMap[0];
  let bars = 0;
  for (const s of sigMap) {
    if (s.tick <= t) {
      const beatsIn = (t - s.tick) / tpq;
      bars = Math.floor(beatsIn / s.barLenBeats);
      span = s;
    } else break;
  }
  void span;
  return bars + 1; // 1-based 小节号
}

/** bar（1-based）起始 tick。 */
export function barToTick(bar: number, tpq: number, sigMap: SigSpan[]): number {
  const b = Math.max(1, Math.floor(bar));
  let tick = 0;
  let remaining = b - 1;
  let i = 0;
  while (remaining > 0 && i < 10000) {
    let span = sigMap[0];
    for (const s of sigMap) {
      if (s.tick <= tick) span = s;
      else break;
    }
    const spanEndTick = nextSigTick(sigMap, tick);
    const beatsToSpanEnd = (spanEndTick - tick) / tpq;
    const barsToSpanEnd = Math.floor(beatsToSpanEnd / span.barLenBeats + 1e-9);
    if (barsToSpanEnd >= remaining) {
      return Math.round(tick + remaining * span.barLenBeats * tpq);
    }
    remaining -= barsToSpanEnd;
    tick = spanEndTick;
    i++;
  }
  return Math.round(tick);
}

function nextSigTick(sigMap: SigSpan[], tick: number): number {
  for (const s of sigMap) {
    if (s.tick > tick) return s.tick;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function bpmOf(usPerQuarter: number): number {
  return 60e6 / usPerQuarter;
}

export function usPerQuarterOf(bpm: number): number {
  return Math.round(60e6 / bpm);
}
