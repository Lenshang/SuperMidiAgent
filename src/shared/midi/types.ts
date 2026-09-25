/** MIDI 文档的内存表示：与具体文件字节解耦，便于编辑与序列化。 */

/** 一个音符。startTick/endTick 为 tick，endTick 为排他边界。 */
export interface MidiNote {
  pitch: number; // 0-127
  velocity: number; // 1-127
  startTick: number;
  endTick: number;
  channel?: number; // 0-15，缺省用轨道 channel
}

export interface ControlEvent {
  tick: number;
  controller: number; // 0-127
  value: number; // 0-127
  channel?: number;
}

export interface PitchBendEvent {
  tick: number;
  value: number; // 0-16383，8192 为中心
  channel?: number;
}

export interface TempoEvent {
  tick: number;
  usPerQuarter: number;
}

export interface TimeSigEvent {
  tick: number;
  numerator: number;
  denominator: number; // 真实分母（如 4 表示四分音符）
}

export interface MidiTrack {
  name: string;
  channel: number; // 输出通道 0-15；-1 表示自动分配
  program: number; // GM 音色 0-127
  notes: MidiNote[];
  controls: ControlEvent[];
  pitchBends: PitchBendEvent[];
  tempos: TempoEvent[];
  timeSignatures: TimeSigEvent[];
}

export interface MidiDocument {
  format: 0 | 1;
  ticksPerQuarter: number;
  tracks: MidiTrack[];
}

export const DEFAULT_TPQ = 480;
export const DEFAULT_US_PER_QUARTER = 500000; // 120 BPM
export const DRUM_CHANNEL = 9; // GM 鼓组通道（0 基）

export function createEmptyTrack(name = '', program = 0, channel = -1): MidiTrack {
  return {
    name,
    channel,
    program,
    notes: [],
    controls: [],
    pitchBends: [],
    tempos: [],
    timeSignatures: [],
  };
}

export function createEmptyDocument(tpq = DEFAULT_TPQ): MidiDocument {
  const conductor = createEmptyTrack('Conductor');
  conductor.tempos.push({ tick: 0, usPerQuarter: DEFAULT_US_PER_QUARTER });
  conductor.timeSignatures.push({ tick: 0, numerator: 4, denominator: 4 });
  return { format: 1, ticksPerQuarter: tpq, tracks: [conductor] };
}

export function cloneDocument(doc: MidiDocument): MidiDocument {
  return {
    format: doc.format,
    ticksPerQuarter: doc.ticksPerQuarter,
    tracks: doc.tracks.map((t) => ({
      ...t,
      notes: t.notes.map((n) => ({ ...n })),
      controls: t.controls.map((c) => ({ ...c })),
      pitchBends: t.pitchBends.map((p) => ({ ...p })),
      tempos: t.tempos.map((e) => ({ ...e })),
      timeSignatures: t.timeSignatures.map((e) => ({ ...e })),
    })),
  };
}

export function sortInPlace(track: MidiTrack): void {
  track.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  track.controls.sort((a, b) => a.tick - b.tick || a.controller - b.controller);
  track.pitchBends.sort((a, b) => a.tick - b.tick);
  track.tempos.sort((a, b) => a.tick - b.tick);
  track.timeSignatures.sort((a, b) => a.tick - b.tick);
}

export function sortDocument(doc: MidiDocument): void {
  for (const t of doc.tracks) sortInPlace(t);
}

/** 轨道中最后一个事件（含音符结尾）所在 tick，用于计算轨道长度。 */
export function trackEndTick(track: MidiTrack): number {
  let end = 0;
  for (const n of track.notes) end = Math.max(end, n.endTick);
  for (const c of track.controls) end = Math.max(end, c.tick);
  for (const p of track.pitchBends) end = Math.max(end, p.tick);
  return end;
}

export function documentEndTick(doc: MidiDocument): number {
  let end = 0;
  for (const t of doc.tracks) end = Math.max(end, trackEndTick(t));
  return end;
}

export function trackNoteCount(track: MidiTrack): number {
  return track.notes.length;
}
