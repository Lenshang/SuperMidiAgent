/** 标准 MIDI 文件（SMF）写入器。输出 format 0 或 1。 */
import {
  MidiDocument,
  TempoEvent,
  TimeSigEvent,
  DEFAULT_US_PER_QUARTER,
  DRUM_CHANNEL,
} from './types';

class ByteWriter {
  private chunks: number[] = [];

  u8(v: number): this {
    this.chunks.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    return this.u8(v >> 8).u8(v);
  }

  u32(v: number): this {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }

  str(s: string): this {
    for (const byte of new TextEncoder().encode(s)) this.u8(byte);
    return this;
  }

  varlen(value: number): this {
    let v = Math.max(0, Math.round(value));
    const buffer: number[] = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      buffer.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    for (const b of buffer) this.u8(b);
    return this;
  }

  bytes(arr: number[] | Uint8Array): this {
    for (const b of arr) this.u8(b);
    return this;
  }

  get length(): number {
    return this.chunks.length;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function meta(w: ByteWriter, type: number, data: number[]): void {
  w.u8(0xff).u8(type).varlen(data.length).bytes(data);
}

function strBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

interface FlatEvent {
  tick: number;
  order: number; // 同 tick 时的排序：meta 0 < program 1 < cc 2 < bend 3 < noteoff 4 < noteon 5
  emit: (w: ByteWriter, prevStatus: { value: number }) => void;
}

function tempoToBytes(e: TempoEvent): number[] {
  const us = Math.max(1, Math.round(e.usPerQuarter));
  return [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
}

function timeSigToBytes(e: TimeSigEvent): number[] {
  const denPow = Math.round(Math.log2(e.denominator));
  return [e.numerator, denPow, 24, 8];
}

function noteChannel(trackChannel: number, noteChannel: number | undefined, trackIndex: number): number {
  if (noteChannel !== undefined && noteChannel >= 0) return noteChannel & 0x0f;
  if (trackChannel >= 0) return trackChannel & 0x0f;
  // 自动分配：跳过鼓组通道 9
  let ch = trackIndex === 0 ? 0 : trackIndex < DRUM_CHANNEL ? trackIndex : trackIndex + 1;
  ch = ch % 16;
  if (ch >= DRUM_CHANNEL) ch = (ch + 1) % 16;
  return ch;
}

/** 将文档编码为 SMF 字节。format 1：轨道 0 为速度轨（若第一条轨道含速度信息则直接使用）。 */
export function writeMidi(doc: MidiDocument): Uint8Array {
  const header = new ByteWriter();
  header.str('MThd').u32(6).u16(doc.format).u16(doc.format === 0 ? 1 : doc.tracks.length).u16(doc.ticksPerQuarter);

  const trackChunks: Uint8Array[] = [];
  const tracks = doc.format === 0 ? [mergeToSingleTrack(doc)] : doc.tracks;

  tracks.forEach((track, index) => {
    const w = new ByteWriter();
    const events: FlatEvent[] = [];
    const isConductor = doc.format === 1 && index === 0;

    if (track.name) {
      const data = strBytes(track.name);
      events.push({ tick: 0, order: 0, emit: (ww) => meta(ww, 0x03, data) });
    }

    if (isConductor || doc.format === 0) {
      const tempos = track.tempos.length
        ? [...track.tempos].sort((a, b) => a.tick - b.tick)
        : [{ tick: 0, usPerQuarter: DEFAULT_US_PER_QUARTER }];
      for (const t of tempos) {
        const data = tempoToBytes(t);
        events.push({ tick: t.tick, order: 0, emit: (ww) => meta(ww, 0x51, data) });
      }
      const sigs = track.timeSignatures.length
        ? [...track.timeSignatures].sort((a, b) => a.tick - b.tick)
        : [{ tick: 0, numerator: 4, denominator: 4 }];
      for (const s of sigs) {
        const data = timeSigToBytes(s);
        events.push({ tick: s.tick, order: 0, emit: (ww) => meta(ww, 0x58, data) });
      }
    }

    if (doc.format === 0) {
      // format 0：所有轨道事件已合并，通道信息保留在事件本身
      emitChannelEvents(events, track, -1);
    } else if (!isConductor) {
      const ch = noteChannel(track.channel, undefined, index);
      events.push({
        tick: 0,
        order: 1,
        emit: (ww) => ww.u8(0xc0 | ch).u8(track.program & 0x7f),
      });
      emitChannelEvents(events, track, ch);
    }

    events.sort((a, b) => a.tick - b.tick || a.order - b.order);

    let lastTick = 0;
    const prevStatus = { value: -1 };
    for (const ev of events) {
      w.varlen(ev.tick - lastTick);
      lastTick = ev.tick;
      ev.emit(w, prevStatus);
    }
    w.varlen(0); // end-of-track 前必须有 delta 时间
    meta(w, 0x2f, []);
    const body = w.toUint8Array();
    const chunk = new ByteWriter();
    chunk.str('MTrk').u32(body.length).bytes(body);
    trackChunks.push(chunk.toUint8Array());
  });

  const total = new ByteWriter();
  total.bytes(header.toUint8Array());
  for (const chunk of trackChunks) total.bytes(chunk);
  return total.toUint8Array();
}

function emitChannelEvents(events: FlatEvent[], track: import('./types').MidiTrack, fixedChannel: number): void {
  for (const c of track.controls) {
    const ch = fixedChannel >= 0 ? fixedChannel : noteChannel(track.channel, c.channel, 1);
    events.push({ tick: c.tick, order: 2, emit: (ww) => ww.u8(0xb0 | ch).u8(c.controller & 0x7f).u8(c.value & 0x7f) });
  }
  for (const p of track.pitchBends) {
    const ch = fixedChannel >= 0 ? fixedChannel : noteChannel(track.channel, p.channel, 1);
    const value = Math.max(0, Math.min(16383, Math.round(p.value)));
    events.push({ tick: p.tick, order: 3, emit: (ww) => ww.u8(0xe0 | ch).u8(value & 0x7f).u8((value >> 7) & 0x7f) });
  }
  for (const n of track.notes) {
    const ch = fixedChannel >= 0 ? fixedChannel : noteChannel(track.channel, n.channel, 1);
    const start = Math.max(0, Math.round(n.startTick));
    const end = Math.max(start + 1, Math.round(n.endTick));
    events.push({
      tick: end,
      order: 4,
      emit: (ww) => ww.u8(0x80 | ch).u8(n.pitch & 0x7f).u8(0x40),
    });
    events.push({
      tick: start,
      order: 5,
      emit: (ww) => ww.u8(0x90 | ch).u8(n.pitch & 0x7f).u8(Math.max(1, Math.min(127, Math.round(n.velocity)))),
    });
  }
}

/** format 0：把所有轨道合并为一条多通道轨道（速度/拍号同样合入）。 */
function mergeToSingleTrack(doc: MidiDocument): import('./types').MidiTrack {
  const merged: import('./types').MidiTrack = {
    name: doc.tracks[0]?.name ?? '',
    channel: -1,
    program: 0,
    notes: [],
    controls: [],
    pitchBends: [],
    tempos: [],
    timeSignatures: [],
  };
  for (const t of doc.tracks) {
    merged.tempos.push(...t.tempos);
    merged.timeSignatures.push(...t.timeSignatures);
    merged.notes.push(...t.notes);
    merged.controls.push(...t.controls);
    merged.pitchBends.push(...t.pitchBends);
  }
  return merged;
}
